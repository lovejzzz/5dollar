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
    assert.deepEqual(migrations.map((name) => name.slice(0, 4)), ["0000", "0001"]);
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
    assert.equal(
      fundedTaskColumns.find((column) => column.name === "funding_receipt_id")?.notnull,
      1,
    );
    assert.equal(
      receiptColumns.find((column) => column.name === "net_cents")?.notnull,
      1,
    );

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
      "notification_outbox",
    ]) {
      assert.ok(tables.includes(expected), `missing migrated table ${expected}`);
    }
  } finally {
    database.close();
  }
});
