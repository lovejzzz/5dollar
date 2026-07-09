import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
