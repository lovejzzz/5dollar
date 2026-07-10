export const SPONSOR_API_CACHE_CONTROL = "private, no-store";

/**
 * Sponsor responses can contain owner-specific task and payment state. Keep the
 * cache policy centralized so an error or early return cannot accidentally be
 * stored by a browser, CDN, or shared intermediary.
 */
export function sponsorJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", SPONSOR_API_CACHE_CONTROL);
  return Response.json(body, { ...init, headers });
}

function forbiddenMutation() {
  return sponsorJson(
    { error: "A same-origin browser request is required." },
    { status: 403 },
  );
}

/**
 * Enforces the browser-facing sponsor mutation contract before authentication
 * or body parsing. Requiring a serialized, same-origin Origin header makes the
 * signed-in endpoints fail closed against cross-site form and fetch requests.
 */
export function sponsorMutationBoundaryError(request: Request) {
  const presentedOrigin = request.headers.get("origin");
  if (!presentedOrigin) return forbiddenMutation();

  try {
    const parsedOrigin = new URL(presentedOrigin);
    const expectedOrigin = new URL(request.url).origin;
    if (
      parsedOrigin.origin !== presentedOrigin ||
      parsedOrigin.origin !== expectedOrigin
    ) {
      return forbiddenMutation();
    }
  } catch {
    return forbiddenMutation();
  }

  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return sponsorJson(
      { error: "Sponsor requests require Content-Type: application/json." },
      { status: 415 },
    );
  }

  return null;
}
