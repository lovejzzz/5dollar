import { Webhook } from "svix";

const DELIVERY_EVENT_STATUSES = {
  "email.delivered": "delivered",
  "email.delivery_delayed": "delayed",
  "email.bounced": "bounced",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
} as const;

export type ResendDeliveryStatus =
  (typeof DELIVERY_EVENT_STATUSES)[keyof typeof DELIVERY_EVENT_STATUSES];

export type ResendNotificationKind =
  | "payout_arrived"
  | "payout_reversed"
  | "gift_card_ready";

export type VerifiedResendDeliveryEvent = {
  eventId: string;
  eventType: keyof typeof DELIVERY_EVENT_STATUSES;
  deliveryStatus: ResendDeliveryStatus;
  notificationKind: ResendNotificationKind;
  providerMessageId: string;
  providerEventTime: number;
};

type VerifyResendWebhookInput = {
  rawPayload: string;
  secret: string;
  eventId: string;
  timestamp: string;
  signature: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeProviderIdentifier(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_.-]{1,200}$/.test(value)
  ) {
    throw new Error(`Resend webhook ${label} is invalid.`);
  }
  return value;
}

/**
 * Verifies the raw Svix-signed body before returning a privacy-minimized event.
 * Recipient addresses and message content from the provider payload are never
 * returned to the durable state layer.
 */
export function verifyResendWebhook(
  input: VerifyResendWebhookInput,
): VerifiedResendDeliveryEvent | null {
  const secret = input.secret.trim();
  if (!secret) throw new Error("Resend webhook secret is required.");
  const eventId = safeProviderIdentifier(input.eventId, "event ID");
  if (!input.timestamp || !input.signature) {
    throw new Error("Resend webhook signature headers are missing.");
  }

  const verified = new Webhook(secret).verify(input.rawPayload, {
    "svix-id": eventId,
    "svix-timestamp": input.timestamp,
    "svix-signature": input.signature,
  });
  const payload = record(verified);
  if (!payload || typeof payload.type !== "string") {
    throw new Error("Resend webhook payload is invalid.");
  }
  if (!(payload.type in DELIVERY_EVENT_STATUSES)) return null;

  const eventType = payload.type as keyof typeof DELIVERY_EVENT_STATUSES;
  const data = record(payload.data);
  const tags = record(data?.tags);
  const category = tags?.category;
  if (
    category !== "payout_arrived" &&
    category !== "payout_reversed" &&
    category !== "gift_card_ready"
  ) {
    return null;
  }
  const providerMessageId = safeProviderIdentifier(
    data?.email_id,
    "email ID",
  );
  if (typeof payload.created_at !== "string") {
    throw new Error("Resend webhook timestamp is invalid.");
  }
  const providerEventTime = Date.parse(payload.created_at);
  if (!Number.isFinite(providerEventTime) || providerEventTime <= 0) {
    throw new Error("Resend webhook timestamp is invalid.");
  }

  return {
    eventId,
    eventType,
    deliveryStatus: DELIVERY_EVENT_STATUSES[eventType],
    notificationKind: category,
    providerMessageId,
    providerEventTime,
  };
}

export function isTerminalResendDeliveryStatus(
  status: ResendDeliveryStatus,
) {
  return status === "bounced" || status === "failed" || status === "suppressed";
}

export function resendDeliveryStatusForEventType(
  eventType: string,
): ResendDeliveryStatus | null {
  return eventType in DELIVERY_EVENT_STATUSES
    ? DELIVERY_EVENT_STATUSES[eventType as keyof typeof DELIVERY_EVENT_STATUSES]
    : null;
}
