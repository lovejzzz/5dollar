import {
  capturePayPalFundingOrder,
  createPayPalFundingOrder,
  getPayPalAccessToken,
  getPayPalFundingOrder,
  PayPalApiError,
  type PayPalFundingCapture,
  type PayPalFundingOrderObservation,
} from "./payouts/paypal";
import {
  SPONSOR_BETA_POLICY,
  SponsorTaskConflictError,
  cancelSponsorFundingOrder as markSponsorFundingOrderCanceled,
  claimNextSponsorCapture,
  claimSponsorCapture,
  createSponsorDraft,
  failSponsorOrderCheck,
  failSponsorCapture,
  finalizeSponsorCapture,
  getSponsorTaskViewForOwner,
  getSponsorDraftForOwner,
  markSponsorOrderCapturing,
  recordSponsorFundingOrder,
  recordSponsorOrderAwaitingApproval,
  recordSponsorCapturePending,
  type SponsorCaptureClaim,
} from "./sponsor-tasks";
import {
  getRuntimeEnv,
  requireLiveEnv,
  type LiveRuntimeEnv,
  type RuntimeEnv,
} from "./runtime-env";

type SponsorFundingDependencies = {
  getAccessToken?: typeof getPayPalAccessToken;
  createOrder?: typeof createPayPalFundingOrder;
  captureOrder?: typeof capturePayPalFundingOrder;
  getOrder?: typeof getPayPalFundingOrder;
};

const FUNDING_ORDER_CREATE_RETRY_WINDOW_MS = 5 * 60 * 60_000;

export type SponsorFundingResult =
  | { processed: false; reason: "no_work" | "busy" | "not_found" }
  | {
      processed: true;
      draftId: string;
      stage:
        | "order_created"
        | "capture_pending"
        | "capture_retry"
        | "funded"
        | "needs_review";
    };

function providerTarget(runtime: LiveRuntimeEnv) {
  return runtime.PAYPAL_API_BASE_URL
    ? { baseUrl: runtime.PAYPAL_API_BASE_URL }
    : { environment: runtime.PAYPAL_MODE };
}

function safeOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The sponsor checkout origin is invalid.");
  }
  const loopback =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password) {
    throw new Error("Sponsor checkout requires a safe HTTPS origin.");
  }
  return url.origin;
}

function classifyFundingError(error: unknown) {
  if (error instanceof SponsorTaskConflictError) {
    const retryable = /reconciliation|current capture lease|lost its current/i.test(
      error.message,
    );
    return {
      code: retryable ? "capture_reconciliation" : "capture_contract_conflict",
      message: error.message,
      retryable,
    };
  }
  if (error instanceof PayPalApiError) {
    const malformedSuccess =
      error.providerCode === "MALFORMED_RESPONSE" &&
      error.status >= 200 &&
      error.status < 300;
    return {
      code: `paypal_${error.operation}_${error.providerCode ?? error.status}`,
      message: error.message,
      retryable:
        malformedSuccess ||
        error.status === 408 ||
        error.status === 429 ||
        error.status >= 500,
    };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      code: "provider_timeout",
      message: "PayPal confirmation timed out.",
      retryable: true,
    };
  }
  if (error instanceof TypeError) {
    return {
      code: "provider_network_error",
      message: "The PayPal network request failed.",
      retryable: true,
    };
  }
  return {
    code: "capture_error",
    message:
      error instanceof Error
        ? error.message
        : "The sponsor capture could not be reconciled.",
    // Provider completion and D1 activation are both idempotent. Unknown local
    // failures must be retried so one transient persistence error cannot strand
    // a sponsor whose payment may already be captured.
    retryable: true,
  };
}

function completedCapture(
  observation: PayPalFundingOrderObservation,
): PayPalFundingCapture | null {
  if (
    observation.captureStatus !== "COMPLETED" ||
    !observation.captureId ||
    observation.netCents === null ||
    !observation.capturedAt
  ) {
    return null;
  }
  return {
    provider: "paypal",
    captureId: observation.captureId,
    status: observation.captureStatus,
    currency: observation.currency,
    grossCents: observation.grossCents,
    netCents: observation.netCents,
    customId: observation.customId,
    capturedAt: observation.capturedAt,
  };
}

function isTerminalUnfundedStatus(value: string | null) {
  return [
    "DECLINED",
    "FAILED",
    "VOIDED",
    "REFUNDED",
    "PARTIALLY_REFUNDED",
  ].includes(value ?? "");
}

async function accessToken(
  runtime: LiveRuntimeEnv,
  dependencies: SponsorFundingDependencies,
  signal: AbortSignal,
) {
  const getAccessToken = dependencies.getAccessToken ?? getPayPalAccessToken;
  return getAccessToken({
    clientId: runtime.PAYPAL_CLIENT_ID,
    clientSecret: runtime.PAYPAL_CLIENT_SECRET,
    signal,
    ...providerTarget(runtime),
  });
}

export async function prepareSponsorFundingOrder(input: {
  ownerEmail: string;
  payload: unknown;
  origin: string;
  runtime?: RuntimeEnv;
  dependencies?: SponsorFundingDependencies;
}) {
  const runtime = requireLiveEnv(input.runtime ?? getRuntimeEnv());
  const origin = safeOrigin(input.origin);
  const creation = await createSponsorDraft({
    ownerEmail: input.ownerEmail,
    payload: input.payload,
    runtime,
  });

  if (creation.draft.status === "funded") {
    return {
      ...creation,
      orderId: creation.draft.paypalOrderId,
      approvalUrl: `${origin}/sponsor/complete?draftId=${encodeURIComponent(creation.draft.id)}`,
      alreadyFunded: true,
    };
  }
  if (creation.draft.status === "needs_review") {
    throw new SponsorTaskConflictError(
      "This sponsor payment needs review and must not be submitted again.",
    );
  }
  if (creation.draft.status === "canceled") {
    throw new SponsorTaskConflictError(
      "This sponsor checkout was canceled. Start a new draft instead of reusing it.",
    );
  }
  if (
    creation.duplicate &&
    !creation.draft.paypalOrderId &&
    Date.now() - Date.parse(creation.draft.createdAt) >=
      FUNDING_ORDER_CREATE_RETRY_WINDOW_MS
  ) {
    throw new SponsorTaskConflictError(
      "The original PayPal order response is too old to retry safely. Operator reconciliation is required before any new order.",
    );
  }

  const returnUrl = new URL("/sponsor/complete", origin);
  returnUrl.searchParams.set("draftId", creation.draft.id);
  const cancelUrl = new URL("/sponsor/complete", origin);
  cancelUrl.searchParams.set("draftId", creation.draft.id);
  cancelUrl.searchParams.set("cancel", "true");

  const dependencies = input.dependencies ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const token = await accessToken(runtime, dependencies, controller.signal);
    if (creation.draft.paypalOrderId) {
      const getOrder = dependencies.getOrder ?? getPayPalFundingOrder;
      const observation = await getOrder({
        accessToken: token.accessToken,
        orderId: creation.draft.paypalOrderId,
        stableRequestKey: creation.draft.id,
        amountCents: SPONSOR_BETA_POLICY.grossCents,
        customId: creation.draft.sponsorReference,
        signal: controller.signal,
        ...providerTarget(runtime),
      });
      const needsLocalCompletion =
        Boolean(observation.captureId) ||
        ["APPROVED", "COMPLETED"].includes(observation.orderStatus);
      const approvalUrl = needsLocalCompletion
        ? `${returnUrl.toString()}&token=${encodeURIComponent(creation.draft.paypalOrderId)}`
        : observation.approvalUrl;
      if (!approvalUrl) {
        throw new SponsorTaskConflictError(
          "The stored PayPal order cannot be approved again. Create a new task draft only after operator review.",
        );
      }
      return {
        ...creation,
        orderId: creation.draft.paypalOrderId,
        approvalUrl,
        alreadyFunded: false,
      };
    }

    const createOrder = dependencies.createOrder ?? createPayPalFundingOrder;
    const order = await createOrder({
      accessToken: token.accessToken,
      stableRequestKey: creation.draft.id,
      amountCents: SPONSOR_BETA_POLICY.grossCents,
      customId: creation.draft.sponsorReference,
      returnUrl: returnUrl.toString(),
      cancelUrl: cancelUrl.toString(),
      signal: controller.signal,
      ...providerTarget(runtime),
    });
    const boundDraft = await recordSponsorFundingOrder({
      draftId: creation.draft.id,
      ownerEmail: input.ownerEmail,
      paypalOrderId: order.orderId,
      runtime,
    });
    if (!boundDraft) {
      throw new SponsorTaskConflictError(
        "The PayPal order was created but could not be bound to its sponsor draft.",
      );
    }
    return {
      ...creation,
      draft: boundDraft,
      orderId: order.orderId,
      approvalUrl: order.approvalUrl,
      alreadyFunded: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function processClaim(
  claim: Extract<SponsorCaptureClaim, { kind: "claimed" }>,
  runtime: LiveRuntimeEnv,
  dependencies: SponsorFundingDependencies,
): Promise<SponsorFundingResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let activeDraft = claim.draft;
  try {
    const token = await accessToken(runtime, dependencies, controller.signal);
    const contract = {
      accessToken: token.accessToken,
      orderId: claim.draft.paypal_order_id!,
      stableRequestKey: claim.draft.id,
      amountCents: claim.draft.gross_cents,
      customId: claim.draft.sponsor_reference,
      signal: controller.signal,
      ...providerTarget(runtime),
    };
    let observation: PayPalFundingOrderObservation;
    if (claim.draft.status === "order_created") {
      observation = await (dependencies.getOrder ?? getPayPalFundingOrder)(contract);
      if (
        !observation.captureId &&
        ["CREATED", "PAYER_ACTION_REQUIRED", "SAVED"].includes(
          observation.orderStatus,
        )
      ) {
        await recordSponsorOrderAwaitingApproval({
          draft: claim.draft,
          leaseToken: claim.leaseToken,
          runtime,
        });
        return {
          processed: true,
          draftId: claim.draft.id,
          stage: "order_created",
        };
      }
      const promoted = await markSponsorOrderCapturing({
        draft: claim.draft,
        leaseToken: claim.leaseToken,
        runtime,
      });
      if (!promoted) {
        throw new SponsorTaskConflictError(
          "The approved PayPal order lost its current capture lease.",
        );
      }
      activeDraft = promoted;
      if (!observation.captureId && observation.orderStatus === "APPROVED") {
        observation = await (dependencies.captureOrder ?? capturePayPalFundingOrder)(
          contract,
        );
      }
    } else {
      observation = claim.draft.paypal_capture_id
        ? await (dependencies.getOrder ?? getPayPalFundingOrder)(contract)
        : await (dependencies.captureOrder ?? capturePayPalFundingOrder)(contract);
    }
    const capture = completedCapture(observation);
    if (capture) {
      const funded = await finalizeSponsorCapture({
        draft: activeDraft,
        leaseToken: claim.leaseToken,
        capture,
        runtime,
      });
      return { processed: true, draftId: funded.id, stage: "funded" };
    }

    const effectiveProviderStatus =
      observation.captureStatus ?? observation.orderStatus;
    if (isTerminalUnfundedStatus(effectiveProviderStatus)) {
      await failSponsorCapture({
        draft: activeDraft,
        leaseToken: claim.leaseToken,
        code: `paypal_capture_${effectiveProviderStatus.toLowerCase()}`,
        message:
          "PayPal reported a terminal capture status; the task was not activated.",
        retryable: false,
        captureId: observation.captureId,
        runtime,
      });
      return {
        processed: true,
        draftId: claim.draft.id,
        stage: "needs_review",
      };
    }

    await recordSponsorCapturePending({
      draft: activeDraft,
      leaseToken: claim.leaseToken,
      captureId: observation.captureId,
      runtime,
    });
    return {
      processed: true,
      draftId: claim.draft.id,
      stage: "capture_pending",
    };
  } catch (error) {
    const classified = classifyFundingError(error);
    const retryable = classified.retryable && claim.draft.attempts < 6;
    if (activeDraft.status === "order_created") {
      await failSponsorOrderCheck({
        draft: activeDraft,
        leaseToken: claim.leaseToken,
        ...classified,
        retryable,
        runtime,
      });
    } else {
      await failSponsorCapture({
        draft: activeDraft,
        leaseToken: claim.leaseToken,
        ...classified,
        retryable,
        runtime,
      });
    }
    return {
      processed: true,
      draftId: claim.draft.id,
      stage: retryable
        ? activeDraft.status === "order_created"
          ? "order_created"
          : "capture_retry"
        : "needs_review",
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function processSponsorCapture(input: {
  draftId: string;
  ownerEmail: string;
  paypalOrderId: string;
  runtime?: RuntimeEnv;
  dependencies?: SponsorFundingDependencies;
}): Promise<SponsorFundingResult> {
  const runtime = requireLiveEnv(input.runtime ?? getRuntimeEnv());
  const claim = await claimSponsorCapture(
    input.draftId,
    input.ownerEmail,
    input.paypalOrderId,
    runtime,
  );
  if (!claim) return { processed: false, reason: "not_found" };
  if (claim.kind === "busy") return { processed: false, reason: "busy" };
  if (claim.kind === "already_funded") {
    return {
      processed: true,
      draftId: claim.draft.id,
      stage: "funded",
    };
  }
  return processClaim(claim, runtime, input.dependencies ?? {});
}

export async function reconcileSponsorCancellation(input: {
  draftId: string;
  ownerEmail: string;
  paypalOrderId?: string;
  runtime?: RuntimeEnv;
  dependencies?: SponsorFundingDependencies;
}) {
  const runtime = requireLiveEnv(input.runtime ?? getRuntimeEnv());
  const draft = await getSponsorDraftForOwner(
    input.draftId,
    input.ownerEmail,
    runtime,
  );
  if (!draft) return { found: false as const };
  if (
    !draft.paypalOrderId ||
    (input.paypalOrderId && draft.paypalOrderId !== input.paypalOrderId)
  ) {
    throw new SponsorTaskConflictError(
      "The PayPal return does not match this sponsor draft.",
    );
  }
  if (draft.status === "funded" || draft.status === "canceled") {
    return { found: true as const, draft, canceled: draft.status === "canceled" };
  }

  const dependencies = input.dependencies ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const token = await accessToken(runtime, dependencies, controller.signal);
    const observation = await (dependencies.getOrder ?? getPayPalFundingOrder)({
      accessToken: token.accessToken,
      orderId: draft.paypalOrderId,
      stableRequestKey: draft.id,
      amountCents: draft.charge.grossCents,
      customId: draft.sponsorReference,
      signal: controller.signal,
      ...providerTarget(runtime),
    });
    if (
      observation.captureId ||
      ["APPROVED", "COMPLETED"].includes(observation.orderStatus)
    ) {
      const funding = await processSponsorCapture({
        draftId: draft.id,
        ownerEmail: input.ownerEmail,
        paypalOrderId: draft.paypalOrderId,
        runtime,
        dependencies,
      });
      return { found: true as const, canceled: false, funding };
    }
    if (
      !["CREATED", "PAYER_ACTION_REQUIRED", "SAVED", "VOIDED"].includes(
        observation.orderStatus,
      )
    ) {
      throw new SponsorTaskConflictError(
        "PayPal returned an order state that must be reviewed before cancellation.",
      );
    }
    const canceledDraft = await markSponsorFundingOrderCanceled({
      draftId: draft.id,
      ownerEmail: input.ownerEmail,
      paypalOrderId: draft.paypalOrderId,
      runtime,
    });
    return {
      found: true as const,
      canceled: canceledDraft?.status === "canceled",
      draft: canceledDraft,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function processNextSponsorCapture(
  options: {
    runtime?: RuntimeEnv;
    dependencies?: SponsorFundingDependencies;
  } = {},
): Promise<SponsorFundingResult> {
  const runtime = requireLiveEnv(options.runtime ?? getRuntimeEnv());
  const claim = await claimNextSponsorCapture(runtime);
  if (!claim) return { processed: false, reason: "no_work" };
  return processClaim(claim, runtime, options.dependencies ?? {});
}

export async function drainSponsorCaptures(
  limit = 1,
  options: {
    runtime?: RuntimeEnv;
    dependencies?: SponsorFundingDependencies;
  } = {},
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) {
    throw new Error("Sponsor capture drain limit must be an integer from 1 to 5.");
  }
  const results: SponsorFundingResult[] = [];
  for (let index = 0; index < limit; index += 1) {
    const result = await processNextSponsorCapture(options);
    results.push(result);
    if (!result.processed) break;
  }
  return results;
}

export async function sponsorTaskView(
  draftId: string,
  ownerEmail: string,
  runtime: RuntimeEnv = getRuntimeEnv(),
) {
  const view = await getSponsorTaskViewForOwner(draftId, ownerEmail, runtime);
  if (!view) return null;
  return {
    ...view.draft,
    workStatus: view.workStatus,
    ...(view.result === undefined ? {} : { result: view.result }),
    receipt: view.receipt,
  };
}
