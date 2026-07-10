import {
  OpenAIAdapterError,
  runOpenAISponsorTask,
  type JsonValue,
} from "./earnings/openai";
import {
  applyPayPalPayoutObservation,
  claimLiveJob,
  decryptLiveJobDestination,
  getOrCreatePayout,
  markEarningAccepted,
  markLiveJobRetry,
  markPayoutPending,
  taskForLiveJob,
  type FundedTaskRow,
  type LiveJobRow,
} from "./live-jobs";
import { submissionPassesAcceptance } from "./funded-tasks";
import {
  createPayPalFiveDollarPayout,
  createPayPalPayoutIdempotency,
  getPayPalAccessToken,
  getPayPalFundingCapture,
  getPayPalPayoutBatch,
  inferPayPalRecipientType,
  PayPalApiError,
} from "./payouts/paypal";
import {
  getRuntimeEnv,
  requireLiveEnv,
  type LiveRuntimeEnv,
  type RuntimeEnv,
} from "./runtime-env";

type ProcessorDependencies = {
  runTask?: typeof runOpenAISponsorTask;
  getAccessToken?: typeof getPayPalAccessToken;
  getFundingCapture?: typeof getPayPalFundingCapture;
  createPayout?: typeof createPayPalFiveDollarPayout;
  getPayoutBatch?: typeof getPayPalPayoutBatch;
};

export type ProcessLiveJobResult =
  | { processed: false; reason: "no_work" }
  | {
      processed: true;
      jobId: string;
      stage:
        | "earned"
        | "needs_review"
        | "payout_pending"
        | "needs_action"
        | "paid"
        | "reversed"
        | "retry_wait"
        | "failed"
        | "state_changed";
    };

function parseTaskInput(value: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ProcessorError("invalid_task_json", "The funded task input is not valid JSON.", false);
  }
  return parsed as JsonValue;
}

class ProcessorError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "ProcessorError";
    this.code = code;
    this.retryable = retryable;
  }
}

function providerTarget(runtime: LiveRuntimeEnv) {
  return runtime.PAYPAL_API_BASE_URL
    ? { baseUrl: runtime.PAYPAL_API_BASE_URL }
    : { environment: runtime.PAYPAL_MODE };
}

function classifyError(error: unknown) {
  if (error instanceof ProcessorError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof OpenAIAdapterError) {
    const retryable =
      ["request_aborted", "request_timeout", "request_failed"].includes(error.code) ||
      (error.code === "api_error" && (error.status === 429 || (error.status ?? 0) >= 500));
    return { code: `openai_${error.code}`, message: error.message, retryable };
  }
  if (error instanceof PayPalApiError) {
    const malformedSuccess =
      error.providerCode === "MALFORMED_RESPONSE" &&
      error.status >= 200 &&
      error.status < 300;
    const ambiguousCreate =
      error.operation === "create-payout" &&
      ((error.status >= 200 && error.status < 300) ||
        error.providerCode === "SENDER_BATCH_ID_DUPLICATE");
    return {
      code: `paypal_${error.operation}_${error.providerCode ?? error.status}`,
      message: error.message,
      retryable:
        malformedSuccess ||
        ambiguousCreate ||
        error.status === 408 ||
        error.status === 429 ||
        error.status >= 500,
    };
  }
  if (error instanceof TypeError) {
    return { code: "network_error", message: "A provider network request failed.", retryable: true };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "provider_timeout", message: "A provider request timed out.", retryable: true };
  }
  return {
    code: "processor_error",
    message: error instanceof Error ? error.message : "The live processor failed.",
    retryable: false,
  };
}

async function requireSettledFunding(
  job: LiveJobRow,
  runtime: LiveRuntimeEnv,
  dependencies: ProcessorDependencies,
): Promise<FundedTaskRow> {
  const task = await taskForLiveJob(job, runtime);
  if (!task) {
    throw new ProcessorError(
      "funding_ledger_missing",
      "The task no longer has a settled funding receipt.",
      false,
    );
  }

  const target = providerTarget(runtime);
  const getAccessToken = dependencies.getAccessToken ?? getPayPalAccessToken;
  const getFundingCapture =
    dependencies.getFundingCapture ?? getPayPalFundingCapture;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const token = await getAccessToken({
      clientId: runtime.PAYPAL_CLIENT_ID,
      clientSecret: runtime.PAYPAL_CLIENT_SECRET,
      signal: controller.signal,
      ...target,
    });
    const capture = await getFundingCapture({
      accessToken: token.accessToken,
      captureId: task.funding_capture_id,
      signal: controller.signal,
      ...target,
    });
    if (
      capture.status !== "COMPLETED" ||
      capture.currency !== "USD" ||
      capture.netCents < task.reward_cents ||
      capture.customId !== task.sponsor_reference
    ) {
      throw new ProcessorError(
        "funding_no_longer_settled",
        "The sponsor funding capture is no longer settled for this task.",
        false,
      );
    }
  } finally {
    clearTimeout(timer);
  }
  return task;
}

async function runEarningStep(
  job: LiveJobRow,
  runtime: LiveRuntimeEnv,
  dependencies: ProcessorDependencies,
) {
  const task = await requireSettledFunding(job, runtime, dependencies);
  if (task.automation_allowed !== 1 || task.status !== "leased") {
    throw new ProcessorError(
      "task_not_eligible",
      "The funded task is not eligible for automated completion.",
      false,
    );
  }

  const runTask = dependencies.runTask ?? runOpenAISponsorTask;
  const result = await runTask(
    {
      id: task.id,
      title: task.title,
      instructions: task.instructions,
      inputJson: parseTaskInput(task.input_json),
      automationAllowed: true,
    },
    {
      apiKey: runtime.OPENAI_API_KEY,
      model: runtime.OPENAI_MODEL,
      endpoint: runtime.OPENAI_API_BASE_URL,
      maxOutputTokens: 1_200,
      timeoutMs: 22_000,
    },
  );

  const accepted = await markEarningAccepted({
    job,
    task,
    submission: result.submission,
    answerLength: result.submission.answer.length,
    acceptancePassed: submissionPassesAcceptance({
      acceptanceJson: task.acceptance_json,
      minAnswerChars: task.min_answer_chars,
      submission: result.submission,
    }),
    responseId: result.responseId,
    model: result.model,
    runtime,
  });
  return accepted ? "earned" : "needs_review";
}

async function runPayoutStep(
  job: LiveJobRow,
  runtime: LiveRuntimeEnv,
  dependencies: ProcessorDependencies,
) {
  if (job.earned_cents < 500) {
    throw new ProcessorError(
      "unearned_payout_blocked",
      "A payout cannot start before at least $5 of task revenue is accepted.",
      false,
    );
  }

  const task = await requireSettledFunding(job, runtime, dependencies);
  if (task.status !== "accepted") {
    throw new ProcessorError(
      "task_not_accepted",
      "The sponsor task is not accepted for payout.",
      false,
    );
  }

  const ids = await createPayPalPayoutIdempotency(job.id);
  const ledger = await getOrCreatePayout(job.id, ids, runtime);
  if (
    !ledger.provider_batch_id &&
    Date.now() - ledger.created_at >= 29 * 24 * 60 * 60_000
  ) {
    throw new ProcessorError(
      "payout_idempotency_window_expired",
      "The original payout submission window expired; support must reconcile PayPal before any new request.",
      false,
    );
  }
  const target = providerTarget(runtime);
  const getAccessToken = dependencies.getAccessToken ?? getPayPalAccessToken;
  const createPayout = dependencies.createPayout ?? createPayPalFiveDollarPayout;
  const getPayoutBatch = dependencies.getPayoutBatch ?? getPayPalPayoutBatch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const token = await getAccessToken({
      clientId: runtime.PAYPAL_CLIENT_ID,
      clientSecret: runtime.PAYPAL_CLIENT_SECRET,
      signal: controller.signal,
      ...target,
    });

    if (ledger.provider_batch_id) {
      const observation = await getPayoutBatch({
        accessToken: token.accessToken,
        payoutBatchId: ledger.provider_batch_id,
        senderItemId: ledger.sender_item_id,
        signal: controller.signal,
        ...target,
      });
      const status = await applyPayPalPayoutObservation({ job, observation, runtime });
      if (
        status === "paid" ||
        status === "reversed" ||
        status === "needs_action" ||
        status === "failed" ||
        status === "payout_pending"
      ) {
        return status;
      }
      return "state_changed" as const;
    }

    const destination = await decryptLiveJobDestination(job, runtime);
    const recipientType = inferPayPalRecipientType(destination);
    if (!recipientType) {
      throw new ProcessorError(
        "invalid_paypal_destination",
        "The saved destination is not a PayPal email, phone number, or PayPal ID.",
        false,
      );
    }

    const result = await createPayout({
      accessToken: token.accessToken,
      stableRequestKey: job.id,
      recipient: { type: recipientType, value: destination },
      signal: controller.signal,
      ...target,
    });
    const recorded = await markPayoutPending({
      job,
      payoutBatchId: result.payoutBatchId,
      batchStatus: result.batchStatus,
      senderBatchId: result.senderBatchId,
      senderItemId: result.senderItemId,
      runtime,
    });
    return recorded ? "payout_pending" as const : "state_changed" as const;
  } finally {
    clearTimeout(timer);
  }
}

export async function processLiveJob(
  requestedJobId?: string,
  options: {
    runtime?: RuntimeEnv;
    dependencies?: ProcessorDependencies;
  } = {},
): Promise<ProcessLiveJobResult> {
  const runtime = requireLiveEnv(options.runtime ?? getRuntimeEnv());
  const job = await claimLiveJob(requestedJobId, runtime);
  if (!job) return { processed: false, reason: "no_work" };

  try {
    const stage =
      job.earned_cents >= 500
        ? await runPayoutStep(job, runtime, options.dependencies ?? {})
        : await runEarningStep(job, runtime, options.dependencies ?? {});
    return { processed: true, jobId: job.id, stage };
  } catch (error) {
    const classified = classifyError(error);
    const transitioned = await markLiveJobRetry({ job, ...classified, runtime });
    return {
      processed: true,
      jobId: job.id,
      stage: transitioned
        ? classified.retryable && job.attempts < 4
          ? "retry_wait"
          : job.earned_cents >= 500
            ? "needs_action"
            : "failed"
        : "state_changed",
    };
  }
}

export async function drainLiveJobs(
  limit = 1,
  options: { runtime?: RuntimeEnv; dependencies?: ProcessorDependencies } = {},
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) {
    throw new Error("Processor drain limit must be an integer from 1 to 5.");
  }
  const results: ProcessLiveJobResult[] = [];
  for (let index = 0; index < limit; index += 1) {
    const result = await processLiveJob(undefined, options);
    results.push(result);
    if (!result.processed) break;
  }
  return results;
}
