export type FundedTaskSpec = {
  taskType: "dataset_summary";
  title: string;
  instructions: string;
  input: unknown;
  rewardCents: number;
  sponsorReference: string;
  fundingCaptureId: string;
  automationAllowed: true;
  autoAccept: true;
  acceptance: {
    requiredEvidenceIds: string[];
    minEvidenceCount?: number;
  };
  minAnswerChars?: number;
};

const PROHIBITED_TASK_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /fake\s+(review|rating|testimonial)/i, label: "fake reviews" },
  { pattern: /spam|mass\s*(email|message|dm)/i, label: "spam" },
  { pattern: /impersonat|pretend\s+to\s+be/i, label: "impersonation" },
  { pattern: /gambl|sports?\s*bet|casino/i, label: "gambling" },
  { pattern: /trade\s+(crypto|stock)|crypto\s+arbitrage/i, label: "financial trading" },
  { pattern: /buy|purchase|place\s+an\s+order/i, label: "purchases" },
  { pattern: /password|one[- ]time\s+code|\botp\b|login\s+credential/i, label: "credentials" },
  { pattern: /click\s+(an?\s+)?ad|ad\s+click/i, label: "ad manipulation" },
  { pattern: /harass|threaten|doxx/i, label: "harassment" },
  { pattern: /vote\s+(for|against)|ballot/i, label: "political manipulation" },
  { pattern: /scrape\s+(personal|private)|steal\s+data/i, label: "private-data collection" },
];

export type ValidatedFundedTask = {
  taskType: "dataset_summary";
  title: string;
  instructions: string;
  inputJson: string;
  acceptanceJson: string;
  rewardCents: number;
  payoutCents: 500;
  sponsorReference: string;
  fundingCaptureId: string;
  automationAllowed: 1;
  autoAccept: 1;
  minAnswerChars: number;
};

type AcceptanceContract = {
  requiredEvidenceIds: string[];
  minEvidenceCount: number;
};

const SAFE_EVIDENCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
const REFUSAL_OR_LIMITATION =
  /\b(cannot|can't|unable|insufficient|not enough|no supplied|not provided|refus(?:e|ed|al)|not possible|as an ai)\b/i;

function collectInputIds(value: unknown, ids: Set<string>, depth = 0) {
  if (depth > 20 || ids.size > 500) return;
  if (Array.isArray(value)) {
    for (const item of value) collectInputIds(item, ids, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, item] of Object.entries(value)) {
    if (key === "id" && typeof item === "string" && SAFE_EVIDENCE_ID.test(item)) {
      ids.add(item);
    }
    collectInputIds(item, ids, depth + 1);
  }
}

function validateAcceptanceContract(
  value: unknown,
  input: unknown,
): AcceptanceContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A deterministic evidence acceptance contract is required.");
  }
  const raw = value as Partial<FundedTaskSpec["acceptance"]>;
  if (
    !Array.isArray(raw.requiredEvidenceIds) ||
    raw.requiredEvidenceIds.length < 1 ||
    raw.requiredEvidenceIds.length > 50
  ) {
    throw new Error("acceptance.requiredEvidenceIds must contain 1-50 source IDs.");
  }

  const requiredEvidenceIds = [...new Set(raw.requiredEvidenceIds.map((id) => id.trim()))];
  if (
    requiredEvidenceIds.length !== raw.requiredEvidenceIds.length ||
    requiredEvidenceIds.some((id) => !SAFE_EVIDENCE_ID.test(id))
  ) {
    throw new Error("Acceptance evidence IDs must be unique safe source identifiers.");
  }

  const availableIds = new Set<string>();
  collectInputIds(input, availableIds);
  const missing = requiredEvidenceIds.filter((id) => !availableIds.has(id));
  if (missing.length > 0) {
    throw new Error(
      "Every required acceptance evidence ID must exist in the supplied task input.",
    );
  }

  const minEvidenceCount = raw.minEvidenceCount ?? requiredEvidenceIds.length;
  if (
    !Number.isInteger(minEvidenceCount) ||
    minEvidenceCount < 1 ||
    minEvidenceCount > 50
  ) {
    throw new Error("acceptance.minEvidenceCount must be an integer from 1 to 50.");
  }
  return { requiredEvidenceIds, minEvidenceCount };
}

export function submissionPassesAcceptance(input: {
  acceptanceJson: string;
  minAnswerChars: number;
  submission: unknown;
}) {
  let contract: AcceptanceContract;
  try {
    contract = JSON.parse(input.acceptanceJson) as AcceptanceContract;
  } catch {
    return false;
  }
  if (!input.submission || typeof input.submission !== "object") return false;
  const submission = input.submission as Record<string, unknown>;
  const answer = typeof submission.answer === "string" ? submission.answer.trim() : "";
  const evidence = Array.isArray(submission.evidence)
    ? submission.evidence.filter((entry): entry is string => typeof entry === "string")
    : [];
  const qualityNotes = Array.isArray(submission.qualityNotes)
    ? submission.qualityNotes.filter((entry): entry is string => typeof entry === "string")
    : Array.isArray(submission.quality_notes)
      ? submission.quality_notes.filter((entry): entry is string => typeof entry === "string")
      : [];

  if (
    answer.length < input.minAnswerChars ||
    evidence.length < contract.minEvidenceCount ||
    REFUSAL_OR_LIMITATION.test(answer) ||
    qualityNotes.some((note) => REFUSAL_OR_LIMITATION.test(note))
  ) {
    return false;
  }

  return contract.requiredEvidenceIds.every((requiredId) =>
    evidence.some((entry) => {
      const normalized = entry.trim();
      return (
        normalized === requiredId ||
        normalized.startsWith(`${requiredId}:`) ||
        normalized.startsWith(`[${requiredId}]`)
      );
    }),
  );
}

export function validateFundedTaskSpec(value: unknown): ValidatedFundedTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A funded task must be a JSON object.");
  }

  const task = value as Partial<FundedTaskSpec>;
  if (task.taskType !== "dataset_summary") {
    throw new Error("The first live workflow accepts only dataset_summary tasks.");
  }
  const title = typeof task.title === "string" ? task.title.trim() : "";
  const instructions =
    typeof task.instructions === "string" ? task.instructions.trim() : "";
  const sponsorReference =
    typeof task.sponsorReference === "string" ? task.sponsorReference.trim() : "";

  if (title.length < 5 || title.length > 160) {
    throw new Error("Task title must be between 5 and 160 characters.");
  }
  if (instructions.length < 30 || instructions.length > 6_000) {
    throw new Error("Task instructions must be between 30 and 6,000 characters.");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{4,119}$/.test(sponsorReference)) {
    throw new Error(
      "Sponsor reference must be 5-120 characters using letters, numbers, dots, colons, underscores, or hyphens.",
    );
  }
  if (!Number.isInteger(task.rewardCents) || (task.rewardCents ?? 0) < 600) {
    throw new Error(
      "A task must be pre-funded for at least 600 cents so the $5 reward and execution costs are covered.",
    );
  }
  if (task.automationAllowed !== true) {
    throw new Error("The sponsor must explicitly allow automated completion.");
  }
  if (task.autoAccept !== true) {
    throw new Error(
      "The first live workflow accepts only pre-funded tasks with an explicit automatic-acceptance contract.",
    );
  }
  const fundingCaptureId =
    typeof task.fundingCaptureId === "string" ? task.fundingCaptureId.trim() : "";
  if (!/^[A-Z0-9]{8,40}$/i.test(fundingCaptureId)) {
    throw new Error("A valid PayPal funding capture ID is required.");
  }

  let inputJson: string;
  try {
    inputJson = JSON.stringify(task.input ?? {});
  } catch {
    throw new Error("Task input must be valid JSON data.");
  }
  if (new TextEncoder().encode(inputJson).byteLength > 20_000) {
    throw new Error("Task input is larger than the 20,000-byte limit.");
  }

  const acceptance = validateAcceptanceContract(task.acceptance, task.input ?? {});

  const prohibited = PROHIBITED_TASK_PATTERNS.find(({ pattern }) =>
    pattern.test(`${title}\n${instructions}\n${inputJson}`),
  );
  if (prohibited) {
    throw new Error(`This task appears to involve prohibited ${prohibited.label}.`);
  }

  const minAnswerChars = task.minAnswerChars ?? 120;
  if (
    !Number.isInteger(minAnswerChars) ||
    minAnswerChars < 40 ||
    minAnswerChars > 4_000
  ) {
    throw new Error("minAnswerChars must be an integer between 40 and 4,000.");
  }

  return {
    taskType: "dataset_summary",
    title,
    instructions,
    inputJson,
    acceptanceJson: JSON.stringify(acceptance),
    rewardCents: task.rewardCents as number,
    payoutCents: 500,
    sponsorReference,
    fundingCaptureId,
    automationAllowed: 1,
    autoAccept: 1,
    minAnswerChars,
  };
}
