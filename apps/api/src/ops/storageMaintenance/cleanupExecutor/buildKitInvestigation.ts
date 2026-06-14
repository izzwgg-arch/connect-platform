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
    const parts = line.split(/\s{2,}/).map((p) => p.trim());
    if (parts.length < 4) continue;
    const [cacheId, cacheType, sizeRaw, , , usageRaw] = parts;
    const usage = Number(usageRaw ?? "0");
    entries.push({
      cacheId: cacheId ?? "",
      cacheType: cacheType ?? "unknown",
      sizeBytes: parseSizeBytes(sizeRaw ?? "0"),
      usageCount: Number.isFinite(usage) ? usage : 0,
      referenced: usage > 0,
    });
  }
  return entries;
}

export function investigateBuildKitCache(systemDfVText: string): BuildKitInvestigation {
  const entries = parseBuildKitCacheFromSystemDfV(systemDfVText);
  const active = entries.filter((e) => e.referenced);
  const inactive = entries.filter((e) => !e.referenced);
  const unknown = entries.filter((e) => e.cacheType.includes("*") && e.usageCount === 0);

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
    safeToPrune: unknown.length === 0 && inactiveBytes > 0,
    entries: entries.slice(0, 200),
  };
}
