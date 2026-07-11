import { constantTimeSecretEqual } from "../../../../../lib/crypto";
import { drainLiveJobs } from "../../../../../lib/process-live-job";
import { drainNotifications } from "../../../../../lib/process-notification";
import { drainSponsorCaptures } from "../../../../../lib/process-sponsor-order";
import {
  getRewardProvider,
  getRuntimeEnv,
  requireActiveLiveEnv,
  requireRuntimeSecret,
} from "../../../../../lib/runtime-env";

export async function POST(request: Request) {
  try {
    const runtime = getRuntimeEnv();
    const expected = requireRuntimeSecret("PROCESSOR_SECRET", runtime);
    const authorization = request.headers.get("authorization") ?? "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!(await constantTimeSecretEqual(supplied, expected))) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }
    const liveRuntime = requireActiveLiveEnv(runtime);
    const payload = (await request.json().catch(() => ({}))) as { limit?: number };
    const limit = payload.limit ?? 1;
    const [sponsorCaptures, jobs, notifications] = await Promise.all([
      getRewardProvider(liveRuntime) === "paypal"
        ? drainSponsorCaptures(limit, { runtime: liveRuntime })
        : Promise.resolve([]),
      drainLiveJobs(limit, { runtime: liveRuntime }),
      drainNotifications(limit, { runtime: liveRuntime }),
    ]);
    return Response.json({ sponsorCaptures, jobs, notifications });
  } catch {
    return Response.json(
      { error: "The processor could not run." },
      { status: 503 },
    );
  }
}
