import type {
  BuildCacheAnalysis,
  DependencyGraphSummary,
  ReadinessBreakdownSummary,
  ReadinessCategoryBreakdown,
  SafetyGateResult,
  SnapshotStatus,
  StorageInventoryItem,
  StorageScanSnapshot,
} from "../types";

export type { ReadinessBreakdownSummary, ReadinessCategoryBreakdown };

function categoryReadiness(unknownCount: number, totalCount: number, blocked: boolean): number {
  if (blocked || totalCount === 0) return unknownCount > 0 ? Math.max(0, 100 - unknownCount * 20) : 100;
  if (unknownCount === 0) return 100;
  return Math.max(0, Math.round(100 - (unknownCount / totalCount) * 100));
}

export function computeReadinessBreakdown(input: {
  scan: StorageScanSnapshot;
  buildCache: BuildCacheAnalysis;
  dependencyGraph: DependencyGraphSummary;
  snapshotStatus: SnapshotStatus;
  safetyGates: SafetyGateResult;
}): ReadinessBreakdownSummary {
  const items = input.scan.items;
  const cats: ReadinessCategoryBreakdown[] = [];

  const addCat = (category: string, filter: (i: StorageInventoryItem) => boolean, blocked = false, detail = "") => {
    const subset = items.filter(filter);
    const unknowns = subset.filter((i) => i.classification === "UNKNOWN_REQUIRES_REVIEW").length;
    cats.push({
      category,
      readinessPct: categoryReadiness(unknowns, subset.length, blocked),
      itemCount: subset.length,
      unknownCount: unknowns,
      blocked,
      detail: detail || (unknowns === 0 ? "Fully classified" : `${unknowns} unknown(s)`),
    });
  };

  addCat(
    "Build Cache",
    (i) => i.kind === "docker_build_cache",
    input.buildCache.unknownBytes > 0,
    input.buildCache.unknownBytes > 0 ? `unknown_bytes:${input.buildCache.unknownBytes}` : "Docker /system/df reclaimable",
  );
  addCat("Images", (i) => i.kind === "docker_image");
  addCat("Volumes", (i) => i.kind === "docker_volume");
  addCat(
    "Database",
    (i) => i.pathOrRef.includes("postgres") || i.pathOrRef.includes("redis") || i.pathOrRef.includes("minio"),
    false,
    "Protected production data paths",
  );
  addCat(
    "Rollback Assets",
    (i) => i.classification === "ROLLBACK_CANDIDATE",
    false,
    "Candidate images for blue/green",
  );
  addCat("Unknowns", (i) => i.classification === "UNKNOWN_REQUIRES_REVIEW", input.scan.unknownCount > 0);
  addCat("Logs", (i) => i.kind === "log_directory");
  addCat("APKs", (i) => i.kind === "apk_download");

  const depBlocked = input.dependencyGraph.incomplete;
  cats.push({
    category: "Dependency Graph",
    readinessPct: depBlocked ? 60 : 100,
    itemCount: input.dependencyGraph.nodes.length,
    unknownCount: depBlocked ? 1 : 0,
    blocked: depBlocked,
    detail: input.dependencyGraph.incompleteReason ?? "All running containers mapped",
  });

  cats.push({
    category: "Preflight Snapshot",
    readinessPct: input.snapshotStatus.available ? 100 : 0,
    itemCount: 1,
    unknownCount: input.snapshotStatus.available ? 0 : 1,
    blocked: !input.snapshotStatus.available,
    detail: input.snapshotStatus.available ? input.snapshotStatus.latestPath ?? "available" : "missing",
  });

  const overallPct = Math.round(
    cats.reduce((s, c) => s + c.readinessPct, 0) / (cats.length || 1),
  );

  return { categories: cats, overallPct };
}
