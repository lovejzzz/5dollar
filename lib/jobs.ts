import { env } from "cloudflare:workers";

export const PAYOUT_METHODS = [
  "paypal",
  "zelle",
  "cashapp",
  "venmo",
  "other",
] as const;

export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

export type JobStatus =
  | "received"
  | "matching"
  | "working"
  | "verifying"
  | "payout_preview"
  | "complete";

type JobRow = {
  id: string;
  payout_method: PayoutMethod;
  destination_hash: string;
  destination_hint: string;
  amount_cents: number;
  mode: "sandbox";
  status: JobStatus;
  current_step: number;
  payout_reference: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

type EventRow = {
  step: number;
  kind: string;
  title: string;
  detail: string;
  created_at: number;
};

export type JobActivity = {
  step: number;
  title: string;
  detail: string;
  state: "done" | "active" | "pending";
  occurredAt: string | null;
};

export type PublicJob = {
  id: string;
  requestCode: string;
  amountCents: 500;
  mode: "sandbox";
  payoutMethod: PayoutMethod;
  payoutMethodLabel: string;
  destinationHint: string;
  status: JobStatus;
  progress: number;
  headline: string;
  message: string;
  payoutReference: string | null;
  createdAt: string;
  completedAt: string | null;
  activities: JobActivity[];
};

const STEP_DEFINITIONS: ReadonlyArray<{
  status: JobStatus;
  title: string;
  detail: string;
  afterMs: number;
}> = [
  {
    status: "received",
    title: "Request received",
    detail: "Payout destination masked and request queued.",
    afterMs: 0,
  },
  {
    status: "matching",
    title: "Finding an opportunity",
    detail: "Demo agent is scanning the approved task inventory.",
    afterMs: 1_600,
  },
  {
    status: "working",
    title: "Doing the work",
    detail: "Demo agent is preparing a sponsor-ready submission.",
    afterMs: 4_300,
  },
  {
    status: "verifying",
    title: "Checking the result",
    detail: "Demo quality checks are validating the submission.",
    afterMs: 7_100,
  },
  {
    status: "payout_preview",
    title: "Preparing the payout",
    detail: "Demo payout details are being assembled.",
    afterMs: 9_700,
  },
  {
    status: "complete",
    title: "Demo complete",
    detail: "The workflow finished. No task or payment was created.",
    afterMs: 12_200,
  },
];

const METHOD_LABELS: Record<PayoutMethod, string> = {
  paypal: "PayPal",
  zelle: "Zelle",
  cashapp: "Cash App",
  venmo: "Venmo",
  other: "Other",
};

function database(): D1Database {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) {
    throw new Error("The job database is unavailable.");
  }
  return binding;
}

async function ensureDatabase(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY NOT NULL,
      payout_method TEXT NOT NULL,
      destination_hash TEXT NOT NULL,
      destination_hint TEXT NOT NULL,
      amount_cents INTEGER NOT NULL DEFAULT 500,
      mode TEXT NOT NULL DEFAULT 'sandbox',
      status TEXT NOT NULL DEFAULT 'received',
      current_step INTEGER NOT NULL DEFAULT 0,
      payout_reference TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    )`),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS jobs_destination_hash_idx ON jobs (destination_hash, created_at)",
    ),
    db.prepare(`CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      step INTEGER NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(job_id, step)
    )`),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS job_events_job_id_idx ON job_events (job_id, step)",
    ),
  ]);
}

export function isPayoutMethod(value: string): value is PayoutMethod {
  return PAYOUT_METHODS.includes(value as PayoutMethod);
}

export function validateDestination(method: PayoutMethod, value: string) {
  const destination = value.trim();
  if (!destination) return "Enter a payout destination.";
  if (destination.length > 120) return "That payout destination is too long.";

  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const phone = /^\+?[\d\s().-]{7,22}$/;
  const handle = /^@?[a-zA-Z0-9._-]{2,40}$/;

  const valid =
    method === "paypal"
      ? email.test(destination) || phone.test(destination) || handle.test(destination)
      : method === "zelle"
        ? email.test(destination) || phone.test(destination)
        : method === "cashapp"
          ? /^\$[a-zA-Z][a-zA-Z0-9_]{1,19}$/.test(destination)
          : method === "venmo"
            ? handle.test(destination)
            : destination.length >= 3;

  return valid ? null : "Check that destination and try again.";
}

function normalizeDestination(method: PayoutMethod, value: string) {
  const trimmed = value.trim();
  return method === "cashapp" || method === "venmo" || trimmed.includes("@")
    ? trimmed.toLowerCase()
    : trimmed;
}

function maskDestination(value: string) {
  if (value.includes("@") && !value.startsWith("@")) {
    const [local, domain] = value.split("@", 2);
    const localHint =
      local.length <= 2 ? `${local[0] ?? "•"}••` : `${local[0]}•••${local.at(-1)}`;
    return `${localHint}@${domain}`;
  }

  const digits = value.replace(/\D/g, "");
  if (digits.length >= 7) return `••• ••• ${digits.slice(-4)}`;

  const prefix = value.startsWith("$") || value.startsWith("@") ? value[0] : "";
  const body = prefix ? value.slice(1) : value;
  if (body.length <= 2) return `${prefix}${body[0] ?? "•"}••`;
  return `${prefix}${body[0]}•••${body.at(-1)}`;
}

async function hashDestination(method: PayoutMethod, value: string) {
  const bytes = new TextEncoder().encode(`${method}:${value}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function stepForElapsed(elapsedMs: number) {
  let step = 0;
  STEP_DEFINITIONS.forEach((definition, index) => {
    if (elapsedMs >= definition.afterMs) step = index;
  });
  return step;
}

function statusCopy(status: JobStatus) {
  switch (status) {
    case "received":
      return {
        headline: "Request locked in.",
        message: "The demo agent is getting ready to look for a funded task.",
      };
    case "matching":
      return {
        headline: "Looking for the right work.",
        message: "Only approved, automation-friendly task inventory is considered.",
      };
    case "working":
      return {
        headline: "Five is on it.",
        message: "The demo is showing how an agent would complete the matched task.",
      };
    case "verifying":
      return {
        headline: "Checking every detail.",
        message: "A live job would need to be accepted and settled before payout.",
      };
    case "payout_preview":
      return {
        headline: "Building the payout preview.",
        message: "A real provider receipt would be required before calling this paid.",
      };
    case "complete":
      return {
        headline: "Demo complete.",
        message: "The full workflow ran, but no real task or payment was created.",
      };
  }
}

async function rowForId(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM jobs WHERE id = ? LIMIT 1").bind(id).first<JobRow>();
}

async function advanceJob(db: D1Database, row: JobRow) {
  const targetStep = stepForElapsed(Date.now() - row.created_at);
  if (targetStep <= row.current_step) return row;

  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (let step = row.current_step + 1; step <= targetStep; step += 1) {
    const definition = STEP_DEFINITIONS[step];
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO job_events
          (job_id, step, kind, title, detail, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          step,
          definition.status,
          definition.title,
          definition.detail,
          now,
        ),
    );
  }

  const status = STEP_DEFINITIONS[targetStep].status;
  const completedAt = status === "complete" ? now : null;
  const reference = status === "complete" ? `demo_${row.id.slice(0, 8)}` : null;
  statements.push(
    db
      .prepare(
        `UPDATE jobs
        SET status = ?, current_step = ?, updated_at = ?,
            completed_at = COALESCE(completed_at, ?),
            payout_reference = COALESCE(payout_reference, ?)
        WHERE id = ? AND current_step < ?`,
      )
      .bind(status, targetStep, now, completedAt, reference, row.id, targetStep),
  );
  await db.batch(statements);
  return (await rowForId(db, row.id)) ?? row;
}

async function toPublicJob(db: D1Database, row: JobRow): Promise<PublicJob> {
  const events = await db
    .prepare("SELECT step, kind, title, detail, created_at FROM job_events WHERE job_id = ? ORDER BY step")
    .bind(row.id)
    .all<EventRow>();
  const occurredAt = new Map(
    events.results.map((event) => [event.step, new Date(event.created_at).toISOString()]),
  );
  const copy = statusCopy(row.status);

  return {
    id: row.id,
    requestCode: `FIVE-${row.id.slice(0, 6).toUpperCase()}`,
    amountCents: 500,
    mode: "sandbox",
    payoutMethod: row.payout_method,
    payoutMethodLabel: METHOD_LABELS[row.payout_method],
    destinationHint: row.destination_hint,
    status: row.status,
    progress: Math.round(((row.current_step + 1) / STEP_DEFINITIONS.length) * 100),
    headline: copy.headline,
    message: copy.message,
    payoutReference: row.payout_reference,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    activities: STEP_DEFINITIONS.map((definition, step) => ({
      step,
      title: definition.title,
      detail: definition.detail,
      state:
        step < row.current_step
          ? "done"
          : step === row.current_step
            ? row.status === "complete"
              ? "done"
              : "active"
            : "pending",
      occurredAt: occurredAt.get(step) ?? null,
    })),
  };
}

export async function createJob(method: PayoutMethod, rawDestination: string) {
  const db = database();
  await ensureDatabase(db);
  const destination = normalizeDestination(method, rawDestination);
  const destinationHash = await hashDestination(method, destination);
  const duplicate = await db
    .prepare(
      "SELECT * FROM jobs WHERE destination_hash = ? AND status != 'complete' AND created_at > ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(destinationHash, Date.now() - 30_000)
    .first<JobRow>();
  if (duplicate) return toPublicJob(db, await advanceJob(db, duplicate));

  const now = Date.now();
  const id = crypto.randomUUID();
  const firstStep = STEP_DEFINITIONS[0];
  await db.batch([
    db
      .prepare(
        `INSERT INTO jobs
        (id, payout_method, destination_hash, destination_hint, amount_cents, mode,
         status, current_step, created_at, updated_at)
        VALUES (?, ?, ?, ?, 500, 'sandbox', 'received', 0, ?, ?)`,
      )
      .bind(id, method, destinationHash, maskDestination(destination), now, now),
    db
      .prepare(
        `INSERT INTO job_events
        (job_id, step, kind, title, detail, created_at)
        VALUES (?, 0, ?, ?, ?, ?)`,
      )
      .bind(id, firstStep.status, firstStep.title, firstStep.detail, now),
  ]);

  const row = await rowForId(db, id);
  if (!row) throw new Error("The request could not be created.");
  return toPublicJob(db, row);
}

export async function getJob(id: string) {
  const db = database();
  await ensureDatabase(db);
  const row = await rowForId(db, id);
  if (!row) return null;
  return toPublicJob(db, await advanceJob(db, row));
}
