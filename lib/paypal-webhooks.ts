const PAYPAL_FUNDING_TERMINAL_EVENTS = {
  "PAYMENT.CAPTURE.REFUNDED": "REFUNDED",
  "PAYMENT.CAPTURE.REVERSED": "REVERSED",
  "PAYMENT.CAPTURE.DENIED": "DENIED",
} as const;

const PAYPAL_WEBHOOK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,119}$/;
const PAYPAL_CAPTURE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,79}$/;

export type PayPalFundingTerminalWebhook = {
  eventId: string;
  eventType: keyof typeof PAYPAL_FUNDING_TERMINAL_EVENTS;
  captureId: string;
  terminalStatus: (typeof PAYPAL_FUNDING_TERMINAL_EVENTS)[keyof typeof PAYPAL_FUNDING_TERMINAL_EVENTS];
  providerEventTime: number;
};

function stringField(value: unknown, max = 160) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Extracts a capture ID only from PayPal's typed capture resource or its
 * structured related_ids.capture_id field. It deliberately never trusts a
 * refund ID, summary text, or arbitrary URL as a capture identifier.
 */
export function parsePayPalFundingTerminalWebhook(
  rawEvent: string,
): PayPalFundingTerminalWebhook | null {
  const event = JSON.parse(rawEvent) as unknown;
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("PayPal webhook event is invalid.");
  }
  const record = event as Record<string, unknown>;
  const eventId = stringField(record.id, 120);
  const eventType = stringField(record.event_type, 120);
  if (!(eventType in PAYPAL_FUNDING_TERMINAL_EVENTS)) return null;
  if (!PAYPAL_WEBHOOK_ID_PATTERN.test(eventId)) {
    throw new Error("PayPal funding webhook has no valid event identifier.");
  }

  const resource =
    record.resource && typeof record.resource === "object" && !Array.isArray(record.resource)
      ? (record.resource as Record<string, unknown>)
      : null;
  if (!resource) throw new Error("PayPal funding webhook has no resource.");
  const resourceType = stringField(record.resource_type, 40).toLowerCase();
  const supplementaryData =
    resource.supplementary_data &&
    typeof resource.supplementary_data === "object" &&
    !Array.isArray(resource.supplementary_data)
      ? (resource.supplementary_data as Record<string, unknown>)
      : null;
  const relatedIds =
    supplementaryData?.related_ids &&
    typeof supplementaryData.related_ids === "object" &&
    !Array.isArray(supplementaryData.related_ids)
      ? (supplementaryData.related_ids as Record<string, unknown>)
      : null;
  const directCaptureId =
    resourceType === "capture" ? stringField(resource.id, 80) : "";
  const relatedCaptureId = stringField(relatedIds?.capture_id, 80);
  const captureIds = [...new Set([directCaptureId, relatedCaptureId].filter(Boolean))];
  if (
    captureIds.length !== 1 ||
    !PAYPAL_CAPTURE_ID_PATTERN.test(captureIds[0] ?? "")
  ) {
    throw new Error("PayPal funding webhook has no unambiguous capture identifier.");
  }

  const rawEventTime = stringField(record.create_time, 80);
  const providerEventTime = Date.parse(rawEventTime);
  if (!Number.isFinite(providerEventTime)) {
    throw new Error("PayPal funding webhook has an invalid event timestamp.");
  }
  const typedEventType = eventType as keyof typeof PAYPAL_FUNDING_TERMINAL_EVENTS;
  return {
    eventId,
    eventType: typedEventType,
    captureId: captureIds[0] as string,
    terminalStatus: PAYPAL_FUNDING_TERMINAL_EVENTS[typedEventType],
    providerEventTime,
  };
}
