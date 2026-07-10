import { encodeBase64Url } from "./crypto";
import { validateFundedTaskSpec } from "./funded-tasks";
import {
  createFundedTask,
  ensureLiveDatabase,
  FundingCaptureTerminalError,
} from "./live-jobs";
import type { PayPalFundingCapture } from "./payouts/paypal";
import { getRuntimeEnv, type RuntimeEnv } from "./runtime-env";

export const SPONSOR_BETA_POLICY = Object.freeze({
  currency: "USD" as const,
  grossCents: 800 as const,
  minimumNetCents: 600 as const,
  payoutCents: 500 as const,
});

export const SPONSOR_ATTESTATION_VERSION = "2026-07-09.v1";
const CAPTURE_LEASE_MS = 60_000;
const PENDING_RECHECK_MS = 30_000;
const SPONSOR_RATE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_DRAFTS_PER_WINDOW = 10;
const MAX_ACTIVE_DRAFTS_PER_WINDOW = 3;
export const SPONSOR_ORDER_REQUEST_THROTTLE = Object.freeze({
  windowMs: 10 * 60 * 1_000,
  maxRequests: 10,
});
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYPAL_ORDER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,79}$/;
const PAYPAL_CAPTURE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,79}$/;

export type SponsorTaskOrderStatus =
  | "draft"
  | "order_created"
  | "capture_pending"
  | "capture_retry"
  | "funded"
  | "canceled"
  | "needs_review";

export type SponsorDraftPayload = {
  clientRequestId: string;
  taskType?: "dataset_summary";
  title: string;
  instructions: string;
  input: unknown;
  acceptance: {
    requiredEvidenceIds: string[];
    minEvidenceCount?: number;
  };
  minAnswerChars?: number;
  automationAllowed: true;
  autoAccept: true;
  rightsAttested: true;
  noSensitiveData: true;
};

export type SponsorTaskOrderRow = {
  id: string;
  owner_email: string;
  client_request_id: string;
  request_hash: string;
  task_type: "dataset_summary";
  title: string;
  instructions: string;
  input_json: string;
  acceptance_json: string;
  min_answer_chars: number;
  automation_allowed: 1;
  auto_accept: 1;
  rights_attested: 1;
  no_sensitive_data: 1;
  attestation_version: string;
  attested_at: number;
  sponsor_reference: string;
  currency: "USD";
  gross_cents: 800;
  minimum_net_cents: number;
  payout_cents: 500;
  paypal_order_id: string | null;
  paypal_capture_id: string | null;
  funded_task_id: string | null;
  status: SponsorTaskOrderStatus;
  attempts: number;
  next_attempt_at: number | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

export type PublicSponsorDraft = {
  id: string;
  clientRequestId: string;
  sponsorReference: string;
  status: SponsorTaskOrderStatus;
  taskType: "dataset_summary";
  title: string;
  instructions: string;
  input: unknown;
  acceptance: {
    requiredEvidenceIds: string[];
    minEvidenceCount: number;
  };
  minAnswerChars: number;
  rightsAttested: true;
  noSensitiveData: true;
  attestationVersion: string;
  attestedAt: string;
  charge: {
    currency: "USD";
    grossCents: 800;
    minimumNetCents: number;
    payoutCents: 500;
  };
  paypalOrderId: string | null;
  fundedTaskId: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type SponsorPayPalOrderSpec = {
  invoiceId: string;
  customId: string;
  description: string;
  currencyCode: "USD";
  amount: "8.00";
};

export type SponsorDraftCreation = {
  draft: PublicSponsorDraft;
  paypalOrderSpec: SponsorPayPalOrderSpec;
  duplicate: boolean;
};

export type SponsorCaptureClaim =
  | {
      kind: "claimed";
      draft: SponsorTaskOrderRow;
      leaseToken: string;
    }
  | {
      kind: "already_funded";
      draft: SponsorTaskOrderRow;
      leaseToken: null;
    }
  | {
      kind: "busy";
      draft: SponsorTaskOrderRow;
      leaseToken: null;
    };

export type SponsorTaskWorkStatus =
  | "waiting"
  | "working"
  | "result_ready"
  | "needs_review";

export type SponsorTaskView = {
  draft: PublicSponsorDraft;
  workStatus: SponsorTaskWorkStatus;
  result?: unknown;
  receipt: {
    provider: "paypal";
    captureId: string;
    currency: "USD";
    grossCents: number;
    netCents: number;
    capturedAt: string;
  } | null;
};

type ValidatedSponsorDraft = {
  clientRequestId: string;
  taskType: "dataset_summary";
  title: string;
  instructions: string;
  inputJson: string;
  acceptanceJson: string;
  minAnswerChars: number;
};

export class SponsorTaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SponsorTaskValidationError";
  }
}

export class SponsorTaskConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SponsorTaskConflictError";
  }
}

export class SponsorTaskRateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message?: string) {
    super(
      message ??
        "This sponsor has reached the beta draft limit. Retry after the current 24-hour window advances.",
    );
    this.name = "SponsorTaskRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function database(runtime: RuntimeEnv) {
  const binding = runtime.DB as D1Database | undefined;
  if (!binding) throw new Error("The sponsor task database is unavailable.");
  return binding;
}

function normalizeOwnerEmail(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new SponsorTaskValidationError(
      "A verified sponsor email is required to create a task.",
    );
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasLuhnChecksum(value: string) {
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function sensitiveDataLabel(value: unknown): string | null {
  const sensitiveKey =
    /^(?:e-?mail|ssn|social[_ -]?security|card(?:[_ -]?number)?|cvv|cvc|password|passphrase|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|private[_ -]?key|credential|authorization|name|(?:first|last|full|legal)[_ -]?name|phone|mobile|telephone|address|street[_ -]?address|postal[_ -]?address|zip(?:[_ -]?code)?|postal[_ -]?code|date[_ -]?of[_ -]?birth|birth[_ -]?date|dob|patient|medical[_ -]?(?:record|history|condition)|health[_ -]?(?:record|condition)|diagnosis|medication|insurance[_ -]?(?:id|number)|bank[_ -]?(?:account|number)|account[_ -]?(?:number|id)|routing[_ -]?(?:number)?|iban|swift|bic|passport[_ -]?(?:number)?|driver(?:s)?[_ -]?license|national[_ -]?id|ip[_ -]?address|device[_ -]?id)$/i;
  const email = /\b[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+\b/;
  const ssn = /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/;
  const phone = /(?:^|[^\d])(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]?[2-9]\d{2}[ .-]?\d{4}(?:[^\d]|$)/;
  const streetAddress =
    /\b\d{1,6}\s+[a-zA-Z0-9.'-]+(?:\s+[a-zA-Z0-9.'-]+){0,4}\s+(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|court|ct|parkway|pkwy|place|pl)\b/i;
  const iban = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/i;
  const ipAddress =
    /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[a-f0-9]{1,4}:){2,7}[a-f0-9]{0,4}\b/i;
  const labeledPrivateData =
    /\b(?:full name|legal name|date of birth|dob|patient|diagnosis|medical record|health record|medication|bank account|account number|routing number|passport|driver'?s license)\s*[:=]\s*\S+/i;
  const credential =
    /\b(?:password|passphrase|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|authorization)\s*[:=]\s*\S+/i;
  const secretToken = /\b(?:sk|rk|pk)-(?:live-|test-)?[a-zA-Z0-9_-]{16,}\b/;
  const cardCandidate = /(?:\d[ -]?){13,19}/g;

  const visit = (item: unknown, depth: number): string | null => {
    if (depth > 20) return "overly nested data";
    if (typeof item === "string") {
      if (email.test(item)) return "email addresses";
      if (ssn.test(item)) return "Social Security numbers";
      if (phone.test(item)) return "phone numbers";
      if (streetAddress.test(item)) return "postal addresses";
      if (iban.test(item) || labeledPrivateData.test(item)) {
        return "personal, medical, or financial records";
      }
      if (ipAddress.test(item)) return "network or device identifiers";
      if (credential.test(item) || secretToken.test(item)) {
        return "credentials or secrets";
      }
      for (const match of item.matchAll(cardCandidate)) {
        if (hasLuhnChecksum(match[0])) return "payment-card numbers";
      }
      return null;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        const found = visit(child, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (!isRecord(item)) return null;
    for (const [key, child] of Object.entries(item)) {
      if (sensitiveKey.test(key) && child !== null && child !== "") {
        return "personal, payment, or credential fields";
      }
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return null;
  };

  return visit(value, 0);
}

export function validateSponsorDraftPayload(
  value: unknown,
): ValidatedSponsorDraft {
  if (!isRecord(value)) {
    throw new SponsorTaskValidationError("A sponsor task must be a JSON object.");
  }

  const clientRequestId =
    typeof value.clientRequestId === "string"
      ? value.clientRequestId.trim().toLowerCase()
      : "";
  if (!UUID_PATTERN.test(clientRequestId)) {
    throw new SponsorTaskValidationError(
      "clientRequestId must be a UUID that is reused when retrying this draft.",
    );
  }
  if (value.taskType !== undefined && value.taskType !== "dataset_summary") {
    throw new SponsorTaskValidationError(
      "The beta accepts only dataset_summary sponsor tasks.",
    );
  }
  if (value.automationAllowed !== true || value.autoAccept !== true) {
    throw new SponsorTaskValidationError(
      "The sponsor must explicitly allow automated completion and deterministic automatic acceptance.",
    );
  }
  if (value.rightsAttested !== true) {
    throw new SponsorTaskValidationError(
      "The sponsor must attest that they have the right to supply and process this data.",
    );
  }
  if (value.noSensitiveData !== true) {
    throw new SponsorTaskValidationError(
      "The sponsor must attest that the task contains no personal or sensitive data.",
    );
  }

  const sensitiveLabel = sensitiveDataLabel({
    title: value.title,
    instructions: value.instructions,
    input: value.input,
  });
  if (sensitiveLabel) {
    throw new SponsorTaskValidationError(
      `Sponsor tasks cannot contain ${sensitiveLabel}. Remove that data before checkout.`,
    );
  }

  try {
    const validated = validateFundedTaskSpec({
      taskType: "dataset_summary",
      title: value.title,
      instructions: value.instructions,
      input: value.input,
      rewardCents: SPONSOR_BETA_POLICY.minimumNetCents,
      sponsorReference: "sponsor:draft:validation",
      fundingCaptureId: "DRAFTVALIDATION01",
      automationAllowed: value.automationAllowed,
      autoAccept: value.autoAccept,
      acceptance: value.acceptance,
      minAnswerChars: value.minAnswerChars,
    });
    return {
      clientRequestId,
      taskType: validated.taskType,
      title: validated.title,
      instructions: validated.instructions,
      inputJson: validated.inputJson,
      acceptanceJson: validated.acceptanceJson,
      minAnswerChars: validated.minAnswerChars,
    };
  } catch (error) {
    throw new SponsorTaskValidationError(
      error instanceof Error ? error.message : "The sponsor task is invalid.",
    );
  }
}

function parseStoredJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Stored sponsor ${label} is invalid.`);
  }
}

function isoTime(value: number | null) {
  return value === null ? null : new Date(value).toISOString();
}

export function toPublicSponsorDraft(
  row: SponsorTaskOrderRow,
): PublicSponsorDraft {
  return {
    id: row.id,
    clientRequestId: row.client_request_id,
    sponsorReference: row.sponsor_reference,
    status: row.status,
    taskType: row.task_type,
    title: row.title,
    instructions: row.instructions,
    input: parseStoredJson(row.input_json, "input"),
    acceptance: parseStoredJson(row.acceptance_json, "acceptance"),
    minAnswerChars: row.min_answer_chars,
    rightsAttested: true,
    noSensitiveData: true,
    attestationVersion: row.attestation_version,
    attestedAt: new Date(row.attested_at).toISOString(),
    charge: {
      currency: row.currency,
      grossCents: row.gross_cents,
      minimumNetCents: row.minimum_net_cents,
      payoutCents: row.payout_cents,
    },
    paypalOrderId: row.paypal_order_id,
    fundedTaskId: row.funded_task_id,
    lastErrorCode: row.last_error_code,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    completedAt: isoTime(row.completed_at),
  };
}

function paypalOrderSpec(row: SponsorTaskOrderRow): SponsorPayPalOrderSpec {
  return {
    invoiceId: `five-${row.id}`,
    customId: row.sponsor_reference,
    description: "FIVE automation-approved dataset summary",
    currencyCode: "USD",
    amount: "8.00",
  };
}

async function requestHash(value: ValidatedSponsorDraft) {
  const encoded = new TextEncoder().encode(
    JSON.stringify({
      ...value,
      rightsAttested: true,
      noSensitiveData: true,
      attestationVersion: SPONSOR_ATTESTATION_VERSION,
    }),
  );
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return encodeBase64Url(digest);
}

async function rowForOwner(
  db: D1Database,
  id: string,
  ownerEmail: string,
) {
  return db
    .prepare(
      "SELECT * FROM sponsor_task_orders WHERE id = ? AND owner_email = ? LIMIT 1",
    )
    .bind(id, ownerEmail)
    .first<SponsorTaskOrderRow>();
}

async function existingDraft(
  db: D1Database,
  ownerEmail: string,
  clientRequestId: string,
) {
  return db
    .prepare(
      "SELECT * FROM sponsor_task_orders WHERE owner_email = ? AND client_request_id = ? LIMIT 1",
    )
    .bind(ownerEmail, clientRequestId)
    .first<SponsorTaskOrderRow>();
}

function sameIdempotentRequest(row: SponsorTaskOrderRow, hash: string) {
  if (row.request_hash !== hash) {
    throw new SponsorTaskConflictError(
      "clientRequestId was already used for a different sponsor task.",
    );
  }
}

async function consumeSponsorOrderRequest(
  db: D1Database,
  ownerEmail: string,
  now: number,
) {
  const expiredBefore = now - SPONSOR_ORDER_REQUEST_THROTTLE.windowMs;
  const consumed = await db
    .prepare(
      `INSERT INTO sponsor_order_request_limits
       (owner_email, window_started_at, request_count, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(owner_email) DO UPDATE SET
         window_started_at = CASE
           WHEN sponsor_order_request_limits.window_started_at <= ? THEN excluded.window_started_at
           ELSE sponsor_order_request_limits.window_started_at
         END,
         request_count = CASE
           WHEN sponsor_order_request_limits.window_started_at <= ? THEN 1
           ELSE sponsor_order_request_limits.request_count + 1
         END,
         updated_at = excluded.updated_at
       WHERE sponsor_order_request_limits.window_started_at <= ?
          OR sponsor_order_request_limits.request_count < ?
       RETURNING window_started_at, request_count`,
    )
    .bind(
      ownerEmail,
      now,
      now,
      expiredBefore,
      expiredBefore,
      expiredBefore,
      SPONSOR_ORDER_REQUEST_THROTTLE.maxRequests,
    )
    .first<{ window_started_at: number; request_count: number }>();
  if (consumed) return;

  const current = await db
    .prepare(
      `SELECT window_started_at FROM sponsor_order_request_limits
       WHERE owner_email = ? LIMIT 1`,
    )
    .bind(ownerEmail)
    .first<{ window_started_at: number }>();
  const retryAfterSeconds = current
    ? Math.max(
        1,
        Math.ceil(
          (current.window_started_at +
            SPONSOR_ORDER_REQUEST_THROTTLE.windowMs -
            now) /
            1_000,
        ),
      )
    : 60;
  throw new SponsorTaskRateLimitError(
    retryAfterSeconds,
    "Sponsor checkout is receiving too many requests. Wait briefly, then retry the same task.",
  );
}

export async function createSponsorDraft(input: {
  ownerEmail: string;
  payload: unknown;
  runtime?: RuntimeEnv;
}): Promise<SponsorDraftCreation> {
  const runtime = input.runtime ?? getRuntimeEnv();
  const validated = validateSponsorDraftPayload(input.payload);
  const ownerEmail = normalizeOwnerEmail(input.ownerEmail);
  const hash = await requestHash(validated);
  const db = await ensureLiveDatabase(runtime);
  await consumeSponsorOrderRequest(db, ownerEmail, Date.now());

  const existing = await existingDraft(
    db,
    ownerEmail,
    validated.clientRequestId,
  );
  if (existing) {
    sameIdempotentRequest(existing, hash);
    return {
      draft: toPublicSponsorDraft(existing),
      paypalOrderSpec: paypalOrderSpec(existing),
      duplicate: true,
    };
  }

  const id = crypto.randomUUID();
  const sponsorReference = `sponsor:${id}`;
  const now = Date.now();
  const windowStart = now - SPONSOR_RATE_WINDOW_MS;
  let inserted: SponsorTaskOrderRow | null;
  try {
    inserted = await db
      .prepare(
        `INSERT INTO sponsor_task_orders
         (id, owner_email, client_request_id, request_hash, task_type, title,
          instructions, input_json, acceptance_json, min_answer_chars,
          automation_allowed, auto_accept, rights_attested, no_sensitive_data,
          attestation_version, attested_at, sponsor_reference, currency,
          gross_cents, minimum_net_cents, payout_cents, status, created_at,
          updated_at)
         SELECT ?, ?, ?, ?, 'dataset_summary', ?, ?, ?, ?, ?, 1, 1, 1, 1,
                ?, ?, ?, 'USD', 800, 600, 500, 'draft', ?, ?
         WHERE (
           SELECT COUNT(*) FROM sponsor_task_orders
           WHERE owner_email = ? AND created_at >= ?
         ) < ?
           AND (
             SELECT COUNT(*) FROM sponsor_task_orders
             WHERE owner_email = ? AND created_at >= ?
               AND status IN ('draft', 'order_created', 'capture_pending', 'capture_retry', 'needs_review')
           ) < ?
         RETURNING *`,
      )
      .bind(
        id,
        ownerEmail,
        validated.clientRequestId,
        hash,
        validated.title,
        validated.instructions,
        validated.inputJson,
        validated.acceptanceJson,
        validated.minAnswerChars,
        SPONSOR_ATTESTATION_VERSION,
        now,
        sponsorReference,
        now,
        now,
        ownerEmail,
        windowStart,
        MAX_DRAFTS_PER_WINDOW,
        ownerEmail,
        windowStart,
        MAX_ACTIVE_DRAFTS_PER_WINDOW,
      )
      .first<SponsorTaskOrderRow>();
  } catch (error) {
    const raced = await existingDraft(
      db,
      ownerEmail,
      validated.clientRequestId,
    );
    if (!raced) throw error;
    sameIdempotentRequest(raced, hash);
    return {
      draft: toPublicSponsorDraft(raced),
      paypalOrderSpec: paypalOrderSpec(raced),
      duplicate: true,
    };
  }

  if (!inserted) {
    const oldest = await db
      .prepare(
        `SELECT created_at FROM sponsor_task_orders
         WHERE owner_email = ? AND created_at >= ?
         ORDER BY created_at ASC LIMIT 1`,
      )
      .bind(ownerEmail, windowStart)
      .first<{ created_at: number }>();
    const retryAfterSeconds = oldest
      ? Math.max(
          1,
          Math.ceil(
            (oldest.created_at + SPONSOR_RATE_WINDOW_MS - now) / 1_000,
          ),
        )
      : 60;
    throw new SponsorTaskRateLimitError(retryAfterSeconds);
  }
  return {
    draft: toPublicSponsorDraft(inserted),
    paypalOrderSpec: paypalOrderSpec(inserted),
    duplicate: false,
  };
}

export async function getSponsorDraftForOwner(
  id: string,
  ownerEmail: string,
  runtime: RuntimeEnv = getRuntimeEnv(),
) {
  if (!UUID_PATTERN.test(id)) return null;
  const db = await ensureLiveDatabase(runtime);
  const row = await rowForOwner(db, id, normalizeOwnerEmail(ownerEmail));
  return row ? toPublicSponsorDraft(row) : null;
}

export async function recordSponsorFundingOrder(input: {
  draftId: string;
  ownerEmail: string;
  paypalOrderId: string;
  runtime?: RuntimeEnv;
}) {
  if (!UUID_PATTERN.test(input.draftId)) return null;
  const runtime = input.runtime ?? getRuntimeEnv();
  const db = await ensureLiveDatabase(runtime);
  const owner = normalizeOwnerEmail(input.ownerEmail);
  const orderId = normalizePayPalOrderId(input.paypalOrderId);
  const now = Date.now();
  try {
    const row = await db
      .prepare(
        `UPDATE sponsor_task_orders
         SET paypal_order_id = COALESCE(paypal_order_id, ?),
             status = CASE WHEN status = 'draft' THEN 'order_created' ELSE status END,
             next_attempt_at = CASE WHEN status = 'draft' THEN ? ELSE next_attempt_at END,
             updated_at = ?
         WHERE id = ? AND owner_email = ?
           AND status IN ('draft', 'order_created', 'capture_pending', 'capture_retry', 'funded')
           AND (paypal_order_id IS NULL OR paypal_order_id = ?)
         RETURNING *`,
      )
      .bind(orderId, now + 60_000, now, input.draftId, owner, orderId)
      .first<SponsorTaskOrderRow>();
    if (row) return toPublicSponsorDraft(row);
  } catch (error) {
    const orderOwner = await db
      .prepare("SELECT id FROM sponsor_task_orders WHERE paypal_order_id = ? LIMIT 1")
      .bind(orderId)
      .first<{ id: string }>();
    if (orderOwner && orderOwner.id !== input.draftId) {
      throw new SponsorTaskConflictError(
        "This PayPal order is already attached to another sponsor draft.",
      );
    }
    throw error;
  }

  const current = await rowForOwner(db, input.draftId, owner);
  if (!current) return null;
  if (current.paypal_order_id && current.paypal_order_id !== orderId) {
    throw new SponsorTaskConflictError(
      "This sponsor draft is already bound to a different PayPal order.",
    );
  }
  if (current.status === "needs_review") {
    throw new SponsorTaskConflictError(
      "This sponsor payment needs review before another order can be used.",
    );
  }
  return toPublicSponsorDraft(current);
}

type SponsorTaskViewRow = {
  funded_task_status: string | null;
  live_job_status: string | null;
  submission_json: string | null;
  receipt_provider: string | null;
  receipt_capture_id: string | null;
  receipt_currency: string | null;
  receipt_gross_cents: number | null;
  receipt_net_cents: number | null;
  receipt_captured_at: number | null;
};

function sponsorWorkStatus(
  draft: PublicSponsorDraft,
  row: SponsorTaskViewRow,
): SponsorTaskWorkStatus {
  if (row.submission_json) return "result_ready";
  if (
    draft.status === "needs_review" ||
    row.funded_task_status === "rejected" ||
    ["needs_review", "needs_action", "failed", "reversed"].includes(
      row.live_job_status ?? "",
    )
  ) {
    return "needs_review";
  }
  if (draft.status !== "funded") return "waiting";
  if (row.funded_task_status === "accepted") return "needs_review";
  if (row.funded_task_status === "leased" || row.live_job_status) {
    return "working";
  }
  return "waiting";
}

export async function getSponsorTaskViewForOwner(
  id: string,
  ownerEmail: string,
  runtime: RuntimeEnv = getRuntimeEnv(),
): Promise<SponsorTaskView | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const db = await ensureLiveDatabase(runtime);
  const owner = normalizeOwnerEmail(ownerEmail);
  const draftRow = await rowForOwner(db, id, owner);
  if (!draftRow) return null;

  // Deliberately select only sponsor task state, result, and funding receipt.
  // No live-job owner, payout destination, fingerprint, hint, or payout IDs are
  // selected into this sponsor-facing projection.
  const joined = await db
    .prepare(
      `SELECT ft.status AS funded_task_status,
              lj.status AS live_job_status,
              lj.submission_json AS submission_json,
              fr.provider AS receipt_provider,
              fr.provider_transaction_id AS receipt_capture_id,
              fr.currency AS receipt_currency,
              fr.gross_cents AS receipt_gross_cents,
              fr.net_cents AS receipt_net_cents,
              fr.captured_at AS receipt_captured_at
       FROM sponsor_task_orders sto
       LEFT JOIN funded_tasks ft ON ft.id = sto.funded_task_id
       LEFT JOIN funding_receipts fr ON fr.task_id = ft.id
       LEFT JOIN live_jobs lj ON lj.task_id = ft.id
       WHERE sto.id = ? AND sto.owner_email = ?
       LIMIT 1`,
    )
    .bind(id, owner)
    .first<SponsorTaskViewRow>();

  const draft = toPublicSponsorDraft(draftRow);
  const state: SponsorTaskViewRow = joined ?? {
    funded_task_status: null,
    live_job_status: null,
    submission_json: null,
    receipt_provider: null,
    receipt_capture_id: null,
    receipt_currency: null,
    receipt_gross_cents: null,
    receipt_net_cents: null,
    receipt_captured_at: null,
  };
  let result: unknown;
  if (state.submission_json) {
    result = parseStoredJson(state.submission_json, "result");
  }
  const hasReceipt =
    state.receipt_provider === "paypal" &&
    state.receipt_capture_id !== null &&
    state.receipt_currency === "USD" &&
    state.receipt_gross_cents !== null &&
    state.receipt_net_cents !== null &&
    state.receipt_captured_at !== null;

  return {
    draft,
    workStatus: sponsorWorkStatus(draft, state),
    ...(result === undefined ? {} : { result }),
    receipt: hasReceipt
      ? {
          provider: "paypal",
          captureId: state.receipt_capture_id as string,
          currency: "USD",
          grossCents: state.receipt_gross_cents as number,
          netCents: state.receipt_net_cents as number,
          capturedAt: new Date(state.receipt_captured_at as number).toISOString(),
        }
      : null,
  };
}

function normalizePayPalOrderId(value: string) {
  const normalized = value.trim();
  if (!PAYPAL_ORDER_ID_PATTERN.test(normalized)) {
    throw new SponsorTaskValidationError("A valid PayPal order ID is required.");
  }
  return normalized;
}

function normalizePayPalCaptureId(value: string) {
  const normalized = value.trim();
  if (!PAYPAL_CAPTURE_ID_PATTERN.test(normalized)) {
    throw new SponsorTaskValidationError("A valid PayPal capture ID is required.");
  }
  return normalized;
}

export async function claimSponsorCapture(
  id: string,
  ownerEmail: string,
  paypalOrderId: string,
  runtime: RuntimeEnv = getRuntimeEnv(),
): Promise<SponsorCaptureClaim | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const db = await ensureLiveDatabase(runtime);
  const owner = normalizeOwnerEmail(ownerEmail);
  const orderId = normalizePayPalOrderId(paypalOrderId);
  const before = await rowForOwner(db, id, owner);
  if (!before) return null;
  if (before.paypal_order_id && before.paypal_order_id !== orderId) {
    throw new SponsorTaskConflictError(
      "This sponsor draft is already bound to a different PayPal order.",
    );
  }
  if (before.status === "funded") {
    return { kind: "already_funded", draft: before, leaseToken: null };
  }
  if (before.status === "canceled") {
    throw new SponsorTaskConflictError(
      "This sponsor checkout was canceled and cannot be captured.",
    );
  }
  if (before.status === "needs_review") {
    throw new SponsorTaskConflictError(
      "This payment needs support review before the task can be activated.",
    );
  }

  const now = Date.now();
  const leaseToken = crypto.randomUUID();
  let claimed: SponsorTaskOrderRow | null;
  try {
    claimed = await db
      .prepare(
      `UPDATE sponsor_task_orders
       SET paypal_order_id = COALESCE(paypal_order_id, ?),
           status = 'capture_pending', attempts = attempts + 1,
           next_attempt_at = NULL, lease_token = ?, lease_expires_at = ?,
           last_error_code = NULL, last_error_message = NULL, updated_at = ?
       WHERE id = ? AND owner_email = ?
         AND status IN ('draft', 'order_created', 'capture_pending', 'capture_retry')
         AND (paypal_order_id IS NULL OR paypal_order_id = ?)
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
       RETURNING *`,
    )
      .bind(
        orderId,
        leaseToken,
        now + CAPTURE_LEASE_MS,
        now,
        id,
        owner,
        orderId,
        now,
      )
      .first<SponsorTaskOrderRow>();
  } catch (error) {
    const orderOwner = await db
      .prepare(
        "SELECT id FROM sponsor_task_orders WHERE paypal_order_id = ? LIMIT 1",
      )
      .bind(orderId)
      .first<{ id: string }>();
    if (orderOwner && orderOwner.id !== id) {
      throw new SponsorTaskConflictError(
        "This PayPal order is already attached to another sponsor draft.",
      );
    }
    throw error;
  }
  if (claimed) return { kind: "claimed", draft: claimed, leaseToken };

  const current = await rowForOwner(db, id, owner);
  if (!current) return null;
  if (current.status === "funded") {
    return { kind: "already_funded", draft: current, leaseToken: null };
  }
  if (current.paypal_order_id && current.paypal_order_id !== orderId) {
    throw new SponsorTaskConflictError(
      "This sponsor draft is already bound to a different PayPal order.",
    );
  }
  return { kind: "busy", draft: current, leaseToken: null };
}

export async function claimNextSponsorCapture(
  runtime: RuntimeEnv = getRuntimeEnv(),
): Promise<Extract<SponsorCaptureClaim, { kind: "claimed" }> | null> {
  const db = await ensureLiveDatabase(runtime);
  const now = Date.now();
  const leaseToken = crypto.randomUUID();
  const draft = await db
    .prepare(
      `UPDATE sponsor_task_orders
       SET status = CASE
             WHEN status = 'order_created' THEN 'order_created'
             ELSE 'capture_pending'
           END,
           attempts = attempts + 1,
           next_attempt_at = NULL, lease_token = ?, lease_expires_at = ?,
           updated_at = ?
       WHERE id = (
         SELECT id FROM sponsor_task_orders
         WHERE status IN ('order_created', 'capture_pending', 'capture_retry')
           AND paypal_order_id IS NOT NULL
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         ORDER BY updated_at ASC, created_at ASC
         LIMIT 1
       )
       AND status IN ('order_created', 'capture_pending', 'capture_retry')
       AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
       RETURNING *`,
    )
    .bind(
      leaseToken,
      now + CAPTURE_LEASE_MS,
      now,
      now,
      now,
      now,
    )
    .first<SponsorTaskOrderRow>();
  return draft ? { kind: "claimed", draft, leaseToken } : null;
}

export async function cancelSponsorFundingOrder(input: {
  draftId: string;
  ownerEmail: string;
  paypalOrderId: string;
  runtime?: RuntimeEnv;
}) {
  if (!UUID_PATTERN.test(input.draftId)) return null;
  const runtime = input.runtime ?? getRuntimeEnv();
  const db = await ensureLiveDatabase(runtime);
  const owner = normalizeOwnerEmail(input.ownerEmail);
  const orderId = normalizePayPalOrderId(input.paypalOrderId);
  const now = Date.now();
  const row = await db
    .prepare(
      `UPDATE sponsor_task_orders
       SET status = 'canceled', next_attempt_at = NULL, attempts = 0,
           lease_token = NULL, lease_expires_at = NULL,
           last_error_code = 'sponsor_canceled', last_error_message = NULL,
           updated_at = ?, completed_at = ?
       WHERE id = ? AND owner_email = ? AND paypal_order_id = ?
         AND status = 'order_created'
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
       RETURNING *`,
    )
    .bind(now, now, input.draftId, owner, orderId, now)
    .first<SponsorTaskOrderRow>();
  if (row) return toPublicSponsorDraft(row);

  const current = await rowForOwner(db, input.draftId, owner);
  if (!current) return null;
  if (current.paypal_order_id !== orderId) {
    throw new SponsorTaskConflictError(
      "This sponsor draft is bound to a different PayPal order.",
    );
  }
  return toPublicSponsorDraft(current);
}

export async function recordSponsorOrderAwaitingApproval(input: {
  draft: SponsorTaskOrderRow;
  leaseToken: string;
  runtime?: RuntimeEnv;
}) {
  const runtime = input.runtime ?? getRuntimeEnv();
  const db = database(runtime);
  const now = Date.now();
  const row = await db
    .prepare(
      `UPDATE sponsor_task_orders
       SET status = 'order_created', attempts = 0, next_attempt_at = ?,
           lease_token = NULL, lease_expires_at = NULL,
           last_error_code = NULL, last_error_message = NULL, updated_at = ?
       WHERE id = ? AND status = 'order_created' AND lease_token = ?
       RETURNING *`,
    )
    .bind(now + 5 * 60_000, now, input.draft.id, input.leaseToken)
    .first<SponsorTaskOrderRow>();
  return row ? toPublicSponsorDraft(row) : null;
}

export async function markSponsorOrderCapturing(input: {
  draft: SponsorTaskOrderRow;
  leaseToken: string;
  runtime?: RuntimeEnv;
}) {
  const runtime = input.runtime ?? getRuntimeEnv();
  const db = database(runtime);
  const now = Date.now();
  return db
    .prepare(
      `UPDATE sponsor_task_orders
       SET status = 'capture_pending', next_attempt_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'order_created' AND lease_token = ?
       RETURNING *`,
    )
    .bind(now, input.draft.id, input.leaseToken)
    .first<SponsorTaskOrderRow>();
}

export async function failSponsorOrderCheck(input: {
  draft: SponsorTaskOrderRow;
  leaseToken: string;
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  runtime?: RuntimeEnv;
}) {
  const runtime = input.runtime ?? getRuntimeEnv();
  const db = database(runtime);
  const now = Date.now();
  const defaultDelay =
    Math.min(900, 30 * 2 ** Math.min(input.draft.attempts, 5)) * 1_000;
  const nextAttemptAt = input.retryable
    ? now + Math.max(5_000, Math.min(input.retryAfterMs ?? defaultDelay, 30 * 60_000))
    : null;
  const row = await db
    .prepare(
      `UPDATE sponsor_task_orders
       SET status = ?, next_attempt_at = ?, lease_token = NULL,
           lease_expires_at = NULL, last_error_code = ?,
           last_error_message = ?, updated_at = ?
       WHERE id = ? AND status = 'order_created' AND lease_token = ?
       RETURNING *`,
    )
    .bind(
      input.retryable ? "order_created" : "needs_review",
      nextAttemptAt,
      safeErrorCode(input.code),
      safeErrorMessage(input.message),
      now,
      input.draft.id,
      input.leaseToken,
    )
    .first<SponsorTaskOrderRow>();
  return row ? toPublicSponsorDraft(row) : null;
}

function safeErrorCode(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .slice(0, 80);
  return normalized || "capture_error";
}

function safeErrorMessage(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 240);
}

export async function recordSponsorCapturePending(input: {
  draft: SponsorTaskOrderRow;
  leaseToken: string;
  captureId?: string | null;
  runtime?: RuntimeEnv;
}) {
  const runtime = input.runtime ?? getRuntimeEnv();
  const db = database(runtime);
  const captureId = input.captureId
    ? normalizePayPalCaptureId(input.captureId)
    : null;
  const now = Date.now();
  const row = await db
    .prepare(
      `UPDATE sponsor_task_orders
       SET paypal_capture_id = COALESCE(paypal_capture_id, ?),
           status = 'capture_pending', attempts = 0, next_attempt_at = ?,
           lease_token = NULL, lease_expires_at = NULL,
           last_error_code = 'provider_pending', last_error_message = NULL,
           updated_at = ?
       WHERE id = ? AND status = 'capture_pending' AND lease_token = ?
         AND (? IS NULL OR paypal_capture_id IS NULL OR paypal_capture_id = ?)
       RETURNING *`,
    )
    .bind(
      captureId,
      now + PENDING_RECHECK_MS,
      now,
      input.draft.id,
      input.leaseToken,
      captureId,
      captureId,
    )
    .first<SponsorTaskOrderRow>();
  return row ? toPublicSponsorDraft(row) : null;
}

export async function markSponsorCaptureRetry(input: {
  draft: SponsorTaskOrderRow;
  leaseToken: string;
  code: string;
  message: string;
  retryAfterMs?: number;
  runtime?: RuntimeEnv;
}) {
  const runtime = input.runtime ?? getRuntimeEnv();
  const db = database(runtime);
  const now = Date.now();
  const defaultDelay =
    Math.min(300, 5 * 2 ** Math.min(input.draft.attempts, 6)) * 1_000;
  const retryAfterMs = Math.max(
    1_000,
    Math.min(input.retryAfterMs ?? defaultDelay, 15 * 60_000),
  );
  const row = await db
    .prepare(
      `UPDATE sponsor_task_orders
       SET status = 'capture_retry', next_attempt_at = ?,
           lease_token = NULL, lease_expires_at = NULL,
           last_error_code = ?, last_error_message = ?, updated_at = ?
       WHERE id = ? AND status = 'capture_pending' AND lease_token = ?
       RETURNING *`,
    )
    .bind(
      now + retryAfterMs,
      safeErrorCode(input.code),
      safeErrorMessage(input.message),
      now,
      input.draft.id,
      input.leaseToken,
    )
    .first<SponsorTaskOrderRow>();
  return row ? toPublicSponsorDraft(row) : null;
}

export async function markSponsorCaptureNeedsReview(input: {
  draft: SponsorTaskOrderRow;
  leaseToken: string;
  code: string;
  message: string;
  captureId?: string | null;
  runtime?: RuntimeEnv;
}) {
  const runtime = input.runtime ?? getRuntimeEnv();
  const db = database(runtime);
  const captureId = input.captureId
    ? normalizePayPalCaptureId(input.captureId)
    : null;
  const now = Date.now();
  const row = await db
    .prepare(
      `UPDATE sponsor_task_orders
       SET paypal_capture_id = COALESCE(paypal_capture_id, ?),
           status = 'needs_review', next_attempt_at = NULL,
           lease_token = NULL, lease_expires_at = NULL,
           last_error_code = ?, last_error_message = ?, updated_at = ?
       WHERE id = ? AND status = 'capture_pending' AND lease_token = ?
         AND (? IS NULL OR paypal_capture_id IS NULL OR paypal_capture_id = ?)
       RETURNING *`,
    )
    .bind(
      captureId,
      safeErrorCode(input.code),
      safeErrorMessage(input.message),
      now,
      input.draft.id,
      input.leaseToken,
      captureId,
      captureId,
    )
    .first<SponsorTaskOrderRow>();
  return row ? toPublicSponsorDraft(row) : null;
}

export async function failSponsorCapture(input: {
  draft: SponsorTaskOrderRow;
  leaseToken: string;
  code: string;
  message: string;
  retryable: boolean;
  captureId?: string | null;
  retryAfterMs?: number;
  runtime?: RuntimeEnv;
}) {
  if (input.retryable) {
    return markSponsorCaptureRetry(input);
  }
  return markSponsorCaptureNeedsReview(input);
}

function captureMatchesDraft(
  row: SponsorTaskOrderRow,
  capture: PayPalFundingCapture,
) {
  return (
    capture.provider === "paypal" &&
    PAYPAL_CAPTURE_ID_PATTERN.test(capture.captureId) &&
    capture.status === "COMPLETED" &&
    capture.currency === "USD" &&
    capture.grossCents === SPONSOR_BETA_POLICY.grossCents &&
    capture.netCents >= row.minimum_net_cents &&
    capture.netCents <= capture.grossCents &&
    capture.customId === row.sponsor_reference &&
    Number.isFinite(Date.parse(capture.capturedAt))
  );
}

export async function finalizeSponsorCapture(input: {
  draft: SponsorTaskOrderRow;
  leaseToken: string;
  capture: PayPalFundingCapture;
  runtime?: RuntimeEnv;
}) {
  const runtime = input.runtime ?? getRuntimeEnv();
  const db = database(runtime);
  const current = await db
    .prepare(
      `SELECT * FROM sponsor_task_orders
       WHERE id = ? AND status = 'capture_pending' AND lease_token = ? LIMIT 1`,
    )
    .bind(input.draft.id, input.leaseToken)
    .first<SponsorTaskOrderRow>();
  if (!current) {
    const latest = await db
      .prepare("SELECT * FROM sponsor_task_orders WHERE id = ? LIMIT 1")
      .bind(input.draft.id)
      .first<SponsorTaskOrderRow>();
    if (latest?.status === "funded") return toPublicSponsorDraft(latest);
    throw new SponsorTaskConflictError(
      "The sponsor capture lease is no longer current.",
    );
  }

  if (!captureMatchesDraft(current, input.capture)) {
    await markSponsorCaptureNeedsReview({
      draft: current,
      leaseToken: input.leaseToken,
      code: "capture_contract_mismatch",
      message:
        "The captured payment did not match the immutable sponsor funding contract.",
      captureId: PAYPAL_CAPTURE_ID_PATTERN.test(input.capture.captureId)
        ? input.capture.captureId
        : null,
      runtime,
    });
    throw new SponsorTaskConflictError(
      "The captured payment needs support review before task activation.",
    );
  }

  let fundedTask: Awaited<ReturnType<typeof createFundedTask>>;
  try {
    fundedTask = await createFundedTask(
      {
        taskType: current.task_type,
        title: current.title,
        instructions: current.instructions,
        input: parseStoredJson(current.input_json, "input"),
        rewardCents: current.minimum_net_cents,
        sponsorReference: current.sponsor_reference,
        fundingCaptureId: input.capture.captureId,
        automationAllowed: true,
        autoAccept: true,
        acceptance: parseStoredJson(current.acceptance_json, "acceptance"),
        minAnswerChars: current.min_answer_chars,
      },
      input.capture,
      runtime,
    );
  } catch (error) {
    if (!(error instanceof FundingCaptureTerminalError)) throw error;
    await markSponsorCaptureNeedsReview({
      draft: current,
      leaseToken: input.leaseToken,
      code: "funding_terminal_event",
      message:
        "PayPal reported the capture as refunded, reversed, or denied before task activation.",
      captureId: input.capture.captureId,
      runtime,
    });
    throw new SponsorTaskConflictError(
      "The sponsor payment is no longer settled and the task was not activated.",
    );
  }

  const now = Date.now();
  const funded = await db
    .prepare(
      `UPDATE sponsor_task_orders
       SET paypal_capture_id = ?, funded_task_id = ?, status = 'funded',
           next_attempt_at = NULL, lease_token = NULL, lease_expires_at = NULL,
           last_error_code = NULL, last_error_message = NULL,
           updated_at = ?, completed_at = ?
       WHERE id = ? AND status = 'capture_pending' AND lease_token = ?
         AND (paypal_capture_id IS NULL OR paypal_capture_id = ?)
         AND EXISTS (
           SELECT 1 FROM funded_tasks ft
           JOIN funding_receipts fr ON fr.id = ft.funding_receipt_id
           WHERE ft.id = ? AND ft.status = 'available'
             AND fr.status = 'COMPLETED'
         )
         AND NOT EXISTS (
           SELECT 1 FROM paypal_funding_webhook_events WHERE capture_id = ?
         )
       RETURNING *`,
    )
    .bind(
      input.capture.captureId,
      fundedTask.id,
      now,
      now,
      current.id,
      input.leaseToken,
      input.capture.captureId,
      fundedTask.id,
      input.capture.captureId,
    )
    .first<SponsorTaskOrderRow>();
  if (funded) return toPublicSponsorDraft(funded);

  const terminalEvent = await db
    .prepare(
      `SELECT terminal_status FROM paypal_funding_webhook_events
       WHERE capture_id = ? LIMIT 1`,
    )
    .bind(input.capture.captureId)
    .first<{ terminal_status: string }>();
  if (terminalEvent) {
    await markSponsorCaptureNeedsReview({
      draft: current,
      leaseToken: input.leaseToken,
      code: "funding_terminal_event",
      message: `PayPal reported the capture as ${terminalEvent.terminal_status} before task activation completed.`,
      captureId: input.capture.captureId,
      runtime,
    });
    throw new SponsorTaskConflictError(
      "The sponsor payment is no longer settled and the task was not activated.",
    );
  }

  const latest = await db
    .prepare("SELECT * FROM sponsor_task_orders WHERE id = ? LIMIT 1")
    .bind(current.id)
    .first<SponsorTaskOrderRow>();
  if (
    latest?.status === "funded" &&
    latest.funded_task_id === fundedTask.id &&
    latest.paypal_capture_id === input.capture.captureId
  ) {
    return toPublicSponsorDraft(latest);
  }
  throw new SponsorTaskConflictError(
    "The payment was verified, but task activation needs reconciliation.",
  );
}
