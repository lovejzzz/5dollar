export type TremendousEnvironment = "sandbox" | "live";

export class TremendousApiError extends Error {
  readonly operation: "create-reward" | "get-reward" | "generate-link";
  readonly status: number;
  readonly providerCode: string | null;

  constructor(
    operation: TremendousApiError["operation"],
    status: number,
    providerCode: string | null = null,
  ) {
    super(
      `Tremendous ${operation} failed with HTTP ${status}${
        providerCode ? ` (${providerCode})` : ""
      }.`,
    );
    this.name = "TremendousApiError";
    this.operation = operation;
    this.status = status;
    this.providerCode = providerCode;
  }
}

type TremendousTarget = {
  environment?: TremendousEnvironment;
  baseUrl?: string;
};

type TremendousReward = {
  id: string;
  orderId: string;
  valueCents: number;
  currency: "USD";
  deliveryMethod: "LINK";
  deliveryStatus: "SUCCEEDED";
};

export type TremendousGiftCardOrder = TremendousReward & {
  provider: "tremendous";
  orderStatus: "EXECUTED";
  externalId: string;
  orderTotalCents: number;
};

function required(value: string, name: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function apiOrigin(target: TremendousTarget) {
  const configured = target.baseUrl?.trim();
  const raw = configured
    ? configured
    : target.environment === "live"
      ? "https://api.tremendous.com"
      : "https://testflight.tremendous.com";
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Tremendous API base URL is invalid.");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function endpoint(target: TremendousTarget, path: string) {
  return `${apiOrigin(target)}/api/v2${path}`;
}

function safeProviderCode(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["code", "error", "message"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.replace(/[\r\n]+/g, " ").slice(0, 120);
    }
  }
  return null;
}

async function responsePayload(response: Response) {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown, max = 160) {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : null;
}

function cents(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 100)
    : null;
}

function parseReward(value: unknown): TremendousReward | null {
  const reward = objectValue(value);
  const rewardValue = objectValue(reward?.value);
  const delivery = objectValue(reward?.delivery);
  const id = stringValue(reward?.id);
  const orderId = stringValue(reward?.order_id);
  const valueCents = cents(rewardValue?.denomination);
  if (
    !id ||
    !orderId ||
    valueCents !== 500 ||
    rewardValue?.currency_code !== "USD" ||
    delivery?.method !== "LINK" ||
    delivery?.status !== "SUCCEEDED"
  ) {
    return null;
  }
  return {
    id,
    orderId,
    valueCents,
    currency: "USD",
    deliveryMethod: "LINK",
    deliveryStatus: "SUCCEEDED",
  };
}

function authorization(apiKey: string) {
  return {
    authorization: `Bearer ${required(apiKey, "Tremendous API key")}`,
    "content-type": "application/json",
  };
}

export async function createTremendousGiftCard(input: {
  apiKey: string;
  campaignId: string;
  externalId: string;
  fundingSourceId?: string;
  recipientEmail: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
} & TremendousTarget): Promise<TremendousGiftCardOrder> {
  const campaignId = required(input.campaignId, "Tremendous campaign ID");
  const externalId = required(input.externalId, "Tremendous external ID");
  const recipientEmail = required(input.recipientEmail, "Reward contact email").toLowerCase();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{4,119}$/.test(externalId)) {
    throw new Error("Tremendous external ID must be a stable safe identifier.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
    throw new Error("Reward contact email is invalid.");
  }

  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(endpoint(input, "/orders"), {
    method: "POST",
    headers: authorization(input.apiKey),
    body: JSON.stringify({
      external_id: externalId,
      payment: {
        funding_source_id: input.fundingSourceId?.trim() || "balance",
      },
      reward: {
        campaign_id: campaignId,
        value: { denomination: 5, currency_code: "USD" },
        delivery: { method: "LINK" },
        recipient: { name: "FIVE reward", email: recipientEmail },
      },
    }),
    signal: input.signal,
  });
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new TremendousApiError(
      "create-reward",
      response.status,
      safeProviderCode(payload),
    );
  }
  const order = objectValue(objectValue(payload)?.order);
  const payment = objectValue(order?.payment);
  const rewards = Array.isArray(order?.rewards) ? order.rewards : [];
  const reward = rewards.length === 1 ? parseReward(rewards[0]) : null;
  const orderId = stringValue(order?.id);
  const returnedExternalId = stringValue(order?.external_id);
  const orderTotalCents = cents(payment?.total);
  if (
    !orderId ||
    returnedExternalId !== externalId ||
    order?.status !== "EXECUTED" ||
    !reward ||
    reward.orderId !== orderId ||
    orderTotalCents === null ||
    orderTotalCents < 500
  ) {
    throw new TremendousApiError("create-reward", response.status, "MALFORMED_RESPONSE");
  }
  return {
    provider: "tremendous",
    orderStatus: "EXECUTED",
    externalId,
    orderTotalCents,
    ...reward,
  };
}

export async function getTremendousReward(input: {
  apiKey: string;
  rewardId: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
} & TremendousTarget): Promise<TremendousReward> {
  const rewardId = required(input.rewardId, "Tremendous reward ID");
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(
    endpoint(input, `/rewards/${encodeURIComponent(rewardId)}`),
    {
      headers: authorization(input.apiKey),
      signal: input.signal,
    },
  );
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new TremendousApiError(
      "get-reward",
      response.status,
      safeProviderCode(payload),
    );
  }
  const reward = parseReward(objectValue(payload)?.reward);
  if (!reward || reward.id !== rewardId) {
    throw new TremendousApiError("get-reward", response.status, "MALFORMED_RESPONSE");
  }
  return reward;
}

export async function generateTremendousRewardLink(input: {
  apiKey: string;
  rewardId: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
} & TremendousTarget) {
  const rewardId = required(input.rewardId, "Tremendous reward ID");
  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(
    endpoint(input, `/rewards/${encodeURIComponent(rewardId)}/generate_link`),
    {
      method: "POST",
      headers: authorization(input.apiKey),
      signal: input.signal,
    },
  );
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new TremendousApiError(
      "generate-link",
      response.status,
      safeProviderCode(payload),
    );
  }
  const reward = objectValue(objectValue(payload)?.reward);
  const returnedId = stringValue(reward?.id);
  const rawLink = stringValue(reward?.link, 2_048);
  if (!returnedId || returnedId !== rewardId || !rawLink) {
    throw new TremendousApiError("generate-link", response.status, "MALFORMED_RESPONSE");
  }
  const link = new URL(rawLink);
  if (
    link.protocol !== "https:" ||
    link.username ||
    link.password ||
    !(link.hostname === "tremendous.com" || link.hostname.endsWith(".tremendous.com"))
  ) {
    throw new TremendousApiError("generate-link", response.status, "UNSAFE_REWARD_LINK");
  }
  return { provider: "tremendous" as const, rewardId, link: link.toString() };
}
