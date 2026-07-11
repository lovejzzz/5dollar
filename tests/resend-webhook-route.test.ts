import assert from "node:assert/strict";
import test from "node:test";
import { env } from "cloudflare:workers";
import { Webhook } from "svix";
import { POST } from "../app/api/webhooks/resend/route";
import type { RuntimeEnv } from "../lib/runtime-env";
import { FakeD1Database } from "./helpers/fake-d1";

const WEBHOOK_SECRET = `whsec_${Buffer.from(
  "five-resend-webhook-test-secret",
).toString("base64")}`;

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
    RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
    NOTIFICATION_FROM_EMAIL: "Five <payouts@example.com>",
    SUPPORT_EMAIL: "support@example.com",
  };
}

function signedRequest(rawPayload: string, eventId: string, now: Date) {
  return new Request("https://five.example/api/webhooks/resend", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": eventId,
      "svix-timestamp": String(Math.floor(now.getTime() / 1_000)),
      "svix-signature": new Webhook(WEBHOOK_SECRET).sign(
        eventId,
        now,
        rawPayload,
      ),
    },
    body: rawPayload,
  });
}

test("the Resend route verifies, minimizes, and deduplicates delivery events", async () => {
  const database = new FakeD1Database();
  const runtimeEnv = env as unknown as Record<string, unknown>;
  Object.assign(runtimeEnv, liveRuntime(database));
  try {
    const now = new Date();
    const eventId = "msg_route_delivery_001";
    const rawPayload = JSON.stringify({
      type: "email.delivered",
      created_at: now.toISOString(),
      data: {
        email_id: "email-route-001",
        to: ["private-route-claimant@example.com"],
        subject: "Your $5 has arrived",
        tags: { category: "payout_arrived" },
      },
    });
    const response = await POST(signedRequest(rawPayload, eventId, now));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      received: true,
      handled: true,
      duplicate: false,
      deliveryStatus: "delivered",
    });

    const duplicate = await POST(signedRequest(rawPayload, eventId, now));
    assert.equal(duplicate.status, 200);
    assert.equal(
      (await duplicate.json() as { duplicate?: boolean }).duplicate,
      true,
    );

    const rows = database.query<Record<string, unknown>>(
      "SELECT * FROM resend_webhook_events",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_id, eventId);
    assert.equal(rows[0].notification_kind, "payout_arrived");
    assert.equal(rows[0].provider_message_id, "email-route-001");
    assert.ok(!JSON.stringify(rows).includes("private-route-claimant@example.com"));

    const unrelatedPayload = rawPayload.replace(
      "payout_arrived",
      "unrelated_product",
    );
    const unrelated = await POST(
      signedRequest(unrelatedPayload, "msg_route_unrelated_001", now),
    );
    assert.equal(unrelated.status, 200);
    assert.deepEqual(await unrelated.json(), {
      received: true,
      handled: false,
    });
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM resend_webhook_events",
      )[0].count,
      1,
    );

    const signedTampered = signedRequest(
      rawPayload,
      "msg_route_tampered_001",
      now,
    );
    const invalid = new Request(signedTampered.url, {
      method: "POST",
      headers: signedTampered.headers,
      body: `${rawPayload} `,
    });
    assert.equal((await POST(invalid)).status, 400);
    assert.equal(
      database.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM resend_webhook_events",
      )[0].count,
      1,
    );

    delete runtimeEnv.RESEND_WEBHOOK_SECRET;
    const unconfigured = await POST(
      signedRequest(rawPayload, "msg_route_unconfigured_001", now),
    );
    assert.equal(unconfigured.status, 503);
  } finally {
    for (const key of Object.keys(runtimeEnv)) delete runtimeEnv[key];
    database.close();
  }
});
