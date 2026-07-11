import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { VideoBountyJob, VideoProbe, VideoQaReport } from "./types";

type CommandResult = { stdout: string; stderr: string };

function run(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim().slice(0, 1200)}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function parseFrameRate(value: string): number {
  const [numerator, denominator] = value.split("/").map(Number);
  return denominator ? numerator / denominator : numerator;
}

export function probeVideo(inputPath: string): VideoProbe {
  const result = run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration,size:stream=index,codec_name,codec_type,width,height,avg_frame_rate,sample_rate,channels",
    "-of",
    "json",
    inputPath,
  ]);
  const data = JSON.parse(result.stdout) as {
    streams: Array<Record<string, string | number>>;
    format: Record<string, string>;
  };
  const video = data.streams.find((stream) => stream.codec_type === "video");
  const audio = data.streams.find((stream) => stream.codec_type === "audio");
  if (!video) throw new Error("Video file has no video stream");
  return {
    durationSeconds: Number(data.format.duration),
    sizeBytes: Number(data.format.size),
    video: {
      codec: String(video.codec_name),
      width: Number(video.width),
      height: Number(video.height),
      fps: parseFrameRate(String(video.avg_frame_rate)),
    },
    audio: audio
      ? {
          codec: String(audio.codec_name),
          channels: Number(audio.channels),
          sampleRate: Number(audio.sample_rate),
        }
      : null,
  };
}

function retainedMotionFrames(inputPath: string): number {
  const result = run("ffmpeg", [
    "-hide_banner",
    "-i",
    inputPath,
    "-vf",
    "mpdecimate",
    "-an",
    "-f",
    "null",
    "-",
  ]);
  const matches = [...result.stderr.matchAll(/frame=\s*(\d+)/g)];
  if (matches.length === 0) throw new Error("Unable to read mpdecimate frame count");
  return Number(matches.at(-1)?.[1]);
}

function audioVolumes(inputPath: string): { mean: number | null; max: number | null } {
  const result = run("ffmpeg", [
    "-hide_banner",
    "-i",
    inputPath,
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]);
  const mean = result.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
  const max = result.stderr.match(/max_volume:\s*(-?[\d.]+) dB/);
  return {
    mean: mean ? Number(mean[1]) : null,
    max: max ? Number(max[1]) : null,
  };
}

export function qaVideo(job: VideoBountyJob, inputPath: string): VideoQaReport {
  const probe = probeVideo(inputPath);
  const [expectedWidth, expectedHeight] = job.resolution.split("x").map(Number);
  const expectedFrames = Math.round(probe.durationSeconds * probe.video.fps);
  const motionFrames = retainedMotionFrames(inputPath);
  const motionRatio = expectedFrames > 0 ? motionFrames / expectedFrames : 0;
  const volumes = job.generateAudio ? audioVolumes(inputPath) : { mean: null, max: null };
  const checks = [
    {
      name: "resolution",
      passed: probe.video.width === expectedWidth && probe.video.height === expectedHeight,
      detail: `${probe.video.width}x${probe.video.height}; expected ${job.resolution}`,
    },
    {
      name: "duration",
      passed: Math.abs(probe.durationSeconds - job.duration) <= 0.6,
      detail: `${probe.durationSeconds.toFixed(3)}s; expected ${job.duration}s ±0.6s`,
    },
    {
      name: "frame-rate",
      passed: Math.abs(probe.video.fps - job.fps) <= 0.1,
      detail: `${probe.video.fps.toFixed(3)}fps; expected ${job.fps}fps`,
    },
    {
      name: "real-motion",
      passed: motionRatio >= 0.35,
      detail: `${motionFrames}/${expectedFrames} frames retained (${(motionRatio * 100).toFixed(1)}%)`,
    },
    {
      name: "audio-stream",
      passed: !job.generateAudio || probe.audio !== null,
      detail: probe.audio ? `${probe.audio.codec}, ${probe.audio.channels}ch, ${probe.audio.sampleRate}Hz` : "absent",
    },
    {
      name: "audible-level",
      passed: !job.generateAudio || (volumes.max !== null && volumes.max > -55),
      detail: volumes.max === null ? "not measured" : `mean ${volumes.mean}dB, max ${volumes.max}dB`,
    },
  ];
  return {
    passed: checks.every((check) => check.passed),
    probe,
    expectedFrames,
    retainedMotionFrames: motionFrames,
    retainedMotionRatio: motionRatio,
    audioMeanVolumeDb: volumes.mean,
    audioMaxVolumeDb: volumes.max,
    checks,
  };
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export async function packageVideo(
  job: VideoBountyJob,
  sourcePath: string,
  workspaceDir: string,
): Promise<{
  finalPath: string;
  posterPath: string;
  contactSheetPath: string;
  notePath: string;
  qaPath: string;
  manifestPath: string;
}> {
  await mkdir(workspaceDir, { recursive: true });
  const overlayPath = path.join(workspaceDir, "credit-overlay.png");
  const finalPath = path.join(workspaceDir, "final.mp4");
  const posterPath = path.join(workspaceDir, "poster-frame.png");
  const contactSheetPath = path.join(workspaceDir, "contact-sheet.png");
  const notePath = path.join(workspaceDir, "submission-note.txt");
  const qaPath = path.join(workspaceDir, "qa-report.json");
  const manifestPath = path.join(workspaceDir, "artifact-manifest.json");
  const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "render-credit.py");
  const font = run("fc-match", ["-f", "%{file}\n", "Arial"]).stdout.trim().split("\n")[0];
  if (!font) throw new Error("No usable font found for the credit overlay");

  run("python3", [
    helperPath,
    "--text",
    job.credit,
    "--font",
    font,
    "--output",
    overlayPath,
    "--font-size",
    job.resolution.startsWith("3840") || job.resolution.startsWith("2160") ? "42" : "28",
  ]);
  run("ffmpeg", [
    "-loglevel",
    "error",
    "-i",
    sourcePath,
    "-loop",
    "1",
    "-i",
    overlayPath,
    "-filter_complex",
    "[0:v][1:v]overlay=40:H-h-36:shortest=1",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "16",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    "-y",
    finalPath,
  ]);
  run("ffmpeg", [
    "-loglevel",
    "error",
    "-ss",
    String(job.posterTimeSeconds),
    "-i",
    finalPath,
    "-frames:v",
    "1",
    "-y",
    posterPath,
  ]);
  run("ffmpeg", [
    "-loglevel",
    "error",
    "-i",
    finalPath,
    "-vf",
    `fps=5/${job.duration},scale=640:-1,tile=5x1`,
    "-frames:v",
    "1",
    "-y",
    contactSheetPath,
  ]);

  const note = [
    `Title: ${job.title}`,
    "",
    `Model: Lightricks ${job.model}.`,
    `Sound vibe: ${job.soundVibe}`,
    `AI disclosure: ${job.disclosure}`,
    ...job.researchSources.map((source) => `Source: ${source}`),
    "",
    `${job.credit}.`,
    "",
  ].join("\n");
  await writeFile(notePath, note, "utf8");

  const qa = qaVideo(job, finalPath);
  await writeFile(qaPath, `${JSON.stringify(qa, null, 2)}\n`, "utf8");
  if (!qa.passed) {
    throw new Error(`Packaged video failed QA; see ${qaPath}`);
  }

  const artifacts = await Promise.all(
    [finalPath, posterPath, notePath].map(async (file) => ({
      file: path.basename(file),
      sha256: await sha256(file),
    })),
  );
  await writeFile(
    manifestPath,
    `${JSON.stringify({ taskId: job.taskId, model: job.model, artifacts }, null, 2)}\n`,
    "utf8",
  );
  return { finalPath, posterPath, contactSheetPath, notePath, qaPath, manifestPath };
}
