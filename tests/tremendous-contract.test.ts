import assert from "node:assert/strict";
import test from "node:test";

import {
  createTremendousGiftCard,
  generateTremendousRewardLink,
  getTremendousReward,
  TremendousApiError,
} from "../lib/rewards/tremendous";

const target = {
  apiKey: "TEST_five-provider-contract",
  environment: "sandbox" as const,
};

function reward(id = "REWARD123") {
  return {
    id,
    order_id: "ORDER123",
    value: { denomination: 5, currency_code: "USD" },
    delivery: { method: "LINK", status: "SUCCEEDED" },
  };
}

test("Tremendous creates one retry-stable, pre-funded $5 link reward", async () => {
  let requestBody: Record<string, unknown> | null = null;
  const result = await createTremendousGiftCard({
    ...target,
    campaignId: "CAMPAIGN123",
    externalId: "sponsor:gift:001",
    recipientEmail: "rewards@five.nexttask.team",
    fetcher: async (input, init) => {
      assert.equal(String(input), "https://testflight.tremendous.com/api/v2/orders");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${target.apiKey}`);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        order: {
          id: "ORDER123",
          external_id: "sponsor:gift:001",
          status: "EXECUTED",
          payment: { total: 5 },
          rewards: [reward()],
        },
      });
    },
  });

  assert.deepEqual(requestBody, {
    external_id: "sponsor:gift:001",
    payment: { funding_source_id: "balance" },
    reward: {
      campaign_id: "CAMPAIGN123",
      value: { denomination: 5, currency_code: "USD" },
      delivery: { method: "LINK" },
      recipient: { name: "FIVE reward", email: "rewards@five.nexttask.team" },
    },
  });
  assert.deepEqual(result, {
    provider: "tremendous",
    orderStatus: "EXECUTED",
    externalId: "sponsor:gift:001",
    orderTotalCents: 500,
    id: "REWARD123",
    orderId: "ORDER123",
    valueCents: 500,
    currency: "USD",
    deliveryMethod: "LINK",
    deliveryStatus: "SUCCEEDED",
  });
});

test("Tremendous verifies provider reward truth before release", async () => {
  const result = await getTremendousReward({
    ...target,
    rewardId: "REWARD123",
    fetcher: async () => Response.json({ reward: reward() }),
  });
  assert.equal(result.valueCents, 500);
  assert.equal(result.deliveryStatus, "SUCCEEDED");

  await assert.rejects(
    getTremendousReward({
      ...target,
      rewardId: "REWARD123",
      fetcher: async () => Response.json({
        reward: {
          ...reward(),
          value: { denomination: 4, currency_code: "USD" },
        },
      }),
    }),
    (error: unknown) =>
      error instanceof TremendousApiError && error.providerCode === "MALFORMED_RESPONSE",
  );
});

test("Tremendous redemption links are generated just in time and host-locked", async () => {
  const result = await generateTremendousRewardLink({
    ...target,
    rewardId: "REWARD123",
    fetcher: async (input) => {
      assert.equal(
        String(input),
        "https://testflight.tremendous.com/api/v2/rewards/REWARD123/generate_link",
      );
      return Response.json({
        reward: {
          id: "REWARD123",
          link: "https://testflight.tremendous.com/rewards/payout/safe-secret-token",
        },
      });
    },
  });
  assert.equal(result.rewardId, "REWARD123");
  assert.match(result.link, /^https:\/\/testflight\.tremendous\.com\/rewards\//);

  await assert.rejects(
    generateTremendousRewardLink({
      ...target,
      rewardId: "REWARD123",
      fetcher: async () => Response.json({
        reward: { id: "REWARD123", link: "https://example.com/stolen" },
      }),
    }),
    (error: unknown) =>
      error instanceof TremendousApiError && error.providerCode === "UNSAFE_REWARD_LINK",
  );
});

test("Tremendous provider failures are classified without leaking credentials", async () => {
  await assert.rejects(
    createTremendousGiftCard({
      ...target,
      campaignId: "CAMPAIGN123",
      externalId: "sponsor:gift:002",
      recipientEmail: "rewards@five.nexttask.team",
      fetcher: async () => Response.json({ code: "INSUFFICIENT_FUNDS" }, { status: 402 }),
    }),
    (error: unknown) =>
      error instanceof TremendousApiError &&
      error.status === 402 &&
      error.providerCode === "INSUFFICIENT_FUNDS" &&
      !error.message.includes(target.apiKey),
  );
});
