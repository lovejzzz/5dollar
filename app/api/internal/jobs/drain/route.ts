import { constantTimeSecretEqual } from "../../../../../lib/crypto";
import { drainLiveJobs } from "../../../../../lib/process-live-job";
import { drainNotifications } from "../../../../../lib/process-notification";
import { drainSponsorCaptures } from "../../../../../lib/process-sponsor-order";
import {
  getRuntimeEnv,
  requireLiveEnv,
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
    requireLiveEnv(runtime);
    const payload = (await request.json().catch(() => ({}))) as { limit?: number };
    const limit = payload.limit ?? 1;
    const [sponsorCaptures, jobs, notifications] = await Promise.all([
      drainSponsorCaptures(limit, { runtime }),
      drainLiveJobs(limit, { runtime }),
      drainNotifications(limit, { runtime }),
    ]);
    return Response.json({ sponsorCaptures, jobs, notifications });
  } catch {
    return Response.json(
      { error: "The processor could not run." },
      { status: 503 },
    );
  }
}
