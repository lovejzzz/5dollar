import type { LtxModel, LtxResolution, Profitability, VideoBountyJob } from "./types";

export const LTX_PRICING_SNAPSHOT_DATE = "2026-07-10";
export const LTX_PRICING_SOURCE = "https://docs.ltx.video/pricing";

const pricePerSecond: Record<LtxModel, Record<LtxResolution, number>> = {
  "ltx-2-3-fast": {
    "1920x1080": 0.06,
    "1080x1920": 0.06,
    "2560x1440": 0.12,
    "1440x2560": 0.12,
    "3840x2160": 0.24,
    "2160x3840": 0.24,
  },
  "ltx-2-3-pro": {
    "1920x1080": 0.08,
    "1080x1920": 0.08,
    "2560x1440": 0.16,
    "1440x2560": 0.16,
    "3840x2160": 0.32,
    "2160x3840": 0.32,
  },
};

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function evaluateProfitability(job: VideoBountyJob): Profitability {
  const unitPrice = pricePerSecond[job.model][job.resolution];
  const generationCostUsd = money(unitPrice * job.duration);
  const expectedProfitAfterGenerationUsd = money(job.expectedNetRewardUsd - generationCostUsd);

  if (generationCostUsd > job.maximumGenerationCostUsd + Number.EPSILON) {
    throw new Error(
      `Generation cost $${generationCostUsd.toFixed(2)} exceeds job cap $${job.maximumGenerationCostUsd.toFixed(2)}`,
    );
  }
  if (expectedProfitAfterGenerationUsd < job.minimumProfitAfterGenerationUsd - Number.EPSILON) {
    throw new Error(
      `Expected profit $${expectedProfitAfterGenerationUsd.toFixed(2)} is below minimum $${job.minimumProfitAfterGenerationUsd.toFixed(2)}`,
    );
  }

  return {
    generationCostUsd,
    expectedProfitAfterGenerationUsd,
    pricePerSecondUsd: unitPrice,
  };
}
