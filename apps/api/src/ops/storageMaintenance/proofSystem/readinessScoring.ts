import type {
  BuildCacheAnalysis,
  ConfidenceLabel,
  DependencyGraphSummary,
  SafetyGateResult,
  SnapshotStatus,
  StorageScanSnapshot,
} from "../types";

export type ReadinessResult = {
  readinessScorePct: number;
  readinessLabel: "READY_FOR_REVIEW" | "BLOCKED" | "HIGH_RISK" | "INCOMPLETE";
  readinessDetail: string;
};

export function computeReadinessScore(input: {
  scan: StorageScanSnapshot;
  buildCache: BuildCacheAnalysis;
  dependencyGraph: DependencyGraphSummary;
  snapshotStatus: SnapshotStatus;
  safetyGates: SafetyGateResult;
  avgConfidencePct: number;
}): ReadinessResult {
  let score = 100;
  const deductions: string[] = [];

  if (input.buildCache.unknownBytes > 0) {
    score -= 25;
    deductions.push("build cache unknown bytes");
  }
  if (input.scan.unknownCount > 0) {
    score -= Math.min(30, input.scan.unknownCount * 2);
    deductions.push(`${input.scan.unknownCount} unknown inventory items`);
  }
  if (input.dependencyGraph.incomplete) {
    score -= 20;
    deductions.push("incomplete dependency graph");
  }
  if (!input.snapshotStatus.available) {
    score -= 15;
    deductions.push("no preflight snapshot");
  }
  if (input.safetyGates.blocked) {
    score -= 20;
    deductions.push("safety gates blocked");
  }
  if (input.avgConfidencePct < 95) {
    score -= Math.round((95 - input.avgConfidencePct) / 2);
    deductions.push("average confidence below 95%");
  }

  score = Math.max(0, Math.min(100, score));

  let readinessLabel: ReadinessResult["readinessLabel"] = "READY_FOR_REVIEW";
  if (score < 40) readinessLabel = "HIGH_RISK";
  else if (score < 70 || input.safetyGates.blocked) readinessLabel = "BLOCKED";
  else if (input.dependencyGraph.incomplete || input.buildCache.unknownBytes > 0) readinessLabel = "INCOMPLETE";

  const readinessDetail =
    deductions.length > 0
      ? `Informational only — ${deductions.join("; ")}`
      : "Informational only — evidence complete, no execution enabled";

  return { readinessScorePct: score, readinessLabel, readinessDetail };
}

export function averageConfidence(labels: Array<{ confidencePct: number; confidenceLabel: ConfidenceLabel }>): number {
  const eligible = labels.filter((l) => l.confidenceLabel !== "BLOCKED");
  if (!eligible.length) return 0;
  return eligible.reduce((s, l) => s + l.confidencePct, 0) / eligible.length;
}
