import assert from "node:assert/strict";
import test from "node:test";
import { liveCanaryCertificate } from "../lib/live-canary";
import {
  applyPayPalPayoutObservation,
  applyPayPalWebhook,
  claimLiveJob,
  createLiveJob,
  getOrCreatePayout,
  markEarningAccepted,
  markPayoutPending,
  taskForLiveJob,
} from "../lib/live-jobs";
import { createPayPalPayoutIdempotency } from "../lib/payouts/paypal";
import { processNotification } from "../lib/process-notification";
import {
  claimSponsorCapture,
  createSponsorDraft,
  finalizeSponsorCapture,
} from "../lib/sponsor-tasks";
import type { RuntimeEnv } from "../lib/runtime-env";
import { FakeD1Database } from "./helpers/fake-d1";

function liveRuntime(database: FakeD1Database): RuntimeEnv {
  return {
    DB: database.asBinding(),
    FIVE_MODE: "live",
    PAYPAL_MODE: "live",
    PAYOUT_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    PAYOUT_FINGERPRINT_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
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
}

test("a canary certificate proves the complete real-money contract without private data", async () => {
  const database = new FakeD1Database();
  const runtime = liveRuntime(database);
  const sponsorEmail = "canary-sponsor@example.com";
  const claimantEmail = "canary-claimant@example.com";
  try {
    const sponsor = await createSponsorDraft({
      ownerEmail: sponsorEmail,
      payload: {
        clientRequestId: "297c2a99-9065-41b8-a96a-e02fa5ad3fec",
        title: "Summarize the supplied canary feedback rows",
        instructions:
          "Using only the supplied feedback rows, summarize the strongest themes and cite each supporting source row identifier.",
        input: {
          rows: [
            { id: "r1", feedback: "Setup was quick and clear." },
            { id: "r2", feedback: "The final confirmation was useful." },
          ],
        },
        acceptance: {
          requiredEvidenceIds: ["r1", "r2"],
          minEvidenceCount: 2,
        },
        minAnswerChars: 80,
        automationAllowed: true,
        autoAccept: true,
        rightsAttested: true,
        noSensitiveData: true,
      },
      runtime,
    });
    const sponsorClaim = await claimSponsorCapture(
      sponsor.draft.id,
      sponsorEmail,
      "PAYPALORDERCANARY1",
      runtime,
    );
    assert.equal(sponsorClaim?.kind, "claimed");
    if (!sponsorClaim || sponsorClaim.kind !== "claimed") {
      throw new Error("Expected a sponsor capture lease.");
    }
    const captureId = "CAPTURECANARY001";
    await finalizeSponsorCapture({
      draft: sponsorClaim.draft,
      leaseToken: sponsorClaim.leaseToken,
      capture: {
        provider: "paypal",
        captureId,
        status: "COMPLETED",
        currency: "USD",
        grossCents: 800,
        netCents: 700,
        customId: sponsor.draft.sponsorReference,
        capturedAt: "2026-07-10T12:00:00.000Z",
      },
      runtime,
    });

    const createdJob = await createLiveJob({
      ownerEmail: claimantEmail,
      payoutMethod: "paypal",
      destination: claimantEmail,
      runtime,
    });
    const earningClaim = await claimLiveJob(createdJob.id, runtime);
    assert.ok(earningClaim);
    const task = await taskForLiveJob(earningClaim, runtime);
    assert.ok(task);
    assert.equal(
      await markEarningAccepted({
        job: earningClaim,
        task,
        submission: {
          answer:
            "The supplied rows show that setup clarity and the final confirmation were the strongest positive themes in this canary dataset.",
          evidence: [
            "r1: Setup was quick and clear.",
            "r2: The final confirmation was useful.",
          ],
          qualityNotes: ["Used only the two supplied canary rows."],
        },
        answerLength: 126,
        acceptancePassed: true,
        responseId: "resp-canary-001",
        model: "gpt-canary",
        runtime,
      }),
      true,
    );

    const payoutClaim = await claimLiveJob(createdJob.id, runtime);
    assert.ok(payoutClaim);
    const ids = await createPayPalPayoutIdempotency(createdJob.id);
    await getOrCreatePayout(createdJob.id, ids, runtime);
    assert.equal(
      await markPayoutPending({
        job: payoutClaim,
        payoutBatchId: "PBATCH-CANARY-001",
        batchStatus: "PENDING",
        senderBatchId: ids.senderBatchId,
        senderItemId: ids.senderItemId,
        runtime,
      }),
      true,
    );
    database.sqlite.exec(
      `UPDATE live_jobs SET next_attempt_at = 0 WHERE id = '${createdJob.id}'`,
    );
    const reconciliationClaim = await claimLiveJob(createdJob.id, runtime);
    assert.ok(reconciliationClaim);
    assert.equal(
      await applyPayPalPayoutObservation({
        job: reconciliationClaim,
        observation: {
          provider: "paypal",
          payoutBatchId: "PBATCH-CANARY-001",
          batchStatus: "SUCCESS",
          senderBatchId: ids.senderBatchId,
          senderItemId: ids.senderItemId,
          providerItemId: "PITEM-CANARY-001",
          itemStatus: "SUCCESS",
        },
        runtime,
      }),
      "paid",
    );
    assert.equal(
      (
        await processNotification({
          runtime,
          dependencies: {
            send: async () => ({
              provider: "resend" as const,
              messageId: "email-canary-001",
            }),
          },
        })
      ).status,
      "sent",
    );

    const certificate = await liveCanaryCertificate(createdJob.id, runtime);
    assert.ok(certificate);
    assert.equal(certificate.passed, true);
    assert.ok(Object.values(certificate.gates).every(Boolean));
    assert.deepEqual(certificate.state, {
      sponsor: "funded",
      funding: "COMPLETED",
      task: "accepted",
      job: "paid",
      payout: "SUCCEEDED",
      notification: "sent",
    });
    const serialized = JSON.stringify(certificate);
    for (const privateValue of [
      sponsorEmail,
      claimantEmail,
      "PAYPALORDERCANARY1",
      captureId,
      "PBATCH-CANARY-001",
      "PITEM-CANARY-001",
      "email-canary-001",
    ]) {
      assert.ok(!serialized.includes(privateValue));
    }

    await applyPayPalWebhook(
      JSON.stringify({
        id: "WH-CANARY-FUNDING-REVERSED",
        event_type: "PAYMENT.CAPTURE.REVERSED",
        resource_type: "capture",
        create_time: "2026-07-10T12:10:00.000Z",
        resource: { id: captureId },
      }),
      runtime,
    );
    const invalidated = await liveCanaryCertificate(createdJob.id, runtime);
    assert.ok(invalidated);
    assert.equal(invalidated.passed, false);
    assert.equal(invalidated.gates.noFundingReversal, false);
    assert.equal(invalidated.gates.sponsorCaptureSettled, false);
  } finally {
    database.close();
  }
});
