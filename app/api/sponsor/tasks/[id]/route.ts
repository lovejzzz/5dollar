import { chatGPTSignInPath, getChatGPTUser } from "../../../../chatgpt-auth";
import { sponsorTaskView } from "../../../../../lib/process-sponsor-order";
import { getRuntimeEnv, requireLiveEnv } from "../../../../../lib/runtime-env";
import { sponsorJson } from "../../../../../lib/sponsor-api";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const user = await getChatGPTUser();
    if (!user) {
      return sponsorJson(
        {
          error: "Sign in is required to view this sponsor task.",
          signInUrl: chatGPTSignInPath(
            `/sponsor/complete?draftId=${encodeURIComponent(id)}`,
          ),
        },
        { status: 401 },
      );
    }
    const runtime = requireLiveEnv(getRuntimeEnv());
    const draft = await sponsorTaskView(id, user.email, runtime);
    if (!draft) return sponsorJson({ error: "Sponsor task not found." }, { status: 404 });
    return sponsorJson({ draft });
  } catch {
    return sponsorJson(
      { error: "The sponsor task status is temporarily unavailable." },
      { status: 503 },
    );
  }
}
