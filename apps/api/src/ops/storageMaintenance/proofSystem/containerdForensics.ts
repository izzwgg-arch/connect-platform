import type { BuildCacheAnalysis, ContainerdBreakdown, ContainerdForensicsSummary, StorageInventoryItem } from "../types";

export type { ContainerdForensicsSummary };

export function buildContainerdForensics(
  breakdown: ContainerdBreakdown | undefined,
  buildCache: BuildCacheAnalysis,
  items: StorageInventoryItem[],
): ContainerdForensicsSummary {
  const overlayBytes = breakdown?.overlaySnapshotsBytes ?? 0;
  const contentBytes = breakdown?.contentBlobsBytes ?? 0;
  const totalBytes = breakdown?.totalBytes ?? overlayBytes + contentBytes;
  const snapshotCount = breakdown?.snapshotCount ?? null;

  const activeImageLayers = items.filter(
    (i) => i.kind === "docker_image" && i.classification === "ACTIVE_REQUIRED",
  ).length;
  const rollbackLayers = items.filter(
    (i) => i.kind === "docker_image" && i.classification === "ROLLBACK_CANDIDATE",
  ).length;

  const buildReferenced = buildCache.entries.filter(
    (e) => e.referencedByActiveImage || e.referencedByRunningContainer || e.referencedByRollbackImage,
  ).length;
  const buildUnreferenced = buildCache.totalEntries - buildReferenced;

  return {
    totalBytes,
    overlayBytes,
    contentBytes,
    snapshotCount,
    buildCacheBytes: buildCache.totalBytes,
    buildCacheEntries: buildCache.totalEntries,
    categories: [
      {
        category: "ACTIVE",
        label: "Overlay snapshots (running container layers)",
        sizeBytes: overlayBytes,
        entryCount: snapshotCount ?? 0,
        referencedCount: activeImageLayers,
        unreferencedCount: Math.max(0, (snapshotCount ?? 0) - activeImageLayers),
        activeDependencyCount: items.filter((i) => i.classification === "ACTIVE_REQUIRED" && i.kind === "docker_container").length,
      },
      {
        category: "ACTIVE",
        label: "Content blobs (image/layer storage)",
        sizeBytes: contentBytes,
        entryCount: 0,
        referencedCount: activeImageLayers,
        unreferencedCount: 0,
        activeDependencyCount: activeImageLayers,
      },
      {
        category: "ORPHANED",
        label: "BuildKit cache (reclaimable via builder prune)",
        sizeBytes: buildCache.unusedBytes,
        entryCount: buildUnreferenced,
        referencedCount: buildReferenced,
        unreferencedCount: buildUnreferenced,
        activeDependencyCount: 0,
      },
      {
        category: "ROLLBACK",
        label: "Candidate image layers in containerd",
        sizeBytes: items
          .filter((i) => i.classification === "ROLLBACK_CANDIDATE")
          .reduce((s, i) => s + (i.sizeBytes ?? 0), 0),
        entryCount: rollbackLayers,
        referencedCount: rollbackLayers,
        unreferencedCount: 0,
        activeDependencyCount: rollbackLayers,
      },
    ],
  };
}
