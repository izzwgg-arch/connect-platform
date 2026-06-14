import { buildProtectedPaths } from "./protectionRules";
import { toHostDisplayPath } from "./hostVisibility";
import type {
  CleanupPlan,
  StorageClassification,
  StorageDashboardSummary,
  StorageDistributionCategory,
  StorageInventoryItem,
  StorageMaintenanceConfig,
  StorageRiskLevel,
  StorageScanSnapshot,
  StorageTrendPoint,
  StorageTrendSeries,
  TrendDirection,
} from "./types";

export type ConsumerRiskLevel = "low" | "medium" | "high" | "critical";
export type ConsumerActionability = "locked" | "review" | "eligible" | "blocked";

function rootMount(scan: StorageScanSnapshot) {
  return scan.diskMounts.find((m) => m.path === "/" || m.path === "C:\\") ?? scan.diskMounts[0] ?? null;
}

export function classificationRisk(c: StorageClassification): ConsumerRiskLevel {
  if (c === "PROTECTED_NEVER_DELETE") return "critical";
  if (c === "ACTIVE_REQUIRED") return "high";
  if (c === "UNKNOWN_REQUIRES_REVIEW" || c === "ROLLBACK_CANDIDATE") return "medium";
  return "low";
}

export function classificationActionability(c: StorageClassification): ConsumerActionability {
  if (c === "PROTECTED_NEVER_DELETE" || c === "ACTIVE_REQUIRED") return "locked";
  if (c === "SAFE_CANDIDATE") return "eligible";
  if (c === "ROLLBACK_CANDIDATE" || c === "UNKNOWN_REQUIRES_REVIEW") return "review";
  return "blocked";
}

export function rankLargestConsumers(
  items: StorageInventoryItem[],
  limit = 20,
  hostInventoryRoot = "",
): StorageDashboardSummary["largestConsumers"] {
  const sorted = [...items]
    .filter((i) => i.sizeBytes != null && i.sizeBytes > 0)
    .sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));

  const seen = new Set<string>();
  const rows: StorageDashboardSummary["largestConsumers"] = [];

  for (const item of sorted) {
    const key = item.pathOrRef;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      rank: rows.length + 1,
      path: toHostDisplayPath(item.pathOrRef, hostInventoryRoot),
      label: item.label,
      sizeBytes: item.sizeBytes,
      classification: item.classification,
      risk: classificationRisk(item.classification),
      actionability: classificationActionability(item.classification),
      kind: item.kind,
    });
    if (rows.length >= limit) break;
  }

  return rows;
}

function itemMatchesCategory(
  item: StorageInventoryItem,
  category: StorageDistributionCategory,
  config: StorageMaintenanceConfig,
): boolean {
  const path = item.pathOrRef.replace(/\\/g, "/");
  const label = item.label.toLowerCase();

  switch (category) {
    case "build_cache":
      return item.kind === "docker_build_cache";
    case "downloads":
      return item.kind === "apk_download" || path.startsWith(config.downloadsRoot);
    case "logs":
      return (
        item.kind === "log_directory" ||
        path.includes("/var/log/journal") ||
        path.includes("/var/log/connect-deploys") ||
        path.startsWith(config.monitoringLogsRoot)
      );
    case "database":
      return path.includes("postgres") || label.includes("postgres");
    case "redis":
      return path.includes("redis") || label.includes("redis");
    case "docker_volumes":
      return item.kind === "docker_volume";
    case "application":
      return (
        (path.startsWith(config.appRoot) || path === config.appRoot) &&
        !path.startsWith(config.downloadsRoot) &&
        !path.startsWith(config.monitoringLogsRoot) &&
        !path.startsWith(config.containerdRoot)
      );
    default:
      return false;
  }
}

type StorageDistributionSlice = StorageDashboardSummary["distribution"][number];

function sumCategoryBytes(
  items: StorageInventoryItem[],
  category: StorageDistributionCategory,
  config: StorageMaintenanceConfig,
  excludeContainerdWhenBuildCache: boolean,
): number {
  return items.reduce((sum, item) => {
    if (excludeContainerdWhenBuildCache && item.pathOrRef === config.containerdRoot) return sum;
    if (item.kind === "docker_build_cache" && category !== "build_cache") return sum;
    if (itemMatchesCategory(item, category, config)) {
      return sum + (item.sizeBytes ?? 0);
    }
    return sum;
  }, 0);
}

export function buildStorageDistribution(
  scan: StorageScanSnapshot,
  config: StorageMaintenanceConfig,
): StorageDistributionSlice[] {
  const root = rootMount(scan);
  const totalUsed = root?.usedBytes ?? 0;
  const hasBuildCache = scan.docker.buildCache.totalBytes != null;

  const defs: Array<{ category: StorageDistributionSlice["category"]; label: string }> = [
    { category: "build_cache", label: "Build Cache" },
    { category: "application", label: "Application" },
    { category: "downloads", label: "Downloads" },
    { category: "logs", label: "Logs" },
    { category: "database", label: "Database" },
    { category: "redis", label: "Redis" },
    { category: "docker_volumes", label: "Docker Volumes" },
    { category: "other", label: "Other" },
  ];

  const slices: StorageDistributionSlice[] = [];
  let accounted = 0;

  for (const def of defs) {
    let sizeBytes = 0;
    if (def.category === "build_cache") {
      sizeBytes = scan.docker.buildCache.totalBytes ?? 0;
    } else if (def.category === "other") {
      const explicit = defs
        .filter((d) => d.category !== "other")
        .reduce((s, d) => {
          if (d.category === "build_cache") return s + (scan.docker.buildCache.totalBytes ?? 0);
          return s + sumCategoryBytes(scan.items, d.category, config, hasBuildCache);
        }, 0);
      sizeBytes = Math.max(0, totalUsed - explicit);
    } else {
      sizeBytes = sumCategoryBytes(scan.items, def.category, config, hasBuildCache);
    }
    accounted += sizeBytes;
    slices.push({
      category: def.category,
      label: def.label,
      sizeBytes,
      pct: totalUsed > 0 ? Math.round((sizeBytes / totalUsed) * 1000) / 10 : 0,
    });
  }

  return slices.filter((s) => s.sizeBytes > 0 || s.category === "build_cache");
}

export function computeRiskLevel(scan: StorageScanSnapshot, config: StorageMaintenanceConfig): StorageRiskLevel {
  const root = rootMount(scan);
  const usedPct = root?.usedPct ?? 0;
  const freeBytes = root?.freeBytes ?? Number.MAX_SAFE_INTEGER;
  const buildBytes = scan.docker.buildCache.totalBytes ?? 0;

  if (
    usedPct >= config.diskCriticalPct ||
    freeBytes <= config.freeSpaceCriticalBytes ||
    buildBytes >= config.buildkitCriticalBytes
  ) {
    return "critical";
  }
  if (usedPct >= config.diskWarningPct || freeBytes <= config.freeSpaceWarningBytes) {
    return "high";
  }
  if (usedPct >= 70 || buildBytes >= config.buildkitWarningBytes || scan.unknownCount > 0) {
    return "medium";
  }
  return "low";
}

export function buildProtectedAssets(
  items: StorageInventoryItem[],
  config: StorageMaintenanceConfig,
): StorageDashboardSummary["protectedAssets"] {
  const protectedPaths = buildProtectedPaths(config);
  const assets: StorageDashboardSummary["protectedAssets"] = [];
  const seen = new Set<string>();

  const push = (row: StorageDashboardSummary["protectedAssets"][number]) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    assets.push(row);
  };

  for (const item of items) {
    if (item.classification !== "PROTECTED_NEVER_DELETE" && item.classification !== "ACTIVE_REQUIRED") continue;

    let category: StorageDashboardSummary["protectedAssets"][number]["category"] = "path";
    if (item.kind === "docker_volume") category = "volume";
    else if (item.kind === "docker_image") category = "image";
    else if (item.pathOrRef.includes("postgres")) category = "database";
    else if (item.pathOrRef.includes("redis")) category = "bind_mount";

    push({
      id: item.id,
      label: item.label,
      category,
      pathOrRef: item.pathOrRef,
      sizeBytes: item.sizeBytes,
      status: item.classification === "PROTECTED_NEVER_DELETE" ? "protected" : "locked",
      detail:
        item.classification === "PROTECTED_NEVER_DELETE"
          ? "Protected — cannot be deleted"
          : "Locked — active production asset",
    });
  }

  for (const path of protectedPaths) {
    const label =
      path.includes("postgres") ? "Postgres" :
      path.includes("redis") ? "Redis" :
      path.includes("minio") ? "Object storage" :
      path.includes("chat-attachments") ? "Chat Attachments" :
      path.includes("crm-lead-docs") ? "CRM Documents" :
      path.includes("crm-voicemail-drops") ? "Voicemail Drops" :
      path.includes("ivr-prompts") ? "IVR Assets" :
      path.includes("moh-assets") ? "MOH Assets" :
      path.includes("backups") ? "Backups" :
      path;

    if (!seen.has(`path:${path}`)) {
      const match = items.find((i) => i.pathOrRef === path || i.pathOrRef.startsWith(`${path}/`));
      push({
        id: `path:${path}`,
        label,
        category: path.includes("postgres") ? "database" : path.includes("redis") ? "bind_mount" : "path",
        pathOrRef: path,
        sizeBytes: match?.sizeBytes ?? null,
        status: "protected",
        detail: "Protected — cannot be deleted",
      });
    }
  }

  return assets.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
}

export function computeReclaimSimulation(scan: StorageScanSnapshot): {
  projectedUsageAfterCleanupBytes: number | null;
  projectedRecoveryBytes: number;
  projectedFreeBytesAfterCleanup: number | null;
} {
  const root = rootMount(scan);
  const used = root?.usedBytes ?? null;
  const free = root?.freeBytes ?? null;
  const recovery = scan.reclaimEstimateBytes;

  if (used == null) {
    return {
      projectedUsageAfterCleanupBytes: null,
      projectedRecoveryBytes: recovery,
      projectedFreeBytesAfterCleanup: null,
    };
  }

  const projectedUsed = Math.max(0, used - recovery);
  return {
    projectedUsageAfterCleanupBytes: projectedUsed,
    projectedRecoveryBytes: recovery,
    projectedFreeBytesAfterCleanup: free != null ? free + recovery : null,
  };
}

export function buildCleanupReadiness(
  scan: StorageScanSnapshot,
  plan: CleanupPlan | null,
): StorageDashboardSummary["cleanupReadiness"] {
  const rows: StorageDashboardSummary["cleanupReadiness"] = [];

  const buildCache = scan.docker.buildCache.totalBytes ?? 0;
  const buildReclaim = scan.docker.buildCache.reclaimableBytes ?? scan.items.find((i) => i.kind === "docker_build_cache")?.reclaimableBytes ?? 0;
  if (buildCache > 0) {
    rows.push({
      category: "BuildKit Cache",
      sizeBytes: buildCache,
      risk: "low",
      status: "eligible",
      classification: "SAFE_CANDIDATE",
    });
  }

  const candidateImages = scan.items.filter(
    (i) => i.kind === "docker_image" && (i.classification === "ROLLBACK_CANDIDATE" || i.classification === "SAFE_CANDIDATE"),
  );
  const candidateImageBytes = candidateImages.reduce((s, i) => s + (i.sizeBytes ?? 0), 0);
  if (candidateImageBytes > 0) {
    const hasRollback = candidateImages.some((i) => i.classification === "ROLLBACK_CANDIDATE");
    rows.push({
      category: "Candidate Images",
      sizeBytes: candidateImageBytes,
      risk: hasRollback ? "medium" : "low",
      status: hasRollback ? "review_required" : "eligible",
      classification: hasRollback ? "ROLLBACK_CANDIDATE" : "SAFE_CANDIDATE",
    });
  }

  const downloadBytes = scan.items
    .filter((i) => i.kind === "apk_download")
    .reduce((s, i) => s + (i.sizeBytes ?? 0), 0);
  const downloadsPath = scan.items.find((i) => i.pathOrRef.includes("downloads") && i.kind === "filesystem_path");
  const totalDownloads = downloadBytes + (downloadsPath?.sizeBytes ?? 0);
  if (totalDownloads > 0) {
    rows.push({
      category: "Downloads",
      sizeBytes: totalDownloads,
      risk: "medium",
      status: "review_required",
      classification: "SAFE_CANDIDATE",
    });
  }

  const protectedBytes = scan.items
    .filter((i) => i.classification === "PROTECTED_NEVER_DELETE" || i.classification === "ACTIVE_REQUIRED")
    .reduce((s, i) => s + (i.sizeBytes ?? 0), 0);
  if (protectedBytes > 0) {
    rows.push({
      category: "Protected Data",
      sizeBytes: protectedBytes,
      risk: "critical",
      status: "blocked",
      classification: "PROTECTED_NEVER_DELETE",
    });
  }

  const logBytes = scan.items
    .filter((i) => i.kind === "log_directory" || i.pathOrRef.includes("/var/log"))
    .reduce((s, i) => s + (i.sizeBytes ?? 0), 0);
  if (logBytes > 0) {
    rows.push({
      category: "Logs & Journal",
      sizeBytes: logBytes,
      risk: "medium",
      status: "review_required",
      classification: "SAFE_CANDIDATE",
    });
  }

  return rows;
}

export function buildStorageDashboardSummary(
  scan: Omit<StorageScanSnapshot, "dashboard">,
  config: StorageMaintenanceConfig,
  plan: CleanupPlan | null = null,
): StorageDashboardSummary {
  const root = rootMount(scan);
  const protectedDataBytes = scan.items
    .filter((i) => i.classification === "PROTECTED_NEVER_DELETE" || i.classification === "ACTIVE_REQUIRED")
    .reduce((s, i) => s + (i.sizeBytes ?? 0), 0);

  const simulation = computeReclaimSimulation(scan);

  return {
    totalDiskBytes: root?.totalBytes ?? null,
    usedBytes: root?.usedBytes ?? null,
    freeBytes: root?.freeBytes ?? null,
    usedPct: root?.usedPct ?? null,
    buildCacheBytes: scan.docker.buildCache.totalBytes,
    containerdBytes: scan.containerd?.totalBytes ?? null,
    containerdOverlayBytes: scan.containerd?.overlaySnapshotsBytes ?? null,
    containerdContentBytes: scan.containerd?.contentBlobsBytes ?? null,
    reclaimableBytes: scan.reclaimEstimateBytes,
    protectedDataBytes,
    riskLevel: computeRiskLevel(scan, config),
    projectedUsageAfterCleanupBytes: simulation.projectedUsageAfterCleanupBytes,
    projectedRecoveryBytes: simulation.projectedRecoveryBytes,
    projectedFreeBytesAfterCleanup: simulation.projectedFreeBytesAfterCleanup,
    largestConsumers: rankLargestConsumers(scan.items, 20, config.hostInventoryRoot),
    protectedAssets: buildProtectedAssets(scan.items, config),
    distribution: buildStorageDistribution(scan, config),
    cleanupReadiness: buildCleanupReadiness(scan, plan),
    operationsCenter: null,
  };
}

export function computeTrendDirection(points: StorageTrendPoint[]): {
  direction: TrendDirection;
  directionPctDelta: number | null;
} {
  const withPct = points.filter((p) => p.diskUsedPct != null);
  if (withPct.length < 2) return { direction: "stable", directionPctDelta: null };

  const first = withPct[0]!.diskUsedPct!;
  const last = withPct[withPct.length - 1]!.diskUsedPct!;
  const delta = Math.round((last - first) * 10) / 10;

  if (delta > 1) return { direction: "increasing", directionPctDelta: delta };
  if (delta < -1) return { direction: "decreasing", directionPctDelta: delta };
  return { direction: "stable", directionPctDelta: delta };
}

export function buildTrendSeries(
  history: StorageTrendPoint[],
  window: StorageTrendSeries["window"],
): StorageTrendSeries {
  const now = Date.now();
  const ms =
    window === "24h" ? 24 * 60 * 60 * 1000 :
    window === "7d" ? 7 * 24 * 60 * 60 * 1000 :
    30 * 24 * 60 * 60 * 1000;

  const cutoff = now - ms;
  const points = history.filter((p) => new Date(p.timestamp).getTime() >= cutoff);
  const { direction, directionPctDelta } = computeTrendDirection(points);

  return { window, direction, directionPctDelta, points };
}
