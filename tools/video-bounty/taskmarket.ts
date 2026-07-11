import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CreativeApproval, VideoBountyJob } from "./types";

type TaskmarketEnvelope<T> = { ok: boolean; data?: T; error?: string };

function runTaskmarket(args: string[]): string {
  const result = spawnSync("taskmarket", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`taskmarket ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(0, 1200)}`);
  }
  return result.stdout;
}

function parseEnvelope<T>(raw: string, label: string): TaskmarketEnvelope<T> {
  const envelope = JSON.parse(raw) as TaskmarketEnvelope<T>;
  if (!envelope.ok || envelope.data === undefined) {
    throw new Error(`${label} failed: ${envelope.error ?? "missing data"}`);
  }
  return envelope;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function verifyCreativeApproval(
  workspaceDir: string,
  manifestPath: string,
): Promise<CreativeApproval> {
  const approvalPath = path.join(workspaceDir, "creative-approval.json");
  if (!(await exists(approvalPath))) {
    throw new Error(
      `Creative approval is required before submission. Review poster-frame.png and contact-sheet.png, then write ${approvalPath}`,
    );
  }
  const approval = JSON.parse(await readFile(approvalPath, "utf8")) as Partial<CreativeApproval>;
  const manifestHash = createHash("sha256").update(await readFile(manifestPath)).digest("hex");
  if (approval.approved !== true || approval.artifactManifestSha256 !== manifestHash) {
    throw new Error("Creative approval is absent, rejected, or does not match the current artifact manifest");
  }
  if (!approval.scores || Object.values(approval.scores).some((score) => typeof score !== "number" || score < 7)) {
    throw new Error("Every creative approval score must be at least 7/10");
  }
  if (!Array.isArray(approval.blockers) || approval.blockers.length !== 0) {
    throw new Error("Creative approval still contains blocking issues");
  }
  if (typeof approval.reviewer !== "string" || !approval.reviewer || typeof approval.note !== "string") {
    throw new Error("Creative approval must identify the reviewer and include a note");
  }
  return approval as CreativeApproval;
}

export async function submitToTaskmarket(
  job: VideoBountyJob,
  files: { finalPath: string; posterPath: string; notePath: string; manifestPath: string },
  workspaceDir: string,
): Promise<Record<string, unknown>> {
  const evidencePath = path.join(workspaceDir, "taskmarket-submission.json");
  if (await exists(evidencePath)) {
    throw new Error(`Submission evidence already exists at ${evidencePath}; refusing to submit twice`);
  }
  await verifyCreativeApproval(workspaceDir, files.manifestPath);

  const preflight = parseEnvelope<{
    id: string;
    status: string;
    reward: string;
    submissionCount: number;
    submissionWindowOpen: boolean;
    pendingActions: Array<{ role: string; action: string; command: string }>;
  }>(runTaskmarket(["task", "get", job.taskId]), "Taskmarket preflight").data!;
  if (preflight.id !== job.taskId || preflight.status !== "open" || !preflight.submissionWindowOpen) {
    throw new Error("Taskmarket task is not open for submissions");
  }
  const submitAction = preflight.pendingActions.find(
    (action) => action.role === "worker" && action.action === "submit",
  );
  if (!submitAction || !submitAction.command.includes(job.taskId)) {
    throw new Error("Taskmarket worker submit action is not currently available");
  }

  const submission = parseEnvelope<{ submissionId: string }>(
    runTaskmarket([
      "task",
      "submit",
      job.taskId,
      "--file",
      files.finalPath,
      "--file",
      files.posterPath,
      "--file",
      files.notePath,
    ]),
    "Taskmarket submit",
  ).data!;
  if (!submission.submissionId) throw new Error("Taskmarket did not return a submissionId");

  const postflight = parseEnvelope<{ submissionCount: number }>(
    runTaskmarket(["task", "get", job.taskId]),
    "Taskmarket postflight",
  ).data!;
  if (postflight.submissionCount !== preflight.submissionCount + 1) {
    throw new Error(
      `Taskmarket submission count did not increase exactly once (${preflight.submissionCount} -> ${postflight.submissionCount})`,
    );
  }

  const address = parseEnvelope<{ address: string }>(runTaskmarket(["address"]), "Taskmarket address").data!
    .address;
  const submissions = parseEnvelope<Array<{ id?: string; submissionId?: string; worker?: string; workerAddress?: string }>>(
    runTaskmarket(["task", "submissions", job.taskId]),
    "Taskmarket submissions",
  ).data!;
  const verified = submissions.some((item) => {
    const id = item.id ?? item.submissionId;
    const worker = item.worker ?? item.workerAddress;
    return id === submission.submissionId && worker?.toLowerCase() === address.toLowerCase();
  });
  if (!verified) throw new Error("Taskmarket submission was not visible under the worker wallet");

  const evidence = {
    taskId: job.taskId,
    network: "Base mainnet",
    action: "submit",
    workerAddress: address,
    submissionId: submission.submissionId,
    submissionCountBefore: preflight.submissionCount,
    submissionCountAfter: postflight.submissionCount,
    verified,
    createdAt: new Date().toISOString(),
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidence;
}
