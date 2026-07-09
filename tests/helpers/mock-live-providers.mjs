import { createServer } from "node:http";

const port = Number(process.env.MOCK_PROVIDER_PORT ?? 3100);
let lastPayout = null;

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

const server = createServer(async (request, response) => {
  const raw = await body(request);

  if (request.method === "POST" && request.url === "/v1/responses") {
    const parsed = JSON.parse(raw);
    if (parsed?.text?.format?.type !== "json_schema" || parsed?.store !== false) {
      return json(response, 400, { error: { message: "structured output contract missing" } });
    }
    return json(response, 200, {
      id: "resp_mock_live_001",
      model: "gpt-5.4-mini-mock",
      status: "completed",
      error: null,
      output_text: JSON.stringify({
        answer:
          "The supplied feedback shows that customers value the fast setup experience. This conclusion is limited to the single provided row and should not be generalized beyond it.",
        evidence: ["r1: The setup was fast."],
        quality_notes: ["Only one sponsor-provided row was available."],
      }),
      usage: {
        input_tokens: 100,
        output_tokens: 45,
        total_tokens: 145,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 5 },
      },
    });
  }

  if (request.method === "POST" && request.url === "/v1/oauth2/token") {
    return json(response, 200, {
      access_token: "mock-paypal-access-token",
      token_type: "Bearer",
      expires_in: 3_600,
      scope: "payouts",
    });
  }

  if (
    request.method === "GET" &&
    request.url === "/v2/payments/captures/CAPTUREMOCK001"
  ) {
    return json(response, 200, {
      id: "CAPTUREMOCK001",
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "7.00" },
      seller_receivable_breakdown: {
        net_amount: { currency_code: "USD", value: "7.00" },
      },
      custom_id: "sponsor:feedback:mock:001",
      create_time: "2026-07-09T18:00:00Z",
    });
  }

  if (request.method === "POST" && request.url === "/v1/payments/payouts") {
    const parsed = JSON.parse(raw);
    if (
      parsed?.items?.length !== 1 ||
      parsed?.items?.[0]?.amount?.value !== "5.00" ||
      parsed?.items?.[0]?.amount?.currency !== "USD"
    ) {
      return json(response, 400, { name: "INVALID_PAYOUT_CONTRACT" });
    }
    lastPayout = parsed;
    return json(response, 201, {
      batch_header: {
        payout_batch_id: "PBATCH-MOCK-001",
        batch_status: "PENDING",
      },
    });
  }

  if (
    request.method === "GET" &&
    request.url === "/v1/payments/payouts/PBATCH-MOCK-001?fields=all"
  ) {
    const header = lastPayout?.sender_batch_header;
    const item = lastPayout?.items?.[0];
    return json(response, 200, {
      batch_header: {
        payout_batch_id: "PBATCH-MOCK-001",
        batch_status: "PENDING",
        sender_batch_header: header,
      },
      items: [
        {
          payout_item_id: "PITEM-MOCK-001",
          transaction_status: "PENDING",
          payout_item: item,
        },
      ],
    });
  }

  if (
    request.method === "POST" &&
    request.url === "/v1/notifications/verify-webhook-signature"
  ) {
    const parsed = JSON.parse(raw);
    if (!parsed?.webhook_event?.id) {
      return json(response, 400, { name: "INVALID_WEBHOOK" });
    }
    return json(response, 200, { verification_status: "SUCCESS" });
  }

  if (request.method === "POST" && request.url === "/emails") {
    const parsed = JSON.parse(raw);
    if (parsed?.subject !== "Your $5 has arrived" || parsed?.to?.length !== 1) {
      return json(response, 400, { name: "INVALID_NOTIFICATION" });
    }
    return json(response, 200, { id: "email-mock-001" });
  }

  return json(response, 404, { error: "not found" });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`mock providers ready on ${port}\n`);
});
