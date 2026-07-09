export class NotificationApiError extends Error {
  readonly status: number;
  readonly providerCode: string | null;

  constructor(status: number, providerCode: string | null = null) {
    super(`Notification delivery provider failed with HTTP ${status}.`);
    this.name = "NotificationApiError";
    this.status = status;
    this.providerCode = providerCode;
  }
}

type SendPayoutNotificationInput = {
  apiKey: string;
  from: string;
  to: string;
  requestCode: string;
  payoutReference: string;
  idempotencyKey: string;
  kind: "payout_arrived" | "payout_reversed";
  fetcher?: typeof fetch;
  baseUrl?: string;
  signal?: AbortSignal;
};

function required(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function endpoint(baseUrl = "https://api.resend.com") {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Notification provider URL must use HTTP(S).");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/emails`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Sends one transactional arrival notice with provider-level idempotency. */
export async function sendPayoutArrivalNotification(
  input: SendPayoutNotificationInput,
) {
  const apiKey = required(input.apiKey, "Notification API key");
  const from = required(input.from, "Notification sender");
  const to = required(input.to, "Notification recipient").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new Error("Notification recipient is invalid.");
  }
  const idempotencyKey = required(input.idempotencyKey, "Notification idempotency key");
  if (idempotencyKey.length > 256) {
    throw new Error("Notification idempotency key is too long.");
  }

  const fetcher = input.fetcher ?? fetch;
  const reversed = input.kind === "payout_reversed";
  const response = await fetcher(endpoint(input.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: reversed ? "Important: your $5 payout was reversed" : "Your $5 has arrived",
      text: (reversed
        ? [
            "PayPal later reported that your $5 payout was returned or refunded.",
            "The payout may previously have appeared successful. Support must review it before any further action.",
          ]
        : ["PayPal confirmed that your individual $5 payout succeeded."]
      ).concat([
        `Request: ${input.requestCode}`,
        `PayPal reference: ${input.payoutReference}`,
        "If you do not recognize this request, reply to this message for support.",
      ]).join("\n\n"),
    }),
    signal: input.signal,
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // The status code is still enough to classify a provider failure.
  }
  const providerCode =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? ["name", "code", "error"]
          .map((key) => (payload as Record<string, unknown>)[key])
          .find((value): value is string => typeof value === "string") ?? null
      : null;
  if (!response.ok) throw new NotificationApiError(response.status, providerCode);
  const id =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).id
      : null;
  if (typeof id !== "string" || !id) {
    throw new NotificationApiError(response.status, providerCode);
  }
  return { provider: "resend" as const, messageId: id };
}
