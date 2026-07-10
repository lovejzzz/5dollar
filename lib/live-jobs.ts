import {
  constantTimeSecretEqual,
  decryptPayoutDestination,
  encryptPayoutDestination,
  fingerprintPayoutDestination,
} from "./crypto";
import { validateFundedTaskSpec, type ValidatedFundedTask } from "./funded-tasks";
import { parsePayPalFundingTerminalWebhook } from "./paypal-webhooks";
import type { PayPalFundingCapture, PayPalPayoutBatchObservation } from "./payouts/paypal";
import { getRuntimeEnv, type RuntimeEnv } from "./runtime-env";

export type LiveJobStatus =
  | "no_inventory"
  | "queued"
  | "earning"
  | "needs_review"
  | "earned"
  | "payout_submitting"
  | "retry_wait"
  | "payout_pending"
  | "needs_action"
  | "paid"
  | "reversed"
  | "failed";

export type LiveJobRow = {
  id: string;
  owner_email: string;
  payout_method: "paypal";
  destination_ciphertext: string;
  destination_fingerprint: string;
  destination_hint: string;
  amount_cents: number;
  status: LiveJobStatus;
  task_id: string | null;
  earned_cents: number;
  submission_json: string | null;
  model_response_id: string | null;
  model_name: string | null;
  provider_status: string | null;
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

export type FundedTaskRow = {
  id: string;
  task_type: "dataset_summary";
  title: string;
  instructions: string;
  input_json: string;
  reward_cents: number;
  payout_cents: number;
  automation_allowed: number;
  auto_accept: number;
  min_answer_chars: number;
  acceptance_json: string;
  sponsor_reference: string;
  funding_receipt_id: string;
  status: "available" | "leased" | "accepted" | "rejected" | "funding_reversed";
  lease_job_id: string | null;
  created_at: number;
  updated_at: number;
  accepted_at: number | null;
  funding_provider: "paypal";
  funding_capture_id: string;
  funding_status: string;
  funding_currency: string;
  funding_gross_cents: number;
  funding_net_cents: number;
};

export class FundingCaptureTerminalError extends Error {
  constructor() {
    super(
      "PayPal already reported this sponsor funding capture as terminal; task activation is blocked.",
    );
    this.name = "FundingCaptureTerminalError";
  }
}

export type PayoutRow = {
  id: string;
  job_id: string;
  sender_batch_id: string;
  sender_item_id: string;
  provider_batch_id: string | null;
  provider_item_id: string | null;
  status: string;
  created_at: number;
  updated_at: number;
};

type LiveEventRow = {
  kind: string;
  title: string;
  detail: string;
  created_at: number;
};

export type NotificationOutboxRow = {
  id: string;
  event_key: string;
  job_id: string;
  kind: "payout_arrived" | "payout_reversed";
  payout_reference: string;
  status: "pending" | "sending" | "retry_wait" | "sent" | "canceled" | "failed";
  attempts: number;
  next_attempt_at: number | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  provider_message_id: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
  owner_email: string;
};

export type LiveJobActivity = {
  step: number;
  title: string;
  detail: string;
  state: "done" | "active" | "pending";
  occurredAt: string | null;
};

export type PublicLiveJob = {
  id: string;
  requestCode: string;
  amountCents: number;
  mode: "live";
  payoutMethod: "paypal";
  payoutMethodLabel: "PayPal";
  destinationHint: string;
  status: LiveJobStatus;
  progress: number;
  headline: string;
  message: string;
  payoutReference: string | null;
  createdAt: string;
  completedAt: string | null;
  activities: LiveJobActivity[];
};

const LIVE_STEPS = [
  {
    title: "Request received",
    detail: "Your payout destination was encrypted and the request was recorded.",
    kinds: ["request_received"],
  },
  {
    title: "Funded task reserved",
    detail: "A sponsor-funded, automation-approved task is assigned to this request.",
    kinds: ["task_reserved"],
  },
  {
    title: "AI completing the work",
    detail: "The agent is producing the sponsor deliverable from approved task data.",
    kinds: ["earning_started"],
  },
  {
    title: "Revenue accepted",
    detail: "The pre-funded task contract accepted the checked deliverable.",
    kinds: ["earning_accepted"],
  },
  {
    title: "Payout submitted",
    detail: "The $5 payout is with PayPal and is waiting for item-level confirmation.",
    kinds: ["payout_submitted", "payout_needs_action"],
  },
  {
    title: "$5 confirmed",
    detail: "PayPal confirmed the individual payout item succeeded.",
    kinds: ["payout_succeeded"],
  },
] as const;

function database(runtime: RuntimeEnv = getRuntimeEnv()): D1Database {
  const binding = runtime.DB as D1Database | undefined;
  if (!binding) throw new Error("The live job database is unavailable.");
  return binding;
}

export async function ensureLiveDatabase(runtime: RuntimeEnv = getRuntimeEnv()) {
  const db = database(runtime);
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS funded_tasks (
      id TEXT PRIMARY KEY NOT NULL,
      task_type TEXT NOT NULL DEFAULT 'dataset_summary',
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      input_json TEXT NOT NULL DEFAULT '{}',
      reward_cents INTEGER NOT NULL,
      payout_cents INTEGER NOT NULL DEFAULT 500,
      automation_allowed INTEGER NOT NULL DEFAULT 0,
      auto_accept INTEGER NOT NULL DEFAULT 0,
      min_answer_chars INTEGER NOT NULL DEFAULT 120,
      acceptance_json TEXT NOT NULL DEFAULT '{}',
      sponsor_reference TEXT NOT NULL,
      funding_receipt_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      lease_job_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      accepted_at INTEGER
    )`),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS funded_tasks_sponsor_reference_idx ON funded_tasks (sponsor_reference)",
    ),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS funded_tasks_funding_receipt_idx ON funded_tasks (funding_receipt_id)",
    ),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS funded_tasks_lease_job_id_idx ON funded_tasks (lease_job_id)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS funded_tasks_available_idx ON funded_tasks (status, automation_allowed, created_at)",
    ),
    db.prepare(`CREATE TABLE IF NOT EXISTS funding_receipts (
      id TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL,
      provider_transaction_id TEXT NOT NULL,
      sponsor_reference TEXT NOT NULL,
      currency TEXT NOT NULL,
      gross_cents INTEGER NOT NULL,
      net_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS funding_receipts_provider_transaction_idx ON funding_receipts (provider, provider_transaction_id)",
    ),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS funding_receipts_sponsor_reference_idx ON funding_receipts (sponsor_reference)",
    ),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS funding_receipts_task_id_idx ON funding_receipts (task_id)",
    ),
    db.prepare(`CREATE TABLE IF NOT EXISTS live_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      owner_email TEXT NOT NULL,
      payout_method TEXT NOT NULL,
      destination_ciphertext TEXT NOT NULL,
      destination_fingerprint TEXT NOT NULL,
      destination_hint TEXT NOT NULL,
      amount_cents INTEGER NOT NULL DEFAULT 500,
      status TEXT NOT NULL DEFAULT 'queued',
      task_id TEXT,
      earned_cents INTEGER NOT NULL DEFAULT 0,
      submission_json TEXT,
      model_response_id TEXT,
      model_name TEXT,
      provider_status TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      lease_token TEXT,
      lease_expires_at INTEGER,
      last_error_code TEXT,
      last_error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    )`),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS live_jobs_owner_email_idx ON live_jobs (owner_email)",
    ),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS live_jobs_destination_fingerprint_idx ON live_jobs (destination_fingerprint)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS live_jobs_processing_idx ON live_jobs (status, next_attempt_at, lease_expires_at)",
    ),
    db.prepare(`CREATE TABLE IF NOT EXISTS payouts (
      id TEXT PRIMARY KEY NOT NULL,
      job_id TEXT NOT NULL,
      sender_batch_id TEXT NOT NULL,
      sender_item_id TEXT NOT NULL,
      provider_batch_id TEXT,
      provider_item_id TEXT,
      status TEXT NOT NULL DEFAULT 'created',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS payouts_job_id_idx ON payouts (job_id)"),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS payouts_sender_batch_id_idx ON payouts (sender_batch_id)",
    ),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS payouts_sender_item_id_idx ON payouts (sender_item_id)",
    ),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS payouts_provider_batch_id_idx ON payouts (provider_batch_id)",
    ),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS payouts_provider_item_id_idx ON payouts (provider_item_id)",
    ),
    db.prepare(`CREATE TABLE IF NOT EXISTS live_job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL,
      job_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS live_job_events_event_key_idx ON live_job_events (event_key)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS live_job_events_job_id_idx ON live_job_events (job_id, created_at)",
    ),
    db.prepare(`CREATE TABLE IF NOT EXISTS paypal_webhook_events (
      event_id TEXT PRIMARY KEY NOT NULL,
      event_type TEXT NOT NULL,
      payout_id TEXT NOT NULL,
      provider_event_time INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      applied_at INTEGER
    )`),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS paypal_webhook_events_payout_idx ON paypal_webhook_events (payout_id)",
    ),
    db.prepare(`CREATE TABLE IF NOT EXISTS paypal_funding_webhook_events (
      event_id TEXT PRIMARY KEY NOT NULL,
      event_type TEXT NOT NULL,
      funding_receipt_id TEXT,
      capture_id TEXT NOT NULL,
      terminal_status TEXT NOT NULL,
      provider_event_time INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      applied_at INTEGER
    )`),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS paypal_funding_webhook_events_capture_idx ON paypal_funding_webhook_events (capture_id)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS paypal_funding_webhook_events_receipt_idx ON paypal_funding_webhook_events (funding_receipt_id)",
    ),
    db.prepare(`CREATE TABLE IF NOT EXISTS notification_outbox (
      id TEXT PRIMARY KEY NOT NULL,
      event_key TEXT NOT NULL,
      job_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payout_reference TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      lease_token TEXT,
      lease_expires_at INTEGER,
      provider_message_id TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      sent_at INTEGER
    )`),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_event_key_idx ON notification_outbox (event_key)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS notification_outbox_delivery_idx ON notification_outbox (status, next_attempt_at, lease_expires_at)",
    ),
    db.prepare(`CREATE TABLE IF NOT EXISTS sponsor_order_request_limits (
      owner_email TEXT PRIMARY KEY NOT NULL,
      window_started_at INTEGER NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 1 CHECK (request_count >= 1),
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sponsor_task_orders (
      id TEXT PRIMARY KEY NOT NULL,
      owner_email TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      task_type TEXT NOT NULL DEFAULT 'dataset_summary'
        CHECK (task_type = 'dataset_summary'),
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      input_json TEXT NOT NULL,
      acceptance_json TEXT NOT NULL,
      min_answer_chars INTEGER NOT NULL DEFAULT 120,
      automation_allowed INTEGER NOT NULL DEFAULT 0,
      auto_accept INTEGER NOT NULL DEFAULT 0,
      rights_attested INTEGER NOT NULL DEFAULT 0,
      no_sensitive_data INTEGER NOT NULL DEFAULT 0,
      attestation_version TEXT NOT NULL,
      attested_at INTEGER NOT NULL,
      sponsor_reference TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
      gross_cents INTEGER NOT NULL DEFAULT 800 CHECK (gross_cents = 800),
      minimum_net_cents INTEGER NOT NULL DEFAULT 600 CHECK (minimum_net_cents >= 600),
      payout_cents INTEGER NOT NULL DEFAULT 500 CHECK (payout_cents = 500),
      paypal_order_id TEXT,
      paypal_capture_id TEXT,
      funded_task_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'order_created', 'capture_pending', 'capture_retry', 'funded', 'canceled', 'needs_review')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      lease_token TEXT,
      lease_expires_at INTEGER,
      last_error_code TEXT,
      last_error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      CHECK (automation_allowed = 1 AND auto_accept = 1),
      CHECK (rights_attested = 1 AND no_sensitive_data = 1),
      CHECK (status <> 'funded' OR (
        paypal_order_id IS NOT NULL AND paypal_capture_id IS NOT NULL AND
        funded_task_id IS NOT NULL AND completed_at IS NOT NULL
      )),
      FOREIGN KEY (funded_task_id) REFERENCES funded_tasks(id)
    )`),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS sponsor_task_orders_owner_request_idx ON sponsor_task_orders (owner_email, client_request_id)",
    ),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS sponsor_task_orders_reference_idx ON sponsor_task_orders (sponsor_reference)",
    ),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS sponsor_task_orders_paypal_order_idx ON sponsor_task_orders (paypal_order_id)",
    ),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS sponsor_task_orders_paypal_capture_idx ON sponsor_task_orders (paypal_capture_id)",
    ),
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS sponsor_task_orders_funded_task_idx ON sponsor_task_orders (funded_task_id)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS sponsor_task_orders_owner_created_idx ON sponsor_task_orders (owner_email, created_at)",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS sponsor_task_orders_capture_idx ON sponsor_task_orders (status, next_attempt_at, lease_expires_at)",
    ),
  ]);
  return db;
}

function normalizeOwnerEmail(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("A verified owner email is required for a live reward.");
  }
  return normalized;
}

function normalizePayPalDestination(value: string) {
  let normalized = value.trim();
  if (!normalized || normalized.length > 127) {
    throw new Error("A valid PayPal payout destination is required.");
  }
  const digits = normalized.replace(/\D/g, "");
  if (/^\+?[\d\s().-]+$/.test(normalized) && digits.length >= 7) {
    normalized = normalized.startsWith("+") ? `+${digits}` : digits;
  }
  return normalized.includes("@") ? normalized.toLowerCase() : normalized;
}

function maskDestination(value: string) {
  if (value.includes("@")) {
    const [local, domain] = value.split("@", 2);
    const hint =
      local.length <= 2 ? `${local[0] ?? "•"}••` : `${local[0]}•••${local.at(-1)}`;
    return `${hint}@${domain}`;
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 7) return `••• ••• ${digits.slice(-4)}`;
  return `${value[0] ?? "•"}•••${value.at(-1) ?? "•"}`;
}

async function liveJobRow(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM live_jobs WHERE id = ? LIMIT 1").bind(id).first<LiveJobRow>();
}

async function payoutForJob(db: D1Database, jobId: string) {
  return db
    .prepare("SELECT * FROM payouts WHERE job_id = ? LIMIT 1")
    .bind(jobId)
    .first<PayoutRow>();
}

function statusStep(job: LiveJobRow) {
  switch (job.status) {
    case "no_inventory":
      return 1;
    case "queued":
      return 1;
    case "earning":
    case "retry_wait":
      return job.earned_cents >= 500 ? 4 : 2;
    case "needs_review":
    case "earned":
      return 3;
    case "payout_pending":
    case "needs_action":
      return 4;
    case "payout_submitting":
      return 4;
    case "paid":
      return 5;
    case "reversed":
      return 5;
    case "failed":
      return job.earned_cents >= 500 ? 4 : 2;
  }
}

function statusCopy(job: LiveJobRow) {
  switch (job.status) {
    case "no_inventory":
      return {
        headline: "You’re first in line.",
        message: "No funded $5 task is available yet. Your encrypted request is waiting for inventory.",
      };
    case "queued":
      return {
        headline: "A funded task is reserved.",
        message: "The agent is queued to complete work the sponsor explicitly approved for automation.",
      };
    case "earning":
      return {
        headline: "Five is doing the work.",
        message: "The AI is producing and checking the sponsor deliverable now.",
      };
    case "needs_review":
      return {
        headline: "A human check is needed.",
        message: "The deliverable did not meet the task’s automatic acceptance contract, so no payout was started.",
      };
    case "earned":
      return {
        headline: "Your $5 was earned.",
        message: "The funded task accepted the deliverable. The payout is next.",
      };
    case "retry_wait":
      return {
        headline: "The agent will retry safely.",
        message: "A temporary provider problem interrupted the workflow; no duplicate task or payout will be created.",
      };
    case "payout_pending":
      return {
        headline: "Your payout is processing.",
        message: "PayPal has the $5 request. We will call it paid only after item-level success confirmation.",
      };
    case "payout_submitting":
      return {
        headline: "Submitting your payout safely.",
        message: "Five is creating one idempotent PayPal payout and will wait for item-level confirmation.",
      };
    case "needs_action":
      return {
        headline: "PayPal needs your attention.",
        message: "The payout is held, blocked, or unclaimed. Check the message from PayPal for the next step.",
      };
    case "paid":
      return {
        headline: "Your $5 has arrived.",
        message: "PayPal confirmed that the individual payout item succeeded.",
      };
    case "reversed":
      return {
        headline: "PayPal reversed the payout.",
        message: "The payout was previously successful, but PayPal later reported it returned or refunded. Support must review it.",
      };
    case "failed":
      return {
        headline: "This request needs support.",
        message: "The workflow stopped without claiming a successful payout. No duplicate payout will be attempted automatically.",
      };
  }
}

async function publicLiveJob(db: D1Database, job: LiveJobRow): Promise<PublicLiveJob> {
  const [eventResult, payout] = await Promise.all([
    db
      .prepare(
        "SELECT kind, title, detail, created_at FROM live_job_events WHERE job_id = ? ORDER BY created_at, id",
      )
      .bind(job.id)
      .all<LiveEventRow>(),
    payoutForJob(db, job.id),
  ]);
  const eventTimes = new Map<string, string>();
  for (const event of eventResult.results) {
    if (!eventTimes.has(event.kind)) {
      eventTimes.set(event.kind, new Date(event.created_at).toISOString());
    }
  }
  const currentStep = statusStep(job);
  const copy = statusCopy(job);
  return {
    id: job.id,
    requestCode: `FIVE-${job.id.slice(0, 6).toUpperCase()}`,
    amountCents: job.amount_cents,
    mode: "live",
    payoutMethod: "paypal",
    payoutMethodLabel: "PayPal",
    destinationHint: job.destination_hint,
    status: job.status,
    progress: Math.round(((currentStep + 1) / LIVE_STEPS.length) * 100),
    headline: copy.headline,
    message: copy.message,
    payoutReference: ["paid", "reversed"].includes(job.status)
      ? payout?.provider_item_id ?? null
      : null,
    createdAt: new Date(job.created_at).toISOString(),
    completedAt: job.completed_at ? new Date(job.completed_at).toISOString() : null,
    activities: LIVE_STEPS.map((step, index) => {
      const occurredAt = step.kinds.map((kind) => eventTimes.get(kind)).find(Boolean) ?? null;
      return {
        step: index,
        title:
          index === LIVE_STEPS.length - 1 && job.status === "reversed"
            ? "Payout reversed"
            : index === 1 && job.status === "no_inventory"
            ? "Waiting for a funded task"
            : step.title,
        detail:
          index === LIVE_STEPS.length - 1 && job.status === "reversed"
            ? "PayPal later reported that the payout was returned or refunded; support must review it."
            : index === 1 && job.status === "no_inventory"
            ? "A sponsor must pre-fund an automation-approved task before Five can earn the reward."
            : step.detail,
        state:
          index < currentStep
            ? "done"
            : index === currentStep && !["paid", "reversed"].includes(job.status)
              ? "active"
              : index === currentStep
                ? "done"
                : "pending",
        occurredAt:
          index === LIVE_STEPS.length - 1 && job.status === "reversed"
            ? eventTimes.get("payout_reversed") ?? occurredAt
            : occurredAt,
      };
    }),
  };
}

export async function createLiveJob(input: {
  ownerEmail: string;
  payoutMethod: "paypal";
  destination: string;
  runtime?: RuntimeEnv;
}) {
  const runtime = input.runtime ?? getRuntimeEnv();
  const db = await ensureLiveDatabase(runtime);
  const ownerEmail = normalizeOwnerEmail(input.ownerEmail);
  const destination = normalizePayPalDestination(input.destination);
  const fingerprint = await fingerprintPayoutDestination("paypal", destination, runtime);

  const existing = await db
    .prepare(
      "SELECT * FROM live_jobs WHERE owner_email = ? OR destination_fingerprint = ? ORDER BY created_at LIMIT 1",
    )
    .bind(ownerEmail, fingerprint)
    .first<LiveJobRow>();
  if (existing) {
    if (existing.owner_email !== ownerEmail) {
      throw new Error("This payout destination is already attached to a reward request.");
    }
    return publicLiveJob(db, existing);
  }

  const id = crypto.randomUUID();
  // Validate and encrypt before writing the request. Inventory is matched only
  // after the durable job exists, so a process crash cannot strand a task on a
  // job ID that was never committed.
  const ciphertext = await encryptPayoutDestination(destination, runtime);
  const now = Date.now();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO live_jobs
           (id, owner_email, payout_method, destination_ciphertext,
            destination_fingerprint, destination_hint, amount_cents, status,
            task_id, created_at, updated_at)
           VALUES (?, ?, 'paypal', ?, ?, ?, 500, 'no_inventory', NULL, ?, ?)`,
        )
        .bind(
          id,
          ownerEmail,
          ciphertext,
          fingerprint,
          maskDestination(destination),
          now,
          now,
        ),
      db
        .prepare(
          `INSERT INTO live_job_events
           (event_key, job_id, kind, title, detail, created_at)
           VALUES (?, ?, 'request_received', 'Request received', ?, ?)`,
        )
        .bind(
          `job:${id}:received`,
          id,
          "The encrypted request is waiting for funded task inventory.",
          now,
        ),
    ]);
  } catch (error) {
    const raced = await db
      .prepare("SELECT * FROM live_jobs WHERE owner_email = ? LIMIT 1")
      .bind(ownerEmail)
      .first<LiveJobRow>();
    if (raced) return publicLiveJob(db, raced);
    throw error;
  }

  await matchOneWaitingJob(db);

  const job = await liveJobRow(db, id);
  if (!job) throw new Error("The live reward request could not be created.");
  return publicLiveJob(db, job);
}

export async function getLiveJobForOwner(
  id: string,
  ownerEmail: string,
  runtime: RuntimeEnv = getRuntimeEnv(),
) {
  const db = await ensureLiveDatabase(runtime);
  const job = await db
    .prepare("SELECT * FROM live_jobs WHERE id = ? AND owner_email = ? LIMIT 1")
    .bind(id, normalizeOwnerEmail(ownerEmail))
    .first<LiveJobRow>();
  return job ? publicLiveJob(db, job) : null;
}

async function terminalFundingEventForCapture(
  db: D1Database,
  captureId: string,
) {
  return db
    .prepare(
      `SELECT event_id, terminal_status
       FROM paypal_funding_webhook_events
       WHERE capture_id = ? LIMIT 1`,
    )
    .bind(captureId)
    .first<{ event_id: string; terminal_status: string }>();
}

export async function createFundedTask(
  rawSpec: unknown,
  fundingCapture: PayPalFundingCapture,
  runtime: RuntimeEnv = getRuntimeEnv(),
) {
  const spec: ValidatedFundedTask = validateFundedTaskSpec(rawSpec);
  if (
    fundingCapture.provider !== "paypal" ||
    fundingCapture.captureId !== spec.fundingCaptureId ||
    fundingCapture.status !== "COMPLETED" ||
    fundingCapture.currency !== "USD" ||
    fundingCapture.netCents < spec.rewardCents ||
    fundingCapture.customId !== spec.sponsorReference
  ) {
    throw new Error(
      "The PayPal capture does not prove settled USD funding for this exact sponsor task.",
    );
  }
  const capturedAt = Date.parse(fundingCapture.capturedAt);
  if (!Number.isFinite(capturedAt)) {
    throw new Error("The PayPal funding capture timestamp is invalid.");
  }
  const db = await ensureLiveDatabase(runtime);
  const now = Date.now();
  const id = crypto.randomUUID();
  const receiptId = `paypal:${fundingCapture.captureId}`;
  if (await terminalFundingEventForCapture(db, fundingCapture.captureId)) {
    throw new FundingCaptureTerminalError();
  }
  try {
    const inserted = await db.batch([
      db
        .prepare(
          `INSERT INTO funded_tasks
           (id, task_type, title, instructions, input_json, reward_cents,
            payout_cents, automation_allowed, auto_accept, min_answer_chars,
            acceptance_json, sponsor_reference, funding_receipt_id, status,
            created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, 500, 1, 1, ?, ?, ?, ?, 'available', ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM paypal_funding_webhook_events WHERE capture_id = ?
           )`,
        )
        .bind(
          id,
          spec.taskType,
          spec.title,
          spec.instructions,
          spec.inputJson,
          spec.rewardCents,
          spec.minAnswerChars,
          spec.acceptanceJson,
          spec.sponsorReference,
          receiptId,
          now,
          now,
          fundingCapture.captureId,
        ),
      db
        .prepare(
          `INSERT INTO funding_receipts
           (id, provider, provider_transaction_id, sponsor_reference, currency,
            gross_cents, net_cents, status, captured_at, task_id, created_at)
           SELECT ?, 'paypal', ?, ?, 'USD', ?, ?, 'COMPLETED', ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM funded_tasks
             WHERE id = ? AND funding_receipt_id = ?
           ) AND NOT EXISTS (
             SELECT 1 FROM paypal_funding_webhook_events WHERE capture_id = ?
           )`,
        )
        .bind(
          receiptId,
          fundingCapture.captureId,
          spec.sponsorReference,
          fundingCapture.grossCents,
          fundingCapture.netCents,
          capturedAt,
          id,
          now,
          id,
          receiptId,
          fundingCapture.captureId,
        ),
    ]);
    if (
      (inserted[0]?.meta.changes ?? 0) !== 1 ||
      (inserted[1]?.meta.changes ?? 0) !== 1
    ) {
      if (await terminalFundingEventForCapture(db, fundingCapture.captureId)) {
        throw new FundingCaptureTerminalError();
      }
      throw new Error("The funded task and receipt were not recorded atomically.");
    }
  } catch (error) {
    const existing = await db
      .prepare(
        `SELECT ft.id, ft.task_type, ft.title, ft.instructions, ft.input_json,
                ft.reward_cents, ft.payout_cents, ft.automation_allowed,
                ft.auto_accept, ft.min_answer_chars, ft.acceptance_json,
                ft.sponsor_reference, ft.funding_receipt_id, ft.status,
                fr.currency AS receipt_currency,
                fr.gross_cents AS receipt_gross_cents,
                fr.net_cents AS receipt_net_cents,
                fr.status AS receipt_status,
                fr.captured_at AS receipt_captured_at
         FROM funding_receipts fr
         JOIN funded_tasks ft ON ft.id = fr.task_id
         WHERE fr.provider = 'paypal' AND fr.provider_transaction_id = ?
           AND fr.sponsor_reference = ? LIMIT 1`,
      )
      .bind(fundingCapture.captureId, spec.sponsorReference)
      .first<{
        id: string;
        task_type: string;
        title: string;
        instructions: string;
        input_json: string;
        reward_cents: number;
        payout_cents: number;
        automation_allowed: number;
        auto_accept: number;
        min_answer_chars: number;
        acceptance_json: string;
        sponsor_reference: string;
        funding_receipt_id: string;
        status: string;
        receipt_currency: string;
        receipt_gross_cents: number;
        receipt_net_cents: number;
        receipt_status: string;
        receipt_captured_at: number;
      }>();
    if (existing) {
      const exactContract =
        existing.task_type === spec.taskType &&
        existing.title === spec.title &&
        existing.instructions === spec.instructions &&
        existing.input_json === spec.inputJson &&
        existing.reward_cents === spec.rewardCents &&
        existing.payout_cents === spec.payoutCents &&
        existing.automation_allowed === spec.automationAllowed &&
        existing.auto_accept === spec.autoAccept &&
        existing.min_answer_chars === spec.minAnswerChars &&
        existing.acceptance_json === spec.acceptanceJson &&
        existing.funding_receipt_id === receiptId &&
        existing.receipt_currency === fundingCapture.currency &&
        existing.receipt_gross_cents === fundingCapture.grossCents &&
        existing.receipt_net_cents === fundingCapture.netCents &&
        existing.receipt_status === fundingCapture.status &&
        existing.receipt_captured_at === capturedAt;
      if (!exactContract) {
        throw new Error(
          "This PayPal capture is already bound to a different immutable task contract.",
        );
      }
      return {
        id: existing.id,
        sponsorReference: existing.sponsor_reference,
        status: existing.status,
        duplicate: true as const,
      };
    }
    throw error;
  }
  return { id, sponsorReference: spec.sponsorReference, status: "available" as const };
}

async function matchOneWaitingJob(db: D1Database) {
  const waiting = await db
    .prepare("SELECT id FROM live_jobs WHERE status = 'no_inventory' ORDER BY created_at LIMIT 1")
    .first<{ id: string }>();
  if (!waiting) return false;
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `UPDATE funded_tasks
         SET status = 'leased', lease_job_id = ?, updated_at = ?
         WHERE id = (
           SELECT ft.id FROM funded_tasks ft
           JOIN funding_receipts fr ON fr.id = ft.funding_receipt_id
           WHERE ft.status = 'available'
             AND ft.automation_allowed = 1
             AND ft.auto_accept = 1
             AND ft.reward_cents >= 600
             AND ft.payout_cents = 500
             AND fr.provider = 'paypal'
             AND fr.status = 'COMPLETED'
             AND fr.currency = 'USD'
             AND fr.net_cents >= ft.reward_cents
           ORDER BY ft.created_at ASC
           LIMIT 1
         )
         AND status = 'available'
         AND EXISTS (
           SELECT 1 FROM live_jobs WHERE id = ? AND status = 'no_inventory'
         )`,
      )
      .bind(waiting.id, now, waiting.id),
    db
      .prepare(
        `UPDATE live_jobs
         SET task_id = (
           SELECT id FROM funded_tasks
           WHERE lease_job_id = ? AND status = 'leased' LIMIT 1
         ), status = 'queued', updated_at = ?
         WHERE id = ? AND status = 'no_inventory'
           AND EXISTS (
             SELECT 1 FROM funded_tasks
             WHERE lease_job_id = ? AND status = 'leased'
           )`,
      )
      .bind(waiting.id, now, waiting.id, waiting.id),
    db
      .prepare(
        `INSERT OR IGNORE INTO live_job_events
         (event_key, job_id, kind, title, detail, created_at)
         SELECT 'job:' || ? || ':task:' || task_id, ?, 'task_reserved',
                'Funded task reserved', ?, ?
         FROM live_jobs
         WHERE id = ? AND status = 'queued' AND task_id IS NOT NULL`,
      )
      .bind(
        waiting.id,
        waiting.id,
        "A verified, pre-funded, automation-approved sponsor task was assigned.",
        now,
        waiting.id,
      ),
    db
      .prepare(
        `UPDATE funded_tasks
         SET status = 'available', lease_job_id = NULL, updated_at = ?
         WHERE lease_job_id = ? AND status = 'leased'
           AND NOT EXISTS (
             SELECT 1 FROM live_jobs
             WHERE id = ? AND task_id = funded_tasks.id AND status = 'queued'
           )`,
      )
      .bind(now, waiting.id, waiting.id),
  ]);
  const matched = await liveJobRow(db, waiting.id);
  return matched?.status === "queued";
}

export async function claimLiveJob(
  requestedJobId?: string,
  runtime: RuntimeEnv = getRuntimeEnv(),
) {
  const db = await ensureLiveDatabase(runtime);
  await matchOneWaitingJob(db);
  const now = Date.now();
  const token = crypto.randomUUID();
  const leaseExpiresAt = now + 60_000;
  const idFilter = requestedJobId ? "AND id = ?" : "";
  const statement = db.prepare(
    `UPDATE live_jobs
     SET lease_token = ?, lease_expires_at = ?, attempts = attempts + 1,
         status = CASE WHEN earned_cents >= 500 THEN 'payout_submitting' ELSE 'earning' END,
         updated_at = ?
     WHERE id = (
       SELECT id FROM live_jobs
       WHERE status IN ('queued', 'retry_wait', 'earned', 'earning', 'payout_submitting', 'payout_pending')
         ${idFilter}
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         AND (lease_expires_at IS NULL OR lease_expires_at < ?)
       ORDER BY created_at
       LIMIT 1
     )
     RETURNING *`,
  );
  const bound = requestedJobId
    ? statement.bind(token, leaseExpiresAt, now, requestedJobId, now, now)
    : statement.bind(token, leaseExpiresAt, now, now, now);
  const job = await bound.first<LiveJobRow>();
  if (!job) return null;

  const payoutStage = job.earned_cents >= 500;
  await db
    .prepare(
      `INSERT OR IGNORE INTO live_job_events
       (event_key, job_id, kind, title, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `job:${job.id}:${payoutStage ? "payout" : "earning"}-attempt:${job.attempts}`,
      job.id,
      payoutStage ? "payout_started" : "earning_started",
      payoutStage ? "Payout submission started" : "AI work started",
      payoutStage
        ? "The processor resumed at the payout step."
        : "The agent began the approved sponsor task.",
      now,
    )
    .run();
  return job;
}

export async function taskForLiveJob(
  job: LiveJobRow,
  runtime: RuntimeEnv = getRuntimeEnv(),
) {
  if (!job.task_id) return null;
  const db = await ensureLiveDatabase(runtime);
  return db
    .prepare(
      `SELECT ft.*,
              fr.provider AS funding_provider,
              fr.provider_transaction_id AS funding_capture_id,
              fr.status AS funding_status,
              fr.currency AS funding_currency,
              fr.gross_cents AS funding_gross_cents,
              fr.net_cents AS funding_net_cents
       FROM funded_tasks ft
       JOIN funding_receipts fr ON fr.id = ft.funding_receipt_id
       WHERE ft.id = ? AND ft.lease_job_id = ?
         AND fr.provider = 'paypal' AND fr.status = 'COMPLETED'
         AND fr.currency = 'USD' AND fr.net_cents >= ft.reward_cents
       LIMIT 1`,
    )
    .bind(job.task_id, job.id)
    .first<FundedTaskRow>();
}

export async function decryptLiveJobDestination(
  job: LiveJobRow,
  runtime: RuntimeEnv = getRuntimeEnv(),
) {
  const destination = await decryptPayoutDestination(job.destination_ciphertext, runtime);
  const fingerprint = await fingerprintPayoutDestination(
    job.payout_method,
    normalizePayPalDestination(destination),
    runtime,
  );
  if (!(await constantTimeSecretEqual(fingerprint, job.destination_fingerprint))) {
    throw new Error("The encrypted payout destination does not match its integrity fingerprint.");
  }
  return destination;
}

export async function markEarningAccepted(input: {
  job: LiveJobRow;
  task: FundedTaskRow;
  submission: unknown;
  answerLength: number;
  acceptancePassed: boolean;
  responseId: string;
  model: string;
  runtime?: RuntimeEnv;
}) {
  const runtime = input.runtime ?? getRuntimeEnv();
  const db = await ensureLiveDatabase(runtime);
  if (
    input.task.auto_accept !== 1 ||
    input.answerLength < input.task.min_answer_chars ||
    !input.acceptancePassed
  ) {
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          `UPDATE live_jobs SET status = 'needs_review', lease_token = NULL,
           lease_expires_at = NULL, updated_at = ?, last_error_code = 'acceptance_check',
           last_error_message = 'The deliverable did not satisfy automatic acceptance.'
           WHERE id = ? AND lease_token = ? AND status = 'earning' AND task_id = ?`,
        )
        .bind(now, input.job.id, input.job.lease_token, input.task.id),
      db
        .prepare(
          `INSERT OR IGNORE INTO live_job_events
           (event_key, job_id, kind, title, detail, created_at)
           SELECT ?, ?, 'needs_review', 'Human review needed', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM live_jobs WHERE id = ? AND status = 'needs_review'
           )`,
        )
        .bind(
          `job:${input.job.id}:review`,
          input.job.id,
          "The deliverable did not meet the sponsor's automatic acceptance contract.",
          now,
          input.job.id,
        ),
    ]);
    return false;
  }

  const submissionJson = JSON.stringify(input.submission);
  if (submissionJson.length > 80_000) {
    throw new Error("The sponsor submission is too large to store.");
  }
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `UPDATE live_jobs SET status = 'earned', earned_cents = 500,
         submission_json = ?, model_response_id = ?, model_name = ?,
         lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
         attempts = 0, last_error_code = NULL, last_error_message = NULL, updated_at = ?
         WHERE id = ? AND lease_token = ? AND status = 'earning' AND task_id = ?`,
      )
      .bind(
        submissionJson,
        input.responseId,
        input.model,
        now,
        input.job.id,
        input.job.lease_token,
        input.task.id,
      ),
    db
      .prepare(
        `UPDATE funded_tasks SET status = 'accepted', accepted_at = ?, updated_at = ?
         WHERE id = ? AND lease_job_id = ? AND status = 'leased'
           AND EXISTS (
             SELECT 1 FROM live_jobs
             WHERE id = ? AND status = 'earned' AND model_response_id = ?
           )`,
      )
      .bind(
        now,
        now,
        input.task.id,
        input.job.id,
        input.job.id,
        input.responseId,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO live_job_events
         (event_key, job_id, kind, title, detail, created_at)
         SELECT ?, ?, 'earning_accepted', 'Revenue accepted', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM live_jobs
           WHERE id = ? AND status = 'earned' AND model_response_id = ?
         )`,
      )
      .bind(
        `job:${input.job.id}:earned`,
        input.job.id,
        "The pre-funded task contract accepted the checked deliverable and released $5 for payout.",
        now,
        input.job.id,
        input.responseId,
      ),
  ]);
  const updated = await liveJobRow(db, input.job.id);
  return updated?.status === "earned" && updated.model_response_id === input.responseId;
}

export async function getOrCreatePayout(
  jobId: string,
  ids: { senderBatchId: string; senderItemId: string },
  runtime: RuntimeEnv = getRuntimeEnv(),
) {
  const db = await ensureLiveDatabase(runtime);
  const now = Date.now();
  await db
    .prepare(
      `INSERT OR IGNORE INTO payouts
       (id, job_id, sender_batch_id, sender_item_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'created', ?, ?)`,
    )
    .bind(`payout:${jobId}`, jobId, ids.senderBatchId, ids.senderItemId, now, now)
    .run();
  const payout = await payoutForJob(db, jobId);
  if (!payout) throw new Error("The payout ledger could not be created.");
  return payout;
}

export async function markPayoutPending(input: {
  job: LiveJobRow;
  payoutBatchId: string;
  batchStatus: string;
  senderBatchId: string;
  senderItemId: string;
  runtime?: RuntimeEnv;
}) {
  const db = await ensureLiveDatabase(input.runtime ?? getRuntimeEnv());
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `UPDATE live_jobs SET status = 'payout_pending', provider_status = ?,
         lease_token = NULL, lease_expires_at = NULL, next_attempt_at = ?,
         attempts = 0,
         last_error_code = NULL, last_error_message = NULL, updated_at = ?
         WHERE id = ? AND status = 'payout_submitting' AND lease_token = ?
           AND earned_cents >= 500`,
      )
      .bind(
        input.batchStatus,
        now + 5 * 60_000,
        now,
        input.job.id,
        input.job.lease_token,
      ),
    db
      .prepare(
        `UPDATE payouts SET provider_batch_id = COALESCE(provider_batch_id, ?),
         status = CASE
           WHEN status IN ('SUCCEEDED', 'RETURNED', 'REFUNDED') THEN status
           ELSE ?
         END,
         updated_at = ?
         WHERE job_id = ? AND sender_batch_id = ? AND sender_item_id = ?
           AND EXISTS (
             SELECT 1 FROM live_jobs
             WHERE id = ? AND status = 'payout_pending' AND provider_status = ?
           )`,
      )
      .bind(
        input.payoutBatchId,
        input.batchStatus,
        now,
        input.job.id,
        input.senderBatchId,
        input.senderItemId,
        input.job.id,
        input.batchStatus,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO live_job_events
         (event_key, job_id, kind, title, detail, created_at)
         SELECT ?, ?, 'payout_submitted', 'Payout submitted', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM live_jobs
           WHERE id = ? AND status = 'payout_pending' AND provider_status = ?
         )`,
      )
      .bind(
        `job:${input.job.id}:payout-submitted`,
        input.job.id,
        "PayPal accepted the idempotent $5 payout request; item-level success is still required.",
        now,
        input.job.id,
        input.batchStatus,
      ),
  ]);
  const updated = await liveJobRow(db, input.job.id);
  return updated?.status === "payout_pending" || updated?.status === "paid";
}

function payoutState(itemStatus: string): {
  jobStatus: LiveJobStatus;
  kind: string;
  title: string;
  detail: string;
  terminal: boolean;
} {
  if (itemStatus === "SUCCEEDED") {
    return {
      jobStatus: "paid",
      kind: "payout_succeeded",
      title: "$5 payout confirmed",
      detail: "PayPal confirmed the individual $5 payout item succeeded.",
      terminal: true,
    };
  }
  if (["RETURNED", "REFUNDED"].includes(itemStatus)) {
    return {
      jobStatus: "reversed",
      kind: "payout_reversed",
      title: "Payout reversed",
      detail: "PayPal reported that the previously submitted payout was returned or refunded.",
      terminal: true,
    };
  }
  if (["UNCLAIMED", "HELD", "BLOCKED"].includes(itemStatus)) {
    return {
      jobStatus: "needs_action",
      kind: "payout_needs_action",
      title: "Payout needs attention",
      detail: "PayPal reports that the recipient must take action before the payout can complete.",
      terminal: false,
    };
  }
  if (["FAILED", "CANCELED"].includes(itemStatus)) {
    return {
      jobStatus: "failed",
      kind: "payout_failed",
      title: "Payout failed",
      detail: "PayPal reported a terminal item-level payout failure.",
      terminal: true,
    };
  }
  return {
    jobStatus: "payout_pending",
    kind: "payout_processing",
    title: "Payout still processing",
    detail: "PayPal has not yet reported a terminal result for the individual payout item.",
    terminal: false,
  };
}

function canonicalPayoutItemStatus(itemStatus: string) {
  if (itemStatus === "SUCCESS") return "SUCCEEDED";
  if (itemStatus === "ONHOLD") return "HELD";
  if (itemStatus === "REVERSED") return "RETURNED";
  return itemStatus;
}

/** Applies authenticated PayPal GET state while respecting the active lease. */
export async function applyPayPalPayoutObservation(input: {
  job: LiveJobRow;
  observation: PayPalPayoutBatchObservation;
  runtime?: RuntimeEnv;
}) {
  const db = await ensureLiveDatabase(input.runtime ?? getRuntimeEnv());
  const payout = await payoutForJob(db, input.job.id);
  if (
    !payout ||
    payout.provider_batch_id !== input.observation.payoutBatchId ||
    payout.sender_batch_id !== input.observation.senderBatchId ||
    payout.sender_item_id !== input.observation.senderItemId
  ) {
    throw new Error("PayPal payout reconciliation identifiers do not match the ledger.");
  }
  const itemStatus = canonicalPayoutItemStatus(input.observation.itemStatus);
  const state = payoutState(itemStatus);
  const now = Date.now();
  const nextAttemptAt = state.jobStatus === "payout_pending" ? now + 5 * 60_000 : null;
  await db.batch([
    db
      .prepare(
        `UPDATE live_jobs SET status = ?, provider_status = ?,
         lease_token = NULL, lease_expires_at = NULL, next_attempt_at = ?,
         attempts = 0,
         last_error_code = NULL, last_error_message = NULL, updated_at = ?,
         completed_at = CASE WHEN ? IN ('paid', 'reversed', 'failed')
                             THEN COALESCE(completed_at, ?) ELSE completed_at END
         WHERE id = ? AND status = 'payout_submitting' AND lease_token = ?
           AND earned_cents >= 500`,
      )
      .bind(
        state.jobStatus,
        itemStatus,
        nextAttemptAt,
        now,
        state.jobStatus,
        now,
        input.job.id,
        input.job.lease_token,
      ),
    db
      .prepare(
        `UPDATE payouts SET provider_item_id = COALESCE(provider_item_id, ?),
         status = ?, updated_at = ?
         WHERE id = ? AND EXISTS (
           SELECT 1 FROM live_jobs WHERE id = ? AND status = ?
             AND provider_status = ?
         )`,
      )
      .bind(
        input.observation.providerItemId,
        itemStatus,
        now,
        payout.id,
        input.job.id,
        state.jobStatus,
        itemStatus,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO live_job_events
         (event_key, job_id, kind, title, detail, created_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM live_jobs WHERE id = ? AND status = ?
             AND provider_status = ?
         )`,
      )
      .bind(
        `paypal-observation:${payout.id}:${itemStatus}`,
        input.job.id,
        state.kind,
        state.title,
        state.detail,
        now,
        input.job.id,
        state.jobStatus,
        itemStatus,
      ),
    ...(state.jobStatus === "paid" && input.observation.providerItemId
      ? [
          db
            .prepare(
              `INSERT OR IGNORE INTO notification_outbox
               (id, event_key, job_id, kind, payout_reference, status,
                created_at, updated_at)
               SELECT ?, ?, ?, 'payout_arrived', ?, 'pending', ?, ?
               WHERE EXISTS (
                 SELECT 1 FROM live_jobs WHERE id = ? AND status = 'paid'
               )`,
            )
            .bind(
              `notification:${input.job.id}:payout-arrived`,
              `job:${input.job.id}:payout-arrived`,
              input.job.id,
              input.observation.providerItemId,
              now,
              now,
              input.job.id,
            ),
        ]
      : []),
    ...(state.jobStatus === "reversed" &&
    (input.observation.providerItemId ?? payout.provider_item_id)
      ? [
          db
            .prepare(
              `UPDATE notification_outbox
               SET status = 'canceled', lease_token = NULL, lease_expires_at = NULL,
                   next_attempt_at = NULL, updated_at = ?,
                   last_error = 'Payout reversed before arrival notice completed.'
               WHERE job_id = ? AND kind = 'payout_arrived'
                 AND status IN ('pending', 'retry_wait', 'sending')
                 AND EXISTS (
                   SELECT 1 FROM live_jobs WHERE id = ? AND status = 'reversed'
                 )`,
            )
            .bind(now, input.job.id, input.job.id),
          db
            .prepare(
              `INSERT OR IGNORE INTO notification_outbox
               (id, event_key, job_id, kind, payout_reference, status,
                created_at, updated_at)
               SELECT ?, ?, ?, 'payout_reversed', ?, 'pending', ?, ?
               WHERE EXISTS (
                 SELECT 1 FROM live_jobs WHERE id = ? AND status = 'reversed'
               )`,
            )
            .bind(
              `notification:${input.job.id}:payout-reversed`,
              `job:${input.job.id}:payout-reversed`,
              input.job.id,
              input.observation.providerItemId ?? payout.provider_item_id,
              now,
              now,
              input.job.id,
            ),
        ]
      : []),
  ]);
  const updated = await liveJobRow(db, input.job.id);
  return updated?.status ?? null;
}

function safeErrorCode(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 60) || "processor_error";
}

function safeErrorMessage(value: string) {
  return value.replace(/[\r\n]+/g, " ").slice(0, 240) || "A provider operation failed.";
}

export async function markLiveJobRetry(input: {
  job: LiveJobRow;
  code: string;
  message: string;
  retryable: boolean;
  runtime?: RuntimeEnv;
}) {
  const db = await ensureLiveDatabase(input.runtime ?? getRuntimeEnv());
  const now = Date.now();
  const exhausted = !input.retryable || input.job.attempts >= 4;
  const payoutStage = input.job.earned_cents >= 500;
  const status: LiveJobStatus = exhausted
    ? payoutStage
      ? "needs_action"
      : "failed"
    : "retry_wait";
  const delayMs = Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, input.job.attempts - 1));
  await db.batch([
    db
      .prepare(
        `UPDATE live_jobs SET status = ?, next_attempt_at = ?, lease_token = NULL,
         lease_expires_at = NULL, last_error_code = ?, last_error_message = ?, updated_at = ?
         WHERE id = ? AND lease_token = ?
           AND status IN ('earning', 'payout_submitting')`,
      )
      .bind(
        status,
        exhausted ? null : now + delayMs,
        safeErrorCode(input.code),
        safeErrorMessage(input.message),
        now,
        input.job.id,
        input.job.lease_token,
      ),
    ...(exhausted && input.job.earned_cents < 500
      ? [
          db
            .prepare(
              `UPDATE funded_tasks SET status = 'rejected', updated_at = ?
               WHERE lease_job_id = ? AND status = 'leased'
                 AND EXISTS (
                   SELECT 1 FROM live_jobs
                   WHERE id = ? AND status = 'failed' AND last_error_code = ?
                 )`,
            )
            .bind(
              now,
              input.job.id,
              input.job.id,
              safeErrorCode(input.code),
            ),
          ...(input.code === "funding_no_longer_settled"
            ? [
                db
                  .prepare(
                    `UPDATE funding_receipts SET status = 'INVALIDATED'
                     WHERE task_id IN (
                       SELECT id FROM funded_tasks
                       WHERE lease_job_id = ? AND status = 'rejected'
                     )`,
                  )
                  .bind(input.job.id),
              ]
            : []),
        ]
      : []),
    db
      .prepare(
        `INSERT OR IGNORE INTO live_job_events
         (event_key, job_id, kind, title, detail, created_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM live_jobs WHERE id = ? AND status = ?
             AND last_error_code = ?
         )`,
      )
      .bind(
        `job:${input.job.id}:${input.job.earned_cents >= 500 ? "payout" : "earning"}-attempt:${input.job.attempts}:error`,
        input.job.id,
        exhausted ? (payoutStage ? "payout_needs_action" : "failed") : "retry_scheduled",
        exhausted
          ? payoutStage
            ? "Payout review required"
            : "Workflow stopped"
          : "Safe retry scheduled",
        exhausted
          ? payoutStage
            ? "Automatic reconciliation stopped without claiming a successful payout; support must check PayPal before any further action."
            : "The workflow stopped without recording a successful payout."
          : "A temporary provider error occurred; the idempotent workflow will retry.",
        now,
        input.job.id,
        status,
        safeErrorCode(input.code),
      ),
  ]);
  const updated = await liveJobRow(db, input.job.id);
  return updated?.status === status;
}

function stringField(value: unknown, max = 160) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

type FundingReceiptWebhookRow = {
  id: string;
  task_id: string;
  status: string;
};

type FundingWebhookEventRow = {
  event_type: string;
  funding_receipt_id: string | null;
  capture_id: string;
  terminal_status: string;
  provider_event_time: number;
  applied_at: number | null;
};

export async function applyPayPalFundingWebhook(
  rawEvent: string,
  runtime: RuntimeEnv = getRuntimeEnv(),
) {
  const parsed = parsePayPalFundingTerminalWebhook(rawEvent);
  if (!parsed) return { handled: false, reason: "unsupported_event" as const };

  const db = await ensureLiveDatabase(runtime);
  const existing = await db
    .prepare(
      `SELECT event_type, funding_receipt_id, capture_id, terminal_status,
              provider_event_time, applied_at
       FROM paypal_funding_webhook_events WHERE event_id = ? LIMIT 1`,
    )
    .bind(parsed.eventId)
    .first<FundingWebhookEventRow>();
  if (
    existing &&
    (existing.event_type !== parsed.eventType ||
      existing.capture_id !== parsed.captureId ||
      existing.terminal_status !== parsed.terminalStatus ||
      existing.provider_event_time !== parsed.providerEventTime)
  ) {
    throw new Error("PayPal funding webhook event conflicts with the durable ledger.");
  }

  // Persist the verified terminal event before looking for its receipt. D1
  // serializes this write against receipt creation: either the event wins and
  // fences creation, or the receipt wins and is found below for immediate
  // reversal. An early webhook is therefore never acknowledged and forgotten.
  const now = Date.now();
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO paypal_funding_webhook_events
       (event_id, event_type, funding_receipt_id, capture_id, terminal_status,
        provider_event_time, received_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    )
    .bind(
      parsed.eventId,
      parsed.eventType,
      parsed.captureId,
      parsed.terminalStatus,
      parsed.providerEventTime,
      now,
    )
    .run();
  const durableEvent = await db
    .prepare(
      `SELECT event_type, funding_receipt_id, capture_id, terminal_status,
              provider_event_time, applied_at
       FROM paypal_funding_webhook_events WHERE event_id = ? LIMIT 1`,
    )
    .bind(parsed.eventId)
    .first<FundingWebhookEventRow>();
  if (
    !durableEvent ||
    durableEvent.event_type !== parsed.eventType ||
    durableEvent.capture_id !== parsed.captureId ||
    durableEvent.terminal_status !== parsed.terminalStatus ||
    durableEvent.provider_event_time !== parsed.providerEventTime
  ) {
    throw new Error("PayPal funding webhook event conflicts with the durable ledger.");
  }

  const receipt = await db
    .prepare(
      `SELECT id, task_id, status FROM funding_receipts
       WHERE provider = 'paypal' AND provider_transaction_id = ? LIMIT 1`,
    )
    .bind(parsed.captureId)
    .first<FundingReceiptWebhookRow>();
  if (!receipt) {
    return {
      handled: true,
      duplicate: (inserted.meta.changes ?? 0) === 0,
      pendingReceipt: true,
      captureId: parsed.captureId,
    };
  }
  if (
    durableEvent.funding_receipt_id &&
    durableEvent.funding_receipt_id !== receipt.id
  ) {
    throw new Error("PayPal funding webhook event conflicts with the durable ledger.");
  }

  await db
    .prepare(
      `UPDATE paypal_funding_webhook_events
       SET funding_receipt_id = COALESCE(funding_receipt_id, ?)
       WHERE event_id = ? AND event_type = ? AND capture_id = ?
         AND terminal_status = ? AND provider_event_time = ?
         AND (funding_receipt_id IS NULL OR funding_receipt_id = ?)`,
    )
    .bind(
      receipt.id,
      parsed.eventId,
      parsed.eventType,
      parsed.captureId,
      parsed.terminalStatus,
      parsed.providerEventTime,
      receipt.id,
    )
    .run();
  const boundEvent = await db
    .prepare(
      `SELECT event_type, funding_receipt_id, capture_id, terminal_status,
              provider_event_time, applied_at
       FROM paypal_funding_webhook_events WHERE event_id = ? LIMIT 1`,
    )
    .bind(parsed.eventId)
    .first<FundingWebhookEventRow>();
  if (!boundEvent || boundEvent.funding_receipt_id !== receipt.id) {
    throw new Error("PayPal funding webhook event conflicts with the durable ledger.");
  }
  if (boundEvent.applied_at !== null) {
    return {
      handled: true,
      duplicate: true,
      captureId: parsed.captureId,
      receiptStatus: receipt.status,
      taskId: receipt.task_id,
    };
  }

  const terminalMessage = `PayPal reported the sponsor funding capture as ${parsed.terminalStatus}. Automatic work and payout stopped before a confirmed claimant payment.`;
  await db.batch([
    db
      .prepare(
        `UPDATE funding_receipts SET status = ?
         WHERE id = ? AND status NOT IN ('REFUNDED', 'REVERSED', 'DENIED')
           AND EXISTS (
             SELECT 1 FROM paypal_funding_webhook_events
             WHERE event_id = ? AND event_type = ? AND funding_receipt_id = ?
               AND capture_id = ? AND terminal_status = ? AND applied_at IS NULL
           )`,
      )
      .bind(
        parsed.terminalStatus,
        receipt.id,
        parsed.eventId,
        parsed.eventType,
        receipt.id,
        parsed.captureId,
        parsed.terminalStatus,
      ),
    db
      .prepare(
        `UPDATE funded_tasks SET status = 'funding_reversed', updated_at = ?
         WHERE id = ? AND status <> 'funding_reversed'
           AND EXISTS (
             SELECT 1 FROM paypal_funding_webhook_events
             WHERE event_id = ? AND event_type = ? AND funding_receipt_id = ?
               AND capture_id = ? AND terminal_status = ? AND applied_at IS NULL
           )`,
      )
      .bind(
        now,
        receipt.task_id,
        parsed.eventId,
        parsed.eventType,
        receipt.id,
        parsed.captureId,
        parsed.terminalStatus,
      ),
    db
      .prepare(
        `UPDATE sponsor_task_orders
         SET status = 'needs_review', next_attempt_at = NULL,
             lease_token = NULL, lease_expires_at = NULL,
             last_error_code = 'funding_reversed',
             last_error_message = ?, updated_at = ?
         WHERE funded_task_id = ? AND status = 'funded'
           AND EXISTS (
             SELECT 1 FROM paypal_funding_webhook_events
             WHERE event_id = ? AND event_type = ? AND funding_receipt_id = ?
               AND capture_id = ? AND terminal_status = ? AND applied_at IS NULL
           )`,
      )
      .bind(
        terminalMessage,
        now,
        receipt.task_id,
        parsed.eventId,
        parsed.eventType,
        receipt.id,
        parsed.captureId,
        parsed.terminalStatus,
      ),
    db
      .prepare(
        `UPDATE live_jobs
         SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
             next_attempt_at = NULL, last_error_code = 'funding_reversed',
             last_error_message = ?, updated_at = ?, completed_at = COALESCE(completed_at, ?)
         WHERE task_id = ? AND status NOT IN ('paid', 'reversed')
           AND EXISTS (
             SELECT 1 FROM paypal_funding_webhook_events
             WHERE event_id = ? AND event_type = ? AND funding_receipt_id = ?
               AND capture_id = ? AND terminal_status = ? AND applied_at IS NULL
           )`,
      )
      .bind(
        terminalMessage,
        now,
        now,
        receipt.task_id,
        parsed.eventId,
        parsed.eventType,
        receipt.id,
        parsed.captureId,
        parsed.terminalStatus,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO live_job_events
         (event_key, job_id, kind, title, detail, created_at)
         SELECT 'job:' || id || ':funding-event:' || ?, id, 'funding_reversed',
                'Sponsor funding is no longer settled',
                CASE WHEN status = 'paid'
                  THEN 'The sponsor capture later became terminal; the already confirmed claimant payout remains recorded.'
                  WHEN status = 'reversed'
                  THEN 'The sponsor capture later became terminal; the existing claimant payout reversal remains recorded.'
                  ELSE ? END,
                ?
         FROM live_jobs WHERE task_id = ?
           AND EXISTS (
             SELECT 1 FROM paypal_funding_webhook_events
             WHERE event_id = ? AND event_type = ? AND funding_receipt_id = ?
               AND capture_id = ? AND terminal_status = ? AND applied_at IS NULL
           )`,
      )
      .bind(
        parsed.eventId,
        terminalMessage,
        now,
        receipt.task_id,
        parsed.eventId,
        parsed.eventType,
        receipt.id,
        parsed.captureId,
        parsed.terminalStatus,
      ),
    db
      .prepare(
        `UPDATE paypal_funding_webhook_events SET applied_at = ?
         WHERE event_id = ? AND event_type = ? AND funding_receipt_id = ?
           AND capture_id = ? AND terminal_status = ? AND applied_at IS NULL`,
      )
      .bind(
        now,
        parsed.eventId,
        parsed.eventType,
        receipt.id,
        parsed.captureId,
        parsed.terminalStatus,
      ),
  ]);
  const updatedReceipt = await db
    .prepare("SELECT status FROM funding_receipts WHERE id = ? LIMIT 1")
    .bind(receipt.id)
    .first<{ status: string }>();
  return {
    handled: true,
    duplicate: (inserted.meta.changes ?? 0) === 0,
    captureId: parsed.captureId,
    receiptStatus: updatedReceipt?.status ?? parsed.terminalStatus,
    taskId: receipt.task_id,
  };
}

export async function applyPayPalPayoutWebhook(
  rawEvent: string,
  runtime: RuntimeEnv = getRuntimeEnv(),
) {
  const event = JSON.parse(rawEvent) as unknown;
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("PayPal webhook event is invalid.");
  }
  const record = event as Record<string, unknown>;
  const eventId = stringField(record.id, 120);
  const eventType = stringField(record.event_type, 120);
  if (!eventId || !eventType.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
    return { handled: false, reason: "unsupported_event" as const };
  }
  const resource =
    record.resource && typeof record.resource === "object" && !Array.isArray(record.resource)
      ? (record.resource as Record<string, unknown>)
      : null;
  if (!resource) throw new Error("PayPal payout item webhook has no resource.");
  const payoutItem =
    resource.payout_item &&
    typeof resource.payout_item === "object" &&
    !Array.isArray(resource.payout_item)
      ? (resource.payout_item as Record<string, unknown>)
      : null;
  const senderItemId = stringField(payoutItem?.sender_item_id, 100);
  const providerItemId = stringField(resource.payout_item_id, 100);
  const providerBatchId = stringField(resource.payout_batch_id, 100);
  if (!senderItemId && !providerItemId) {
    throw new Error("PayPal payout item webhook has no stable item identifier.");
  }

  const db = await ensureLiveDatabase(runtime);
  const payout = senderItemId
    ? await db
        .prepare("SELECT * FROM payouts WHERE sender_item_id = ? LIMIT 1")
        .bind(senderItemId)
        .first<PayoutRow>()
    : await db
        .prepare("SELECT * FROM payouts WHERE provider_item_id = ? LIMIT 1")
        .bind(providerItemId)
        .first<PayoutRow>();
  if (!payout) return { handled: false, reason: "unknown_payout" as const };
  if (
    (payout.provider_item_id &&
      providerItemId &&
      payout.provider_item_id !== providerItemId) ||
    (payout.provider_batch_id &&
      providerBatchId &&
      payout.provider_batch_id !== providerBatchId)
  ) {
    throw new Error("PayPal webhook payout identifiers conflict with the ledger.");
  }

  const succeeded = eventType === "PAYMENT.PAYOUTS-ITEM.SUCCEEDED";
  const needsAction = [
    "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
    "PAYMENT.PAYOUTS-ITEM.HELD",
    "PAYMENT.PAYOUTS-ITEM.BLOCKED",
  ].includes(eventType);
  const terminalFailure = [
    "PAYMENT.PAYOUTS-ITEM.FAILED",
    "PAYMENT.PAYOUTS-ITEM.RETURNED",
    "PAYMENT.PAYOUTS-ITEM.REFUNDED",
    "PAYMENT.PAYOUTS-ITEM.CANCELED",
  ].includes(eventType);
  if (!succeeded && !needsAction && !terminalFailure) {
    return { handled: false, reason: "unsupported_item_state" as const };
  }
  if (succeeded && (!providerItemId || !providerBatchId)) {
    throw new Error("PayPal success webhook is missing payout identifiers.");
  }

  const now = Date.now();
  const payoutStatus = eventType.replace("PAYMENT.PAYOUTS-ITEM.", "");
  const state = payoutState(payoutStatus);
  const rawEventTime = stringField(record.create_time, 80);
  const parsedEventTime = Date.parse(rawEventTime);
  const providerEventTime = Number.isFinite(parsedEventTime) ? parsedEventTime : now;
  const transitionPredicate = succeeded
    ? "status NOT IN ('RETURNED', 'REFUNDED')"
    : ["RETURNED", "REFUNDED"].includes(payoutStatus)
      ? "1 = 1"
      : needsAction
        ? "status NOT IN ('SUCCEEDED', 'RETURNED', 'REFUNDED', 'FAILED', 'CANCELED')"
        : "status NOT IN ('SUCCEEDED', 'RETURNED', 'REFUNDED')";
  const results = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO paypal_webhook_events
         (event_id, event_type, payout_id, provider_event_time, received_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(eventId, eventType, payout.id, providerEventTime, now),
    db
      .prepare(
        `UPDATE payouts SET provider_item_id = COALESCE(provider_item_id, ?),
         provider_batch_id = COALESCE(provider_batch_id, ?), status = ?, updated_at = ?
         WHERE id = ? AND ${transitionPredicate}
           AND (provider_item_id IS NULL OR provider_item_id = ?)
           AND (provider_batch_id IS NULL OR provider_batch_id = ?)
           AND EXISTS (
             SELECT 1 FROM paypal_webhook_events
             WHERE event_id = ? AND applied_at IS NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM paypal_webhook_events
             WHERE payout_id = ? AND applied_at IS NOT NULL
               AND provider_event_time > ?
           )`,
      )
      .bind(
        providerItemId || null,
        providerBatchId || null,
        payoutStatus,
        now,
        payout.id,
        providerItemId || payout.provider_item_id,
        providerBatchId || payout.provider_batch_id,
        eventId,
        payout.id,
        providerEventTime,
      ),
    db
      .prepare(
        `UPDATE live_jobs
         SET status = CASE (SELECT status FROM payouts WHERE id = ?)
           WHEN 'SUCCEEDED' THEN 'paid'
           WHEN 'RETURNED' THEN 'reversed'
           WHEN 'REFUNDED' THEN 'reversed'
           WHEN 'UNCLAIMED' THEN 'needs_action'
           WHEN 'HELD' THEN 'needs_action'
           WHEN 'BLOCKED' THEN 'needs_action'
           WHEN 'FAILED' THEN 'failed'
           WHEN 'CANCELED' THEN 'failed'
           ELSE status END,
         provider_status = (SELECT status FROM payouts WHERE id = ?),
         lease_token = NULL, lease_expires_at = NULL,
         next_attempt_at = CASE
           WHEN (SELECT status FROM payouts WHERE id = ?) IN
             ('SUCCEEDED', 'RETURNED', 'REFUNDED', 'UNCLAIMED', 'HELD',
              'BLOCKED', 'FAILED', 'CANCELED') THEN NULL
           ELSE next_attempt_at END,
         updated_at = ?,
         completed_at = CASE
           WHEN (SELECT status FROM payouts WHERE id = ?) IN
             ('SUCCEEDED', 'RETURNED', 'REFUNDED', 'FAILED', 'CANCELED')
           THEN COALESCE(completed_at, ?) ELSE completed_at END
         WHERE id = ? AND EXISTS (
           SELECT 1 FROM paypal_webhook_events
           WHERE event_id = ? AND applied_at IS NULL
         )`,
      )
      .bind(
        payout.id,
        payout.id,
        payout.id,
        now,
        payout.id,
        now,
        payout.job_id,
        eventId,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO live_job_events
         (event_key, job_id, kind, title, detail, created_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE (SELECT status FROM payouts WHERE id = ?) = ?
           AND EXISTS (
             SELECT 1 FROM paypal_webhook_events
             WHERE event_id = ? AND applied_at IS NULL
           )`,
      )
      .bind(
        `job:${payout.job_id}:paypal-state:${payoutStatus}`,
        payout.job_id,
        state.kind,
        state.title,
        state.detail,
        now,
        payout.id,
        payoutStatus,
        eventId,
      ),
    ...(succeeded && providerItemId
      ? [
          db
            .prepare(
              `INSERT OR IGNORE INTO notification_outbox
               (id, event_key, job_id, kind, payout_reference, status,
                created_at, updated_at)
               SELECT ?, ?, ?, 'payout_arrived', ?, 'pending', ?, ?
               WHERE EXISTS (
                 SELECT 1 FROM live_jobs WHERE id = ? AND status = 'paid'
               ) AND EXISTS (
                 SELECT 1 FROM paypal_webhook_events
                 WHERE event_id = ? AND applied_at IS NULL
               )`,
            )
            .bind(
              `notification:${payout.job_id}:payout-arrived`,
              `job:${payout.job_id}:payout-arrived`,
              payout.job_id,
              providerItemId,
              now,
              now,
              payout.job_id,
              eventId,
            ),
        ]
      : []),
    ...(state.jobStatus === "reversed" && (providerItemId || payout.provider_item_id)
      ? [
          db
            .prepare(
              `UPDATE notification_outbox
               SET status = 'canceled', lease_token = NULL, lease_expires_at = NULL,
                   next_attempt_at = NULL, updated_at = ?,
                   last_error = 'Payout reversed before arrival notice completed.'
               WHERE job_id = ? AND kind = 'payout_arrived'
                 AND status IN ('pending', 'retry_wait', 'sending')
                 AND EXISTS (
                   SELECT 1 FROM live_jobs WHERE id = ? AND status = 'reversed'
                 ) AND EXISTS (
                   SELECT 1 FROM paypal_webhook_events
                   WHERE event_id = ? AND applied_at IS NULL
                 )`,
            )
            .bind(now, payout.job_id, payout.job_id, eventId),
          db
            .prepare(
              `INSERT OR IGNORE INTO notification_outbox
               (id, event_key, job_id, kind, payout_reference, status,
                created_at, updated_at)
               SELECT ?, ?, ?, 'payout_reversed', ?, 'pending', ?, ?
               WHERE EXISTS (
                 SELECT 1 FROM live_jobs WHERE id = ? AND status = 'reversed'
               ) AND EXISTS (
                 SELECT 1 FROM paypal_webhook_events
                 WHERE event_id = ? AND applied_at IS NULL
               )`,
            )
            .bind(
              `notification:${payout.job_id}:payout-reversed`,
              `job:${payout.job_id}:payout-reversed`,
              payout.job_id,
              providerItemId || payout.provider_item_id,
              now,
              now,
              payout.job_id,
              eventId,
            ),
        ]
      : []),
    db
      .prepare(
        `UPDATE paypal_webhook_events SET applied_at = ?
         WHERE event_id = ? AND applied_at IS NULL`,
      )
      .bind(now, eventId),
  ]);
  const duplicate = (results[0]?.meta.changes ?? 0) === 0;
  const job = await liveJobRow(db, payout.job_id);
  return {
    handled: true,
    duplicate,
    status: job?.status ?? state.jobStatus,
    jobId: payout.job_id,
  };
}

export async function applyPayPalWebhook(
  rawEvent: string,
  runtime: RuntimeEnv = getRuntimeEnv(),
) {
  const fundingResult = await applyPayPalFundingWebhook(rawEvent, runtime);
  if (fundingResult.handled || fundingResult.reason !== "unsupported_event") {
    return fundingResult;
  }
  return applyPayPalPayoutWebhook(rawEvent, runtime);
}

export async function claimNotification(
  runtime: RuntimeEnv = getRuntimeEnv(),
) {
  const db = await ensureLiveDatabase(runtime);
  const now = Date.now();
  const token = crypto.randomUUID();
  const row = await db
    .prepare(
      `UPDATE notification_outbox
       SET status = 'sending', attempts = attempts + 1, lease_token = ?,
           lease_expires_at = ?, updated_at = ?
       WHERE id = (
         SELECT no.id FROM notification_outbox no
         JOIN live_jobs lj ON lj.id = no.job_id
         WHERE no.status IN ('pending', 'retry_wait', 'sending')
           AND (no.next_attempt_at IS NULL OR no.next_attempt_at <= ?)
           AND (no.lease_expires_at IS NULL OR no.lease_expires_at < ?)
           AND (
             (no.kind = 'payout_arrived' AND lj.status = 'paid') OR
             (no.kind = 'payout_reversed' AND lj.status = 'reversed')
           )
         ORDER BY no.created_at LIMIT 1
       )
       RETURNING *`,
    )
    .bind(token, now + 60_000, now, now, now)
    .first<Omit<NotificationOutboxRow, "owner_email">>();
  if (!row) return null;
  return db
    .prepare(
      `SELECT no.*, lj.owner_email
       FROM notification_outbox no
       JOIN live_jobs lj ON lj.id = no.job_id
       WHERE no.id = ? AND no.lease_token = ? LIMIT 1`,
    )
    .bind(row.id, token)
    .first<NotificationOutboxRow>();
}

export async function notificationStillCurrent(input: {
  notification: NotificationOutboxRow;
  runtime?: RuntimeEnv;
}) {
  const db = await ensureLiveDatabase(input.runtime ?? getRuntimeEnv());
  const current = await db
    .prepare(
      `SELECT 1 AS current
       FROM notification_outbox no
       JOIN live_jobs lj ON lj.id = no.job_id
       WHERE no.id = ? AND no.status = 'sending' AND no.lease_token = ?
         AND (
           (no.kind = 'payout_arrived' AND lj.status = 'paid') OR
           (no.kind = 'payout_reversed' AND lj.status = 'reversed')
         )
       LIMIT 1`,
    )
    .bind(input.notification.id, input.notification.lease_token)
    .first<{ current: number }>();
  return current?.current === 1;
}

export async function markNotificationSent(input: {
  notification: NotificationOutboxRow;
  providerMessageId: string;
  runtime?: RuntimeEnv;
}) {
  const db = await ensureLiveDatabase(input.runtime ?? getRuntimeEnv());
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `UPDATE notification_outbox
         SET status = 'sent', provider_message_id = ?, sent_at = ?,
             updated_at = ?, lease_token = NULL, lease_expires_at = NULL,
             next_attempt_at = NULL, last_error = NULL
         WHERE id = ? AND status = 'sending' AND lease_token = ?`,
      )
      .bind(
        input.providerMessageId,
        now,
        now,
        input.notification.id,
        input.notification.lease_token,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO live_job_events
         (event_key, job_id, kind, title, detail, created_at)
         SELECT ?, ?, 'notification_sent', ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM notification_outbox
           WHERE id = ? AND status = 'sent' AND provider_message_id = ?
         )`,
      )
      .bind(
        `job:${input.notification.job_id}:notification:${input.notification.kind}:sent`,
        input.notification.job_id,
        input.notification.kind === "payout_reversed"
          ? "Reversal notice sent"
          : "Arrival notice sent",
        input.notification.kind === "payout_reversed"
          ? "A transactional email reported that PayPal later returned or refunded the payout."
          : "A transactional email confirmed that PayPal reported the $5 payout succeeded.",
        now,
        input.notification.id,
        input.providerMessageId,
      ),
  ]);
}

export async function markNotificationRetry(input: {
  notification: NotificationOutboxRow;
  message: string;
  retryable: boolean;
  runtime?: RuntimeEnv;
}) {
  const db = await ensureLiveDatabase(input.runtime ?? getRuntimeEnv());
  const now = Date.now();
  const exhausted = !input.retryable || input.notification.attempts >= 6;
  const delayMs = Math.min(
    6 * 60 * 60_000,
    30_000 * 2 ** Math.max(0, input.notification.attempts - 1),
  );
  await db
    .prepare(
      `UPDATE notification_outbox
       SET status = ?, next_attempt_at = ?, lease_token = NULL,
           lease_expires_at = NULL, last_error = ?, updated_at = ?
       WHERE id = ? AND status = 'sending' AND lease_token = ?`,
    )
    .bind(
      exhausted ? "failed" : "retry_wait",
      exhausted ? null : now + delayMs,
      safeErrorMessage(input.message),
      now,
      input.notification.id,
      input.notification.lease_token,
    )
    .run();
}

export async function liveSystemStats(runtime: RuntimeEnv = getRuntimeEnv()) {
  const db = await ensureLiveDatabase(runtime);
  const [tasks, waiting] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM funded_tasks ft
         JOIN funding_receipts fr ON fr.id = ft.funding_receipt_id
         WHERE ft.status = 'available' AND ft.automation_allowed = 1
           AND ft.auto_accept = 1 AND ft.reward_cents >= 600
           AND fr.provider = 'paypal' AND fr.status = 'COMPLETED'
           AND fr.currency = 'USD' AND fr.net_cents >= ft.reward_cents`,
      )
      .first<{ count: number }>(),
    db
      .prepare("SELECT COUNT(*) AS count FROM live_jobs WHERE status = 'no_inventory'")
      .first<{ count: number }>(),
  ]);
  return { availableFundedTasks: tasks?.count ?? 0, waitingRequests: waiting?.count ?? 0 };
}
