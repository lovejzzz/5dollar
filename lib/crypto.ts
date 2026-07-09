import {
  getRuntimeEnv,
  requireRuntimeSecret,
  type RuntimeEnv,
} from "./runtime-env";

const textEncoder = new TextEncoder();
const PAYOUT_CIPHERTEXT_VERSION = "v1";
const PAYOUT_ENCRYPTION_AAD = textEncoder.encode(
  "five:payout-destination:v1",
);
const AES_GCM_IV_BYTES = 12;
const AES_256_KEY_BYTES = 32;
const HMAC_MINIMUM_KEY_BYTES = 32;

function webCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error("The Web Crypto API is unavailable in this runtime.");
  }
  return globalThis.crypto;
}

function toUint8Array(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

/** Encodes bytes as unpadded RFC 4648 base64url. */
export function encodeBase64Url(value: Uint8Array | ArrayBuffer): string {
  const bytes = toUint8Array(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

/** Decodes strict, unpadded RFC 4648 base64url into bytes. */
export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) {
    throw new Error("Value is not valid unpadded base64url.");
  }

  const paddingLength = (4 - (value.length % 4)) % 4;
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat(paddingLength);

  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error("Value is not valid unpadded base64url.");
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  if (encodeBase64Url(bytes) !== value) {
    throw new Error("Value is not canonical unpadded base64url.");
  }
  return bytes;
}

// Clear aliases for callers that prefer noun-first utility names.
export const bytesToBase64Url = encodeBase64Url;
export const base64UrlToBytes = decodeBase64Url;

function decodeSecretKey(
  encodedKey: string,
  bindingName: string,
  requiredLength?: number,
): Uint8Array<ArrayBuffer> {
  let keyBytes: Uint8Array<ArrayBuffer>;
  try {
    keyBytes = decodeBase64Url(encodedKey);
  } catch {
    throw new Error(
      `Cloudflare secret binding \`${bindingName}\` must contain an unpadded base64url key.`,
    );
  }

  if (requiredLength !== undefined && keyBytes.length !== requiredLength) {
    throw new Error(
      `Cloudflare secret binding \`${bindingName}\` must decode to exactly ${requiredLength} bytes.`,
    );
  }
  return keyBytes;
}

async function importEncryptionKey(encodedKey: string): Promise<CryptoKey> {
  const keyBytes = decodeSecretKey(
    encodedKey,
    "PAYOUT_ENCRYPTION_KEY",
    AES_256_KEY_BYTES,
  );
  return webCrypto().subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function importFingerprintKey(encodedKey: string): Promise<CryptoKey> {
  const keyBytes = decodeSecretKey(encodedKey, "PAYOUT_FINGERPRINT_KEY");
  if (keyBytes.length < HMAC_MINIMUM_KEY_BYTES) {
    throw new Error(
      `Cloudflare secret binding \`PAYOUT_FINGERPRINT_KEY\` must decode to at least ${HMAC_MINIMUM_KEY_BYTES} bytes.`,
    );
  }
  return webCrypto().subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function encryptionKeyFrom(runtime: RuntimeEnv): string {
  return requireRuntimeSecret("PAYOUT_ENCRYPTION_KEY", runtime);
}

function fingerprintKeyFrom(runtime: RuntimeEnv): string {
  return requireRuntimeSecret("PAYOUT_FINGERPRINT_KEY", runtime);
}

/**
 * Encrypts a payout destination with AES-256-GCM and a fresh 96-bit IV.
 * The authenticated, versioned envelope is safe to persist as a single value.
 */
export async function encryptPayoutDestination(
  destination: string,
  runtime: RuntimeEnv = getRuntimeEnv(),
): Promise<string> {
  if (destination.length === 0) {
    throw new Error("A payout destination is required for encryption.");
  }

  const cryptoApi = webCrypto();
  const key = await importEncryptionKey(encryptionKeyFrom(runtime));
  const iv = cryptoApi.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const ciphertext = await cryptoApi.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: PAYOUT_ENCRYPTION_AAD,
      tagLength: 128,
    },
    key,
    textEncoder.encode(destination),
  );

  return [
    PAYOUT_CIPHERTEXT_VERSION,
    encodeBase64Url(iv),
    encodeBase64Url(ciphertext),
  ].join(".");
}

/** Decrypts and authenticates a value produced by `encryptPayoutDestination`. */
export async function decryptPayoutDestination(
  envelope: string,
  runtime: RuntimeEnv = getRuntimeEnv(),
): Promise<string> {
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== PAYOUT_CIPHERTEXT_VERSION) {
    throw new Error("Encrypted payout destination has an unsupported format.");
  }

  let iv: Uint8Array<ArrayBuffer>;
  let ciphertext: Uint8Array<ArrayBuffer>;
  try {
    iv = decodeBase64Url(parts[1]);
    ciphertext = decodeBase64Url(parts[2]);
  } catch {
    throw new Error("Encrypted payout destination is malformed.");
  }

  if (iv.length !== AES_GCM_IV_BYTES || ciphertext.length < 16) {
    throw new Error("Encrypted payout destination is malformed.");
  }

  const key = await importEncryptionKey(encryptionKeyFrom(runtime));
  try {
    const plaintext = await webCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: PAYOUT_ENCRYPTION_AAD,
        tagLength: 128,
      },
      key,
      ciphertext,
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw new Error(
      "Encrypted payout destination could not be authenticated or decrypted.",
    );
  }
}

/**
 * Produces a stable, non-reversible keyed fingerprint for deduplication.
 * Callers should pass the already normalized destination used by their payout
 * rail; the method is included so identical handles on different rails differ.
 */
export async function fingerprintPayoutDestination(
  payoutMethod: string,
  normalizedDestination: string,
  runtime: RuntimeEnv = getRuntimeEnv(),
): Promise<string> {
  const method = payoutMethod.trim().toLowerCase();
  if (!method || !normalizedDestination) {
    throw new Error(
      "A payout method and normalized destination are required for fingerprinting.",
    );
  }

  const key = await importFingerprintKey(fingerprintKeyFrom(runtime));
  const payload = textEncoder.encode(
    `five:payout-fingerprint:v1\u0000${method.length}:${method}\u0000${normalizedDestination}`,
  );
  const signature = await webCrypto().subtle.sign("HMAC", key, payload);
  return encodeBase64Url(signature);
}

/**
 * Compares secrets without an early exit. Hashing both inputs first keeps the
 * byte-comparison loop fixed at 32 iterations even when input lengths differ.
 */
export async function constantTimeSecretEqual(
  left: string,
  right: string,
): Promise<boolean> {
  const cryptoApi = webCrypto();
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const [leftDigest, rightDigest] = await Promise.all([
    cryptoApi.subtle.digest("SHA-256", leftBytes),
    cryptoApi.subtle.digest("SHA-256", rightBytes),
  ]);

  const leftHash = new Uint8Array(leftDigest);
  const rightHash = new Uint8Array(rightDigest);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftHash.length; index += 1) {
    difference |= leftHash[index] ^ rightHash[index];
  }
  return difference === 0;
}

export const constantTimeEqual = constantTimeSecretEqual;
