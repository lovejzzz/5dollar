import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VideoBountyJob } from "./types";

type FetchLike = typeof fetch;
type LtxJobStatus = {
  id?: string;
  status: "pending" | "processing" | "completed" | "failed";
  result?: { video_url?: string };
  error?: unknown;
};

async function parseJsonResponse(response: Response, label: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${label} returned non-JSON response (${response.status})`);
  }
  if (!response.ok) {
    const message = JSON.stringify(data).slice(0, 600);
    throw new Error(`${label} failed (${response.status}): ${message}`);
  }
  return data;
}

export class LtxClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = "https://api.ltx.video",
  ) {}

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async submitTextToVideo(job: VideoBountyJob): Promise<{ id: string; createdAt?: string }> {
    const response = await this.fetchImpl(`${this.baseUrl}/v2/text-to-video`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        prompt: job.prompt,
        model: job.model,
        duration: job.duration,
        resolution: job.resolution,
        fps: job.fps,
        generate_audio: job.generateAudio,
      }),
    });
    const data = await parseJsonResponse(response, "LTX submit");
    if (typeof data.id !== "string" || data.id.length === 0) {
      throw new Error("LTX submit response did not include a job id");
    }
    return {
      id: data.id,
      createdAt: typeof data.created_at === "string" ? data.created_at : undefined,
    };
  }

  async getTextToVideoStatus(id: string): Promise<LtxJobStatus> {
    const response = await this.fetchImpl(`${this.baseUrl}/v2/text-to-video/${encodeURIComponent(id)}`, {
      headers: this.headers(),
    });
    return (await parseJsonResponse(response, "LTX status")) as LtxJobStatus;
  }

  async waitForTextToVideo(
    id: string,
    options?: {
      pollIntervalMs?: number;
      timeoutMs?: number;
      onStatus?: (status: LtxJobStatus["status"]) => void;
    },
  ): Promise<string> {
    const pollIntervalMs = options?.pollIntervalMs ?? 5_000;
    const timeoutMs = options?.timeoutMs ?? 20 * 60_000;
    const startedAt = Date.now();
    let previousStatus: LtxJobStatus["status"] | undefined;

    while (Date.now() - startedAt < timeoutMs) {
      const status = await this.getTextToVideoStatus(id);
      if (status.status !== previousStatus) {
        options?.onStatus?.(status.status);
        previousStatus = status.status;
      }
      if (status.status === "completed") {
        const url = status.result?.video_url;
        if (!url) throw new Error("Completed LTX job did not include result.video_url");
        return url;
      }
      if (status.status === "failed") {
        throw new Error(`LTX generation failed: ${JSON.stringify(status.error ?? "unknown error")}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`LTX job ${id} did not finish within ${Math.round(timeoutMs / 1000)} seconds`);
  }

  async downloadVideo(url: string, outputPath: string): Promise<void> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new Error("LTX result URL must use HTTPS");
    }
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`LTX video download failed (${response.status})`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 1_024) {
      throw new Error("LTX video download was unexpectedly small");
    }
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, bytes);
  }
}
