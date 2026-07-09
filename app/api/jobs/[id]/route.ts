import { getJob } from "../../../../lib/jobs";
import { getLiveJobForOwner } from "../../../../lib/live-jobs";
import { processLiveJob } from "../../../../lib/process-live-job";
import { getFiveMode, getRuntimeEnv } from "../../../../lib/runtime-env";
import { chatGPTSignInPath, getChatGPTUser } from "../../../chatgpt-auth";
import { waitUntil } from "cloudflare:workers";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return Response.json({ error: "Request not found." }, { status: 404 });
    }

    const runtime = getRuntimeEnv();
    if (getFiveMode(runtime) === "live") {
      const user = await getChatGPTUser();
      if (!user) {
        return Response.json(
          {
            error: "Sign in is required to view this reward request.",
            signInUrl: chatGPTSignInPath("/"),
          },
          { status: 401 },
        );
      }
      const job = await getLiveJobForOwner(id, user.email, runtime);
      if (!job) return Response.json({ error: "Request not found." }, { status: 404 });
      waitUntil(processLiveJob(id, { runtime }).catch(() => undefined));
      return Response.json({ job });
    }

    const job = await getJob(id);
    if (!job) return Response.json({ error: "Request not found." }, { status: 404 });
    return Response.json({ job });
  } catch (error) {
    const message =
      getFiveMode(getRuntimeEnv()) === "live"
        ? "This live reward status is temporarily unavailable."
        : error instanceof Error
          ? error.message
          : "The request could not be loaded.";
    return Response.json({ error: message }, { status: 503 });
  }
}
