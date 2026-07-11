import { applyResendDeliveryEvent } from "../../../../lib/live-jobs";
import { verifyResendWebhook } from "../../../../lib/resend-webhooks";
import {
  getRuntimeEnv,
  requireActiveLiveEnv,
} from "../../../../lib/runtime-env";

const JSON_HEADERS = { "Cache-Control": "no-store" };
const MAX_WEBHOOK_BYTES = 64 * 1024;

export async function POST(request: Request) {
  let runtime: ReturnType<typeof requireActiveLiveEnv>;
  try {
    runtime = requireActiveLiveEnv(getRuntimeEnv());
  } catch {
    return Response.json(
      { error: "Resend webhook processing is unavailable." },
      { status: 503, headers: JSON_HEADERS },
    );
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength > MAX_WEBHOOK_BYTES) {
    return Response.json(
      { error: "Webhook body is too large." },
      { status: 413, headers: JSON_HEADERS },
    );
  }
  const rawPayload = await request.text();
  if (new TextEncoder().encode(rawPayload).byteLength > MAX_WEBHOOK_BYTES) {
    return Response.json(
      { error: "Webhook body is too large." },
      { status: 413, headers: JSON_HEADERS },
    );
  }

  let event: ReturnType<typeof verifyResendWebhook>;
  try {
    event = verifyResendWebhook({
      rawPayload,
      secret: runtime.RESEND_WEBHOOK_SECRET,
      eventId: request.headers.get("svix-id") ?? "",
      timestamp: request.headers.get("svix-timestamp") ?? "",
      signature: request.headers.get("svix-signature") ?? "",
    });
  } catch {
    return Response.json(
      { error: "Invalid Resend webhook." },
      { status: 400, headers: JSON_HEADERS },
    );
  }
  if (!event) {
    return Response.json(
      { received: true, handled: false },
      { headers: JSON_HEADERS },
    );
  }

  try {
    const result = await applyResendDeliveryEvent(event, runtime);
    return Response.json(
      {
        received: true,
        handled: result.handled,
        duplicate: result.duplicate,
        deliveryStatus: result.deliveryStatus,
      },
      { headers: JSON_HEADERS },
    );
  } catch {
    // A 5xx asks Resend to retry instead of losing a verified delivery event.
    return Response.json(
      { error: "Resend webhook processing is temporarily unavailable." },
      { status: 503, headers: JSON_HEADERS },
    );
  }
}
