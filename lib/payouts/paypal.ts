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

export type PayPalFundingOrderIdempotency = {
  createRequestId: string;
  captureRequestId: string;
  invoiceId: string;
};

type PayPalFundingOrderContract = {
  /** A durable internal sponsor/draft ID. The same order must always reuse it. */
  stableRequestKey: string;
  /** The exact sponsor charge, expressed in whole USD cents. */
  amountCents: number;
  /** The sponsor task reference recorded in PayPal settlement reports. */
  customId: string;
};

export type CreatePayPalFundingOrderInput = PayPalRequestTarget &
  PayPalFundingOrderContract & {
    accessToken: string;
    returnUrl: string;
    cancelUrl: string;
  };

export type PayPalFundingOrderResult = {
  provider: "paypal";
  orderId: string;
  status: string;
  approvalUrl: string;
  requestId: string;
  invoiceId: string;
  customId: string;
  currency: "USD";
  grossCents: number;
};

export type PayPalFundingOrderObservation = {
  provider: "paypal";
  orderId: string;
  orderStatus: string;
  /** Capture status when one exists; otherwise the current order status. */
  status: string;
  captureId: string | null;
  captureStatus: string | null;
  currency: "USD";
  grossCents: number;
  /** PayPal omits receivable details until a capture completes. */
  netCents: number | null;
  customId: string;
  invoiceId: string;
  capturedAt: string | null;
  /** Present while PayPal still exposes an approval action for this order. */
  approvalUrl: string | null;
};

export type CapturePayPalFundingOrderInput = PayPalRequestTarget &
  PayPalFundingOrderContract & {
    accessToken: string;
    orderId: string;
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
  | "create-order"
  | "capture-order"
  | "show-order"
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
const PAYPAL_ORDER_STATUSES = new Set([
  "CREATED",
  "SAVED",
  "APPROVED",
  "VOIDED",
  "COMPLETED",
  "PAYER_ACTION_REQUIRED",
]);
const PAYPAL_CAPTURE_STATUSES = new Set([
  "COMPLETED",
  "DECLINED",
  "PARTIALLY_REFUNDED",
  "PENDING",
  "REFUNDED",
  "FAILED",
]);

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

function validatedFundingContract(contract: PayPalFundingOrderContract) {
  if (!Number.isSafeInteger(contract.amountCents) || contract.amountCents <= 0) {
    throw new Error("PayPal funding amount must be a positive whole number of USD cents.");
  }
  // usdCents deliberately accepts no more than ten dollar digits.
  if (contract.amountCents > 999_999_999_999) {
    throw new Error("PayPal funding amount is too large.");
  }
  const customId = contract.customId.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{4,119}$/.test(customId)) {
    throw new Error("PayPal funding custom ID is invalid.");
  }

  return {
    amountCents: contract.amountCents,
    amountValue: `${Math.floor(contract.amountCents / 100)}.${String(contract.amountCents % 100).padStart(2, "0")}`,
    customId,
  };
}

function validatedRedirectUrl(value: string, label: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  const loopbackHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]");
  if (
    (url.protocol !== "https:" && !loopbackHttp) ||
    url.username ||
    url.password ||
    url.hash ||
    url.toString().length > 2_048
  ) {
    throw new Error(`${label} must be a safe HTTPS URL.`);
  }
  return url.toString();
}

function validatedOrderId(value: string) {
  const orderId = value.trim();
  if (!/^[A-Z0-9]{1,36}$/.test(orderId)) {
    throw new Error("PayPal order ID is invalid.");
  }
  return orderId;
}

function approvalOrigin(target: PayPalRequestTarget) {
  const apiUrl = new URL(resolveBaseUrl(target));
  if (apiUrl.hostname === "api-m.paypal.com" || apiUrl.hostname === "api.paypal.com") {
    return "https://www.paypal.com";
  }
  if (
    apiUrl.hostname === "api-m.sandbox.paypal.com" ||
    apiUrl.hostname === "api.sandbox.paypal.com"
  ) {
    return "https://www.sandbox.paypal.com";
  }
  return apiUrl.origin;
}

function validatedApprovalUrl(
  payload: Record<string, unknown>,
  orderId: string,
  target: PayPalRequestTarget,
) {
  if (!Array.isArray(payload.links)) return null;
  const candidates = payload.links.filter(
    (link) =>
      isRecord(link) &&
      (link.rel === "approve" || link.rel === "payer-action") &&
      (link.method === undefined || link.method === "GET") &&
      typeof link.href === "string",
  );
  if (candidates.length !== 1) return null;

  const href = candidates[0].href;
  if (typeof href !== "string") return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const expectedOrigin = approvalOrigin(target);
  const officialOrigin = expectedOrigin.endsWith("paypal.com");
  if (
    url.origin !== expectedOrigin ||
    (officialOrigin && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname.replace(/\/+$/, "") !== "/checkoutnow" ||
    url.searchParams.getAll("token").length !== 1 ||
    url.searchParams.get("token") !== orderId
  ) {
    return null;
  }
  return url.toString();
}

function assertFundingPurchaseUnit(
  payload: Record<string, unknown>,
  expected: { amountCents: number; customId: string; invoiceId: string },
  operation: "create-order" | "capture-order" | "show-order",
  response: Response,
) {
  if (payload.intent !== "CAPTURE" || !Array.isArray(payload.purchase_units) || payload.purchase_units.length !== 1) {
    throwMalformedResponse(operation, response);
  }
  const unit = payload.purchase_units[0];
  if (!isRecord(unit) || !isRecord(unit.amount)) {
    throwMalformedResponse(operation, response);
  }
  if (
    unit.amount.currency_code !== "USD" ||
    usdCents(unit.amount.value) !== expected.amountCents ||
    unit.custom_id !== expected.customId ||
    unit.invoice_id !== expected.invoiceId
  ) {
    throwMalformedResponse(operation, response);
  }
  return unit;
}

function parseFundingOrderObservation(
  payload: unknown,
  response: Response,
  operation: "capture-order" | "show-order",
  expected: {
    orderId: string;
    amountCents: number;
    customId: string;
    invoiceId: string;
  },
  target: PayPalRequestTarget,
): PayPalFundingOrderObservation {
  if (
    !isRecord(payload) ||
    payload.id !== expected.orderId ||
    typeof payload.status !== "string" ||
    !PAYPAL_ORDER_STATUSES.has(payload.status)
  ) {
    throwMalformedResponse(operation, response);
  }
  const unit = assertFundingPurchaseUnit(payload, expected, operation, response);
  const payments = unit.payments;
  if (payments !== undefined && !isRecord(payments)) {
    throwMalformedResponse(operation, response);
  }
  const rawCaptures = isRecord(payments) ? payments.captures : undefined;
  if (rawCaptures !== undefined && !Array.isArray(rawCaptures)) {
    throwMalformedResponse(operation, response);
  }
  const captures = Array.isArray(rawCaptures) ? rawCaptures : [];
  if (captures.length > 1 || (payload.status === "COMPLETED" && captures.length !== 1)) {
    throwMalformedResponse(operation, response);
  }
  if (captures.length === 0) {
    return {
      provider: "paypal",
      orderId: expected.orderId,
      orderStatus: payload.status,
      status: payload.status,
      captureId: null,
      captureStatus: null,
      currency: "USD",
      grossCents: expected.amountCents,
      netCents: null,
      customId: expected.customId,
      invoiceId: expected.invoiceId,
      capturedAt: null,
      approvalUrl: validatedApprovalUrl(payload, expected.orderId, target),
    };
  }

  const capture = captures[0];
  if (
    !isRecord(capture) ||
    typeof capture.id !== "string" ||
    !/^[A-Z0-9]{8,40}$/.test(capture.id) ||
    typeof capture.status !== "string" ||
    !PAYPAL_CAPTURE_STATUSES.has(capture.status) ||
    !isRecord(capture.amount) ||
    capture.amount.currency_code !== "USD" ||
    usdCents(capture.amount.value) !== expected.amountCents ||
    (capture.custom_id !== undefined && capture.custom_id !== expected.customId) ||
    (capture.invoice_id !== undefined && capture.invoice_id !== expected.invoiceId) ||
    typeof capture.create_time !== "string" ||
    !Number.isFinite(Date.parse(capture.create_time))
  ) {
    throwMalformedResponse(operation, response);
  }

  let netCents: number | null = null;
  if (capture.status === "COMPLETED") {
    const breakdown = capture.seller_receivable_breakdown;
    const netAmount = isRecord(breakdown) ? breakdown.net_amount : null;
    netCents = isRecord(netAmount) ? usdCents(netAmount.value) : null;
    if (
      !isRecord(netAmount) ||
      netAmount.currency_code !== "USD" ||
      netCents === null ||
      netCents > expected.amountCents
    ) {
      throwMalformedResponse(operation, response);
    }
  }

  return {
    provider: "paypal",
    orderId: expected.orderId,
    orderStatus: payload.status,
    status: capture.status,
    captureId: capture.id,
    captureStatus: capture.status,
    currency: "USD",
    grossCents: expected.amountCents,
    netCents,
    customId: expected.customId,
    invoiceId: expected.invoiceId,
    capturedAt: capture.create_time,
    approvalUrl: null,
  };
}

function isAlreadyCapturedOrder(payload: unknown) {
  if (!isRecord(payload)) return false;
  if (payload.name === "ORDER_ALREADY_CAPTURED") return true;
  return (
    Array.isArray(payload.details) &&
    payload.details.some(
      (detail) => isRecord(detail) && detail.issue === "ORDER_ALREADY_CAPTURED",
    )
  );
}

export async function createPayPalFundingOrderIdempotency(
  stableRequestKey: string,
): Promise<PayPalFundingOrderIdempotency> {
  if (!stableRequestKey.trim()) {
    throw new Error("A stable PayPal funding request key is required.");
  }
  const suffix = (await sha256Hex(stableRequestKey)).slice(0, 56);
  return {
    createRequestId: `five-fund-create-${suffix}`,
    captureRequestId: `five-fund-capture-${suffix}`,
    invoiceId: `five-fund-${suffix}`,
  };
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

/** Creates one retry-stable PayPal Checkout order for an exact sponsor charge. */
export async function createPayPalFundingOrder(
  input: CreatePayPalFundingOrderInput,
): Promise<PayPalFundingOrderResult> {
  const accessToken = requiredSecret(input.accessToken, "PayPal access token");
  const contract = validatedFundingContract(input);
  const ids = await createPayPalFundingOrderIdempotency(input.stableRequestKey);
  const returnUrl = validatedRedirectUrl(input.returnUrl, "PayPal return URL");
  const cancelUrl = validatedRedirectUrl(input.cancelUrl, "PayPal cancel URL");
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(endpoint(input, "/v2/checkout/orders"), {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": ids.createRequestId,
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: "default",
          description: "Sponsor a FIVE $5 task",
          custom_id: contract.customId,
          invoice_id: ids.invoiceId,
          amount: { currency_code: "USD", value: contract.amountValue },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "FIVE",
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
    }),
    signal: input.signal,
  });
  const payload = await responseJson(response);
  if (!response.ok) throwApiError("create-order", response, payload);
  if (
    !isRecord(payload) ||
    typeof payload.id !== "string" ||
    typeof payload.status !== "string" ||
    !PAYPAL_ORDER_STATUSES.has(payload.status)
  ) {
    throwMalformedResponse("create-order", response);
  }
  if (!/^[A-Z0-9]{1,36}$/.test(payload.id)) {
    throwMalformedResponse("create-order", response);
  }
  const orderId = payload.id;
  assertFundingPurchaseUnit(
    payload,
    { ...contract, invoiceId: ids.invoiceId },
    "create-order",
    response,
  );
  const approvalUrl = validatedApprovalUrl(payload, orderId, input);
  if (!approvalUrl) throwMalformedResponse("create-order", response);

  return {
    provider: "paypal",
    orderId,
    status: payload.status,
    approvalUrl,
    requestId: ids.createRequestId,
    invoiceId: ids.invoiceId,
    customId: contract.customId,
    currency: "USD",
    grossCents: contract.amountCents,
  };
}

/** Reads an order and enforces the caller's exact sponsor funding contract. */
export async function getPayPalFundingOrder(
  input: CapturePayPalFundingOrderInput,
): Promise<PayPalFundingOrderObservation> {
  const accessToken = requiredSecret(input.accessToken, "PayPal access token");
  const orderId = validatedOrderId(input.orderId);
  const contract = validatedFundingContract(input);
  const ids = await createPayPalFundingOrderIdempotency(input.stableRequestKey);
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(
    endpoint(input, `/v2/checkout/orders/${encodeURIComponent(orderId)}`),
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
  if (!response.ok) throwApiError("show-order", response, payload);
  return parseFundingOrderObservation(payload, response, "show-order", {
    orderId,
    amountCents: contract.amountCents,
    customId: contract.customId,
    invoiceId: ids.invoiceId,
  }, input);
}

/**
 * Captures one approved order. PayPal may report ORDER_ALREADY_CAPTURED when a
 * previous response was lost; in that case authenticated GET state is returned.
 */
export async function capturePayPalFundingOrder(
  input: CapturePayPalFundingOrderInput,
): Promise<PayPalFundingOrderObservation> {
  const accessToken = requiredSecret(input.accessToken, "PayPal access token");
  const orderId = validatedOrderId(input.orderId);
  const contract = validatedFundingContract(input);
  const ids = await createPayPalFundingOrderIdempotency(input.stableRequestKey);
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(
    endpoint(input, `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": ids.captureRequestId,
        Prefer: "return=representation",
      },
      body: "{}",
      signal: input.signal,
    },
  );
  const payload = await responseJson(response);
  if (!response.ok) {
    if (response.status === 422 && isAlreadyCapturedOrder(payload)) {
      const recovered = await getPayPalFundingOrder({ ...input, orderId, fetcher });
      if (!recovered.captureId) {
        throw new PayPalApiError({
          operation: "show-order",
          status: 200,
          providerCode: "MALFORMED_RESPONSE",
        });
      }
      return recovered;
    }
    throwApiError("capture-order", response, payload);
  }
  const observation = parseFundingOrderObservation(payload, response, "capture-order", {
    orderId,
    amountCents: contract.amountCents,
    customId: contract.customId,
    invoiceId: ids.invoiceId,
  }, input);
  if (!observation.captureId) throwMalformedResponse("capture-order", response);
  return observation;
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
