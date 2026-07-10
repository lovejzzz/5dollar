import {
  validateGiftCardTaskSpec,
  type ValidatedGiftCardTask,
} from "./funded-tasks";
import { ensureLiveDatabase } from "./live-jobs";
import type { TremendousGiftCardOrder } from "./rewards/tremendous";
import { getRuntimeEnv, type RuntimeEnv } from "./runtime-env";

export type GiftCardRewardRow = {
  task_id: string;
  provider: "tremendous";
  order_id: string;
  reward_id: string;
  status: "ISSUED" | "DELIVERY_PENDING" | "DELIVERED" | "CANCELED";
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
};

type ExistingGiftCardTask = {
  id: string;
  task_type: string;
  title: string;
  instructions: string;
  input_json: string;
  reward_cents: number;
  payout_cents: number;
  automation_allowed: number;
  auto_accept: number;
  min_answer_chars: number;
  acceptance_json: string;
  sponsor_reference: string;
  funding_receipt_id: string;
  status: string;
  receipt_provider: string;
  receipt_transaction_id: string;
  receipt_currency: string;
  receipt_gross_cents: number;
  receipt_net_cents: number;
  receipt_status: string;
  reward_provider: string;
  order_id: string;
  reward_id: string;
  reward_status: string;
};

function exactContract(
  existing: ExistingGiftCardTask,
  spec: ValidatedGiftCardTask,
  order: TremendousGiftCardOrder,
) {
  return (
    existing.task_type === spec.taskType &&
    existing.title === spec.title &&
    existing.instructions === spec.instructions &&
    existing.input_json === spec.inputJson &&
    existing.reward_cents === spec.rewardCents &&
    existing.payout_cents === spec.payoutCents &&
    existing.automation_allowed === spec.automationAllowed &&
    existing.auto_accept === spec.autoAccept &&
    existing.min_answer_chars === spec.minAnswerChars &&
    existing.acceptance_json === spec.acceptanceJson &&
    existing.sponsor_reference === spec.sponsorReference &&
    existing.receipt_provider === "tremendous" &&
    existing.receipt_transaction_id === order.orderId &&
    existing.receipt_currency === "USD" &&
    existing.receipt_gross_cents === order.orderTotalCents &&
    existing.receipt_net_cents === 500 &&
    existing.receipt_status === "EXECUTED" &&
    existing.reward_provider === "tremendous" &&
    existing.order_id === order.orderId &&
    existing.reward_id === order.id &&
    ["ISSUED", "DELIVERY_PENDING", "DELIVERED"].includes(existing.reward_status)
  );
}

async function existingForReference(db: D1Database, sponsorReference: string) {
  return db
    .prepare(
      `SELECT ft.*,
              fr.provider AS receipt_provider,
              fr.provider_transaction_id AS receipt_transaction_id,
              fr.currency AS receipt_currency,
              fr.gross_cents AS receipt_gross_cents,
              fr.net_cents AS receipt_net_cents,
              fr.status AS receipt_status,
              gcr.provider AS reward_provider,
              gcr.order_id,
              gcr.reward_id,
              gcr.status AS reward_status
       FROM funded_tasks ft
       JOIN funding_receipts fr ON fr.id = ft.funding_receipt_id
       JOIN gift_card_rewards gcr ON gcr.task_id = ft.id
       WHERE ft.sponsor_reference = ? LIMIT 1`,
    )
    .bind(sponsorReference)
    .first<ExistingGiftCardTask>();
}

export async function createGiftCardFundedTask(
  value: unknown,
  order: TremendousGiftCardOrder,
  runtime: RuntimeEnv = getRuntimeEnv(),
) {
  const spec = validateGiftCardTaskSpec(value);
  if (
    order.provider !== "tremendous" ||
    order.orderStatus !== "EXECUTED" ||
    order.externalId !== spec.sponsorReference ||
    order.valueCents !== 500 ||
    order.currency !== "USD" ||
    order.deliveryMethod !== "LINK" ||
    order.deliveryStatus !== "SUCCEEDED" ||
    order.orderTotalCents < 500
  ) {
    throw new Error("The Tremendous reward does not satisfy the immutable $5 task contract.");
  }
  const db = await ensureLiveDatabase(runtime);
  const existing = await existingForReference(db, spec.sponsorReference);
  if (existing) {
    if (!exactContract(existing, spec, order)) {
      throw new Error(
        "This sponsor reference is already bound to a different gift-card task contract.",
      );
    }
    return {
      id: existing.id,
      sponsorReference: existing.sponsor_reference,
      status: existing.status,
      rewardId: existing.reward_id,
      duplicate: true as const,
    };
  }

  const id = crypto.randomUUID();
  const receiptId = `funding:tremendous:${order.orderId}`;
  const now = Date.now();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO funding_receipts
           (id, provider, provider_transaction_id, sponsor_reference, currency,
            gross_cents, net_cents, status, captured_at, task_id, created_at)
           VALUES (?, 'tremendous', ?, ?, 'USD', ?, 500, 'EXECUTED', ?, ?, ?)`,
        )
        .bind(
          receiptId,
          order.orderId,
          spec.sponsorReference,
          order.orderTotalCents,
          now,
          id,
          now,
        ),
      db
        .prepare(
          `INSERT INTO funded_tasks
           (id, task_type, title, instructions, input_json, reward_cents,
            payout_cents, automation_allowed, auto_accept, min_answer_chars,
            acceptance_json, sponsor_reference, funding_receipt_id, status,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 500, 500, 1, 1, ?, ?, ?, ?, 'available', ?, ?)`,
        )
        .bind(
          id,
          spec.taskType,
          spec.title,
          spec.instructions,
          spec.inputJson,
          spec.minAnswerChars,
          spec.acceptanceJson,
          spec.sponsorReference,
          receiptId,
          now,
          now,
        ),
      db
        .prepare(
          `INSERT INTO gift_card_rewards
           (task_id, provider, order_id, reward_id, status, created_at, updated_at)
           VALUES (?, 'tremendous', ?, ?, 'ISSUED', ?, ?)`,
        )
        .bind(id, order.orderId, order.id, now, now),
    ]);
  } catch (error) {
    const raced = await existingForReference(db, spec.sponsorReference);
    if (raced && exactContract(raced, spec, order)) {
      return {
        id: raced.id,
        sponsorReference: raced.sponsor_reference,
        status: raced.status,
        rewardId: raced.reward_id,
        duplicate: true as const,
      };
    }
    throw error;
  }
  return {
    id,
    sponsorReference: spec.sponsorReference,
    status: "available" as const,
    rewardId: order.id,
    duplicate: false as const,
  };
}

export async function giftCardRewardForTask(
  taskId: string,
  runtime: RuntimeEnv = getRuntimeEnv(),
) {
  const db = await ensureLiveDatabase(runtime);
  return db
    .prepare("SELECT * FROM gift_card_rewards WHERE task_id = ? LIMIT 1")
    .bind(taskId)
    .first<GiftCardRewardRow>();
}
