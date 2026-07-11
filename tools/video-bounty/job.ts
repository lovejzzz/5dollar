import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LtxModel, LtxResolution, VideoBountyJob } from "./types";

const taskIdPattern = /^0x[0-9a-fA-F]{64}$/;
const models = new Set<LtxModel>(["ltx-2-3-fast", "ltx-2-3-pro"]);
const resolutions = new Set<LtxResolution>([
  "1920x1080",
  "1080x1920",
  "2560x1440",
  "1440x2560",
  "3840x2160",
  "2160x3840",
]);

function finitePositive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
}

export function validateVideoBountyJob(input: unknown): VideoBountyJob {
  if (!input || typeof input !== "object") {
    throw new Error("Job must be a JSON object");
  }

  const job = input as Record<string, unknown>;
  if (typeof job.taskId !== "string" || !taskIdPattern.test(job.taskId)) {
    throw new Error("taskId must be a 0x-prefixed 32-byte hex string");
  }
  if (typeof job.title !== "string" || job.title.trim().length < 3) {
    throw new Error("title is required");
  }
  if (job.provider !== "ltx") {
    throw new Error("provider must be ltx");
  }
  if (!models.has(job.model as LtxModel)) {
    throw new Error("model must be ltx-2-3-fast or ltx-2-3-pro");
  }
  if (!resolutions.has(job.resolution as LtxResolution)) {
    throw new Error("resolution is not supported by LTX-2.3");
  }

  const duration = finitePositive(job.duration, "duration");
  const allowedDurations =
    job.model === "ltx-2-3-fast" &&
    (job.resolution === "1920x1080" || job.resolution === "1080x1920") &&
    (job.fps === 24 || job.fps === 25)
      ? new Set([6, 8, 10, 12, 14, 16, 18, 20])
      : new Set([6, 8, 10]);
  if (!allowedDurations.has(duration)) {
    throw new Error(`duration ${duration} is not supported for this model, resolution, and fps`);
  }

  if (![24, 25, 48, 50].includes(job.fps as number)) {
    throw new Error("fps must be 24, 25, 48, or 50");
  }
  if (typeof job.generateAudio !== "boolean") {
    throw new Error("generateAudio must be boolean");
  }
  if (typeof job.prompt !== "string" || job.prompt.trim().length < 20 || job.prompt.length > 5000) {
    throw new Error("prompt must contain 20 to 5000 characters");
  }
  if (typeof job.credit !== "string" || job.credit.trim().length === 0) {
    throw new Error("credit is required");
  }
  if (typeof job.soundVibe !== "string" || job.soundVibe.trim().length === 0) {
    throw new Error("soundVibe is required");
  }
  if (typeof job.disclosure !== "string" || job.disclosure.trim().length === 0) {
    throw new Error("disclosure is required");
  }
  if (!Array.isArray(job.researchSources) || job.researchSources.some((item) => typeof item !== "string")) {
    throw new Error("researchSources must be an array of URLs");
  }

  finitePositive(job.expectedNetRewardUsd, "expectedNetRewardUsd");
  finitePositive(job.minimumProfitAfterGenerationUsd, "minimumProfitAfterGenerationUsd");
  finitePositive(job.maximumGenerationCostUsd, "maximumGenerationCostUsd");
  const posterTime = finitePositive(job.posterTimeSeconds, "posterTimeSeconds");
  if (posterTime >= duration) {
    throw new Error("posterTimeSeconds must be earlier than duration");
  }

  return job as VideoBountyJob;
}

export async function loadVideoBountyJob(jobPath: string): Promise<VideoBountyJob> {
  const raw = await readFile(jobPath, "utf8");
  return validateVideoBountyJob(JSON.parse(raw));
}

export function resolveWorkspaceDir(job: VideoBountyJob, cwd = process.cwd()): string {
  return path.resolve(cwd, job.workspaceDir ?? `.context/taskmarket/${job.taskId}`);
}
