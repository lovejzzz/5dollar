import { constantTimeSecretEqual } from "../../../../../lib/crypto";
import { liveCanaryCertificate } from "../../../../../lib/live-canary";
import {
  getRuntimeEnv,
  requireLiveEnv,
  requireRuntimeSecret,
} from "../../../../../lib/runtime-env";

const PRIVATE_JSON_HEADERS = { "Cache-Control": "private, no-store" };

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const runtime = getRuntimeEnv();
    const expected = requireRuntimeSecret("PROCESSOR_SECRET", runtime);
    const authorization = request.headers.get("authorization") ?? "";
    const supplied = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    if (!(await constantTimeSecretEqual(supplied, expected))) {
      return Response.json(
        { error: "Unauthorized." },
        { status: 401, headers: PRIVATE_JSON_HEADERS },
      );
    }
    requireLiveEnv(runtime);
    const { id } = await context.params;
    const certificate = await liveCanaryCertificate(id, runtime);
    if (!certificate) {
      return Response.json(
        { error: "Canary job not found." },
        { status: 404, headers: PRIVATE_JSON_HEADERS },
      );
    }
    return Response.json({ certificate }, { headers: PRIVATE_JSON_HEADERS });
  } catch {
    return Response.json(
      { error: "Canary verification is temporarily unavailable." },
      { status: 503, headers: PRIVATE_JSON_HEADERS },
    );
  }
}
