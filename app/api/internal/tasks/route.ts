import { waitUntil } from "cloudflare:workers";
import { constantTimeSecretEqual } from "../../../../lib/crypto";
import { createFundedTask } from "../../../../lib/live-jobs";
import { createGiftCardFundedTask } from "../../../../lib/gift-card-tasks";
import { drainLiveJobs } from "../../../../lib/process-live-job";
import {
  validateFundedTaskSpec,
  validateGiftCardTaskSpec,
} from "../../../../lib/funded-tasks";
import {
  getPayPalAccessToken,
  getPayPalFundingCapture,
} from "../../../../lib/payouts/paypal";
import { createTremendousGiftCard } from "../../../../lib/rewards/tremendous";
import {
  getRuntimeEnv,
  requireActiveLiveEnv,
  requireLiveEnv,
  requireRuntimeSecret,
} from "../../../../lib/runtime-env";

async function authorized(request: Request) {
  try {
    const runtime = getRuntimeEnv();
    const expected = requireRuntimeSecret("TASK_ADMIN_SECRET", runtime);
    const header = request.headers.get("authorization") ?? "";
    const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
    return constantTimeSecretEqual(supplied, expected);
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  try {
    if (!(await authorized(request))) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }
    const runtime = requireActiveLiveEnv(getRuntimeEnv());
    const payload = (await request.json()) as unknown;
    if (runtime.REWARD_PROVIDER === "tremendous") {
      const spec = validateGiftCardTaskSpec(payload);
      const target = runtime.TREMENDOUS_API_BASE_URL
        ? { baseUrl: runtime.TREMENDOUS_API_BASE_URL }
        : { environment: runtime.TREMENDOUS_MODE };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      let reward;
      try {
        reward = await createTremendousGiftCard({
          apiKey: runtime.TREMENDOUS_API_KEY,
          campaignId: runtime.TREMENDOUS_CAMPAIGN_ID,
          fundingSourceId: runtime.TREMENDOUS_FUNDING_SOURCE_ID,
          externalId: spec.sponsorReference,
          recipientEmail: runtime.SUPPORT_EMAIL,
          signal: controller.signal,
          ...target,
        });
      } finally {
        clearTimeout(timer);
      }
      const task = await createGiftCardFundedTask(payload, reward, runtime);
      waitUntil(drainLiveJobs(1, { runtime }).catch(() => undefined));
      return Response.json({ task }, { status: 201 });
    }

    const payPalRuntime = requireLiveEnv(runtime);
    const spec = validateFundedTaskSpec(payload);
    const target = payPalRuntime.PAYPAL_API_BASE_URL
      ? { baseUrl: payPalRuntime.PAYPAL_API_BASE_URL }
      : { environment: payPalRuntime.PAYPAL_MODE };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let capture;
    try {
      const token = await getPayPalAccessToken({
        clientId: payPalRuntime.PAYPAL_CLIENT_ID,
        clientSecret: payPalRuntime.PAYPAL_CLIENT_SECRET,
        signal: controller.signal,
        ...target,
      });
      capture = await getPayPalFundingCapture({
        accessToken: token.accessToken,
        captureId: spec.fundingCaptureId,
        signal: controller.signal,
        ...target,
      });
    } finally {
      clearTimeout(timer);
    }
    const task = await createFundedTask(payload, capture, payPalRuntime);
    waitUntil(drainLiveJobs(1, { runtime: payPalRuntime }).catch(() => undefined));
    return Response.json({ task }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The funded task could not be created." },
      { status: 400 },
    );
  }
}
