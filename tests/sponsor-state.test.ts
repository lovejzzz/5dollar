import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeEnv } from "../lib/runtime-env";
import { applyPayPalWebhook, createFundedTask } from "../lib/live-jobs";
import {
  claimSponsorCapture,
  claimNextSponsorCapture,
  createSponsorDraft,
  finalizeSponsorCapture,
  getSponsorDraftForOwner,
  markSponsorCaptureRetry,
  recordSponsorCapturePending,
  SPONSOR_ORDER_REQUEST_THROTTLE,
  SponsorTaskConflictError,
  SponsorTaskRateLimitError,
  SponsorTaskValidationError,
  validateSponsorDraftPayload,
} from "../lib/sponsor-tasks";
import { FakeD1Database } from "./helpers/fake-d1";

const ownerEmail = "sponsor@example.com";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    clientRequestId: "87a4f641-5f4f-478b-9764-89c090f0a991",
    title: "Summarize the supplied product feedback rows",
    instructions:
      "Using only the supplied feedback rows, summarize the strongest themes and cite the supporting source row identifiers.",
    input: {
      rows: [
        { id: "row-1", feedback: "Setup was fast and straightforward." },
        { id: "row-2", feedback: "The navigation labels were clear." },
      ],
    },
    acceptance: {
      requiredEvidenceIds: ["row-1", "row-2"],
      minEvidenceCount: 2,
    },
    minAnswerChars: 100,
    automationAllowed: true,
    autoAccept: true,
    rightsAttested: true,
    noSensitiveData: true,
    ...overrides,
  };
}

test("sponsor draft validation requires attestations and rejects sensitive data", () => {
  assert.throws(
    () => validateSponsorDraftPayload(payload({ rightsAttested: false })),
    SponsorTaskValidationError,
  );
  assert.throws(
    () =>
      validateSponsorDraftPayload(
        payload({
          input: {
            rows: [
              {
                id: "row-1",
                feedback: "Contact private.person@example.com for details.",
              },
              { id: "row-2", feedback: "Safe feedback." },
            ],
          },
        }),
      ),
    /email addresses/,
  );
  assert.throws(
    () =>
      validateSponsorDraftPayload(
        payload({
          input: {
            rows: [
              { id: "row-1", feedback: "Card 4111 1111 1111 1111" },
              { id: "row-2", feedback: "Safe feedback." },
            ],
          },
        }),
      ),
    /payment-card numbers/,
  );
  for (const sensitiveInput of [
    { id: "row-1", feedback: "Call me at (212) 555-0198." },
    { id: "row-1", full_name: "Private Person", feedback: "Safe feedback." },
    { id: "row-1", feedback: "Send it to 123 Main Street." },
    { id: "row-1", feedback: "Diagnosis: hypertension" },
    { id: "row-1", feedback: "IBAN: GB82WEST12345698765432" },
    { id: "row-1", feedback: "Device observed at 192.168.10.4" },
  ]) {
    assert.throws(
      () =>
        validateSponsorDraftPayload(
          payload({ input: { rows: [sensitiveInput] } }),
        ),
      SponsorTaskValidationError,
    );
  }
  assert.throws(
    () =>
      validateSponsorDraftPayload(
        payload({
          acceptance: { requiredEvidenceIds: ["missing-row"] },
        }),
      ),
    /must exist in the supplied task input/,
  );
});

test("sponsor drafts are owner-scoped and idempotent without claimant data", async () => {
  const database = new FakeD1Database();
  const runtime: RuntimeEnv = { DB: database.asBinding() };
  try {
    const created = await createSponsorDraft({
      ownerEmail: "  Sponsor@Example.com ",
      payload: payload(),
      runtime,
    });
    assert.equal(created.duplicate, false);
    assert.equal(created.draft.status, "draft");
    assert.deepEqual(created.draft.charge, {
      currency: "USD",
      grossCents: 800,
      minimumNetCents: 600,
      payoutCents: 500,
    });
    assert.equal(created.paypalOrderSpec.amount, "8.00");
    assert.equal(
      created.paypalOrderSpec.customId,
      created.draft.sponsorReference,
    );
    assert.ok(!("ownerEmail" in created.draft));

    const replay = await createSponsorDraft({
      ownerEmail,
      payload: payload(),
      runtime,
    });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.draft.id, created.draft.id);
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sponsor_task_orders",
      )[0].count,
      1,
    );

    await assert.rejects(
      createSponsorDraft({
        ownerEmail,
        payload: payload({ title: "A different valid summary task title" }),
        runtime,
      }),
      SponsorTaskConflictError,
    );
    assert.equal(
      await getSponsorDraftForOwner(
        created.draft.id,
        "another-sponsor@example.com",
        runtime,
      ),
      null,
    );

    const columns = database
      .query<{ name: string }>("PRAGMA table_info(sponsor_task_orders)")
      .map((column) => column.name);
    assert.ok(!columns.includes("claimant_email"));
    assert.ok(!columns.includes("payout_destination"));
    assert.ok(!columns.includes("destination_ciphertext"));
  } finally {
    database.close();
  }
});

test("sponsor order-request limits count idempotent replays durably", async () => {
  const database = new FakeD1Database();
  const runtime: RuntimeEnv = { DB: database.asBinding() };
  try {
    for (
      let request = 0;
      request < SPONSOR_ORDER_REQUEST_THROTTLE.maxRequests;
      request += 1
    ) {
      const creation = await createSponsorDraft({
        ownerEmail,
        payload: payload(),
        runtime,
      });
      assert.equal(creation.duplicate, request > 0);
    }

    await assert.rejects(
      createSponsorDraft({ ownerEmail, payload: payload(), runtime }),
      (error: unknown) => {
        assert.ok(error instanceof SponsorTaskRateLimitError);
        assert.match(error.message, /too many requests/i);
        assert.ok(error.retryAfterSeconds > 0);
        assert.ok(
          error.retryAfterSeconds <=
            SPONSOR_ORDER_REQUEST_THROTTLE.windowMs / 1_000,
        );
        return true;
      },
    );

    const limitRows = database.query<{
      owner_email: string;
      request_count: number;
    }>("SELECT owner_email, request_count FROM sponsor_order_request_limits");
    assert.equal(limitRows.length, 1);
    assert.equal(limitRows[0].owner_email, ownerEmail);
    assert.equal(
      limitRows[0].request_count,
      SPONSOR_ORDER_REQUEST_THROTTLE.maxRequests,
    );
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sponsor_task_orders",
      )[0].count,
      1,
    );
  } finally {
    database.close();
  }
});

test("capture activation is lease-fenced, retryable, and funds exactly once", async () => {
  const database = new FakeD1Database();
  const runtime: RuntimeEnv = { DB: database.asBinding() };
  try {
    const created = await createSponsorDraft({
      ownerEmail,
      payload: payload(),
      runtime,
    });
    const firstClaim = await claimSponsorCapture(
      created.draft.id,
      ownerEmail,
      "PAYPALORDER00001",
      runtime,
    );
    assert.equal(firstClaim?.kind, "claimed");
    if (!firstClaim || firstClaim.kind !== "claimed") {
      throw new Error("Expected the first capture lease.");
    }

    const concurrentClaim = await claimSponsorCapture(
      created.draft.id,
      ownerEmail,
      "PAYPALORDER00001",
      runtime,
    );
    assert.equal(concurrentClaim?.kind, "busy");
    assert.equal(
      await markSponsorCaptureRetry({
        draft: firstClaim.draft,
        leaseToken: "stale-lease-token",
        code: "network",
        message: "stale worker",
        runtime,
      }),
      null,
    );

    const retry = await markSponsorCaptureRetry({
      draft: firstClaim.draft,
      leaseToken: firstClaim.leaseToken,
      code: "paypal_timeout",
      message: "PayPal did not answer before the request deadline.",
      retryAfterMs: 1_000,
      runtime,
    });
    assert.equal(retry?.status, "capture_retry");
    database.sqlite.exec(
      `UPDATE sponsor_task_orders SET next_attempt_at = 0 WHERE id = '${created.draft.id}'`,
    );

    const secondClaim = await claimSponsorCapture(
      created.draft.id,
      ownerEmail,
      "PAYPALORDER00001",
      runtime,
    );
    assert.equal(secondClaim?.kind, "claimed");
    if (!secondClaim || secondClaim.kind !== "claimed") {
      throw new Error("Expected the retry capture lease.");
    }

    const capture = {
      provider: "paypal" as const,
      captureId: "CAPTURESPONSOR001",
      status: "COMPLETED",
      currency: "USD",
      grossCents: 800,
      netCents: 700,
      customId: created.draft.sponsorReference,
      capturedAt: "2026-07-09T22:00:00.000Z",
    };
    const funded = await finalizeSponsorCapture({
      draft: secondClaim.draft,
      leaseToken: secondClaim.leaseToken,
      capture,
      runtime,
    });
    assert.equal(funded.status, "funded");
    assert.ok(funded.fundedTaskId);
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM funded_tasks",
      )[0].count,
      1,
    );
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM funding_receipts",
      )[0].count,
      1,
    );
    const storedTask = database.query<{
      reward_cents: number;
      payout_cents: number;
    }>("SELECT reward_cents, payout_cents FROM funded_tasks")[0];
    assert.deepEqual({ ...storedTask }, { reward_cents: 600, payout_cents: 500 });

    const replay = await claimSponsorCapture(
      created.draft.id,
      ownerEmail,
      "PAYPALORDER00001",
      runtime,
    );
    assert.equal(replay?.kind, "already_funded");

    await assert.rejects(
      createFundedTask(
        {
          ...payload(),
          title: "A conflicting task bound to the same capture",
          taskType: "dataset_summary",
          rewardCents: 600,
          sponsorReference: created.draft.sponsorReference,
          fundingCaptureId: capture.captureId,
        },
        capture,
        runtime,
      ),
      /different immutable task contract/,
    );

    const laterReversal = await applyPayPalWebhook(
      JSON.stringify({
        id: "WH-SPONSOR-FUNDING-REVERSED",
        event_type: "PAYMENT.CAPTURE.REVERSED",
        resource_type: "capture",
        create_time: "2026-07-09T22:00:30.000Z",
        resource: { id: capture.captureId },
      }),
      runtime,
    );
    assert.equal(laterReversal.handled, true);
    assert.equal(
      database.query<{ status: string }>(
        "SELECT status FROM sponsor_task_orders",
      )[0].status,
      "needs_review",
    );
    assert.equal(
      database.query<{ status: string }>("SELECT status FROM funded_tasks")[0]
        .status,
      "funding_reversed",
    );
  } finally {
    database.close();
  }
});

test("a captured payment that violates the immutable contract needs review", async () => {
  const database = new FakeD1Database();
  const runtime: RuntimeEnv = { DB: database.asBinding() };
  try {
    const created = await createSponsorDraft({
      ownerEmail,
      payload: payload({
        clientRequestId: "439e5f99-933e-4472-8371-e65f1d8247bc",
      }),
      runtime,
    });
    const claim = await claimSponsorCapture(
      created.draft.id,
      ownerEmail,
      "PAYPALORDER00002",
      runtime,
    );
    assert.equal(claim?.kind, "claimed");
    if (!claim || claim.kind !== "claimed") {
      throw new Error("Expected a capture lease.");
    }

    await assert.rejects(
      finalizeSponsorCapture({
        draft: claim.draft,
        leaseToken: claim.leaseToken,
        capture: {
          provider: "paypal",
          captureId: "CAPTURESPONSOR002",
          status: "COMPLETED",
          currency: "USD",
          grossCents: 800,
          netCents: 550,
          customId: created.draft.sponsorReference,
          capturedAt: "2026-07-09T22:01:00.000Z",
        },
        runtime,
      }),
      SponsorTaskConflictError,
    );
    const stored = database.query<{ status: string; last_error_code: string }>(
      "SELECT status, last_error_code FROM sponsor_task_orders",
    )[0];
    assert.deepEqual({ ...stored }, {
      status: "needs_review",
      last_error_code: "capture_contract_mismatch",
    });
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM funded_tasks",
      )[0].count,
      0,
    );
  } finally {
    database.close();
  }
});

test("a terminal funding webhook that arrives before its receipt blocks activation", async () => {
  const database = new FakeD1Database();
  const runtime: RuntimeEnv = { DB: database.asBinding() };
  try {
    const created = await createSponsorDraft({
      ownerEmail,
      payload: payload({
        clientRequestId: "0aa930e6-4ae5-4556-828e-d243a5288dbc",
      }),
      runtime,
    });
    const claim = await claimSponsorCapture(
      created.draft.id,
      ownerEmail,
      "PAYPALORDEREARLY1",
      runtime,
    );
    assert.equal(claim?.kind, "claimed");
    if (!claim || claim.kind !== "claimed") {
      throw new Error("Expected a capture lease.");
    }

    const captureId = "CAPTUREEARLY001";
    const terminal = await applyPayPalWebhook(
      JSON.stringify({
        id: "WH-EARLY-REFUND-001",
        event_type: "PAYMENT.CAPTURE.REFUNDED",
        resource_type: "capture",
        create_time: "2026-07-09T22:02:00.000Z",
        resource: { id: captureId },
      }),
      runtime,
    );
    assert.equal(terminal.handled, true);
    assert.equal("pendingReceipt" in terminal && terminal.pendingReceipt, true);
    assert.deepEqual(
      {
        ...database.query<{
          funding_receipt_id: string | null;
          applied_at: number | null;
        }>(
          "SELECT funding_receipt_id, applied_at FROM paypal_funding_webhook_events",
        )[0],
      },
      { funding_receipt_id: null, applied_at: null },
    );

    await assert.rejects(
      finalizeSponsorCapture({
        draft: claim.draft,
        leaseToken: claim.leaseToken,
        capture: {
          provider: "paypal",
          captureId,
          status: "COMPLETED",
          currency: "USD",
          grossCents: 800,
          netCents: 700,
          customId: created.draft.sponsorReference,
          capturedAt: "2026-07-09T22:01:59.000Z",
        },
        runtime,
      }),
      SponsorTaskConflictError,
    );
    assert.deepEqual(
      {
        ...database.query<{ status: string; last_error_code: string }>(
          "SELECT status, last_error_code FROM sponsor_task_orders",
        )[0],
      },
      { status: "needs_review", last_error_code: "funding_terminal_event" },
    );
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM funded_tasks",
      )[0].count,
      0,
    );
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM funding_receipts",
      )[0].count,
      0,
    );
  } finally {
    database.close();
  }
});

test("ordinary pending capture observations reset the consecutive failure budget", async () => {
  const database = new FakeD1Database();
  const runtime: RuntimeEnv = { DB: database.asBinding() };
  try {
    const created = await createSponsorDraft({
      ownerEmail,
      payload: payload({
        clientRequestId: "11a90cc7-03b0-4761-9b17-78c16e2c4051",
      }),
      runtime,
    });
    const claim = await claimSponsorCapture(
      created.draft.id,
      ownerEmail,
      "PAYPALORDERPENDING1",
      runtime,
    );
    assert.equal(claim?.kind, "claimed");
    if (!claim || claim.kind !== "claimed") throw new Error("Expected capture claim.");
    await recordSponsorCapturePending({
      draft: claim.draft,
      leaseToken: claim.leaseToken,
      captureId: "CAPTUREPENDING001",
      runtime,
    });
    assert.equal(
      database.query<{ attempts: number }>(
        "SELECT attempts FROM sponsor_task_orders WHERE id = ?",
        created.draft.id,
      )[0].attempts,
      0,
    );
    database.sqlite
      .prepare("UPDATE sponsor_task_orders SET next_attempt_at = 0 WHERE id = ?")
      .run(created.draft.id);
    const scheduled = await claimNextSponsorCapture(runtime);
    assert.equal(scheduled?.kind, "claimed");
    assert.equal(scheduled?.draft.attempts, 1);
  } finally {
    database.close();
  }
});
