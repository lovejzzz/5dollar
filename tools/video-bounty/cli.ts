#!/usr/bin/env node
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadVideoBountyJob, resolveWorkspaceDir } from "./job";
import { readLtxApiKey } from "./keychain";
import { generateWithOfficialLocalLtx, OFFICIAL_LTX_COMMIT } from "./local-ltx";
import { LtxClient } from "./ltx-client";
import { packageVideo, qaVideo } from "./media";
import { evaluateProfitability, LTX_PRICING_SNAPSHOT_DATE, LTX_PRICING_SOURCE } from "./pricing";
import { submitToTaskmarket } from "./taskmarket";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function usage(): never {
  console.error(`Usage:
  npm run video:bounty -- estimate --job <job.json>
  npm run video:bounty -- local-estimate --job <job.json>
  npm run video:bounty -- local-generate --job <job.json> --confirm-electricity-only
  npm run video:bounty -- local-run --job <job.json> --confirm-electricity-only
  npm run video:bounty -- generate --job <job.json> --confirm-cost-usd <amount>
  npm run video:bounty -- package --job <job.json> --input <source.mp4>
  npm run video:bounty -- qa --job <job.json> --input <final.mp4>
  npm run video:bounty -- submit --job <job.json>
  npm run video:bounty -- run --job <job.json> --confirm-cost-usd <amount> [--submit]
`);
  process.exit(2);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const jobPath = option("--job");
  if (!command || !jobPath) usage();
  const job = await loadVideoBountyJob(path.resolve(jobPath));
  const workspaceDir = resolveWorkspaceDir(job);
  const profitability = evaluateProfitability(job);

  if (command === "estimate") {
    console.log(
      JSON.stringify(
        {
          taskId: job.taskId,
          model: job.model,
          resolution: job.resolution,
          duration: job.duration,
          ...profitability,
          pricingSnapshotDate: LTX_PRICING_SNAPSHOT_DATE,
          pricingSource: LTX_PRICING_SOURCE,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "local-estimate") {
    console.log(
      JSON.stringify(
        {
          taskId: job.taskId,
          backend: `Lightricks/LTX-Video@${OFFICIAL_LTX_COMMIT} ltxv-2b-0.9.8-distilled on Apple MPS`,
          generationCostUsd: 0,
          expectedProfitAfterGenerationUsd: job.expectedNetRewardUsd,
          electricityExcluded: true,
          defaultLocalResolution: job.resolution.endsWith("x1920") ? "432x768" : "768x432",
          finalResolution: job.resolution,
        },
        null,
        2,
      ),
    );
    return;
  }

  const input = option("--input");
  if (command === "qa") {
    if (!input) usage();
    const report = qaVideo(job, path.resolve(input));
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
    return;
  }

  if (command === "package") {
    if (!input) usage();
    const packaged = await packageVideo(job, path.resolve(input), workspaceDir);
    console.log(JSON.stringify(packaged, null, 2));
    return;
  }

  if (command === "submit") {
    const evidence = await submitToTaskmarket(
      job,
      {
        finalPath: path.join(workspaceDir, "final.mp4"),
        posterPath: path.join(workspaceDir, "poster-frame.png"),
        notePath: path.join(workspaceDir, "submission-note.txt"),
        manifestPath: path.join(workspaceDir, "artifact-manifest.json"),
      },
      workspaceDir,
    );
    console.log(JSON.stringify(evidence, null, 2));
    return;
  }

  if (command === "local-generate" || command === "local-run") {
    if (!has("--confirm-electricity-only")) {
      throw new Error("Local generation requires --confirm-electricity-only");
    }
    const vertical = job.resolution.endsWith("x1920") || job.resolution.endsWith("x2560") || job.resolution.endsWith("x3840");
    const localWidth = Number(option("--local-width") ?? (vertical ? 432 : 768));
    const localHeight = Number(option("--local-height") ?? (vertical ? 768 : 432));
    const seed = Number(option("--seed") ?? 171198);
    const localSourcePath = path.join(workspaceDir, "ltx-local-source.mp4");
    if (await fileExists(localSourcePath)) {
      throw new Error(`Local source already exists at ${localSourcePath}; refusing to spend electricity twice`);
    }
    const local = await generateWithOfficialLocalLtx(job, workspaceDir, {
      pythonPath: process.env.FIVE_LTX_LOCAL_PYTHON ?? path.resolve(".context/ltx-local/env/bin/python"),
      repositoryDir: process.env.FIVE_LTX_LOCAL_REPO ?? path.resolve(".context/vendor/LTX-Video"),
      configPath: process.env.FIVE_LTX_LOCAL_CONFIG ?? path.resolve("tools/video-bounty/ltxv-2b-0.9.8-local.yaml"),
      width: localWidth,
      height: localHeight,
      seed,
    });
    if (command === "local-generate") {
      console.log(JSON.stringify(local, null, 2));
      return;
    }
    const packaged = await packageVideo(job, local.sourcePath, workspaceDir, local.backend);
    if (has("--submit")) {
      const submission = await submitToTaskmarket(job, packaged, workspaceDir);
      console.log(JSON.stringify({ ...local, ...packaged, submission }, null, 2));
    } else {
      console.log(JSON.stringify({ ...local, ...packaged }, null, 2));
    }
    return;
  }

  if (command !== "generate" && command !== "run") usage();
  const confirmation = Number(option("--confirm-cost-usd"));
  if (!Number.isFinite(confirmation) || Math.abs(confirmation - profitability.generationCostUsd) > 0.001) {
    throw new Error(
      `Generation requires --confirm-cost-usd ${profitability.generationCostUsd.toFixed(2)} for this exact job`,
    );
  }
  await mkdir(workspaceDir, { recursive: true });
  const sourcePath = path.join(workspaceDir, "ltx-source.mp4");
  const jobEvidencePath = path.join(workspaceDir, "ltx-job.json");
  if (await fileExists(sourcePath)) {
    throw new Error(`Source already exists at ${sourcePath}; refusing to spend twice`);
  }

  const client = new LtxClient(readLtxApiKey());
  const submitted = await client.submitTextToVideo(job);
  await writeFile(
    jobEvidencePath,
    `${JSON.stringify({ ...submitted, taskId: job.taskId, expectedCostUsd: profitability.generationCostUsd }, null, 2)}\n`,
    "utf8",
  );
  console.error(`LTX job ${submitted.id}: submitted`);
  const resultUrl = await client.waitForTextToVideo(submitted.id, {
    onStatus: (status) => console.error(`LTX job ${submitted.id}: ${status}`),
  });
  await client.downloadVideo(resultUrl, sourcePath);
  console.error(`Downloaded ${sourcePath}`);
  if (command === "generate") {
    console.log(JSON.stringify({ sourcePath, ...submitted }, null, 2));
    return;
  }

  const packaged = await packageVideo(job, sourcePath, workspaceDir);
  if (has("--submit")) {
    const submission = await submitToTaskmarket(job, packaged, workspaceDir);
    console.log(JSON.stringify({ ...packaged, submission }, null, 2));
  } else {
    console.log(JSON.stringify(packaged, null, 2));
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`video-bounty: ${message}`);
  process.exitCode = 1;
});
