import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    payoutMethod: text("payout_method").notNull(),
    destinationHash: text("destination_hash").notNull(),
    destinationHint: text("destination_hint").notNull(),
    amountCents: integer("amount_cents").notNull().default(500),
    mode: text("mode").notNull().default("sandbox"),
    status: text("status").notNull().default("received"),
    currentStep: integer("current_step").notNull().default(0),
    payoutReference: text("payout_reference"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => [
    uniqueIndex("jobs_id_idx").on(table.id),
    uniqueIndex("jobs_destination_created_idx").on(
      table.destinationHash,
      table.createdAt,
    ),
  ],
);

export const jobEvents = sqliteTable(
  "job_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id").notNull(),
    step: integer("step").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("job_events_job_step_idx").on(table.jobId, table.step),
  ],
);

export const fundedTasks = sqliteTable(
  "funded_tasks",
  {
    id: text("id").primaryKey(),
    taskType: text("task_type").notNull().default("dataset_summary"),
    title: text("title").notNull(),
    instructions: text("instructions").notNull(),
    inputJson: text("input_json").notNull().default("{}"),
    rewardCents: integer("reward_cents").notNull(),
    payoutCents: integer("payout_cents").notNull().default(500),
    automationAllowed: integer("automation_allowed").notNull().default(0),
    autoAccept: integer("auto_accept").notNull().default(0),
    minAnswerChars: integer("min_answer_chars").notNull().default(120),
    acceptanceJson: text("acceptance_json").notNull().default("{}"),
    sponsorReference: text("sponsor_reference").notNull(),
    fundingReceiptId: text("funding_receipt_id").notNull(),
    status: text("status").notNull().default("available"),
    leaseJobId: text("lease_job_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    acceptedAt: integer("accepted_at"),
  },
  (table) => [
    uniqueIndex("funded_tasks_sponsor_reference_idx").on(table.sponsorReference),
    uniqueIndex("funded_tasks_funding_receipt_idx").on(table.fundingReceiptId),
    uniqueIndex("funded_tasks_lease_job_id_idx").on(table.leaseJobId),
    index("funded_tasks_available_idx").on(
      table.status,
      table.automationAllowed,
      table.createdAt,
    ),
  ],
);

export const fundingReceipts = sqliteTable(
  "funding_receipts",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    providerTransactionId: text("provider_transaction_id").notNull(),
    sponsorReference: text("sponsor_reference").notNull(),
    currency: text("currency").notNull(),
    grossCents: integer("gross_cents").notNull(),
    netCents: integer("net_cents").notNull(),
    status: text("status").notNull(),
    capturedAt: integer("captured_at").notNull(),
    taskId: text("task_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("funding_receipts_provider_transaction_idx").on(
      table.provider,
      table.providerTransactionId,
    ),
    uniqueIndex("funding_receipts_sponsor_reference_idx").on(
      table.sponsorReference,
    ),
    uniqueIndex("funding_receipts_task_id_idx").on(table.taskId),
  ],
);

export const liveJobs = sqliteTable(
  "live_jobs",
  {
    id: text("id").primaryKey(),
    ownerEmail: text("owner_email").notNull(),
    payoutMethod: text("payout_method").notNull(),
    destinationCiphertext: text("destination_ciphertext").notNull(),
    destinationFingerprint: text("destination_fingerprint").notNull(),
    destinationHint: text("destination_hint").notNull(),
    amountCents: integer("amount_cents").notNull().default(500),
    status: text("status").notNull().default("queued"),
    taskId: text("task_id"),
    earnedCents: integer("earned_cents").notNull().default(0),
    submissionJson: text("submission_json"),
    modelResponseId: text("model_response_id"),
    modelName: text("model_name"),
    providerStatus: text("provider_status"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => [
    uniqueIndex("live_jobs_owner_email_idx").on(table.ownerEmail),
    uniqueIndex("live_jobs_destination_fingerprint_idx").on(
      table.destinationFingerprint,
    ),
    index("live_jobs_processing_idx").on(
      table.status,
      table.nextAttemptAt,
      table.leaseExpiresAt,
    ),
  ],
);

export const payouts = sqliteTable(
  "payouts",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull(),
    senderBatchId: text("sender_batch_id").notNull(),
    senderItemId: text("sender_item_id").notNull(),
    providerBatchId: text("provider_batch_id"),
    providerItemId: text("provider_item_id"),
    status: text("status").notNull().default("created"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("payouts_job_id_idx").on(table.jobId),
    uniqueIndex("payouts_sender_batch_id_idx").on(table.senderBatchId),
    uniqueIndex("payouts_sender_item_id_idx").on(table.senderItemId),
    uniqueIndex("payouts_provider_batch_id_idx").on(table.providerBatchId),
    uniqueIndex("payouts_provider_item_id_idx").on(table.providerItemId),
  ],
);

export const liveJobEvents = sqliteTable(
  "live_job_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventKey: text("event_key").notNull(),
    jobId: text("job_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("live_job_events_event_key_idx").on(table.eventKey),
    index("live_job_events_job_id_idx").on(table.jobId, table.createdAt),
  ],
);

export const paypalWebhookEvents = sqliteTable(
  "paypal_webhook_events",
  {
    eventId: text("event_id").primaryKey(),
    eventType: text("event_type").notNull(),
    payoutId: text("payout_id").notNull(),
    providerEventTime: integer("provider_event_time").notNull(),
    receivedAt: integer("received_at").notNull(),
    appliedAt: integer("applied_at"),
  },
  (table) => [index("paypal_webhook_events_payout_idx").on(table.payoutId)],
);

export const notificationOutbox = sqliteTable(
  "notification_outbox",
  {
    id: text("id").primaryKey(),
    eventKey: text("event_key").notNull(),
    jobId: text("job_id").notNull(),
    kind: text("kind").notNull(),
    payoutReference: text("payout_reference").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at"),
    providerMessageId: text("provider_message_id"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    sentAt: integer("sent_at"),
  },
  (table) => [
    uniqueIndex("notification_outbox_event_key_idx").on(table.eventKey),
    index("notification_outbox_delivery_idx").on(
      table.status,
      table.nextAttemptAt,
      table.leaseExpiresAt,
    ),
  ],
);
