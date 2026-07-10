import { waitUntil } from "cloudflare:workers";
import { applyPayPalWebhook } from "../../../../lib/live-jobs";
import { drainNotifications } from "../../../../lib/process-notification";
import {
  getPayPalAccessToken,
  verifyPayPalWebhookSignature,
} from "../../../../lib/payouts/paypal";
import { getRuntimeEnv, requireLiveEnv } from "../../../../lib/runtime-env";

export async function POST(request: Request) {
  try {
    const runtime = requireLiveEnv(getRuntimeEnv());
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isFinite(declaredLength) || declaredLength > 256_000) {
      return Response.json({ error: "Webhook body is too large." }, { status: 413 });
    }
    const requiredHeaders = [
      "paypal-auth-algo",
      "paypal-cert-url",
      "paypal-transmission-id",
      "paypal-transmission-sig",
      "paypal-transmission-time",
    ];
    if (
      requiredHeaders.some((name) => {
        const value = request.headers.get(name)?.trim() ?? "";
        return !value || value.length > 4_096;
      })
    ) {
      return Response.json({ error: "Webhook headers are invalid." }, { status: 400 });
    }
    const rawEvent = await request.text();
    if (new TextEncoder().encode(rawEvent).byteLength > 256_000) {
      return Response.json({ error: "Webhook body is too large." }, { status: 413 });
    }
    const target = runtime.PAYPAL_API_BASE_URL
      ? { baseUrl: runtime.PAYPAL_API_BASE_URL }
      : { environment: runtime.PAYPAL_MODE };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let verification;
    try {
      const token = await getPayPalAccessToken({
        clientId: runtime.PAYPAL_CLIENT_ID,
        clientSecret: runtime.PAYPAL_CLIENT_SECRET,
        signal: controller.signal,
        ...target,
      });
      verification = await verifyPayPalWebhookSignature({
        accessToken: token.accessToken,
        webhookId: runtime.PAYPAL_WEBHOOK_ID,
        headers: request.headers,
        rawEvent,
        signal: controller.signal,
        ...target,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!verification.signatureVerified) {
      return Response.json({ error: "Webhook signature verification failed." }, { status: 400 });
    }
    const result = await applyPayPalWebhook(rawEvent, runtime);
    waitUntil(drainNotifications(1, { runtime }).catch(() => undefined));
    return Response.json({ received: true, ...result });
  } catch {
    return Response.json(
      { error: "Webhook processing failed." },
      { status: 400 },
    );
  }
}
