import type { DockerBuildCacheRaw } from "../dockerSystemDfApi";
import { scoreConfidence } from "./confidenceEngine";
import type { BuildCacheAnalysis, BuildCacheEntryRow, ConfidenceLabel } from "../types";
import { isRollbackImageRef } from "./serviceMapping";

function parseDockerfileFromDescription(description: string | undefined): string | null {
  if (!description) return null;
  const m = description.match(/Dockerfile[^,\s]*/i);
  return m?.[0] ?? null;
}

function parseStageFromDescription(description: string | undefined): string | null {
  if (!description) return null;
  if (description.length <= 80) return description;
  return `${description.slice(0, 77)}…`;
}

function ageDaysFrom(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000)));
}

function scoreBuildCacheEntry(
  entry: DockerBuildCacheRaw,
  activeImageRefs: Set<string>,
  rollbackImageRefs: Set<string>,
  runningContainerImages: Set<string>,
): { confidencePct: number; confidenceLabel: ConfidenceLabel } {
  const inUse = entry.InUse === true;
  const reclaimable = entry.Reclaimable === true;
  const relatedImage = entry.Description?.match(/\[([^\]]+)\]/)?.[1] ?? null;
  const referencedByActiveImage =
    inUse ||
    (relatedImage != null && activeImageRefs.has(relatedImage.toLowerCase()));
  const referencedByRollbackImage =
    relatedImage != null && isRollbackImageRef(relatedImage);
  const referencedByRunningContainer =
    relatedImage != null && runningContainerImages.has(relatedImage.toLowerCase());

  if (!entry.ID || entry.Size == null) {
    return { confidencePct: 0, confidenceLabel: "UNKNOWN" };
  }
  return scoreConfidence({
    classification: reclaimable && !inUse ? "SAFE_CANDIDATE" : "ACTIVE_REQUIRED",
    sizeBytes: entry.Size ?? null,
    referencedByRunningContainer,
    referencedByActiveImage,
    referencedByRollbackImage,
    reclaimable,
    inUse,
    knownKind: Boolean(entry.ID),
    metadataComplete: Boolean(entry.CreatedAt || entry.LastUsedAt || entry.Description),
  });
}

export function buildBuildCacheAnalysis(
  rawEntries: DockerBuildCacheRaw[],
  activeImageRefs: string[],
  rollbackImageRefs: string[],
  runningContainerImages: string[],
): BuildCacheAnalysis {
  const activeSet = new Set(activeImageRefs.map((r) => r.toLowerCase()));
  const rollbackSet = new Set(rollbackImageRefs.map((r) => r.toLowerCase()));
  const runningSet = new Set(runningContainerImages.map((r) => r.toLowerCase()));

  const entries: BuildCacheEntryRow[] = rawEntries.map((entry) => {
    const relatedImage = entry.Description?.match(/\[([^\]]+)\]/)?.[1] ?? null;
    const inUse = entry.InUse === true;
    const reclaimable = entry.Reclaimable === true;
    const score = scoreBuildCacheEntry(entry, activeSet, rollbackSet, runningSet);
    return {
      cacheId: entry.ID ?? "unknown",
      sizeBytes: entry.Size ?? 0,
      createdAt: entry.CreatedAt ?? null,
      lastUsedAt: entry.LastUsedAt ?? null,
      ageDays: ageDaysFrom(entry.CreatedAt ?? entry.LastUsedAt),
      buildStage: parseStageFromDescription(entry.Description),
      sourceDockerfile: parseDockerfileFromDescription(entry.Description),
      relatedImage,
      referencedByActiveImage: inUse || (relatedImage != null && activeSet.has(relatedImage.toLowerCase())),
      referencedByRunningContainer: relatedImage != null && runningSet.has(relatedImage.toLowerCase()),
      referencedByRollbackImage: relatedImage != null && isRollbackImageRef(relatedImage),
      confidencePct: score.confidencePct,
      confidenceLabel: score.confidenceLabel,
    };
  });

  let referencedBytes = 0;
  let unusedBytes = 0;
  let unknownBytes = 0;
  for (const e of entries) {
    if (e.confidenceLabel === "UNKNOWN" || e.cacheId === "unknown") {
      unknownBytes += e.sizeBytes;
    } else if (e.referencedByActiveImage || e.referencedByRunningContainer) {
      referencedBytes += e.sizeBytes;
    } else {
      unusedBytes += e.sizeBytes;
    }
  }

  const totalBytes = entries.reduce((s, e) => s + e.sizeBytes, 0);
  const sorted = [...entries].sort((a, b) => b.sizeBytes - a.sizeBytes);

  return {
    totalEntries: entries.length,
    totalBytes,
    referencedBytes,
    unusedBytes,
    unknownBytes,
    entries,
    topEntries: sorted.slice(0, 25),
  };
}
