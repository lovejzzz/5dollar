import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPayPalWebhook,
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
import { processLiveJob } from "../lib/process-live-job";
import { isSponsorAllowed, type RuntimeEnv } from "../lib/runtime-env";
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

test("sponsor checkout allowlisting is normalized and fails closed", () => {
  const runtime: RuntimeEnv = {
    SPONSOR_ALLOWED_EMAILS:
      "First.Sponsor@example.com, second-sponsor@example.com",
  };
  assert.equal(isSponsorAllowed("first.sponsor@EXAMPLE.com", runtime), true);
  assert.equal(isSponsorAllowed("outsider@example.com", runtime), false);
  assert.equal(isSponsorAllowed("first.sponsor@example.com", {}), false);
  assert.throws(
    () =>
      isSponsorAllowed("first.sponsor@example.com", {
        SPONSOR_ALLOWED_EMAILS: "not-an-email",
      }),
    /must contain only comma-separated sponsor email addresses/,
  );
});

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

    const fundingReversal = await applyPayPalWebhook(
      JSON.stringify({
        id: "WH-FUNDING-REVERSED-PAID",
        event_type: "PAYMENT.CAPTURE.REVERSED",
        resource_type: "capture",
        create_time: "2026-07-09T20:00:30Z",
        resource: { id: taskSpec.fundingCaptureId },
      }),
      runtime,
    );
    assert.equal(fundingReversal.handled, true);
    assert.equal(
      database.query<{ status: string }>("SELECT status FROM funding_receipts")[0].status,
      "REVERSED",
    );
    assert.equal(
      database.query<{ status: string }>("SELECT status FROM funded_tasks")[0].status,
      "funding_reversed",
    );
    const paidAfterFundingReversal = database.query<{
      status: string;
      submission_json: string | null;
    }>("SELECT status, submission_json FROM live_jobs")[0];
    assert.equal(paidAfterFundingReversal.status, "paid");
    assert.ok(paidAfterFundingReversal.submission_json);

    const duplicateFundingReversal = await applyPayPalWebhook(
      JSON.stringify({
        id: "WH-FUNDING-REVERSED-PAID",
        event_type: "PAYMENT.CAPTURE.REVERSED",
        resource_type: "capture",
        create_time: "2026-07-09T20:00:30Z",
        resource: { id: taskSpec.fundingCaptureId },
      }),
      runtime,
    );
    assert.equal(duplicateFundingReversal.duplicate, true);
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM paypal_funding_webhook_events",
      )[0].count,
      1,
    );

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
        SUPPORT_EMAIL: "support@example.com",
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

test("funding reversal halts an unpaid job without deleting the accepted result", async () => {
  const database = new FakeD1Database();
  const runtime: RuntimeEnv = { DB: database.asBinding(), ...runtimeKeys };
  const unpaidTaskSpec = {
    ...taskSpec,
    sponsorReference: "sponsor:feedback:state:unpaid",
    fundingCaptureId: "CAPTUREUNPAID001",
  };
  try {
    await createFundedTask(
      unpaidTaskSpec,
      {
        provider: "paypal",
        captureId: unpaidTaskSpec.fundingCaptureId,
        status: "COMPLETED",
        currency: "USD",
        grossCents: 750,
        netCents: 700,
        customId: unpaidTaskSpec.sponsorReference,
        capturedAt: "2026-07-10T01:30:00Z",
      },
      runtime,
    );
    const created = await createLiveJob({
      ownerEmail: "unpaid-owner@example.com",
      payoutMethod: "paypal",
      destination: "unpaid-person@example.com",
      runtime,
    });
    const claim = await claimLiveJob(created.id, runtime);
    assert.ok(claim);
    const task = await taskForLiveJob(claim, runtime);
    assert.ok(task);
    assert.equal(
      await markEarningAccepted({
        job: claim,
        task,
        submission: {
          answer:
            "The supplied row says setup was fast, which is the only supported theme in this bounded sponsor dataset.",
          evidence: ["r1: The setup was fast."],
          qualityNotes: ["Only one row was supplied."],
        },
        answerLength: 105,
        acceptancePassed: true,
        responseId: "resp-unpaid-001",
        model: "gpt-test",
        runtime,
      }),
      true,
    );

    const result = await applyPayPalWebhook(
      JSON.stringify({
        id: "WH-FUNDING-REFUNDED-UNPAID",
        event_type: "PAYMENT.CAPTURE.REFUNDED",
        resource_type: "refund",
        create_time: "2026-07-10T01:31:00Z",
        resource: {
          id: "REFUNDUNPAID001",
          supplementary_data: {
            related_ids: { capture_id: unpaidTaskSpec.fundingCaptureId },
          },
        },
      }),
      runtime,
    );
    assert.equal(result.handled, true);
    assert.ok("receiptStatus" in result);
    assert.equal(result.receiptStatus, "REFUNDED");

    const halted = database.query<{
      status: string;
      submission_json: string | null;
      model_response_id: string | null;
      earned_cents: number;
      lease_token: string | null;
      next_attempt_at: number | null;
      last_error_code: string | null;
    }>(
      `SELECT status, submission_json, model_response_id, earned_cents,
              lease_token, next_attempt_at, last_error_code FROM live_jobs`,
    )[0];
    assert.equal(halted.status, "failed");
    assert.ok(halted.submission_json);
    assert.equal(halted.model_response_id, "resp-unpaid-001");
    assert.equal(halted.earned_cents, 500);
    assert.equal(halted.lease_token, null);
    assert.equal(halted.next_attempt_at, null);
    assert.equal(halted.last_error_code, "funding_reversed");
    assert.equal(
      database.query<{ status: string }>("SELECT status FROM funded_tasks")[0].status,
      "funding_reversed",
    );
    assert.equal(await claimLiveJob(created.id, runtime), null);
  } finally {
    database.close();
  }
});

test("a funding reversal discovered before payout blocks the claimant transfer", async () => {
  const database = new FakeD1Database();
  const runtime: RuntimeEnv = {
    DB: database.asBinding(),
    ...runtimeKeys,
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
    SUPPORT_EMAIL: "support@example.com",
  };

  try {
    const fundedTask = await createFundedTask(
      taskSpec,
      {
        provider: "paypal",
        captureId: taskSpec.fundingCaptureId,
        status: "COMPLETED",
        currency: "USD",
        grossCents: 750,
        netCents: 700,
        customId: taskSpec.sponsorReference,
        capturedAt: "2026-07-09T18:00:00Z",
      },
      runtime,
    );
    const created = await createLiveJob({
      ownerEmail: "owner@example.com",
      payoutMethod: "paypal",
      destination: "person@example.com",
      runtime,
    });
    const earningClaim = await claimLiveJob(created.id, runtime);
    assert.ok(earningClaim);
    const reservedTask = await taskForLiveJob(earningClaim, runtime);
    assert.equal(reservedTask?.id, fundedTask.id);
    assert.ok(reservedTask);
    assert.equal(
      await markEarningAccepted({
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
        responseId: "resp-reversal-001",
        model: "gpt-test",
        runtime,
      }),
      true,
    );

    let payoutCalls = 0;
    const result = await processLiveJob(created.id, {
      runtime,
      dependencies: {
        getAccessToken: async () => ({
          accessToken: "paypal-access-token",
          tokenType: "Bearer",
          expiresInSeconds: 3_600,
          scope: "payments",
        }),
        getFundingCapture: async () => ({
          provider: "paypal",
          captureId: taskSpec.fundingCaptureId,
          status: "REFUNDED",
          currency: "USD",
          grossCents: 750,
          netCents: 0,
          customId: taskSpec.sponsorReference,
          capturedAt: "2026-07-09T18:00:00Z",
        }),
        createPayout: async () => {
          payoutCalls += 1;
          throw new Error("A payout must not be submitted after a funding reversal.");
        },
      },
    });

    assert.deepEqual(result, {
      processed: true,
      jobId: created.id,
      stage: "needs_action",
    });
    assert.equal(payoutCalls, 0);
    assert.equal(
      database.query<{ count: number }>("SELECT COUNT(*) AS count FROM payouts")[0]
        .count,
      0,
    );
    assert.equal(
      database.query<{ status: string }>("SELECT status FROM live_jobs")[0].status,
      "needs_action",
    );
  } finally {
    database.close();
  }
});
