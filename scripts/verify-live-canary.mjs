const [baseUrlInput, jobId, ...options] = process.argv.slice(2);
const secret = process.env.PROCESSOR_SECRET ?? "";

function usage(message) {
  if (message) console.error(message);
  console.error(
    "Usage: PROCESSOR_SECRET=<secret> npm run verify:live-canary -- <https-base-url> <job-uuid> [--wait=300] [--interval=5]",
  );
  process.exit(2);
}

if (!baseUrlInput || !jobId || !secret) {
  usage("A base URL, job UUID, and PROCESSOR_SECRET are required.");
}

let baseUrl;
try {
  baseUrl = new URL(baseUrlInput);
} catch {
  usage("The base URL is invalid.");
}
const loopback =
  baseUrl.protocol === "http:" &&
  ["localhost", "127.0.0.1", "::1"].includes(baseUrl.hostname);
if ((baseUrl.protocol !== "https:" && !loopback) || baseUrl.username || baseUrl.password) {
  usage("The base URL must use HTTPS, except for a loopback development URL.");
}
if (
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    jobId,
  )
) {
  usage("The job ID is invalid.");
}

function numericOption(name, fallback, minimum, maximum) {
  const raw = options.find((option) => option.startsWith(`--${name}=`));
  if (!raw) return fallback;
  const value = Number(raw.slice(name.length + 3));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    usage(`--${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

const waitSeconds = numericOption("wait", 0, 0, 1_800);
const intervalSeconds = numericOption("interval", 5, 1, 60);
const deadline = Date.now() + waitSeconds * 1_000;
const endpoint = new URL(
  `/api/internal/canary/${encodeURIComponent(jobId)}`,
  baseUrl.origin,
);

let lastCertificate = null;
while (true) {
  let response;
  try {
    response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${secret}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    if (Date.now() >= deadline) {
      console.error("The live canary endpoint could not be reached.");
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1_000));
    continue;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(payload.error || `Canary endpoint returned HTTP ${response.status}.`);
    process.exit(1);
  }
  lastCertificate = payload.certificate ?? null;
  if (lastCertificate?.passed || Date.now() >= deadline) break;
  await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1_000));
}

console.log(JSON.stringify(lastCertificate, null, 2));
if (!lastCertificate?.passed) {
  const failed = Object.entries(lastCertificate?.gates ?? {})
    .filter(([, passed]) => !passed)
    .map(([gate]) => gate);
  console.error(`Live canary has not passed: ${failed.join(", ") || "certificate missing"}.`);
  process.exit(1);
}
