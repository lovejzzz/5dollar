import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VideoBountyJob } from "./types";

export type LocalLtxOptions = {
  pythonPath: string;
  repositoryDir: string;
  configPath?: string;
  width: number;
  height: number;
  seed: number;
};

export const OFFICIAL_LTX_COMMIT = "4b2d053057623ddd4d0a1d3e9cd28890e9ef487f";

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

export function buildOfficialLtxArgs(
  job: VideoBountyJob,
  outputDir: string,
  options: LocalLtxOptions,
): string[] {
  positiveInteger(options.width, "local width");
  positiveInteger(options.height, "local height");
  positiveInteger(options.seed, "seed");
  const frameCount = positiveInteger(Math.round(job.duration * job.fps), "frame count");
  return [
    path.join(options.repositoryDir, "inference.py"),
    "--prompt",
    job.prompt,
    "--output_path",
    outputDir,
    "--pipeline_config",
    options.configPath ?? path.join(options.repositoryDir, "configs/ltxv-2b-0.9.8-distilled.yaml"),
    "--seed",
    String(options.seed),
    "--height",
    String(options.height),
    "--width",
    String(options.width),
    "--num_frames",
    String(frameCount),
    "--frame_rate",
    String(job.fps),
  ];
}

async function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`));
    });
  });
}

function normalizationArgs(job: VideoBountyJob, rawPath: string, sourcePath: string): string[] {
  const [width, height] = job.resolution.split("x").map(Number);
  const args = ["-loglevel", "error", "-i", rawPath];
  if (job.generateAudio) {
    args.push(
      "-f",
      "lavfi",
      "-t",
      String(job.duration),
      "-i",
      "anoisesrc=color=pink:amplitude=0.025:sample_rate=48000",
    );
  }
  args.push(
    "-vf",
    `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${job.fps}`,
    "-t",
    String(job.duration),
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "16",
    "-pix_fmt",
    "yuv420p",
  );
  if (job.generateAudio) {
    args.push("-c:a", "aac", "-b:a", "160k", "-shortest");
  } else {
    args.push("-an");
  }
  args.push("-movflags", "+faststart", "-y", sourcePath);
  return args;
}

export async function generateWithOfficialLocalLtx(
  job: VideoBountyJob,
  workspaceDir: string,
  options: LocalLtxOptions,
): Promise<{ sourcePath: string; evidencePath: string; backend: string }> {
  const revision = spawnSync("git", ["-C", options.repositoryDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  if (revision.status !== 0 || revision.stdout.trim() !== OFFICIAL_LTX_COMMIT) {
    throw new Error(`Local LTX repository must be pinned to ${OFFICIAL_LTX_COMMIT}`);
  }
  const outputDir = path.join(workspaceDir, "ltx-local-raw");
  const rawPath = path.join(workspaceDir, "ltx-local-raw.mp4");
  const sourcePath = path.join(workspaceDir, "ltx-local-source.mp4");
  const evidencePath = path.join(workspaceDir, "ltx-local-job.json");
  await mkdir(workspaceDir, { recursive: true });
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const args = buildOfficialLtxArgs(job, outputDir, options);
  await run(options.pythonPath, args, {
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    TOKENIZERS_PARALLELISM: "false",
  });
  const generated = (await readdir(outputDir)).filter((name) => name.endsWith(".mp4"));
  if (generated.length !== 1) {
    throw new Error(`Expected exactly one local LTX video, found ${generated.length}`);
  }
  await copyFile(path.join(outputDir, generated[0]), rawPath);
  await run("ffmpeg", normalizationArgs(job, rawPath, sourcePath));

  const evidence = {
    taskId: job.taskId,
    backend: `Lightricks/LTX-Video@${OFFICIAL_LTX_COMMIT} ltxv-2b-0.9.8-distilled on Apple MPS`,
    generationCostUsd: 0,
    electricityExcluded: true,
    generatedAt: new Date().toISOString(),
    localResolution: `${options.width}x${options.height}`,
    finalResolution: job.resolution,
    frameCount: Math.round(job.duration * job.fps),
    fps: job.fps,
    seed: options.seed,
    promptSha256: createHash("sha256").update(job.prompt).digest("hex"),
    audio: job.generateAudio ? "locally synthesized pink-noise ambience" : "none",
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return { sourcePath, evidencePath, backend: evidence.backend };
}
