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
  const blockers: BlockerRow[] = [];

  if (input.buildCache.unknownBytes > 0) {
    reasons.push(`build_cache_unknown_bytes:${input.buildCache.unknownBytes}`);
    blockers.push({
      id: "build_cache_unknown",
      label: "BuildKit cache unknown bytes",
      pathOrRef: "docker_buildkit_cache",
      reason: `build_cache_unknown_bytes:${input.buildCache.unknownBytes}`,
      sizeBytes: input.buildCache.unknownBytes,
    });
  }
  for (const item of input.scan.items.filter((i) => i.classification === "UNKNOWN_REQUIRES_REVIEW")) {
    reasons.push(`unknown_inventory_item:${item.id}`);
    blockers.push({
      id: item.id,
      label: item.label,
      pathOrRef: item.pathOrRef,
      reason: item.evidence,
      sizeBytes: item.sizeBytes,
    });
  }
  if (input.scan.unknownCount > 0 && !reasons.some((r) => r.startsWith("unknown_inventory_item:"))) {
    reasons.push(`unknown_inventory_items:${input.scan.unknownCount}`);
  }
  if (input.dependencyGraph.incomplete) {
    const reason = `dependency_graph_incomplete:${input.dependencyGraph.incompleteReason ?? "unknown"}`;
    reasons.push(reason);
    blockers.push({
      id: "dependency_graph_incomplete",
      label: "Dependency graph incomplete",
      pathOrRef: "dependency_graph",
      reason,
      sizeBytes: null,
    });
  }
  if (!input.snapshotStatus.available) {
    reasons.push("preflight_snapshot_missing");
    blockers.push({
      id: "preflight_snapshot_missing",
      label: "Preflight snapshot",
      pathOrRef: input.snapshotStatus.storageRoot,
      reason: "preflight_snapshot_missing",
      sizeBytes: null,
    });
  }
  if (input.candidates.some((c) => c.confidenceLabel === "UNKNOWN")) {
    reasons.push("cleanup_candidates_include_unknown");
  }
  if (input.candidates.some((c) => c.classification === "PROTECTED_NEVER_DELETE")) {
    reasons.push("protected_assets_in_candidate_set");
    blockers.push({
      id: "protected_in_candidates",
      label: "Protected asset in candidate set",
      pathOrRef: "cleanup_candidates",
      reason: "protected_assets_in_candidate_set",
      sizeBytes: null,
    });
  }
  const lowConfidence = input.candidates.filter((c) => c.confidencePct < 95 && c.confidenceLabel !== "BLOCKED");
  if (lowConfidence.length > 0) {
    reasons.push(`low_confidence_candidates:${lowConfidence.length}`);
  }

  return { blocked: reasons.length > 0, reasons, blockers };
}
