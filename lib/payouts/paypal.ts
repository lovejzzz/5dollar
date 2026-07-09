export const PAYPAL_API_BASE_URLS = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
} as const;

export type PayPalEnvironment = keyof typeof PAYPAL_API_BASE_URLS;
export type PayPalRecipientType = "EMAIL" | "PHONE" | "PAYPAL_ID";

export type PayPalPayoutRecipient = {
  type: PayPalRecipientType;
  value: string;
};

type PayPalRequestTarget = {
  /** Defaults to sandbox. A custom baseUrl takes precedence when supplied. */
  environment?: PayPalEnvironment;
  baseUrl?: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
};

export type PayPalOAuthInput = PayPalRequestTarget & {
  clientId: string;
  clientSecret: string;
};

export type PayPalAccessToken = {
  accessToken: string;
  tokenType: string;
  expiresInSeconds: number;
  scope: string;
};

export type PayPalPayoutIdempotency = {
  senderBatchId: string;
  senderItemId: string;
  requestId: string;
};

export type CreatePayPalFiveDollarPayoutInput = PayPalRequestTarget & {
  accessToken: string;
  /** A durable internal request/job ID. The same request must always reuse it. */
  stableRequestKey: string;
  recipient: PayPalPayoutRecipient;
};

export type PayPalFiveDollarPayoutResult = PayPalPayoutIdempotency & {
  provider: "paypal";
  payoutBatchId: string;
  batchStatus: string;
};

export type PayPalFundingCapture = {
  provider: "paypal";
  captureId: string;
  status: string;
  currency: string;
  grossCents: number;
  netCents: number;
  customId: string;
  capturedAt: string;
};

export type PayPalPayoutBatchObservation = {
  provider: "paypal";
  payoutBatchId: string;
  batchStatus: string;
  senderBatchId: string;
  senderItemId: string;
  providerItemId: string | null;
  itemStatus: string;
};

export type VerifyPayPalWebhookInput = PayPalRequestTarget & {
  accessToken: string;
  webhookId: string;
  headers: HeadersInit;
  /**
   * The untouched request body from request.text(). It is embedded verbatim in
   * the PayPal postback payload so webhook_event is not parsed/re-serialized.
   */
  rawEvent: string;
};

export type PayPalWebhookVerificationResult = {
  provider: "paypal";
  verificationStatus: "SUCCESS" | "FAILURE";
  signatureVerified: boolean;
};

type PayPalOperation =
  | "oauth"
  | "show-capture"
  | "create-payout"
  | "show-payout"
  | "verify-webhook";

export class PayPalApiError extends Error {
  readonly operation: PayPalOperation;
  readonly status: number;
  readonly providerCode: string | null;
  readonly debugId: string | null;

  constructor(options: {
    operation: PayPalOperation;
    status: number;
    providerCode?: string | null;
    debugId?: string | null;
  }) {
    const providerCode = sanitizeProviderIdentifier(options.providerCode);
    const suffix = providerCode ? ` (${providerCode})` : "";
    super(`PayPal ${options.operation} failed with HTTP ${options.status}${suffix}.`);
    this.name = "PayPalApiError";
    this.operation = options.operation;
    this.status = options.status;
    this.providerCode = providerCode;
    this.debugId = sanitizeProviderIdentifier(options.debugId);
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAYPAL_ID_PATTERN = /^[2-9A-HJ-NP-Z]{13}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeProviderIdentifier(value: string | null | undefined) {
  if (!value) return null;
  const sanitized = value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
  return sanitized || null;
}

function requiredSecret(value: string, label: string) {
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function resolveBaseUrl(target: PayPalRequestTarget) {
  const value =
    target.baseUrl ??
    PAYPAL_API_BASE_URLS[target.environment ?? "sandbox"];
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("PayPal baseUrl must be a valid HTTP(S) URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("PayPal baseUrl must be a valid HTTP(S) URL.");
  }

  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function endpoint(target: PayPalRequestTarget, path: string) {
  return `${resolveBaseUrl(target)}${path}`;
}

function encodeBasicCredentials(clientId: string, clientSecret: string) {
  const bytes = new TextEncoder().encode(`${clientId}:${clientSecret}`);
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function usdCents(value: unknown) {
  if (typeof value !== "string" || !/^\d{1,10}\.\d{2}$/.test(value)) {
    return null;
  }
  const [dollars, cents] = value.split(".");
  const amount = Number(dollars) * 100 + Number(cents);
  return Number.isSafeInteger(amount) ? amount : null;
}

function providerErrorFields(payload: unknown, response: Response) {
  const providerCode = isRecord(payload)
    ? typeof payload.name === "string"
      ? payload.name
      : typeof payload.error === "string"
        ? payload.error
        : null
    : null;
  const payloadDebugId =
    isRecord(payload) && typeof payload.debug_id === "string"
      ? payload.debug_id
      : null;

  return {
    providerCode,
    debugId: response.headers.get("paypal-debug-id") ?? payloadDebugId,
  };
}

function duplicatePayoutBatchId(
  payload: unknown,
  target: PayPalRequestTarget,
): string | null {
  if (!isRecord(payload)) return null;
  const identifiers = [payload.name, payload.error, payload.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const detailIssues = Array.isArray(payload.details)
    ? payload.details
        .filter(isRecord)
        .flatMap((detail) => [detail.issue, detail.description])
        .filter((value): value is string => typeof value === "string")
        .join(" ")
    : "";
  if (!/DUPLICATE|ALREADY[_ ]EXISTS|ALREADY USED/i.test(`${identifiers} ${detailIssues}`)) {
    return null;
  }

  const links = [
    ...(Array.isArray(payload.links) ? payload.links : []),
    ...(Array.isArray(payload.details)
      ? payload.details.filter(isRecord).flatMap((detail) =>
          Array.isArray(detail.links) ? detail.links : [],
        )
      : []),
  ];
  const baseUrl = new URL(resolveBaseUrl(target));
  const allowedOrigins = new Set([baseUrl.origin]);
  if (baseUrl.hostname === "api-m.paypal.com") {
    allowedOrigins.add("https://api.paypal.com");
  }
  if (baseUrl.hostname === "api-m.sandbox.paypal.com") {
    allowedOrigins.add("https://api.sandbox.paypal.com");
  }
  for (const candidate of links) {
    if (!isRecord(candidate) || typeof candidate.href !== "string") continue;
    let url: URL;
    try {
      url = new URL(candidate.href);
    } catch {
      continue;
    }
    if (!allowedOrigins.has(url.origin)) continue;
    const match = url.pathname.match(/\/v1\/payments\/payouts\/([a-zA-Z0-9_-]{3,100})\/?$/);
    if (match) return match[1];
  }
  return null;
}

function throwApiError(
  operation: PayPalOperation,
  response: Response,
  payload: unknown,
): never {
  throw new PayPalApiError({
    operation,
    status: response.status,
    ...providerErrorFields(payload, response),
  });
}

function throwMalformedResponse(
  operation: PayPalOperation,
  response: Response,
): never {
  throw new PayPalApiError({
    operation,
    status: response.status,
    providerCode: "MALFORMED_RESPONSE",
    debugId: response.headers.get("paypal-debug-id"),
  });
}

function looksLikePhone(value: string) {
  if (!/^\+?[0-9\s().-]+$/.test(value)) return false;
  const digitCount = value.replace(/\D/g, "").length;
  return digitCount >= 7 && digitCount <= 15;
}

/** Infers only identifiers that PayPal Payouts can receive directly. */
export function inferPayPalRecipientType(
  value: string,
): PayPalRecipientType | null {
  const candidate = value.trim();
  if (EMAIL_PATTERN.test(candidate)) return "EMAIL";
  if (looksLikePhone(candidate)) return "PHONE";
  if (PAYPAL_ID_PATTERN.test(candidate)) return "PAYPAL_ID";
  return null;
}

function validatedRecipient(recipient: PayPalPayoutRecipient) {
  const value = recipient.value.trim();
  const byteLength = new TextEncoder().encode(value).byteLength;
  const validForType =
    recipient.type === "EMAIL"
      ? EMAIL_PATTERN.test(value)
      : recipient.type === "PHONE"
        ? looksLikePhone(value)
        : PAYPAL_ID_PATTERN.test(value);

  if (!validForType || byteLength > 127) {
    throw new Error("PayPal payout recipient is invalid.");
  }

  return { type: recipient.type, value };
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Derives retry-stable PayPal IDs without putting the recipient in any ID.
 * The 56-hex-character suffix keeps sender_item_id within PayPal's 63-char cap.
 */
export async function createPayPalPayoutIdempotency(
  stableRequestKey: string,
): Promise<PayPalPayoutIdempotency> {
  if (!stableRequestKey.trim()) {
    throw new Error("A stable PayPal payout request key is required.");
  }

  const suffix = (await sha256Hex(stableRequestKey)).slice(0, 56);
  return {
    senderBatchId: `five-b-${suffix}`,
    senderItemId: `five-i-${suffix}`,
    requestId: `five-r-${suffix}`,
  };
}

export async function getPayPalAccessToken(
  input: PayPalOAuthInput,
): Promise<PayPalAccessToken> {
  const clientId = requiredSecret(input.clientId, "PayPal client ID");
  const clientSecret = requiredSecret(input.clientSecret, "PayPal client secret");
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(endpoint(input, "/v1/oauth2/token"), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-Language": "en_US",
      Authorization: `Basic ${encodeBasicCredentials(clientId, clientSecret)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: input.signal,
  });
  const payload = await responseJson(response);

  if (!response.ok) throwApiError("oauth", response, payload);
  if (
    !isRecord(payload) ||
    typeof payload.access_token !== "string" ||
    !payload.access_token ||
    typeof payload.token_type !== "string" ||
    typeof payload.expires_in !== "number"
  ) {
    throwMalformedResponse("oauth", response);
  }

  return {
    accessToken: payload.access_token,
    tokenType: payload.token_type,
    expiresInSeconds: payload.expires_in,
    scope: typeof payload.scope === "string" ? payload.scope : "",
  };
}

/**
 * Reads an already-created PayPal capture. Callers must still compare the
 * returned custom ID and amount with their own sponsor contract before
 * recording the receipt as spendable inventory.
 */
export async function getPayPalFundingCapture(
  input: PayPalRequestTarget & { accessToken: string; captureId: string },
): Promise<PayPalFundingCapture> {
  const accessToken = requiredSecret(input.accessToken, "PayPal access token");
  const captureId = input.captureId.trim();
  if (!/^[A-Z0-9]{8,40}$/i.test(captureId)) {
    throw new Error("PayPal capture ID is invalid.");
  }
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(
    endpoint(input, `/v2/payments/captures/${encodeURIComponent(captureId)}`),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      signal: input.signal,
    },
  );
  const payload = await responseJson(response);
  if (!response.ok) throwApiError("show-capture", response, payload);
  if (
    !isRecord(payload) ||
    !isRecord(payload.amount) ||
    !isRecord(payload.seller_receivable_breakdown) ||
    !isRecord(payload.seller_receivable_breakdown.net_amount)
  ) {
    throwMalformedResponse("show-capture", response);
  }

  const id = payload.id;
  const status = payload.status;
  const currency = payload.amount.currency_code;
  const grossCents = usdCents(payload.amount.value);
  const netCurrency = payload.seller_receivable_breakdown.net_amount.currency_code;
  const netCents = usdCents(payload.seller_receivable_breakdown.net_amount.value);
  const customId = payload.custom_id;
  const capturedAt = payload.create_time;
  if (
    typeof id !== "string" ||
    id !== captureId ||
    typeof status !== "string" ||
    typeof currency !== "string" ||
    grossCents === null ||
    netCurrency !== currency ||
    netCents === null ||
    netCents > grossCents ||
    typeof customId !== "string" ||
    typeof capturedAt !== "string" ||
    !Number.isFinite(Date.parse(capturedAt))
  ) {
    throwMalformedResponse("show-capture", response);
  }

  return {
    provider: "paypal",
    captureId: id,
    status,
    currency,
    grossCents,
    netCents,
    customId,
    capturedAt,
  };
}

/**
 * Submits exactly one USD 5.00 payout. A successful create response is usually
 * PENDING; this function intentionally returns provider state and IDs only.
 */
export async function createPayPalFiveDollarPayout(
  input: CreatePayPalFiveDollarPayoutInput,
): Promise<PayPalFiveDollarPayoutResult> {
  const accessToken = requiredSecret(input.accessToken, "PayPal access token");
  const recipient = validatedRecipient(input.recipient);
  const ids = await createPayPalPayoutIdempotency(input.stableRequestKey);
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(endpoint(input, "/v1/payments/payouts"), {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": ids.requestId,
    },
    body: JSON.stringify({
      sender_batch_header: {
        sender_batch_id: ids.senderBatchId,
        email_subject: "Your $5 payout from Five",
      },
      items: [
        {
          recipient_type: recipient.type,
          amount: { currency: "USD", value: "5.00" },
          note: "Your $5 payout from Five.",
          sender_item_id: ids.senderItemId,
          receiver: recipient.value,
        },
      ],
    }),
    signal: input.signal,
  });
  const payload = await responseJson(response);

  if (!response.ok) {
    const existingBatchId = duplicatePayoutBatchId(payload, input);
    if (existingBatchId) {
      return {
        provider: "paypal",
        ...ids,
        payoutBatchId: existingBatchId,
        batchStatus: "PENDING",
      };
    }
    throwApiError("create-payout", response, payload);
  }
  if (!isRecord(payload) || !isRecord(payload.batch_header)) {
    throwMalformedResponse("create-payout", response);
  }

  const payoutBatchId = payload.batch_header.payout_batch_id;
  const batchStatus = payload.batch_header.batch_status;
  if (typeof payoutBatchId !== "string" || typeof batchStatus !== "string") {
    throwMalformedResponse("create-payout", response);
  }

  return {
    provider: "paypal",
    ...ids,
    payoutBatchId,
    batchStatus,
  };
}

/** Retrieves provider truth for a previously-created payout batch. */
export async function getPayPalPayoutBatch(
  input: PayPalRequestTarget & {
    accessToken: string;
    payoutBatchId: string;
    senderItemId: string;
  },
): Promise<PayPalPayoutBatchObservation> {
  const accessToken = requiredSecret(input.accessToken, "PayPal access token");
  const payoutBatchId = input.payoutBatchId.trim();
  if (!/^[a-zA-Z0-9_-]{3,100}$/.test(payoutBatchId)) {
    throw new Error("PayPal payout batch ID is invalid.");
  }
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(
    endpoint(
      input,
      `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}?fields=all`,
    ),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      signal: input.signal,
    },
  );
  const payload = await responseJson(response);
  if (!response.ok) throwApiError("show-payout", response, payload);
  if (!isRecord(payload) || !isRecord(payload.batch_header) || !Array.isArray(payload.items)) {
    throwMalformedResponse("show-payout", response);
  }

  const providerBatchId = payload.batch_header.payout_batch_id;
  const batchStatus = payload.batch_header.batch_status;
  const senderBatchHeader = payload.batch_header.sender_batch_header;
  const senderBatchId = isRecord(senderBatchHeader)
    ? senderBatchHeader.sender_batch_id
    : null;
  const item = payload.items.find((candidate) => {
    if (!isRecord(candidate) || !isRecord(candidate.payout_item)) return false;
    return candidate.payout_item.sender_item_id === input.senderItemId;
  });
  if (!isRecord(item) || !isRecord(item.payout_item)) {
    throwMalformedResponse("show-payout", response);
  }
  const itemStatus = item.transaction_status;
  const senderItemId = item.payout_item.sender_item_id;
  const providerItemId = item.payout_item_id;
  if (
    providerBatchId !== payoutBatchId ||
    typeof batchStatus !== "string" ||
    typeof senderBatchId !== "string" ||
    senderItemId !== input.senderItemId ||
    typeof itemStatus !== "string" ||
    (["SUCCESS", "SUCCEEDED"].includes(String(itemStatus)) &&
      typeof providerItemId !== "string") ||
    (providerItemId !== undefined && typeof providerItemId !== "string")
  ) {
    throwMalformedResponse("show-payout", response);
  }

  return {
    provider: "paypal",
    payoutBatchId: providerBatchId,
    batchStatus,
    senderBatchId,
    senderItemId,
    providerItemId: typeof providerItemId === "string" ? providerItemId : null,
    itemStatus,
  };
}

const REQUIRED_WEBHOOK_HEADERS = {
  authAlgo: "paypal-auth-algo",
  certUrl: "paypal-cert-url",
  transmissionId: "paypal-transmission-id",
  transmissionSignature: "paypal-transmission-sig",
  transmissionTime: "paypal-transmission-time",
} as const;

function requiredWebhookHeader(headers: Headers, name: string) {
  const value = headers.get(name)?.trim();
  if (!value) throw new Error(`Required PayPal webhook header ${name} is missing.`);
  return value;
}

function assertRawEventObject(rawEvent: string) {
  let event: unknown;
  try {
    event = JSON.parse(rawEvent);
  } catch {
    throw new Error("PayPal webhook body must be valid JSON.");
  }

  if (!isRecord(event)) {
    throw new Error("PayPal webhook body must be a JSON object.");
  }
}

function webhookPostbackBody(
  metadata: Record<string, string>,
  rawEvent: string,
) {
  // JSON.stringify only the metadata. rawEvent stays byte-for-byte unchanged.
  const prefix = JSON.stringify(metadata);
  return `${prefix.slice(0, -1)},"webhook_event":${rawEvent}}`;
}

/**
 * Asks PayPal to verify a webhook signature. Signature verification alone does
 * not prove payout settlement and this function never changes application state.
 */
export async function verifyPayPalWebhookSignature(
  input: VerifyPayPalWebhookInput,
): Promise<PayPalWebhookVerificationResult> {
  const accessToken = requiredSecret(input.accessToken, "PayPal access token");
  const webhookId = requiredSecret(input.webhookId, "PayPal webhook ID");
  assertRawEventObject(input.rawEvent);

  const headers = new Headers(input.headers);
  const metadata = {
    auth_algo: requiredWebhookHeader(headers, REQUIRED_WEBHOOK_HEADERS.authAlgo),
    cert_url: requiredWebhookHeader(headers, REQUIRED_WEBHOOK_HEADERS.certUrl),
    transmission_id: requiredWebhookHeader(
      headers,
      REQUIRED_WEBHOOK_HEADERS.transmissionId,
    ),
    transmission_sig: requiredWebhookHeader(
      headers,
      REQUIRED_WEBHOOK_HEADERS.transmissionSignature,
    ),
    transmission_time: requiredWebhookHeader(
      headers,
      REQUIRED_WEBHOOK_HEADERS.transmissionTime,
    ),
    webhook_id: webhookId,
  };
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(
    endpoint(input, "/v1/notifications/verify-webhook-signature"),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: webhookPostbackBody(metadata, input.rawEvent),
      signal: input.signal,
    },
  );
  const payload = await responseJson(response);

  if (!response.ok) throwApiError("verify-webhook", response, payload);
  if (
    !isRecord(payload) ||
    (payload.verification_status !== "SUCCESS" &&
      payload.verification_status !== "FAILURE")
  ) {
    throwMalformedResponse("verify-webhook", response);
  }

  return {
    provider: "paypal",
    verificationStatus: payload.verification_status,
    signatureVerified: payload.verification_status === "SUCCESS",
  };
}
