import { ensureLiveDatabase } from "./live-jobs";
import { getRuntimeEnv, type RuntimeEnv } from "./runtime-env";

const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CanaryRow = {
  job_id: string;
  amount_cents: number;
  job_status: string;
  earned_cents: number;
  submission_json: string | null;
  model_response_id: string | null;
  model_name: string | null;
  provider_status: string | null;
  job_completed_at: number | null;
  task_id: string | null;
  task_status: string | null;
  reward_cents: number | null;
  payout_cents: number | null;
  funding_status: string | null;
  funding_currency: string | null;
  funding_net_cents: number | null;
  funding_capture_id: string | null;
  sponsor_status: string | null;
  sponsor_order_id: string | null;
  sponsor_capture_id: string | null;
  sponsor_task_id: string | null;
  payout_status: string | null;
  provider_batch_id: string | null;
  provider_item_id: string | null;
  notification_status: string | null;
  notification_message_id: string | null;
  notification_sent_at: number | null;
  notification_delivery_status: string | null;
  notification_delivered_at: number | null;
  terminal_funding_events: number;
  terminal_notification_events: number;
};

export type LiveCanaryCertificate = {
  proofVersion: "five-live-canary-v2";
  jobId: string;
  checkedAt: string;
  passed: boolean;
  gates: {
    exactReward: boolean;
    sponsorCaptureSettled: boolean;
    aiWorkAccepted: boolean;
    individualPayoutSucceeded: boolean;
    arrivalNotificationDelivered: boolean;
    noFundingReversal: boolean;
  };
  state: {
    sponsor: string | null;
    funding: string | null;
    task: string | null;
    job: string;
    payout: string | null;
    notification: string | null;
  };
  completedAt: string | null;
};

function isoTime(value: number | null) {
  return value === null ? null : new Date(value).toISOString();
}

export async function liveCanaryCertificate(
  jobId: string,
  runtime: RuntimeEnv = getRuntimeEnv(),
): Promise<LiveCanaryCertificate | null> {
  if (!JOB_ID_PATTERN.test(jobId)) return null;
  const db = await ensureLiveDatabase(runtime);
  const row = await db
    .prepare(
      `SELECT lj.id AS job_id, lj.amount_cents, lj.status AS job_status,
              lj.earned_cents, lj.submission_json, lj.model_response_id,
              lj.model_name, lj.provider_status,
              lj.completed_at AS job_completed_at,
              ft.id AS task_id, ft.status AS task_status,
              ft.reward_cents, ft.payout_cents,
              fr.status AS funding_status, fr.currency AS funding_currency,
              fr.net_cents AS funding_net_cents,
              fr.provider_transaction_id AS funding_capture_id,
              sto.status AS sponsor_status,
              sto.paypal_order_id AS sponsor_order_id,
              sto.paypal_capture_id AS sponsor_capture_id,
              sto.funded_task_id AS sponsor_task_id,
              p.status AS payout_status,
              p.provider_batch_id, p.provider_item_id,
              no.status AS notification_status,
              no.provider_message_id AS notification_message_id,
              no.sent_at AS notification_sent_at,
              no.delivery_status AS notification_delivery_status,
              no.delivered_at AS notification_delivered_at,
              (SELECT COUNT(*) FROM paypal_funding_webhook_events pfwe
               WHERE pfwe.capture_id = fr.provider_transaction_id)
                AS terminal_funding_events,
              (SELECT COUNT(*) FROM resend_webhook_events rwe
               WHERE rwe.provider_message_id = no.provider_message_id
                 AND rwe.event_type IN
                   ('email.bounced', 'email.failed', 'email.suppressed'))
                AS terminal_notification_events
       FROM live_jobs lj
       LEFT JOIN funded_tasks ft ON ft.id = lj.task_id
       LEFT JOIN funding_receipts fr ON fr.id = ft.funding_receipt_id
       LEFT JOIN sponsor_task_orders sto ON sto.funded_task_id = ft.id
       LEFT JOIN payouts p ON p.job_id = lj.id
       LEFT JOIN notification_outbox no
         ON no.job_id = lj.id AND no.kind = 'payout_arrived'
       WHERE lj.id = ? LIMIT 1`,
    )
    .bind(jobId)
    .first<CanaryRow>();
  if (!row) return null;

  const exactReward =
    row.amount_cents === 500 &&
    row.payout_cents === 500 &&
    row.earned_cents >= 500;
  const sponsorCaptureSettled =
    row.sponsor_status === "funded" &&
    Boolean(row.sponsor_order_id) &&
    Boolean(row.sponsor_capture_id) &&
    row.sponsor_capture_id === row.funding_capture_id &&
    row.sponsor_task_id === row.task_id &&
    row.funding_status === "COMPLETED" &&
    row.funding_currency === "USD" &&
    row.funding_net_cents !== null &&
    row.reward_cents !== null &&
    row.funding_net_cents >= row.reward_cents;
  const aiWorkAccepted =
    row.task_status === "accepted" &&
    Boolean(row.submission_json) &&
    Boolean(row.model_response_id) &&
    Boolean(row.model_name);
  const individualPayoutSucceeded =
    row.job_status === "paid" &&
    row.provider_status === "SUCCEEDED" &&
    row.payout_status === "SUCCEEDED" &&
    Boolean(row.provider_batch_id) &&
    Boolean(row.provider_item_id) &&
    row.job_completed_at !== null;
  const arrivalNotificationDelivered =
    row.notification_status === "sent" &&
    Boolean(row.notification_message_id) &&
    row.notification_sent_at !== null &&
    row.notification_delivery_status === "delivered" &&
    row.notification_delivered_at !== null &&
    row.terminal_notification_events === 0;
  const noFundingReversal = row.terminal_funding_events === 0;
  const gates = {
    exactReward,
    sponsorCaptureSettled,
    aiWorkAccepted,
    individualPayoutSucceeded,
    arrivalNotificationDelivered,
    noFundingReversal,
  };

  return {
    proofVersion: "five-live-canary-v2",
    jobId: row.job_id,
    checkedAt: new Date().toISOString(),
    passed: Object.values(gates).every(Boolean),
    gates,
    state: {
      sponsor: row.sponsor_status,
      funding: row.funding_status,
      task: row.task_status,
      job: row.job_status,
      payout: row.payout_status,
      notification:
        row.notification_delivery_status ?? row.notification_status,
    },
    completedAt: isoTime(
      row.notification_delivered_at ??
        row.notification_sent_at ??
        row.job_completed_at,
    ),
  };
}
