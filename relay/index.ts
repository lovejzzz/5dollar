type RelayEnv = {
  FIVE_TARGET_ORIGIN: string;
  PROCESSOR_SECRET: string;
  SITES_BYPASS_TOKEN: string;
};

type RelayExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

type RelayFetcher = (request: Request) => Promise<Response>;

const PAYPAL_MAX_BYTES = 256_000;
const RESEND_MAX_BYTES = 64 * 1024;
const NO_STORE_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

const PAYPAL_HEADERS = [
  "paypal-auth-algo",
  "paypal-cert-url",
  "paypal-transmission-id",
  "paypal-transmission-sig",
  "paypal-transmission-time",
] as const;

const RESEND_HEADERS = [
  "svix-id",
  "svix-timestamp",
  "svix-signature",
] as const;

function json(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: NO_STORE_HEADERS,
  });
}

function requiredValue(value: string | undefined, name: string) {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function targetOrigin(env: RelayEnv) {
  const configured = requiredValue(env.FIVE_TARGET_ORIGIN, "FIVE_TARGET_ORIGIN");
  const url = new URL(configured);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("FIVE_TARGET_ORIGIN must be an origin-only HTTPS URL.");
  }
  return url.origin;
}

function privateHeaders(env: RelayEnv) {
  return {
    "oai-sites-authorization": `Bearer ${requiredValue(
      env.SITES_BYPASS_TOKEN,
      "SITES_BYPASS_TOKEN",
    )}`,
  };
}

function validWebhookHeaders(request: Request, names: readonly string[]) {
  return names.every((name) => {
    const value = request.headers.get(name)?.trim() ?? "";
    return value.length > 0 && value.length <= 4_096;
  });
}

async function boundedBody(request: Request, maxBytes: number) {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > maxBytes) return null;
  }
  const body = await request.arrayBuffer();
  return body.byteLength <= maxBytes ? body : null;
}

function forwardedHeaders(
  request: Request,
  names: readonly string[],
  env: RelayEnv,
) {
  const headers = new Headers(privateHeaders(env));
  headers.set("content-type", request.headers.get("content-type") ?? "application/json");
  for (const name of names) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

async function publicWebhookResponse(
  request: Request,
  env: RelayEnv,
  fetcher: RelayFetcher,
  options: {
    privatePath: string;
    maxBytes: number;
    headerNames: readonly string[];
  },
) {
  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed." });
  }
  if (!validWebhookHeaders(request, options.headerNames)) {
    return json(400, { error: "Webhook headers are invalid." });
  }
  const body = await boundedBody(request, options.maxBytes);
  if (!body) return json(413, { error: "Webhook body is too large." });

  let upstream: Response;
  try {
    upstream = await fetcher(
      new Request(`${targetOrigin(env)}${options.privatePath}`, {
        method: "POST",
        headers: forwardedHeaders(request, options.headerNames, env),
        body,
      }),
    );
  } catch {
    return json(502, { error: "Webhook relay is temporarily unavailable." });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "cache-control": "no-store",
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    },
  });
}

async function drainPrivateSite(env: RelayEnv, fetcher: RelayFetcher) {
  const response = await fetcher(
    new Request(`${targetOrigin(env)}/api/internal/jobs/drain`, {
      method: "POST",
      headers: {
        ...privateHeaders(env),
        authorization: `Bearer ${requiredValue(
          env.PROCESSOR_SECRET,
          "PROCESSOR_SECRET",
        )}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ limit: 5 }),
    }),
  );
  if (!response.ok) {
    throw new Error(`FIVE recovery drain returned HTTP ${response.status}.`);
  }
}

export function createRelay(fetcher: RelayFetcher = fetch) {
  return {
    async fetch(request: Request, env: RelayEnv) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/health" && request.method === "GET") {
        return json(200, { ok: true });
      }
      if (pathname === "/webhooks/paypal") {
        return publicWebhookResponse(request, env, fetcher, {
          privatePath: "/api/webhooks/paypal",
          maxBytes: PAYPAL_MAX_BYTES,
          headerNames: PAYPAL_HEADERS,
        });
      }
      if (pathname === "/webhooks/resend") {
        return publicWebhookResponse(request, env, fetcher, {
          privatePath: "/api/webhooks/resend",
          maxBytes: RESEND_MAX_BYTES,
          headerNames: RESEND_HEADERS,
        });
      }
      return json(404, { error: "Not found." });
    },

    scheduled(
      _controller: unknown,
      env: RelayEnv,
      ctx: RelayExecutionContext,
    ) {
      ctx.waitUntil(drainPrivateSite(env, fetcher));
    },
  };
}

export default createRelay();
