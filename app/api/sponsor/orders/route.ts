import { chatGPTSignInPath, getChatGPTUser } from "../../../chatgpt-auth";
import { PayPalApiError } from "../../../../lib/payouts/paypal";
import { prepareSponsorFundingOrder } from "../../../../lib/process-sponsor-order";
import {
  SponsorTaskConflictError,
  SponsorTaskRateLimitError,
  SponsorTaskValidationError,
} from "../../../../lib/sponsor-tasks";
import {
  getRuntimeEnv,
  isSponsorAllowed,
  requireLiveEnv,
} from "../../../../lib/runtime-env";
import {
  sponsorJson,
  sponsorMutationBoundaryError,
} from "../../../../lib/sponsor-api";

const MAX_BODY_BYTES = 32_000;

async function jsonBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength > MAX_BODY_BYTES) {
    throw new SponsorTaskValidationError("The sponsor task request is too large.");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new SponsorTaskValidationError("The sponsor task request is too large.");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new SponsorTaskValidationError("The sponsor task request must be valid JSON.");
  }
}

export async function POST(request: Request) {
  const boundaryError = sponsorMutationBoundaryError(request);
  if (boundaryError) return boundaryError;

  try {
    const user = await getChatGPTUser();
    if (!user) {
      return sponsorJson(
        {
          error: "Sign in is required before funding a task.",
          signInUrl: chatGPTSignInPath("/sponsor"),
        },
        { status: 401 },
      );
    }
    const runtime = requireLiveEnv(getRuntimeEnv());
    if (!isSponsorAllowed(user.email, runtime)) {
      return sponsorJson(
        { error: "Sponsor Checkout is currently limited to approved beta sponsors." },
        { status: 403 },
      );
    }
    const payload = await jsonBody(request);
    const result = await prepareSponsorFundingOrder({
      ownerEmail: user.email,
      payload,
      origin: runtime.SPONSOR_SITE_ORIGIN ?? "",
      runtime,
    });
    return sponsorJson(
      {
        draft: result.draft,
        orderId: result.orderId,
        approvalUrl: result.approvalUrl,
        duplicate: result.duplicate,
        alreadyFunded: result.alreadyFunded,
      },
      { status: result.duplicate ? 200 : 201 },
    );
  } catch (error) {
    if (error instanceof SponsorTaskValidationError) {
      return sponsorJson({ error: error.message }, { status: 400 });
    }
    if (error instanceof SponsorTaskConflictError) {
      return sponsorJson({ error: error.message }, { status: 409 });
    }
    if (error instanceof SponsorTaskRateLimitError) {
      return sponsorJson(
        { error: error.message },
        {
          status: 429,
          headers: { "Retry-After": String(error.retryAfterSeconds) },
        },
      );
    }
    if (error instanceof PayPalApiError) {
      const retryable =
        error.status === 408 || error.status === 429 || error.status >= 500;
      return sponsorJson(
        {
          error: retryable
            ? "PayPal checkout is temporarily unavailable. Retry this same task without changing it."
            : "PayPal could not prepare this funding order.",
        },
        {
          status: retryable ? 503 : 502,
          headers: retryable ? { "Retry-After": "5" } : undefined,
        },
      );
    }
    return sponsorJson(
      { error: "Sponsor checkout is not fully configured or temporarily unavailable." },
      { status: 503 },
    );
  }
}
