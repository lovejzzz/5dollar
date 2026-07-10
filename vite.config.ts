import vinext from "vinext";
import { defineConfig, loadEnv } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

const RUNTIME_VARIABLE_NAMES = [
  "FIVE_MODE",
  "PAYPAL_MODE",
  "PAYOUT_ENCRYPTION_KEY",
  "PAYOUT_FINGERPRINT_KEY",
  "PROCESSOR_SECRET",
  "TASK_ADMIN_SECRET",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "OPENAI_API_BASE_URL",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_WEBHOOK_ID",
  "PAYPAL_API_BASE_URL",
  "RESEND_API_KEY",
  "NOTIFICATION_FROM_EMAIL",
  "SUPPORT_EMAIL",
  "SPONSOR_ALLOWED_EMAILS",
  "SPONSOR_SITE_ORIGIN",
  "RESEND_API_BASE_URL",
  "PROVIDER_TEST_MODE",
] as const;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async ({ mode }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Values stay server-side as Worker bindings. Hosted values are managed by
  // Sites; this path exists only for ignored local .env files and explicit
  // process environment values used during integration testing.
  const fileEnv = loadEnv(mode, process.cwd(), "");
  const runtimeVars = Object.fromEntries(
    RUNTIME_VARIABLE_NAMES.flatMap((name) => {
      const value = process.env[name] ?? fileEnv[name];
      return value ? [[name, value]] : [];
    }),
  );

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: { ...localBindingConfig, vars: runtimeVars },
      }),
    ],
  };
});
