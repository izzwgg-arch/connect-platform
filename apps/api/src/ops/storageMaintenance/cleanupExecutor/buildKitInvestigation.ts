import type { DockerBuildCacheRaw } from "../dockerSystemDfApi";
import type { BuildKitInvestigation, BuildKitCacheEntryStat } from "../types";

function parseSizeBytes(raw: string): number {
  const m = raw.trim().match(/^([\d.]+)\s*(B|kB|MB|GB|TB)$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2]!.toUpperCase();
  const mult =
    unit === "TB" ? 1e12 : unit === "GB" ? 1e9 : unit === "MB" ? 1e6 : unit === "KB" ? 1e3 : 1;
  return Math.round(n * mult);
}

export function parseBuildKitCacheFromSystemDfV(text: string): BuildKitCacheEntryStat[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith("CACHE ID"));
  if (start < 0) return [];
  const entries: BuildKitCacheEntryStat[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("REPOSITORY") || line.startsWith("CONTAINER ID")) break;
    if (!/^[a-z0-9]{5,}/i.test(line)) continue;
    const parts = line.split(/\s{2,}/).map((p) => p.trim());
    if (parts.length < 4) continue;
    const cacheId = parts[0] ?? "";
    const cacheType = parts[1] ?? "unknown";
    const sizeRaw = parts[2] ?? "0";
    const usageRaw = parts[parts.length - 2] ?? "0";
    const usage = Number(usageRaw);
    const incomplete = cacheId.endsWith("*") || cacheType.includes("*");
    entries.push({
      cacheId: cacheId.replace(/\*$/, ""),
      cacheType,
      sizeBytes: parseSizeBytes(sizeRaw),
      usageCount: Number.isFinite(usage) ? usage : 0,
      referenced: Number.isFinite(usage) ? usage > 0 : false,
      incomplete,
    });
  }
  return entries;
}

export function mapRawBuildCacheToStats(raw: DockerBuildCacheRaw[]): BuildKitCacheEntryStat[] {
  return raw.map((entry) => {
    const usageCount = entry.UsageCount ?? (entry.InUse ? 1 : 0);
    const incomplete = entry.Type === "incomplete" || (entry.ID ?? "").endsWith("*");
    return {
      cacheId: entry.ID ?? "",
      cacheType: entry.Type ?? "unknown",
      sizeBytes: entry.Size ?? 0,
      usageCount,
      referenced: entry.InUse === true || usageCount > 0,
      incomplete,
      reclaimable: entry.Reclaimable === true,
      lastUsedAt: entry.LastUsedAt ?? null,
      createdAt: entry.CreatedAt ?? null,
    };
  });
}

export function investigateBuildKitFromRaw(rawEntries: DockerBuildCacheRaw[]): BuildKitInvestigation {
  const entries = mapRawBuildCacheToStats(rawEntries);
  return buildInvestigationFromStats(entries);
}

export function investigateBuildKitCache(systemDfVText: string): BuildKitInvestigation {
  const entries = parseBuildKitCacheFromSystemDfV(systemDfVText);
  return buildInvestigationFromStats(entries);
}

function buildInvestigationFromStats(entries: BuildKitCacheEntryStat[]): BuildKitInvestigation {
  const active = entries.filter((e) => e.referenced);
  const inactive = entries.filter((e) => !e.referenced);
  const unknown = entries.filter(
    (e) => e.incomplete === true || (e.cacheType.includes("*") && e.usageCount === 0) || !e.cacheId,
  );

  const totalBytes = entries.reduce((s, e) => s + e.sizeBytes, 0);
  const activeBytes = active.reduce((s, e) => s + e.sizeBytes, 0);
  const inactiveBytes = inactive.reduce((s, e) => s + e.sizeBytes, 0);
  const unknownBytes = unknown.reduce((s, e) => s + e.sizeBytes, 0);

  const inactivePct = totalBytes > 0 ? Math.round((inactiveBytes / totalBytes) * 100) : 0;
  let confidencePct = 92;
  const confidenceReasons: string[] = [];

  if (unknown.length > 0) {
    confidencePct -= Math.min(30, unknown.length * 2);
    confidenceReasons.push(`${unknown.length} cache entries marked incomplete (*) with zero usage`);
  }
  if (active.length > 0) {
    confidencePct -= Math.min(15, active.length);
    confidenceReasons.push(`${active.length} cache entries still show USAGE>0 and must be excluded`);
  }
  if (entries.length === 0) {
    confidencePct = 0;
    confidenceReasons.push("build_cache_inventory_unavailable");
  }
  if (inactivePct < 80) {
    confidencePct -= 10;
    confidenceReasons.push(`only ${inactivePct}% of cache bytes are inactive`);
  }

  confidenceReasons.push(
    "Docker reports cumulative layer sizes; physical disk reclaim may be lower than logical cache total",
  );
  confidenceReasons.push(
    "Prune uses builder prune filters — active image layers in content store are never targeted",
  );

  return {
    investigatedAt: new Date().toISOString(),
    totalEntries: entries.length,
    activeReferences: active.length,
    inactiveReferences: inactive.length,
    unknownReferences: unknown.length,
    totalBytes,
    activeBytes,
    inactiveBytes,
    unknownBytes,
    confidencePct: Math.max(0, Math.min(100, confidencePct)),
    confidenceLabel: confidencePct >= 95 ? "HIGH" : confidencePct >= 85 ? "MEDIUM" : "LOW",
    whyNot99Plus: confidenceReasons,
    safeToPrune: entries.length > 0 && unknown.length === 0 && inactiveBytes > 0,
    inventoryStatus: entries.length > 0 ? "OK" : "UNAVAILABLE",
    inventoryError: entries.length > 0 ? null : "build_cache_inventory_unavailable",
    collectionSource: entries.length > 0 ? "docker_system_df_api" : "none",
    cleanupBlockedReason:
      entries.length > 0 && unknown.length === 0 && inactiveBytes > 0
        ? "cleanup_blocked_pending_approval"
        : entries.length === 0
          ? "buildkit_inventory_unavailable"
          : `buildkit_not_safe:confidence=${Math.max(0, Math.min(100, confidencePct))}`,
    entries: entries.slice(0, 200),
  };
}
