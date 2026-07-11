import { spawnSync } from "node:child_process";

export const DEFAULT_LTX_KEYCHAIN_SERVICE = "team.nexttask.five.ltx.api";
export const DEFAULT_LTX_KEYCHAIN_ACCOUNT = "FIVE";

export function readLtxApiKey(options?: { service?: string; account?: string }): string {
  const environmentKey = process.env.LTXV_API_KEY?.trim();
  if (environmentKey) return environmentKey;

  const service = options?.service ?? DEFAULT_LTX_KEYCHAIN_SERVICE;
  const account = options?.account ?? DEFAULT_LTX_KEYCHAIN_ACCOUNT;
  const result = spawnSync(
    "security",
    ["find-generic-password", "-s", service, "-a", account, "-w"],
    { encoding: "utf8" },
  );
  const key = result.stdout.trim();
  if (result.status !== 0 || !key) {
    throw new Error(
      `LTX API key not found. Set LTXV_API_KEY or add macOS Keychain service ${service}, account ${account}`,
    );
  }
  return key;
}
