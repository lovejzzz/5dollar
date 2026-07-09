import {
  createJob,
  isPayoutMethod,
  validateDestination,
} from "../../../lib/jobs";
import { createLiveJob } from "../../../lib/live-jobs";
import { inferPayPalRecipientType } from "../../../lib/payouts/paypal";
import { processLiveJob } from "../../../lib/process-live-job";
import { getFiveMode, getRuntimeEnv, requireLiveEnv } from "../../../lib/runtime-env";
import {
  chatGPTSignInPath,
  getChatGPTUser,
} from "../../chatgpt-auth";
import { waitUntil } from "cloudflare:workers";

export async function POST(request: Request) {
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isFinite(declaredLength) || declaredLength > 4_096) {
      return Response.json({ error: "Request body is too large." }, { status: 413 });
    }
    const rawPayload = await request.text();
    if (new TextEncoder().encode(rawPayload).byteLength > 4_096) {
      return Response.json({ error: "Request body is too large." }, { status: 413 });
    }
    let payload: { payoutMethod?: string; destination?: string };
    try {
      payload = JSON.parse(rawPayload) as typeof payload;
    } catch {
      return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }
    const payoutMethod = payload.payoutMethod?.trim().toLowerCase() ?? "";
    const destination = payload.destination ?? "";

    if (!isPayoutMethod(payoutMethod)) {
      return Response.json({ error: "Choose a supported payout method." }, { status: 400 });
    }

    const destinationError = validateDestination(payoutMethod, destination);
    if (destinationError) {
      return Response.json({ error: destinationError }, { status: 400 });
    }

    const runtime = getRuntimeEnv();
    if (getFiveMode(runtime) === "live") {
      requireLiveEnv(runtime);
      const user = await getChatGPTUser();
      if (!user) {
        return Response.json(
          {
            error: "Sign in is required before requesting a real reward.",
            signInUrl: chatGPTSignInPath("/"),
          },
          { status: 401 },
        );
      }
      if (payoutMethod !== "paypal" || !inferPayPalRecipientType(destination)) {
        return Response.json(
          {
            error:
              "Live rewards currently support only a PayPal email, phone number, or PayPal ID.",
          },
          { status: 400 },
        );
      }

      const job = await createLiveJob({
        ownerEmail: user.email,
        payoutMethod: "paypal",
        destination,
        runtime,
      });
      waitUntil(processLiveJob(job.id, { runtime }).catch(() => undefined));
      return Response.json({ job }, { status: 202 });
    }

    const job = await createJob(payoutMethod, destination);
    return Response.json({ job }, { status: 202 });
  } catch (error) {
    const message =
      getFiveMode(getRuntimeEnv()) === "live"
        ? "Live reward requests are temporarily unavailable."
        : error instanceof Error
          ? error.message
          : "The request could not be started.";
    return Response.json({ error: message }, { status: 503 });
  }
}
