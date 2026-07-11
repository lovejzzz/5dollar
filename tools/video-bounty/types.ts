export type LtxModel = "ltx-2-3-fast" | "ltx-2-3-pro";
export type LtxResolution =
  | "1920x1080"
  | "1080x1920"
  | "2560x1440"
  | "1440x2560"
  | "3840x2160"
  | "2160x3840";

export type VideoBountyJob = {
  taskId: string;
  title: string;
  expectedNetRewardUsd: number;
  minimumProfitAfterGenerationUsd: number;
  maximumGenerationCostUsd: number;
  provider: "ltx";
  model: LtxModel;
  duration: number;
  resolution: LtxResolution;
  fps: 24 | 25 | 48 | 50;
  generateAudio: boolean;
  posterTimeSeconds: number;
  credit: string;
  prompt: string;
  soundVibe: string;
  disclosure: string;
  researchSources: string[];
  workspaceDir?: string;
};

export type Profitability = {
  generationCostUsd: number;
  expectedProfitAfterGenerationUsd: number;
  pricePerSecondUsd: number;
};

export type VideoProbe = {
  durationSeconds: number;
  sizeBytes: number;
  video: {
    codec: string;
    width: number;
    height: number;
    fps: number;
  };
  audio: null | {
    codec: string;
    channels: number;
    sampleRate: number;
  };
};

export type VideoQaReport = {
  passed: boolean;
  probe: VideoProbe;
  expectedFrames: number;
  retainedMotionFrames: number;
  retainedMotionRatio: number;
  audioMeanVolumeDb: number | null;
  audioMaxVolumeDb: number | null;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
};

export type CreativeApproval = {
  approved: true;
  reviewer: string;
  artifactManifestSha256: string;
  reviewedAt: string;
  scores: {
    briefAdherence: number;
    realism: number;
    motionTruth: number;
    posterFrame: number;
    wow: number;
  };
  blockers: [];
  note: string;
};
