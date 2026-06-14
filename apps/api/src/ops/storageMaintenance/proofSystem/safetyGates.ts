import type {
  BuildCacheAnalysis,
  CleanupCandidateRow,
  ConfidenceDistributionSlice,
  ConfidenceLabel,
  DependencyGraphSummary,
  SafetyGateResult,
  SnapshotStatus,
  StorageInventoryItem,
  StorageOperationsCenter,
  StorageScanSnapshot,
} from "../types";
import { scoreInventoryItem } from "./confidenceEngine";

export function buildCleanupCandidates(items: StorageInventoryItem[]): CleanupCandidateRow[] {
  return items
    .filter((i) => i.reclaimableBytes != null && i.reclaimableBytes > 0)
    .map((item) => {
      const score = scoreInventoryItem(item);
      return {
        id: item.id,
        label: item.label,
        pathOrRef: item.pathOrRef,
        sizeBytes: item.sizeBytes,
        classification: item.classification,
        confidencePct: score.confidencePct,
        confidenceLabel: score.confidenceLabel,
        kind: item.kind,
      };
    })
    .sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
}

export function buildConfidenceDistribution(
  candidates: CleanupCandidateRow[],
  buildCache: BuildCacheAnalysis,
): ConfidenceDistributionSlice[] {
  const buckets = new Map<ConfidenceLabel, { count: number; sizeBytes: number }>();
  const add = (label: ConfidenceLabel, size: number) => {
    const cur = buckets.get(label) ?? { count: 0, sizeBytes: 0 };
    buckets.set(label, { count: cur.count + 1, sizeBytes: cur.sizeBytes + size });
  };

  for (const c of candidates) add(c.confidenceLabel, c.sizeBytes ?? 0);
  for (const e of buildCache.entries) add(e.confidenceLabel, e.sizeBytes);

  const total = [...buckets.values()].reduce((s, b) => s + b.sizeBytes, 0) || 1;
  const labels: ConfidenceLabel[] = ["SAFE", "LIKELY_SAFE", "REVIEW_REQUIRED", "BLOCKED", "UNKNOWN"];
  return labels
    .filter((l) => buckets.has(l))
    .map((label) => {
      const b = buckets.get(label)!;
      return {
        label,
        count: b.count,
        sizeBytes: b.sizeBytes,
        pct: Math.round((b.sizeBytes / total) * 1000) / 10,
      };
    });
}

export function evaluateSafetyGates(input: {
  scan: StorageScanSnapshot;
  buildCache: BuildCacheAnalysis;
  dependencyGraph: DependencyGraphSummary;
  snapshotStatus: SnapshotStatus;
  candidates: CleanupCandidateRow[];
}): SafetyGateResult {
  const reasons: string[] = [];

  if (input.buildCache.unknownBytes > 0) {
    reasons.push(`build_cache_unknown_bytes:${input.buildCache.unknownBytes}`);
  }
  if (input.scan.unknownCount > 0) {
    reasons.push(`unknown_inventory_items:${input.scan.unknownCount}`);
  }
  if (input.dependencyGraph.incomplete) {
    reasons.push(`dependency_graph_incomplete:${input.dependencyGraph.incompleteReason ?? "unknown"}`);
  }
  if (!input.snapshotStatus.available) {
    reasons.push("preflight_snapshot_missing");
  }
  if (input.candidates.some((c) => c.confidenceLabel === "UNKNOWN")) {
    reasons.push("cleanup_candidates_include_unknown");
  }
  if (input.candidates.some((c) => c.classification === "PROTECTED_NEVER_DELETE")) {
    reasons.push("protected_assets_in_candidate_set");
  }
  const lowConfidence = input.candidates.filter((c) => c.confidencePct < 95 && c.confidenceLabel !== "BLOCKED");
  if (lowConfidence.length > 0) {
    reasons.push(`low_confidence_candidates:${lowConfidence.length}`);
  }

  return { blocked: reasons.length > 0, reasons };
}
