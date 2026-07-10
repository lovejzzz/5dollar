import assert from "node:assert/strict";
import test from "node:test";
import {
  SPONSOR_ORDER_REQUEST_THROTTLE,
  SponsorTaskRateLimitError,
} from "../lib/sponsor-tasks";
import {
  prepareSponsorFundingOrder,
  processNextSponsorCapture,
  processSponsorCapture,
  reconcileSponsorCancellation,
  sponsorTaskView,
} from "../lib/process-sponsor-order";
import type { RuntimeEnv } from "../lib/runtime-env";
import { FakeD1Database } from "./helpers/fake-d1";

function runtime(database: FakeD1Database): RuntimeEnv {
  return {
    DB: database.asBinding(),
    FIVE_MODE: "live",
    PAYPAL_MODE: "live",
    PAYOUT_ENCRYPTION_KEY: "encryption-key-placeholder",
    PAYOUT_FINGERPRINT_KEY: "fingerprint-key-placeholder",
    PROCESSOR_SECRET: "processor-secret-placeholder",
    TASK_ADMIN_SECRET: "task-admin-secret-placeholder",
    OPENAI_API_KEY: "openai-key-placeholder",
    PAYPAL_CLIENT_ID: "paypal-client-placeholder",
    PAYPAL_CLIENT_SECRET: "paypal-secret-placeholder",
    PAYPAL_WEBHOOK_ID: "paypal-webhook-placeholder",
    RESEND_API_KEY: "resend-key-placeholder",
    NOTIFICATION_FROM_EMAIL: "FIVE <payouts@example.com>",
    SUPPORT_EMAIL: "support@example.com",
  };
}

function payload() {
  return {
    clientRequestId: "f9be3c16-8e0a-4b13-8ee2-d99aa9cb8f61",
    title: "Summarize the supplied onboarding feedback",
    instructions:
      "Using only the supplied rows, summarize the strongest onboarding themes and cite each supporting source identifier.",
    input: {
      rows: [
        { id: "r1", feedback: "The first-run checklist made setup fast." },
        { id: "r2", feedback: "The final confirmation was easy to miss." },
      ],
    },
    acceptance: {
      requiredEvidenceIds: ["r1", "r2"],
      minEvidenceCount: 2,
    },
    minAnswerChars: 100,
    automationAllowed: true,
    autoAccept: true,
    rightsAttested: true,
    noSensitiveData: true,
  };
}

test("lost sponsor capture responses recover once through the scheduled processor", async () => {
  const database = new FakeD1Database();
  const liveRuntime = runtime(database);
  let createOrderCalls = 0;
  let captureCalls = 0;
  let createdCustomId = "";
  try {
    const prepared = await prepareSponsorFundingOrder({
      ownerEmail: "sponsor@example.com",
      payload: payload(),
      origin: "https://five.example",
      runtime: liveRuntime,
      dependencies: {
        getAccessToken: async () => ({
          accessToken: "access-token",
          tokenType: "Bearer",
          expiresInSeconds: 3_600,
          scope: "",
        }),
        createOrder: async (input) => {
          createOrderCalls += 1;
          assert.equal(input.amountCents, 800);
          assert.match(input.customId, /^sponsor:[0-9a-f-]{36}$/);
          createdCustomId = input.customId;
          assert.match(input.returnUrl, /\/sponsor\/complete\?draftId=/);
          return {
            provider: "paypal",
            orderId: "PAYPALORDER90001",
            status: "PAYER_ACTION_REQUIRED",
            approvalUrl:
              "https://www.paypal.com/checkoutnow?token=PAYPALORDER90001",
            requestId: "stable-create-request",
            invoiceId: "stable-invoice",
            customId: input.customId,
            currency: "USD",
            grossCents: input.amountCents,
          };
        },
      },
    });
    assert.equal(createOrderCalls, 1);
    assert.equal(prepared.orderId, "PAYPALORDER90001");
    assert.equal(createdCustomId, prepared.draft.sponsorReference);

    const first = await processSponsorCapture({
      draftId: prepared.draft.id,
      ownerEmail: "sponsor@example.com",
      paypalOrderId: "PAYPALORDER90001",
      runtime: liveRuntime,
      dependencies: {
        getAccessToken: async () => ({
          accessToken: "access-token",
          tokenType: "Bearer",
          expiresInSeconds: 3_600,
          scope: "",
        }),
        captureOrder: async () => {
          captureCalls += 1;
          throw new TypeError("simulated lost provider response");
        },
      },
    });
    assert.deepEqual(first, {
      processed: true,
      draftId: prepared.draft.id,
      stage: "capture_retry",
    });

    database.sqlite
      .prepare("UPDATE sponsor_task_orders SET next_attempt_at = 0 WHERE id = ?")
      .run(prepared.draft.id);
    const recovered = await processNextSponsorCapture({
      runtime: liveRuntime,
      dependencies: {
        getAccessToken: async () => ({
          accessToken: "access-token",
          tokenType: "Bearer",
          expiresInSeconds: 3_600,
          scope: "",
        }),
        captureOrder: async (input) => {
          captureCalls += 1;
          return {
            provider: "paypal",
            orderId: input.orderId,
            orderStatus: "COMPLETED",
            status: "COMPLETED",
            captureId: "CAPTURESPONSOR9001",
            captureStatus: "COMPLETED",
            currency: "USD",
            grossCents: 800,
            netCents: 710,
            customId: input.customId,
            invoiceId: "stable-invoice",
            capturedAt: "2026-07-09T23:30:00.000Z",
            approvalUrl: null,
          };
        },
      },
    });
    assert.deepEqual(recovered, {
      processed: true,
      draftId: prepared.draft.id,
      stage: "funded",
    });
    assert.equal(captureCalls, 2);
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

    const view = await sponsorTaskView(
      prepared.draft.id,
      "sponsor@example.com",
      liveRuntime,
    );
    assert.equal(view?.status, "funded");
    assert.equal(view?.workStatus, "waiting");
    assert.equal(view?.receipt?.captureId, "CAPTURESPONSOR9001");
    assert.equal(view?.receipt?.netCents, 710);

    const replay = await processSponsorCapture({
      draftId: prepared.draft.id,
      ownerEmail: "sponsor@example.com",
      paypalOrderId: "PAYPALORDER90001",
      runtime: liveRuntime,
    });
    assert.equal(replay.processed, true);
    assert.equal(replay.processed && replay.stage, "funded");
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM funded_tasks",
      )[0].count,
      1,
    );
  } finally {
    database.close();
  }
});

test("sponsor order preparation is draft-idempotent", async () => {
  const database = new FakeD1Database();
  const liveRuntime = runtime(database);
  const stableKeys: string[] = [];
  let orderReads = 0;
  try {
    const dependencies = {
      getAccessToken: async () => ({
        accessToken: "access-token",
        tokenType: "Bearer",
        expiresInSeconds: 3_600,
        scope: "",
      }),
      createOrder: async (input: {
        stableRequestKey: string;
        customId: string;
        amountCents: number;
      }) => {
        stableKeys.push(input.stableRequestKey);
        return {
          provider: "paypal" as const,
          orderId: "PAYPALORDER90002",
          status: "PAYER_ACTION_REQUIRED",
          approvalUrl:
            "https://www.paypal.com/checkoutnow?token=PAYPALORDER90002",
          requestId: "stable-create-request",
          invoiceId: "stable-invoice",
          customId: input.customId,
          currency: "USD" as const,
          grossCents: input.amountCents,
        };
      },
      getOrder: async (input: {
        orderId: string;
        customId: string;
        amountCents: number;
      }) => {
        orderReads += 1;
        return {
          provider: "paypal" as const,
          orderId: input.orderId,
          orderStatus: "PAYER_ACTION_REQUIRED",
          status: "PAYER_ACTION_REQUIRED",
          captureId: null,
          captureStatus: null,
          currency: "USD" as const,
          grossCents: input.amountCents,
          netCents: null,
          customId: input.customId,
          invoiceId: "stable-invoice",
          capturedAt: null,
          approvalUrl:
            "https://www.paypal.com/checkoutnow?token=PAYPALORDER90002",
        };
      },
    };
    const first = await prepareSponsorFundingOrder({
      ownerEmail: "sponsor@example.com",
      payload: payload(),
      origin: "https://five.example",
      runtime: liveRuntime,
      dependencies,
    });
    const replay = await prepareSponsorFundingOrder({
      ownerEmail: "sponsor@example.com",
      payload: payload(),
      origin: "https://five.example",
      runtime: liveRuntime,
      dependencies,
    });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.draft.id, first.draft.id);
    assert.deepEqual(stableKeys, [first.draft.id]);
    assert.equal(orderReads, 1);
    assert.equal(replay.orderId, "PAYPALORDER90002");
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

test("sponsor request throttle stops idempotent replay before another PayPal call", async () => {
  const database = new FakeD1Database();
  const liveRuntime = runtime(database);
  let accessTokenCalls = 0;
  let createOrderCalls = 0;
  let orderReads = 0;
  const dependencies = {
    getAccessToken: async () => {
      accessTokenCalls += 1;
      return {
        accessToken: "access-token",
        tokenType: "Bearer",
        expiresInSeconds: 3_600,
        scope: "",
      };
    },
    createOrder: async (input: {
      customId: string;
      amountCents: number;
    }) => {
      createOrderCalls += 1;
      return {
        provider: "paypal" as const,
        orderId: "PAYPALORDERTHROTTLE1",
        status: "PAYER_ACTION_REQUIRED",
        approvalUrl:
          "https://www.paypal.com/checkoutnow?token=PAYPALORDERTHROTTLE1",
        requestId: "stable-create-request",
        invoiceId: "stable-invoice",
        customId: input.customId,
        currency: "USD" as const,
        grossCents: input.amountCents,
      };
    },
    getOrder: async (input: {
      orderId: string;
      customId: string;
      amountCents: number;
    }) => {
      orderReads += 1;
      return {
        provider: "paypal" as const,
        orderId: input.orderId,
        orderStatus: "PAYER_ACTION_REQUIRED",
        status: "PAYER_ACTION_REQUIRED",
        captureId: null,
        captureStatus: null,
        currency: "USD" as const,
        grossCents: input.amountCents,
        netCents: null,
        customId: input.customId,
        invoiceId: "stable-invoice",
        capturedAt: null,
        approvalUrl:
          "https://www.paypal.com/checkoutnow?token=PAYPALORDERTHROTTLE1",
      };
    },
  };

  try {
    for (
      let request = 0;
      request < SPONSOR_ORDER_REQUEST_THROTTLE.maxRequests;
      request += 1
    ) {
      await prepareSponsorFundingOrder({
        ownerEmail: "throttled-sponsor@example.com",
        payload: payload(),
        origin: "https://five.example",
        runtime: liveRuntime,
        dependencies,
      });
    }

    await assert.rejects(
      prepareSponsorFundingOrder({
        ownerEmail: "throttled-sponsor@example.com",
        payload: payload(),
        origin: "https://five.example",
        runtime: liveRuntime,
        dependencies,
      }),
      SponsorTaskRateLimitError,
    );
    assert.equal(accessTokenCalls, SPONSOR_ORDER_REQUEST_THROTTLE.maxRequests);
    assert.equal(createOrderCalls, 1);
    assert.equal(
      orderReads,
      SPONSOR_ORDER_REQUEST_THROTTLE.maxRequests - 1,
    );
  } finally {
    database.close();
  }
});

test("the scheduler captures the stored approved order after the browser closes", async () => {
  const database = new FakeD1Database();
  const liveRuntime = runtime(database);
  try {
    const prepared = await prepareSponsorFundingOrder({
      ownerEmail: "closed-tab-sponsor@example.com",
      payload: {
        ...payload(),
        clientRequestId: "e078f8c0-0bd0-459a-9883-84b705c15939",
      },
      origin: "https://five.example",
      runtime: liveRuntime,
      dependencies: {
        getAccessToken: async () => ({
          accessToken: "access-token",
          tokenType: "Bearer",
          expiresInSeconds: 3_600,
          scope: "",
        }),
        createOrder: async (input) => ({
          provider: "paypal",
          orderId: "PAYPALORDERCLOSED1",
          status: "PAYER_ACTION_REQUIRED",
          approvalUrl:
            "https://www.paypal.com/checkoutnow?token=PAYPALORDERCLOSED1",
          requestId: "stable-create-request",
          invoiceId: "stable-invoice",
          customId: input.customId,
          currency: "USD",
          grossCents: input.amountCents,
        }),
      },
    });
    const stored = database.query<{
      status: string;
      paypal_order_id: string;
    }>(
      "SELECT status, paypal_order_id FROM sponsor_task_orders WHERE id = ?",
      prepared.draft.id,
    )[0];
    assert.equal(stored.status, "order_created");
    assert.equal(stored.paypal_order_id, "PAYPALORDERCLOSED1");
    database.sqlite
      .prepare("UPDATE sponsor_task_orders SET next_attempt_at = 0 WHERE id = ?")
      .run(prepared.draft.id);

    let orderReads = 0;
    let captureCalls = 0;
    const result = await processNextSponsorCapture({
      runtime: liveRuntime,
      dependencies: {
        getAccessToken: async () => ({
          accessToken: "access-token",
          tokenType: "Bearer",
          expiresInSeconds: 3_600,
          scope: "",
        }),
        getOrder: async (input) => {
          orderReads += 1;
          return {
            provider: "paypal",
            orderId: input.orderId,
            orderStatus: "APPROVED",
            status: "APPROVED",
            captureId: null,
            captureStatus: null,
            currency: "USD",
            grossCents: input.amountCents,
            netCents: null,
            customId: input.customId,
            invoiceId: "stable-invoice",
            capturedAt: null,
            approvalUrl: null,
          };
        },
        captureOrder: async (input) => {
          captureCalls += 1;
          return {
            provider: "paypal",
            orderId: input.orderId,
            orderStatus: "COMPLETED",
            status: "COMPLETED",
            captureId: "CAPTURECLOSEDTAB01",
            captureStatus: "COMPLETED",
            currency: "USD",
            grossCents: input.amountCents,
            netCents: 705,
            customId: input.customId,
            invoiceId: "stable-invoice",
            capturedAt: "2026-07-09T23:45:00.000Z",
            approvalUrl: null,
          };
        },
      },
    });
    assert.deepEqual(result, {
      processed: true,
      draftId: prepared.draft.id,
      stage: "funded",
    });
    assert.equal(orderReads, 1);
    assert.equal(captureCalls, 1);
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM funded_tasks",
      )[0].count,
      1,
    );
  } finally {
    database.close();
  }
});

test("cancel returns use PayPal truth instead of trusting the query string", async () => {
  const database = new FakeD1Database();
  const liveRuntime = runtime(database);
  try {
    const createDependencies = {
      getAccessToken: async () => ({
        accessToken: "access-token",
        tokenType: "Bearer",
        expiresInSeconds: 3_600,
        scope: "",
      }),
      createOrder: async (input: {
        customId: string;
        amountCents: number;
      }) => ({
        provider: "paypal" as const,
        orderId: "PAYPALORDERCANCEL1",
        status: "PAYER_ACTION_REQUIRED",
        approvalUrl:
          "https://www.paypal.com/checkoutnow?token=PAYPALORDERCANCEL1",
        requestId: "stable-create-request",
        invoiceId: "stable-invoice",
        customId: input.customId,
        currency: "USD" as const,
        grossCents: input.amountCents,
      }),
    };
    const prepared = await prepareSponsorFundingOrder({
      ownerEmail: "cancel-sponsor@example.com",
      payload: {
        ...payload(),
        clientRequestId: "b02da8e1-65da-4edc-8d0a-89f4bfd7f617",
      },
      origin: "https://five.example",
      runtime: liveRuntime,
      dependencies: createDependencies,
    });
    const canceled = await reconcileSponsorCancellation({
      draftId: prepared.draft.id,
      ownerEmail: "cancel-sponsor@example.com",
      runtime: liveRuntime,
      dependencies: {
        getAccessToken: createDependencies.getAccessToken,
        getOrder: async (input) => ({
          provider: "paypal",
          orderId: input.orderId,
          orderStatus: "PAYER_ACTION_REQUIRED",
          status: "PAYER_ACTION_REQUIRED",
          captureId: null,
          captureStatus: null,
          currency: "USD",
          grossCents: input.amountCents,
          netCents: null,
          customId: input.customId,
          invoiceId: "stable-invoice",
          capturedAt: null,
          approvalUrl:
            "https://www.paypal.com/checkoutnow?token=PAYPALORDERCANCEL1",
        }),
      },
    });
    assert.equal(canceled.found, true);
    assert.equal(canceled.found && canceled.canceled, true);
    const canceledView = await sponsorTaskView(
      prepared.draft.id,
      "cancel-sponsor@example.com",
      liveRuntime,
    );
    assert.equal(canceledView?.status, "canceled");
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

test("a forged cancel return cannot suppress an approved sponsor payment", async () => {
  const database = new FakeD1Database();
  const liveRuntime = runtime(database);
  try {
    const prepared = await prepareSponsorFundingOrder({
      ownerEmail: "approved-cancel@example.com",
      payload: {
        ...payload(),
        clientRequestId: "a50bb7d0-ecf4-4fb3-a3d6-d76fc8f15f83",
      },
      origin: "https://five.example",
      runtime: liveRuntime,
      dependencies: {
        getAccessToken: async () => ({
          accessToken: "access-token",
          tokenType: "Bearer",
          expiresInSeconds: 3_600,
          scope: "",
        }),
        createOrder: async (input) => ({
          provider: "paypal",
          orderId: "PAYPALORDERAPPROV1",
          status: "PAYER_ACTION_REQUIRED",
          approvalUrl:
            "https://www.paypal.com/checkoutnow?token=PAYPALORDERAPPROV1",
          requestId: "stable-create-request",
          invoiceId: "stable-invoice",
          customId: input.customId,
          currency: "USD",
          grossCents: input.amountCents,
        }),
      },
    });
    const dependencies = {
      getAccessToken: async () => ({
        accessToken: "access-token",
        tokenType: "Bearer",
        expiresInSeconds: 3_600,
        scope: "",
      }),
      getOrder: async (input: {
        orderId: string;
        amountCents: number;
        customId: string;
      }) => ({
        provider: "paypal" as const,
        orderId: input.orderId,
        orderStatus: "APPROVED",
        status: "APPROVED",
        captureId: null,
        captureStatus: null,
        currency: "USD" as const,
        grossCents: input.amountCents,
        netCents: null,
        customId: input.customId,
        invoiceId: "stable-invoice",
        capturedAt: null,
        approvalUrl: null,
      }),
      captureOrder: async (input: {
        orderId: string;
        amountCents: number;
        customId: string;
      }) => ({
        provider: "paypal" as const,
        orderId: input.orderId,
        orderStatus: "COMPLETED",
        status: "COMPLETED",
        captureId: "CAPTUREAPPROVED01",
        captureStatus: "COMPLETED",
        currency: "USD" as const,
        grossCents: input.amountCents,
        netCents: 704,
        customId: input.customId,
        invoiceId: "stable-invoice",
        capturedAt: "2026-07-10T00:00:00.000Z",
        approvalUrl: null,
      }),
    };
    const result = await reconcileSponsorCancellation({
      draftId: prepared.draft.id,
      ownerEmail: "approved-cancel@example.com",
      paypalOrderId: "PAYPALORDERAPPROV1",
      runtime: liveRuntime,
      dependencies,
    });
    assert.equal(result.found, true);
    assert.equal(result.found && result.canceled, false);
    const view = await sponsorTaskView(
      prepared.draft.id,
      "approved-cancel@example.com",
      liveRuntime,
    );
    assert.equal(view?.status, "funded");
  } finally {
    database.close();
  }
});
