import { liveSystemStats } from "../../../lib/live-jobs";
import {
  getFiveMode,
  getRewardProvider,
  getRuntimeEnv,
  requireActiveLiveEnv,
} from "../../../lib/runtime-env";

export async function GET() {
  const runtime = getRuntimeEnv();
  const mode = getFiveMode(runtime);
  if (mode === "sandbox") {
    return Response.json({
      mode,
      rewardProvider: "tremendous",
      liveReady: false,
      availableFundedTasks: 0,
    });
  }

  try {
    requireActiveLiveEnv(runtime);
    const rewardProvider = getRewardProvider(runtime);
    const stats = await liveSystemStats(runtime);
    return Response.json({
      mode,
      rewardProvider,
      liveReady: true,
      availableFundedTasks: stats.availableFundedTasks,
    });
  } catch {
    return Response.json(
      {
        mode,
        liveReady: false,
        availableFundedTasks: 0,
        error: "Live mode is not fully configured.",
      },
      { status: 503 },
    );
  }
}
