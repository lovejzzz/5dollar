import { env } from "cloudflare:workers";

export type FiveMode = "sandbox" | "live";
export type PayPalMode = "sandbox" | "live";
export type TremendousMode = "sandbox" | "live";
export type RewardProvider = "paypal" | "tremendous";

/**
 * Bindings made available to the application by the Cloudflare runtime.
 *
 * Secrets stay optional here so local sandbox builds can start without live
 * credentials. Call `requireLiveEnv` at the live execution boundary to obtain
 * a configuration whose required secrets are all present.
 */
export interface RuntimeEnv {
  DB?: unknown;
  FIVE_MODE?: FiveMode;
  PAYPAL_MODE?: PayPalMode;
  REWARD_PROVIDER?: RewardProvider;
  TREMENDOUS_MODE?: TremendousMode;
  PAYOUT_ENCRYPTION_KEY?: string;
  PAYOUT_FINGERPRINT_KEY?: string;
  PROCESSOR_SECRET?: string;
  TASK_ADMIN_SECRET?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_API_BASE_URL?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_WEBHOOK_ID?: string;
  PAYPAL_API_BASE_URL?: string;
  TREMENDOUS_API_KEY?: string;
  TREMENDOUS_CAMPAIGN_ID?: string;
  TREMENDOUS_FUNDING_SOURCE_ID?: string;
  TREMENDOUS_API_BASE_URL?: string;
  RESEND_API_KEY?: string;
  RESEND_WEBHOOK_SECRET?: string;
  NOTIFICATION_FROM_EMAIL?: string;
  SUPPORT_EMAIL?: string;
  SPONSOR_ALLOWED_EMAILS?: string;
  SPONSOR_SITE_ORIGIN?: string;
  RESEND_API_BASE_URL?: string;
  PROVIDER_TEST_MODE?: "loopback";
}

export const COMMON_LIVE_SECRET_NAMES = [
  "PAYOUT_ENCRYPTION_KEY",
  "PAYOUT_FINGERPRINT_KEY",
  "PROCESSOR_SECRET",
  "TASK_ADMIN_SECRET",
  "OPENAI_API_KEY",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "NOTIFICATION_FROM_EMAIL",
  "SUPPORT_EMAIL",
] as const;

export const PAYPAL_LIVE_SECRET_NAMES = [
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_WEBHOOK_ID",
] as const;

export const TREMENDOUS_LIVE_SECRET_NAMES = [
  "TREMENDOUS_API_KEY",
  "TREMENDOUS_CAMPAIGN_ID",
] as const;

export const REQUIRED_LIVE_SECRET_NAMES = [
  ...COMMON_LIVE_SECRET_NAMES,
  ...PAYPAL_LIVE_SECRET_NAMES,
] as const;

export type RequiredLiveSecretName =
  (typeof REQUIRED_LIVE_SECRET_NAMES)[number];

export type RuntimeSecretName =
  | (typeof COMMON_LIVE_SECRET_NAMES)[number]
  | (typeof PAYPAL_LIVE_SECRET_NAMES)[number]
  | (typeof TREMENDOUS_LIVE_SECRET_NAMES)[number];

export type LiveRuntimeEnv = Omit<
  RuntimeEnv,
  RequiredLiveSecretName | "FIVE_MODE" | "PAYPAL_MODE"
> &
  Record<RequiredLiveSecretName, string> & {
    FIVE_MODE: "live";
    PAYPAL_MODE: "live";
    REWARD_PROVIDER: "paypal";
  };

type GiftCardRequiredName =
  | (typeof COMMON_LIVE_SECRET_NAMES)[number]
  | (typeof TREMENDOUS_LIVE_SECRET_NAMES)[number];

export type GiftCardLiveRuntimeEnv = Omit<
  RuntimeEnv,
  GiftCardRequiredName | "FIVE_MODE" | "TREMENDOUS_MODE" | "REWARD_PROVIDER"
> &
  Record<GiftCardRequiredName, string> & {
    FIVE_MODE: "live";
    TREMENDOUS_MODE: "live";
    REWARD_PROVIDER: "tremendous";
  };

export type ActiveLiveRuntimeEnv = LiveRuntimeEnv | GiftCardLiveRuntimeEnv;

export function getRuntimeEnv(): RuntimeEnv {
  return env as unknown as RuntimeEnv;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizedMode(
  value: unknown,
  name: "FIVE_MODE" | "PAYPAL_MODE" | "TREMENDOUS_MODE",
) {
  if (!nonEmptyString(value)) return "sandbox";

  const mode = value.trim().toLowerCase();
  if (mode === "sandbox" || mode === "live") return mode;

  throw new Error(
    `Cloudflare binding \`${name}\` must be either \`sandbox\` or \`live\`.`,
  );
}

export function getFiveMode(runtime: RuntimeEnv = getRuntimeEnv()): FiveMode {
  return normalizedMode(runtime.FIVE_MODE, "FIVE_MODE");
}

export function getPayPalMode(
  runtime: RuntimeEnv = getRuntimeEnv(),
): PayPalMode {
  return normalizedMode(runtime.PAYPAL_MODE, "PAYPAL_MODE");
}

export function getTremendousMode(
  runtime: RuntimeEnv = getRuntimeEnv(),
): TremendousMode {
  return normalizedMode(runtime.TREMENDOUS_MODE, "TREMENDOUS_MODE");
}

export function getRewardProvider(
  runtime: RuntimeEnv = getRuntimeEnv(),
): RewardProvider {
  if (!nonEmptyString(runtime.REWARD_PROVIDER)) return "paypal";
  const provider = runtime.REWARD_PROVIDER.trim().toLowerCase();
  if (provider === "paypal" || provider === "tremendous") return provider;
  throw new Error(
    "Cloudflare binding `REWARD_PROVIDER` must be either `paypal` or `tremendous`.",
  );
}

/**
 * Sponsor Checkout is a private beta. An absent allowlist disables new public
 * sponsor orders without disabling claimant payouts or operator-funded tasks.
 */
export function isSponsorAllowed(
  email: string,
  runtime: RuntimeEnv = getRuntimeEnv(),
) {
  const configured = runtime.SPONSOR_ALLOWED_EMAILS;
  if (!nonEmptyString(configured)) return false;

  const allowed = configured
    .split(/[\s,]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (
    allowed.length === 0 ||
    allowed.some((value) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
  ) {
    throw new Error(
      "Cloudflare binding `SPONSOR_ALLOWED_EMAILS` must contain only comma-separated sponsor email addresses.",
    );
  }
  return allowed.includes(email.trim().toLowerCase());
}

export function requireRuntimeSecret(
  name: RuntimeSecretName,
  runtime: RuntimeEnv = getRuntimeEnv(),
): string {
  const value = runtime[name];
  if (!nonEmptyString(value)) {
    throw new Error(
      `Required Cloudflare secret binding \`${name}\` is missing. Configure it before enabling the live FIVE workflow.`,
    );
  }
  return value;
}

function requireCommonLiveEnv(runtime: RuntimeEnv) {
  if (getFiveMode(runtime) !== "live") {
    throw new Error(
      "Live FIVE configuration was requested, but `FIVE_MODE` is not set to `live`.",
    );
  }
  const missing = COMMON_LIVE_SECRET_NAMES.filter(
    (name) => !nonEmptyString(runtime[name]),
  );
  if (missing.length > 0) {
    const names = missing.map((name) => `\`${name}\``).join(", ");
    throw new Error(
      `Live FIVE configuration is incomplete. Missing required Cloudflare secret binding${missing.length === 1 ? "" : "s"}: ${names}.`,
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(runtime.SUPPORT_EMAIL ?? "")) {
    throw new Error(
      "Cloudflare binding `SUPPORT_EMAIL` must be a valid support mailbox before live rewards are enabled.",
    );
  }

  const providerOverrides = [
    ["OPENAI_API_BASE_URL", runtime.OPENAI_API_BASE_URL],
    ["PAYPAL_API_BASE_URL", runtime.PAYPAL_API_BASE_URL],
    ["RESEND_API_BASE_URL", runtime.RESEND_API_BASE_URL],
    ["TREMENDOUS_API_BASE_URL", runtime.TREMENDOUS_API_BASE_URL],
  ] as const;
  for (const [name, value] of providerOverrides) {
    if (!nonEmptyString(value)) continue;
    if (runtime.PROVIDER_TEST_MODE !== "loopback") {
      throw new Error(
        `Live FIVE configuration rejects \`${name}\` unless \`PROVIDER_TEST_MODE=loopback\` is explicitly enabled for local integration testing.`,
      );
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Cloudflare binding \`${name}\` must be a valid URL.`);
    }
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      throw new Error(
        `Cloudflare binding \`${name}\` may target only a loopback host in provider test mode.`,
      );
    }
  }
}

/**
 * Returns a narrowed live configuration, or throws without including any
 * secret values in the error. This is intentionally strict: a live processor
 * must not silently fall back to sandbox task execution or PayPal endpoints.
 */
export function requireLiveEnv(
  runtime: RuntimeEnv = getRuntimeEnv(),
): LiveRuntimeEnv {
  requireCommonLiveEnv(runtime);
  if (getRewardProvider(runtime) !== "paypal") {
    throw new Error(
      "PayPal live configuration was requested, but `REWARD_PROVIDER` is not set to `paypal`.",
    );
  }

  const payPalMode = getPayPalMode(runtime);
  if (payPalMode !== "live") {
    throw new Error(
      "Live FIVE configuration requires Cloudflare binding `PAYPAL_MODE=live`.",
    );
  }

  const missing = PAYPAL_LIVE_SECRET_NAMES.filter(
    (name) => !nonEmptyString(runtime[name]),
  );
  if (missing.length > 0) {
    const names = missing.map((name) => `\`${name}\``).join(", ");
    throw new Error(
      `Live FIVE configuration is incomplete. Missing required Cloudflare secret binding${missing.length === 1 ? "" : "s"}: ${names}.`,
    );
  }
  return {
    ...runtime,
    FIVE_MODE: "live",
    PAYPAL_MODE: "live",
    REWARD_PROVIDER: "paypal",
  } as LiveRuntimeEnv;
}

export function requireGiftCardLiveEnv(
  runtime: RuntimeEnv = getRuntimeEnv(),
): GiftCardLiveRuntimeEnv {
  requireCommonLiveEnv(runtime);
  if (getRewardProvider(runtime) !== "tremendous") {
    throw new Error(
      "Gift-card live configuration requires `REWARD_PROVIDER=tremendous`.",
    );
  }
  if (getTremendousMode(runtime) !== "live") {
    throw new Error(
      "Gift-card live configuration requires `TREMENDOUS_MODE=live`.",
    );
  }
  const missing = TREMENDOUS_LIVE_SECRET_NAMES.filter(
    (name) => !nonEmptyString(runtime[name]),
  );
  if (missing.length > 0) {
    const names = missing.map((name) => `\`${name}\``).join(", ");
    throw new Error(
      `Gift-card live configuration is incomplete. Missing required Cloudflare secret binding${missing.length === 1 ? "" : "s"}: ${names}.`,
    );
  }
  if (
    runtime.PROVIDER_TEST_MODE !== "loopback" &&
    !runtime.TREMENDOUS_API_KEY?.startsWith("PROD_")
  ) {
    throw new Error(
      "Live gift-card mode requires a Tremendous production API key.",
    );
  }
  return {
    ...runtime,
    FIVE_MODE: "live",
    TREMENDOUS_MODE: "live",
    REWARD_PROVIDER: "tremendous",
  } as GiftCardLiveRuntimeEnv;
}

export function requireActiveLiveEnv(
  runtime: RuntimeEnv = getRuntimeEnv(),
): ActiveLiveRuntimeEnv {
  return getRewardProvider(runtime) === "tremendous"
    ? requireGiftCardLiveEnv(runtime)
    : requireLiveEnv(runtime);
}
