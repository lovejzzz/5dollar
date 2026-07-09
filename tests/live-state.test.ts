import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPayPalPayoutWebhook,
  applyPayPalPayoutObservation,
  claimLiveJob,
  createFundedTask,
  createLiveJob,
  getOrCreatePayout,
  markEarningAccepted,
  markLiveJobRetry,
  markPayoutPending,
  taskForLiveJob,
} from "../lib/live-jobs";
import { createPayPalPayoutIdempotency } from "../lib/payouts/paypal";
import type { RuntimeEnv } from "../lib/runtime-env";
import { processNotification } from "../lib/process-notification";
import { FakeD1Database } from "./helpers/fake-d1";

const runtimeKeys = {
  PAYOUT_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  PAYOUT_FINGERPRINT_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
};

const taskSpec = {
  taskType: "dataset_summary" as const,
  title: "Summarize a supplied product feedback dataset",
  instructions:
    "Using only the supplied feedback rows, produce a concise theme summary and list the supporting row identifiers.",
  input: { rows: [{ id: "r1", feedback: "The setup was fast." }] },
  rewardCents: 700,
  sponsorReference: "sponsor:feedback:state:001",
  fundingCaptureId: "CAPTURESTATE001",
  automationAllowed: true as const,
  autoAccept: true as const,
  acceptance: { requiredEvidenceIds: ["r1"] },
  minAnswerChars: 80,
};

test("D1 live state is funded once, lease-fenced, monotonic, and notifies once", async () => {
  const database = new FakeD1Database();
  const runtime: RuntimeEnv = { DB: database.asBinding(), ...runtimeKeys };
  try {
    const capture = {
      provider: "paypal" as const,
      captureId: "CAPTURESTATE001",
      status: "COMPLETED",
      currency: "USD",
      grossCents: 750,
      netCents: 700,
      customId: taskSpec.sponsorReference,
      capturedAt: "2026-07-09T18:00:00Z",
    };
    const task = await createFundedTask(taskSpec, capture, runtime);
    const replay = await createFundedTask(taskSpec, capture, runtime);
    assert.equal(replay.id, task.id);
    assert.equal(replay.duplicate, true);
    assert.equal(
      database.query<{ count: number }>("SELECT COUNT(*) AS count FROM funded_tasks")[0]
        .count,
      1,
    );
    assert.equal(
      database.query<{ count: number }>("SELECT COUNT(*) AS count FROM funding_receipts")[0]
        .count,
      1,
    );

    const created = await createLiveJob({
      ownerEmail: "owner@example.com",
      payoutMethod: "paypal",
      destination: "person@example.com",
      runtime,
    });
    assert.equal(created.status, "queued");
    const stored = database.query<{
      destination_ciphertext: string;
      destination_fingerprint: string;
      destination_hint: string;
    }>("SELECT destination_ciphertext, destination_fingerprint, destination_hint FROM live_jobs")[0];
    assert.ok(stored.destination_ciphertext.startsWith("v1."));
    assert.ok(!stored.destination_ciphertext.includes("person@example.com"));
    assert.equal(stored.destination_fingerprint.length, 43);
    assert.equal(stored.destination_hint, "p•••n@example.com");

    const earningClaim = await claimLiveJob(created.id, runtime);
    assert.ok(earningClaim);
    assert.equal(earningClaim.status, "earning");
    const reservedTask = await taskForLiveJob(earningClaim, runtime);
    assert.ok(reservedTask);
    const accepted = await markEarningAccepted({
      job: earningClaim,
      task: reservedTask,
      submission: {
        answer:
          "The supplied feedback indicates that this customer valued the fast setup experience, based only on source row r1.",
        evidence: ["r1: The setup was fast."],
        qualityNotes: ["Limited to one supplied row."],
      },
      answerLength: 113,
      acceptancePassed: true,
      responseId: "resp-state-001",
      model: "gpt-test",
      runtime,
    });
    assert.equal(accepted, true);

    const payoutClaim = await claimLiveJob(created.id, runtime);
    assert.ok(payoutClaim);
    assert.equal(payoutClaim.status, "payout_submitting");
    const ids = await createPayPalPayoutIdempotency(created.id);
    await getOrCreatePayout(created.id, ids, runtime);
    const pending = await markPayoutPending({
      job: payoutClaim,
      payoutBatchId: "PBATCH-STATE-001",
      batchStatus: "PENDING",
      senderBatchId: ids.senderBatchId,
      senderItemId: ids.senderItemId,
      runtime,
    });
    assert.equal(pending, true);

    database.sqlite.exec(
      `UPDATE live_jobs SET next_attempt_at = 0 WHERE id = '${created.id}'`,
    );
    const reconciliationClaim = await claimLiveJob(created.id, runtime);
    assert.ok(reconciliationClaim);

    const reconciled = await applyPayPalPayoutObservation({
      job: reconciliationClaim,
      observation: {
        provider: "paypal",
        payoutBatchId: "PBATCH-STATE-001",
        batchStatus: "SUCCESS",
        senderBatchId: ids.senderBatchId,
        senderItemId: ids.senderItemId,
        providerItemId: "PITEM-STATE-001",
        itemStatus: "SUCCESS",
      },
      runtime,
    });
    assert.equal(reconciled, "paid");
    assert.equal(
      database.query<{ attempts: number }>("SELECT attempts FROM live_jobs")[0].attempts,
      0,
    );

    const webhook = (id: string, type: string, createTime: string) =>
      JSON.stringify({
        id,
        event_type: type,
        create_time: createTime,
        resource: {
          payout_item_id: "PITEM-STATE-001",
          payout_batch_id: "PBATCH-STATE-001",
          payout_item: { sender_item_id: ids.senderItemId },
        },
      });
    const success = await applyPayPalPayoutWebhook(
      webhook(
        "WH-STATE-SUCCESS",
        "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
        "2026-07-09T20:00:00Z",
      ),
      runtime,
    );
    assert.equal(success.status, "paid");
    const duplicate = await applyPayPalPayoutWebhook(
      webhook(
        "WH-STATE-SUCCESS",
        "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
        "2026-07-09T20:00:00Z",
      ),
      runtime,
    );
    assert.equal(duplicate.duplicate, true);

    await markPayoutPending({
      job: payoutClaim,
      payoutBatchId: "PBATCH-STATE-001",
      batchStatus: "PENDING",
      senderBatchId: ids.senderBatchId,
      senderItemId: ids.senderItemId,
      runtime,
    });
    const staleRetry = await markLiveJobRetry({
      job: payoutClaim,
      code: "network_error",
      message: "stale worker",
      retryable: true,
      runtime,
    });
    assert.equal(staleRetry, false);

    const staleHeld = await applyPayPalPayoutWebhook(
      webhook(
        "WH-STATE-OLD-HELD",
        "PAYMENT.PAYOUTS-ITEM.HELD",
        "2026-07-09T19:59:00Z",
      ),
      runtime,
    );
    assert.equal(staleHeld.status, "paid");
    assert.equal(
      database.query<{ status: string }>("SELECT status FROM live_jobs")[0].status,
      "paid",
    );
    assert.equal(
      database.query<{ count: number }>("SELECT COUNT(*) AS count FROM notification_outbox")[0]
        .count,
      1,
    );

    const reversed = await applyPayPalPayoutWebhook(
      webhook(
        "WH-STATE-RETURNED",
        "PAYMENT.PAYOUTS-ITEM.RETURNED",
        "2026-07-09T20:01:00Z",
      ),
      runtime,
    );
    assert.equal(reversed.status, "reversed");
    const notifications = database.query<{ kind: string; status: string }>(
      "SELECT kind, status FROM notification_outbox ORDER BY kind",
    );
    assert.equal(notifications.length, 2);
    assert.equal(notifications[0].kind, "payout_arrived");
    assert.equal(notifications[0].status, "canceled");
    assert.equal(notifications[1].kind, "payout_reversed");
    assert.equal(notifications[1].status, "pending");

    let sentKind = "";
    const notificationResult = await processNotification({
      runtime: {
        ...runtime,
        FIVE_MODE: "live",
        PAYPAL_MODE: "live",
        PROCESSOR_SECRET: "processor-secret",
        TASK_ADMIN_SECRET: "task-secret",
        OPENAI_API_KEY: "openai-key",
        PAYPAL_CLIENT_ID: "paypal-client",
        PAYPAL_CLIENT_SECRET: "paypal-secret",
        PAYPAL_WEBHOOK_ID: "webhook-id",
        RESEND_API_KEY: "resend-key",
        NOTIFICATION_FROM_EMAIL: "Five <payouts@example.com>",
      },
      dependencies: {
        send: async (input) => {
          sentKind = input.kind;
          return { provider: "resend" as const, messageId: "email-reversal-001" };
        },
      },
    });
    assert.equal(notificationResult.status, "sent");
    assert.equal(sentKind, "payout_reversed");
    assert.equal(
      database.query<{ status: string }>(
        "SELECT status FROM notification_outbox WHERE kind = 'payout_reversed'",
      )[0].status,
      "sent",
    );
  } finally {
    database.close();
  }
});
