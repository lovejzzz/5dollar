import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SPONSOR_API_CACHE_CONTROL,
  sponsorJson,
  sponsorMutationBoundaryError,
} from "../lib/sponsor-api";

function mutationRequest(headers: HeadersInit = {}) {
  return new Request("https://five.example/api/sponsor/orders", {
    method: "POST",
    headers,
    body: "{}",
  });
}

test("sponsor JSON responses are private and never stored", async () => {
  const response = sponsorJson(
    { ok: true },
    {
      status: 429,
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Retry-After": "5",
      },
    },
  );

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("cache-control"), SPONSOR_API_CACHE_CONTROL);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.deepEqual(await response.json(), { ok: true });
});

test("sponsor mutation boundary accepts same-origin JSON with parameters", () => {
  const error = sponsorMutationBoundaryError(
    mutationRequest({
      Origin: "https://five.example",
      "Content-Type": "Application/JSON; charset=utf-8",
    }),
  );

  assert.equal(error, null);
});

test("sponsor mutation boundary rejects absent, invalid, and cross-site origins", async () => {
  for (const origin of [undefined, "not a URL", "https://attacker.example"]) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (origin) headers.Origin = origin;
    const response = sponsorMutationBoundaryError(mutationRequest(headers));

    assert.ok(response);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), SPONSOR_API_CACHE_CONTROL);
    assert.deepEqual(await response.json(), {
      error: "A same-origin browser request is required.",
    });
  }
});

test("sponsor mutation boundary rejects non-JSON media types", async () => {
  for (const contentType of [undefined, "text/plain", "application/problem+json"]) {
    const headers: Record<string, string> = { Origin: "https://five.example" };
    if (contentType) headers["Content-Type"] = contentType;
    const response = sponsorMutationBoundaryError(mutationRequest(headers));

    assert.ok(response);
    assert.equal(response.status, 415);
    assert.equal(response.headers.get("cache-control"), SPONSOR_API_CACHE_CONTROL);
  }
});

test("all sponsor route responses use the no-store JSON helper", async () => {
  const routeUrls = [
    new URL("../app/api/sponsor/orders/route.ts", import.meta.url),
    new URL("../app/api/sponsor/orders/[id]/capture/route.ts", import.meta.url),
    new URL("../app/api/sponsor/orders/[id]/cancel/route.ts", import.meta.url),
    new URL("../app/api/sponsor/tasks/[id]/route.ts", import.meta.url),
  ];

  for (const routeUrl of routeUrls) {
    const source = await readFile(routeUrl, "utf8");
    assert.match(source, /sponsorJson/);
    assert.doesNotMatch(source, /Response\.json/);
  }
});
