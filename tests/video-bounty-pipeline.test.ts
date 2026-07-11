import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateVideoBountyJob } from "../tools/video-bounty/job";
import { LtxClient } from "../tools/video-bounty/ltx-client";
import { evaluateProfitability } from "../tools/video-bounty/pricing";
import { verifyCreativeApproval } from "../tools/video-bounty/taskmarket";

const job = validateVideoBountyJob({
  taskId: `0x${"1".repeat(64)}`,
  title: "A funded test task",
  expectedNetRewardUsd: 7.4,
  minimumProfitAfterGenerationUsd: 5,
  maximumGenerationCostUsd: 0.8,
  provider: "ltx",
  model: "ltx-2-3-pro",
  duration: 10,
  resolution: "1920x1080",
  fps: 24,
  generateAudio: true,
  posterTimeSeconds: 7.5,
  credit: "Built for Taskmarket",
  prompt: "A detailed chronological cinematic prompt with genuine motion and synchronized sound throughout the shot.",
  soundVibe: "warm electrical ambience",
  disclosure: "AI-generated video and audio.",
  researchSources: ["https://example.com/source"],
});

test("profit guard prices a 10-second LTX-2.3 Pro job and preserves five dollars", () => {
  assert.deepEqual(evaluateProfitability(job), {
    generationCostUsd: 0.8,
    expectedProfitAfterGenerationUsd: 6.6,
    pricePerSecondUsd: 0.08,
  });
});

test("profit guard rejects a bounty that cannot retain five dollars", () => {
  assert.throws(
    () => evaluateProfitability({ ...job, expectedNetRewardUsd: 5.5 }),
    /below minimum/,
  );
});

test("job validation rejects unsupported Pro duration", () => {
  assert.throws(() => validateVideoBountyJob({ ...job, duration: 20 }), /not supported/);
});

test("LTX client submits, polls, and returns the completed video URL", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let polls = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ id: "job-123", created_at: "2026-07-10T00:00:00Z" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    polls += 1;
    return new Response(
      JSON.stringify(
        polls === 1
          ? { id: "job-123", status: "processing" }
          : { id: "job-123", status: "completed", result: { video_url: "https://cdn.example/video.mp4" } },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const client = new LtxClient("secret-key", fakeFetch, "https://api.example");
  const submitted = await client.submitTextToVideo(job);
  assert.equal(submitted.id, "job-123");
  const url = await client.waitForTextToVideo(submitted.id, { pollIntervalMs: 1, timeoutMs: 100 });
  assert.equal(url, "https://cdn.example/video.mp4");
  assert.equal(requests[0].url, "https://api.example/v2/text-to-video");
  const body = JSON.parse(String(requests[0].init?.body));
  assert.deepEqual(body, {
    prompt: job.prompt,
    model: "ltx-2-3-pro",
    duration: 10,
    resolution: "1920x1080",
    fps: 24,
    generate_audio: true,
  });
});

test("creative approval must match the artifact manifest and clear every score", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "five-creative-approval-"));
  const manifestPath = path.join(directory, "artifact-manifest.json");
  const manifest = '{"taskId":"test"}\n';
  await writeFile(manifestPath, manifest);
  const hash = createHash("sha256").update(manifest).digest("hex");
  await writeFile(
    path.join(directory, "creative-approval.json"),
    JSON.stringify({
      approved: true,
      reviewer: "FIVE",
      artifactManifestSha256: hash,
      reviewedAt: "2026-07-10T00:00:00Z",
      scores: { briefAdherence: 8, realism: 7, motionTruth: 9, posterFrame: 8, wow: 7 },
      blockers: [],
      note: "Reviewed against the exact task brief.",
    }),
  );
  const approval = await verifyCreativeApproval(directory, manifestPath);
  assert.equal(approval.approved, true);

  await writeFile(
    path.join(directory, "creative-approval.json"),
    JSON.stringify({ ...approval, scores: { ...approval.scores, realism: 6 } }),
  );
  await assert.rejects(() => verifyCreativeApproval(directory, manifestPath), /at least 7/);
});
