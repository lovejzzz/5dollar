import { waitUntil } from "cloudflare:workers";
import { chatGPTSignInPath, getChatGPTUser } from "../../../../../chatgpt-auth";
import { drainLiveJobs } from "../../../../../../lib/process-live-job";
import {
  reconcileSponsorCancellation,
  sponsorTaskView,
} from "../../../../../../lib/process-sponsor-order";
import {
  SponsorTaskConflictError,
  SponsorTaskValidationError,
} from "../../../../../../lib/sponsor-tasks";
import { getRuntimeEnv, requireLiveEnv } from "../../../../../../lib/runtime-env";
import {
  sponsorJson,
  sponsorMutationBoundaryError,
} from "../../../../../../lib/sponsor-api";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const boundaryError = sponsorMutationBoundaryError(request);
  if (boundaryError) return boundaryError;

  let user: Awaited<ReturnType<typeof getChatGPTUser>> = null;
  try {
    user = await getChatGPTUser();
    const { id } = await context.params;
    if (!user) {
      return sponsorJson(
        {
          error: "Sign in is required to reconcile this sponsor checkout.",
          signInUrl: chatGPTSignInPath(
            `/sponsor/complete?draftId=${encodeURIComponent(id)}&cancel=true`,
          ),
        },
        { status: 401 },
      );
    }
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isFinite(declaredLength) || declaredLength > 1_024) {
      return sponsorJson({ error: "The cancellation request is too large." }, { status: 413 });
    }
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 1_024) {
      return sponsorJson({ error: "The cancellation request is too large." }, { status: 413 });
    }
    let payload: { paypalOrderId?: unknown };
    try {
      payload = raw ? (JSON.parse(raw) as typeof payload) : {};
    } catch {
      return sponsorJson(
        { error: "The cancellation request must be valid JSON." },
        { status: 400 },
      );
    }
    if (
      payload.paypalOrderId !== undefined &&
      (typeof payload.paypalOrderId !== "string" || !payload.paypalOrderId.trim())
    ) {
      return sponsorJson(
        { error: "The PayPal return included an invalid order reference." },
        { status: 400 },
      );
    }

    const runtime = requireLiveEnv(getRuntimeEnv());
    const result = await reconcileSponsorCancellation({
      draftId: id,
      ownerEmail: user.email,
      paypalOrderId:
        typeof payload.paypalOrderId === "string"
          ? payload.paypalOrderId
          : undefined,
      runtime,
    });
    if (!result.found) {
      return sponsorJson({ error: "Sponsor task not found." }, { status: 404 });
    }
    const draft = await sponsorTaskView(id, user.email, runtime);
    if (!draft) return sponsorJson({ error: "Sponsor task not found." }, { status: 404 });
    if (!result.canceled) {
      waitUntil(drainLiveJobs(1, { runtime }).catch(() => undefined));
    }
    return sponsorJson({ draft });
  } catch (error) {
    if (error instanceof SponsorTaskValidationError) {
      return sponsorJson({ error: error.message }, { status: 400 });
    }
    if (error instanceof SponsorTaskConflictError) {
      const draft = user
        ? await (async () => {
            try {
              const { id } = await context.params;
              return sponsorTaskView(id, user!.email, getRuntimeEnv());
            } catch {
              return null;
            }
          })()
        : null;
      return sponsorJson({ error: error.message, draft }, { status: 409 });
    }
    return sponsorJson(
      { error: "The checkout cancellation is temporarily unavailable." },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }
}
