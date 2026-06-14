import type {
  DiskMount,
  DockerSystemSummary,
  StorageInventoryItem,
  StorageMaintenanceConfig,
} from "./types";

export type ReclaimEstimateBreakdown = {
  buildKitCacheBytes: number;
  unusedImageBytes: number;
  rollbackImageBytes: number;
  historicalApkBytes: number;
  totalBytes: number;
  cappedToUsedDisk: boolean;
};

/**
 * Non-overlapping reclaim estimate — never sums full `du` sizes for containerd
 * trees alongside BuildKit cache (same bytes on disk). Uses Docker-reported
 * BuildKit reclaimable bytes plus explicit removable image/APK candidates only.
 */
export function computeReclaimEstimate(
  items: StorageInventoryItem[],
  docker: DockerSystemSummary,
  diskMounts: DiskMount[],
  config: StorageMaintenanceConfig,
): { reclaimEstimateBytes: number; breakdown: ReclaimEstimateBreakdown } {
  const buildCacheItem = items.find((i) => i.kind === "docker_build_cache");
  const metaReclaim = buildCacheItem?.metadata?.reclaimableBytes;
  const buildKitCacheBytes =
    docker.buildCache.reclaimableBytes ??
    (typeof metaReclaim === "number" ? metaReclaim : 0);

  const unusedImageBytes = items
    .filter((i) => i.kind === "docker_image" && i.classification === "SAFE_CANDIDATE")
    .reduce((s, i) => s + (i.sizeBytes ?? 0), 0);

  const rollbackImageBytes = items
    .filter((i) => i.kind === "docker_image" && i.classification === "ROLLBACK_CANDIDATE")
    .reduce((s, i) => s + (i.sizeBytes ?? 0), 0);

  const apkItems = items
    .filter((i) => i.kind === "apk_download")
    .sort((a, b) => Number(a.metadata?.sortIndex ?? 0) - Number(b.metadata?.sortIndex ?? 0));
  const historicalApkBytes = apkItems
    .slice(config.apkRetentionCount)
    .reduce((s, i) => s + (i.sizeBytes ?? 0), 0);

  let totalBytes = buildKitCacheBytes + unusedImageBytes + rollbackImageBytes + historicalApkBytes;

  const root = diskMounts.find((m) => m.path === "/" || m.path === "C:\\") ?? diskMounts[0];
  let cappedToUsedDisk = false;
  if (root?.usedBytes != null && totalBytes > root.usedBytes) {
    totalBytes = root.usedBytes;
    cappedToUsedDisk = true;
  }

  const rounded = Math.round(totalBytes);
  return {
    reclaimEstimateBytes: rounded,
    breakdown: {
      buildKitCacheBytes: Math.round(buildKitCacheBytes),
      unusedImageBytes: Math.round(unusedImageBytes),
      rollbackImageBytes: Math.round(rollbackImageBytes),
      historicalApkBytes: Math.round(historicalApkBytes),
      totalBytes: rounded,
      cappedToUsedDisk,
    },
  };
}
