import assert from "node:assert/strict";
import test from "node:test";

import { createRelay } from "../relay/index";

const env = {
  FIVE_TARGET_ORIGIN: "https://private-five.example",
  PROCESSOR_SECRET: "processor-test-secret",
  SITES_BYPASS_TOKEN: "sites-test-token",
};

const paypalHeaders = {
  "content-type": "application/json",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.paypal.com/cert.pem",
  "paypal-transmission-id": "transmission-id",
  "paypal-transmission-sig": "signature",
  "paypal-transmission-time": "2026-07-10T14:00:00Z",
};

test("PayPal relay preserves the signed body and required headers", async () => {
  const forwarded: Request[] = [];
  const relay = createRelay(async (request) => {
    forwarded.push(request);
    return Response.json({ received: true });
  });
  const rawBody = '{"event_type":"PAYMENT.PAYOUTS-ITEM.SUCCEEDED","n":1}';
  const response = await relay.fetch(
    new Request("https://relay.example/webhooks/paypal", {
      method: "POST",
      headers: paypalHeaders,
      body: rawBody,
    }),
    env,
  );

  assert.equal(response.status, 200);
  const forwardedRequest = forwarded[0];
  assert.ok(forwardedRequest);
  assert.equal(forwardedRequest.url, "https://private-five.example/api/webhooks/paypal");
  assert.equal(await forwardedRequest.text(), rawBody);
  assert.equal(forwardedRequest.headers.get("paypal-transmission-id"), "transmission-id");
  assert.equal(
    forwardedRequest.headers.get("oai-sites-authorization"),
    "Bearer sites-test-token",
  );
});

test("Resend relay preserves the Svix signature contract", async () => {
  const forwarded: Request[] = [];
  const relay = createRelay(async (request) => {
    forwarded.push(request);
    return Response.json({ received: true });
  });
  const rawBody = '{"type":"email.delivered","created_at":"now"}';
  const response = await relay.fetch(
    new Request("https://relay.example/webhooks/resend", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": "msg_1",
        "svix-timestamp": "1783692000",
        "svix-signature": "v1,signature",
      },
      body: rawBody,
    }),
    env,
  );

  assert.equal(response.status, 200);
  const forwardedRequest = forwarded[0];
  assert.ok(forwardedRequest);
  assert.equal(forwardedRequest.url, "https://private-five.example/api/webhooks/resend");
  assert.equal(await forwardedRequest.text(), rawBody);
  assert.equal(forwardedRequest.headers.get("svix-signature"), "v1,signature");
  assert.equal(
    forwardedRequest.headers.get("oai-sites-authorization"),
    "Bearer sites-test-token",
  );
});

test("relay rejects invalid signatures and oversized payloads before forwarding", async () => {
  let calls = 0;
  const relay = createRelay(async () => {
    calls += 1;
    return Response.json({ received: true });
  });

  const missingHeaders = await relay.fetch(
    new Request("https://relay.example/webhooks/resend", {
      method: "POST",
      body: "{}",
    }),
    env,
  );
  assert.equal(missingHeaders.status, 400);

  const tooLarge = await relay.fetch(
    new Request("https://relay.example/webhooks/paypal", {
      method: "POST",
      headers: { ...paypalHeaders, "content-length": "256001" },
      body: "{}",
    }),
    env,
  );
  assert.equal(tooLarge.status, 413);
  assert.equal(calls, 0);
});

test("scheduled recovery drains the private site with both secrets", async () => {
  const forwarded: Request[] = [];
  const relay = createRelay(async (request) => {
    forwarded.push(request);
    return Response.json({ processed: true });
  });
  let scheduled: Promise<unknown> | null = null;

  relay.scheduled({}, env, {
    waitUntil(promise) {
      scheduled = promise;
    },
  });
  assert.ok(scheduled);
  await scheduled;
  const forwardedRequest = forwarded[0];
  assert.ok(forwardedRequest);
  assert.equal(forwardedRequest.url, "https://private-five.example/api/internal/jobs/drain");
  assert.equal(forwardedRequest.headers.get("authorization"), "Bearer processor-test-secret");
  assert.equal(
    forwardedRequest.headers.get("oai-sites-authorization"),
    "Bearer sites-test-token",
  );
  assert.deepEqual(await forwardedRequest.json(), { limit: 5 });
});
