import { waitUntil } from "cloudflare:workers";
import { constantTimeSecretEqual } from "../../../../lib/crypto";
import { createFundedTask } from "../../../../lib/live-jobs";
import { drainLiveJobs } from "../../../../lib/process-live-job";
import { validateFundedTaskSpec } from "../../../../lib/funded-tasks";
import {
  getPayPalAccessToken,
  getPayPalFundingCapture,
} from "../../../../lib/payouts/paypal";
import {
  getRuntimeEnv,
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
    const runtime = requireLiveEnv(getRuntimeEnv());
    const payload = (await request.json()) as unknown;
    const spec = validateFundedTaskSpec(payload);
    const target = runtime.PAYPAL_API_BASE_URL
      ? { baseUrl: runtime.PAYPAL_API_BASE_URL }
      : { environment: runtime.PAYPAL_MODE };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let capture;
    try {
      const token = await getPayPalAccessToken({
        clientId: runtime.PAYPAL_CLIENT_ID,
        clientSecret: runtime.PAYPAL_CLIENT_SECRET,
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
    const task = await createFundedTask(payload, capture, runtime);
    waitUntil(drainLiveJobs(1, { runtime }).catch(() => undefined));
    return Response.json({ task }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "The funded task could not be created." },
      { status: 400 },
    );
  }
}
