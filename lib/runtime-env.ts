import { env } from "cloudflare:workers";

export type FiveMode = "sandbox" | "live";
export type PayPalMode = "sandbox" | "live";

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
  RESEND_API_KEY?: string;
  NOTIFICATION_FROM_EMAIL?: string;
  RESEND_API_BASE_URL?: string;
  PROVIDER_TEST_MODE?: "loopback";
}

export const REQUIRED_LIVE_SECRET_NAMES = [
  "PAYOUT_ENCRYPTION_KEY",
  "PAYOUT_FINGERPRINT_KEY",
  "PROCESSOR_SECRET",
  "TASK_ADMIN_SECRET",
  "OPENAI_API_KEY",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_WEBHOOK_ID",
  "RESEND_API_KEY",
  "NOTIFICATION_FROM_EMAIL",
] as const;

export type RequiredLiveSecretName =
  (typeof REQUIRED_LIVE_SECRET_NAMES)[number];

export type LiveRuntimeEnv = Omit<
  RuntimeEnv,
  RequiredLiveSecretName | "FIVE_MODE" | "PAYPAL_MODE"
> &
  Record<RequiredLiveSecretName, string> & {
    FIVE_MODE: "live";
    PAYPAL_MODE: "live";
  };

export function getRuntimeEnv(): RuntimeEnv {
  return env as unknown as RuntimeEnv;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizedMode(value: unknown, name: "FIVE_MODE" | "PAYPAL_MODE") {
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

export function requireRuntimeSecret(
  name: RequiredLiveSecretName,
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

/**
 * Returns a narrowed live configuration, or throws without including any
 * secret values in the error. This is intentionally strict: a live processor
 * must not silently fall back to sandbox task execution or PayPal endpoints.
 */
export function requireLiveEnv(
  runtime: RuntimeEnv = getRuntimeEnv(),
): LiveRuntimeEnv {
  const fiveMode = getFiveMode(runtime);
  if (fiveMode !== "live") {
    throw new Error(
      "Live FIVE configuration was requested, but `FIVE_MODE` is not set to `live`.",
    );
  }

  const payPalMode = getPayPalMode(runtime);
  if (payPalMode !== "live") {
    throw new Error(
      "Live FIVE configuration requires Cloudflare binding `PAYPAL_MODE=live`.",
    );
  }

  const missing = REQUIRED_LIVE_SECRET_NAMES.filter(
    (name) => !nonEmptyString(runtime[name]),
  );
  if (missing.length > 0) {
    const names = missing.map((name) => `\`${name}\``).join(", ");
    throw new Error(
      `Live FIVE configuration is incomplete. Missing required Cloudflare secret binding${missing.length === 1 ? "" : "s"}: ${names}.`,
    );
  }

  const providerOverrides = [
    ["OPENAI_API_BASE_URL", runtime.OPENAI_API_BASE_URL],
    ["PAYPAL_API_BASE_URL", runtime.PAYPAL_API_BASE_URL],
    ["RESEND_API_BASE_URL", runtime.RESEND_API_BASE_URL],
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

  return {
    ...runtime,
    FIVE_MODE: "live",
    PAYPAL_MODE: "live",
  } as LiveRuntimeEnv;
}
