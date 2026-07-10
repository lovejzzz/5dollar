import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("checked-in migrations produce the final constrained live schema", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const directory = fileURLToPath(new URL("../drizzle/", import.meta.url));
    const migrations = readdirSync(directory)
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();
    assert.deepEqual(migrations.map((name) => name.slice(0, 4)), [
      "0000",
      "0001",
      "0002",
    ]);
    for (const migration of migrations) {
      database.exec(readFileSync(`${directory}/${migration}`, "utf8"));
    }

    const integrity = database.prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    };
    assert.equal(integrity.integrity_check, "ok");

    const fundedTaskColumns = database.prepare("PRAGMA table_info(funded_tasks)").all() as
      Array<{ name: string; notnull: number }>;
    const receiptColumns = database.prepare("PRAGMA table_info(funding_receipts)").all() as
      Array<{ name: string; notnull: number }>;
    const sponsorOrderColumns = database
      .prepare("PRAGMA table_info(sponsor_task_orders)")
      .all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    const fundingWebhookColumns = database
      .prepare("PRAGMA table_info(paypal_funding_webhook_events)")
      .all() as Array<{ name: string; notnull: number; pk: number }>;
    const sponsorRequestLimitColumns = database
      .prepare("PRAGMA table_info(sponsor_order_request_limits)")
      .all() as Array<{ name: string; notnull: number; pk: number }>;
    assert.equal(
      fundedTaskColumns.find((column) => column.name === "funding_receipt_id")?.notnull,
      1,
    );
    assert.equal(
      receiptColumns.find((column) => column.name === "net_cents")?.notnull,
      1,
    );
    for (const required of [
      "owner_email",
      "client_request_id",
      "request_hash",
      "rights_attested",
      "no_sensitive_data",
      "attestation_version",
      "gross_cents",
      "minimum_net_cents",
      "payout_cents",
    ]) {
      assert.equal(
        sponsorOrderColumns.find((column) => column.name === required)?.notnull,
        1,
        `sponsor_task_orders.${required} must be NOT NULL`,
      );
    }
    for (const consent of [
      "automation_allowed",
      "auto_accept",
      "rights_attested",
      "no_sensitive_data",
    ]) {
      assert.equal(
        sponsorOrderColumns.find((column) => column.name === consent)?.dflt_value,
        "0",
        `sponsor_task_orders.${consent} must fail closed when omitted`,
      );
    }
    for (const required of [
      "event_id",
      "event_type",
      "capture_id",
      "terminal_status",
      "provider_event_time",
      "received_at",
    ]) {
      assert.equal(
        fundingWebhookColumns.find((column) => column.name === required)?.notnull,
        1,
        `paypal_funding_webhook_events.${required} must be NOT NULL`,
      );
    }
    assert.equal(
      fundingWebhookColumns.find((column) => column.name === "event_id")?.pk,
      1,
    );
    assert.equal(
      fundingWebhookColumns.find(
        (column) => column.name === "funding_receipt_id",
      )?.notnull,
      0,
      "orphan terminal funding events must persist before a receipt exists",
    );
    for (const required of [
      "owner_email",
      "window_started_at",
      "request_count",
      "updated_at",
    ]) {
      assert.equal(
        sponsorRequestLimitColumns.find((column) => column.name === required)
          ?.notnull,
        1,
        `sponsor_order_request_limits.${required} must be NOT NULL`,
      );
    }
    assert.equal(
      sponsorRequestLimitColumns.find((column) => column.name === "owner_email")
        ?.pk,
      1,
    );

    const sponsorForeignKeys = database
      .prepare("PRAGMA foreign_key_list(sponsor_task_orders)")
      .all() as Array<{ table: string; from: string; to: string }>;
    assert.ok(
      sponsorForeignKeys.some(
        (key) =>
          key.table === "funded_tasks" &&
          key.from === "funded_task_id" &&
          key.to === "id",
      ),
    );

    const rawDraftInsert = `INSERT INTO sponsor_task_orders
      (id, owner_email, client_request_id, request_hash, title, instructions,
       input_json, acceptance_json, automation_allowed, auto_accept,
       rights_attested, no_sensitive_data, attestation_version, attested_at,
       sponsor_reference, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    assert.throws(
      () =>
        database.prepare(rawDraftInsert).run(
          "raw-default-consent",
          "sponsor@example.com",
          "request-default-consent",
          "hash-default-consent",
          "Valid task title",
          "A sufficiently detailed set of sponsor task instructions.",
          "{}",
          "{}",
          0,
          0,
          0,
          0,
          "test-v1",
          1,
          "sponsor:raw-default-consent",
          1,
          1,
        ),
      /constraint/i,
    );
    database.prepare(rawDraftInsert).run(
      "raw-completeness",
      "sponsor@example.com",
      "request-completeness",
      "hash-completeness",
      "Valid task title",
      "A sufficiently detailed set of sponsor task instructions.",
      "{}",
      "{}",
      1,
      1,
      1,
      1,
      "test-v1",
      1,
      "sponsor:raw-completeness",
      1,
      1,
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE sponsor_task_orders SET status = 'funded' WHERE id = ?")
          .run("raw-completeness"),
      /constraint/i,
    );

    const fundingWebhookIndexes = database
      .prepare("PRAGMA index_list(paypal_funding_webhook_events)")
      .all()
      .map((row) => (row as { name: string }).name);
    assert.ok(fundingWebhookIndexes.includes("paypal_funding_webhook_events_capture_idx"));
    assert.ok(fundingWebhookIndexes.includes("paypal_funding_webhook_events_receipt_idx"));

    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    for (const expected of [
      "funded_tasks",
      "funding_receipts",
      "live_jobs",
      "payouts",
      "paypal_webhook_events",
      "paypal_funding_webhook_events",
      "notification_outbox",
      "sponsor_order_request_limits",
      "sponsor_task_orders",
    ]) {
      assert.ok(tables.includes(expected), `missing migrated table ${expected}`);
    }
  } finally {
    database.close();
  }
});
