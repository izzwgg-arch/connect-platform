import { extractBuildCacheRaw, type DockerBuildCacheRaw } from "../dockerSystemDfApi";
import type { DockerContainerRow, DockerImageRow } from "../scanner";
import type {
  ConsumerRiskLevel,
  StorageMaintenanceConfig,
  StorageOperationsCenter,
  StorageScanSnapshot,
  StorageTrendPoint,
} from "../types";
import { buildApkForensics } from "./apkForensics";
import { buildBuildCacheAnalysis } from "./buildKitForensics";
import { buildCleanupCandidates, buildConfidenceDistribution, evaluateSafetyGates } from "./safetyGates";
import { buildDependencyGraph, type ImageInspectRow } from "./dependencyGraph";
import { buildLogForensics } from "./logForensics";
import { averageConfidence, computeReadinessScore } from "./readinessScoring";
import { buildRollbackCoverage } from "./rollbackAudit";
import { isRollbackImageRef } from "./serviceMapping";
import { buildCacheGroups } from "./buildCacheGrouping";
import { buildContainerdForensics } from "./containerdForensics";
import {
  buildDependencyProofPanel,
  buildForensicFinalReport,
  buildOrphanAnalysisPanel,
  buildUnknownItemsPanel,
} from "./forensicInvestigation";
import { computeReadinessBreakdown } from "./readinessBreakdown";
import { computeReclaimEstimate } from "../reclaimEstimate";
import { getSnapshotStatus } from "./snapshotGenerator";
import { buildVolumeMountIndex } from "./volumeMountIndex";

export function buildOperationsCenter(input: {
  scan: Omit<StorageScanSnapshot, "dashboard">;
  config: StorageMaintenanceConfig;
  buildCacheRaw: DockerBuildCacheRaw[];
  images: DockerImageRow[];
  containers: DockerContainerRow[];
  imageInspects: ImageInspectRow[];
  history?: StorageTrendPoint[];
}): StorageOperationsCenter {
  const activeImageRefs = input.images
    .filter((i) => (i.Containers ?? 0) > 0)
    .flatMap((i) => i.RepoTags ?? []);
  const rollbackImageRefs = input.images
    .flatMap((i) => i.RepoTags ?? [])
    .filter((t) => isRollbackImageRef(t));
  const runningContainerImages = input.containers
    .filter((c) => (c.State ?? "").toLowerCase().includes("running"))
    .map((c) => c.Image);

  const buildCacheAnalysis = buildBuildCacheAnalysis(
    input.buildCacheRaw,
    activeImageRefs,
    rollbackImageRefs,
    runningContainerImages,
  );
  const dependencyGraph = buildDependencyGraph(input.containers, input.images, input.imageInspects);
  const rollbackCoverage = buildRollbackCoverage(input.images);
  const apkForensics = buildApkForensics(input.scan.items);
  const logForensics = buildLogForensics(input.scan.items, input.config, input.history ?? []);
  const cleanupCandidates = buildCleanupCandidates(input.scan.items);
  const confidenceDistribution = buildConfidenceDistribution(cleanupCandidates, buildCacheAnalysis);
  const snapshotStatus = getSnapshotStatus(input.config, input.scan.scanId);
  const volumeMountIndex = buildVolumeMountIndex(input.containers);
  const pathStats = new Map<string, import("./forensicInvestigation").PathForensicStat>();

  const safetyGates = evaluateSafetyGates({
    scan: { ...input.scan, dashboard: null as never },
    buildCache: buildCacheAnalysis,
    dependencyGraph,
    snapshotStatus,
    candidates: cleanupCandidates,
  });

  const avgConfidence = averageConfidence([
    ...cleanupCandidates,
    ...buildCacheAnalysis.entries,
  ]);

  const readiness = computeReadinessScore({
    scan: { ...input.scan, dashboard: null as never },
    buildCache: buildCacheAnalysis,
    dependencyGraph,
    snapshotStatus,
    safetyGates,
    avgConfidencePct: avgConfidence,
  });

  const riskMatrix = [
    {
      category: "BuildKit Cache",
      risk: (buildCacheAnalysis.unusedBytes > buildCacheAnalysis.referencedBytes ? "low" : "medium") as ConsumerRiskLevel,
      sizeBytes: buildCacheAnalysis.totalBytes,
      confidenceLabel: buildCacheAnalysis.unknownBytes > 0 ? "UNKNOWN" as const : "LIKELY_SAFE" as const,
      blocked: buildCacheAnalysis.unknownBytes > 0,
    },
    {
      category: "Protected Assets",
      risk: "critical" as ConsumerRiskLevel,
      sizeBytes: input.scan.items
        .filter((i) => i.classification === "PROTECTED_NEVER_DELETE")
        .reduce((s, i) => s + (i.sizeBytes ?? 0), 0),
      confidenceLabel: "BLOCKED" as const,
      blocked: true,
    },
    {
      category: "Rollback Images",
      risk: "medium" as ConsumerRiskLevel,
      sizeBytes: rollbackCoverage
        .filter((r) => r.classification === "ROLLBACK_CANDIDATE")
        .reduce((s, r) => s + (r.sizeBytes ?? 0), 0),
      confidenceLabel: "LIKELY_SAFE" as const,
      blocked: false,
    },
    {
      category: "Logs",
      risk: "medium" as ConsumerRiskLevel,
      sizeBytes: logForensics.totalBytes,
      confidenceLabel: "REVIEW_REQUIRED" as const,
      blocked: false,
    },
  ];

  const unknownItemsPanel = buildUnknownItemsPanel(
    input.scan.items,
    { ...input.scan, dashboard: null as never },
    input.config,
    volumeMountIndex,
    pathStats,
    dependencyGraph,
  );
  const dependencyProofPanel = buildDependencyProofPanel(input.scan.items, dependencyGraph);
  const orphanAnalysisPanel = buildOrphanAnalysisPanel(input.scan.items, volumeMountIndex);
  const readinessBreakdown = computeReadinessBreakdown({
    scan: { ...input.scan, dashboard: null as never },
    buildCache: buildCacheAnalysis,
    dependencyGraph,
    snapshotStatus,
    safetyGates,
  });
  const containerdForensics = buildContainerdForensics(input.scan.containerd, buildCacheAnalysis, input.scan.items);
  const cacheGroups = buildCacheGroups(buildCacheAnalysis.entries);
  const reclaimBreakdown = computeReclaimEstimate(
    input.scan.items,
    input.scan.docker,
    input.scan.diskMounts,
    input.config,
  );

  const forensicReport = buildForensicFinalReport({
    scan: { ...input.scan, dashboard: null as never },
    readinessScorePct: readiness.readinessScorePct,
    safetyGatesPass: !safetyGates.blocked,
    unknownPanel: unknownItemsPanel,
    buildCacheReclaimableBytes: reclaimBreakdown.breakdown.buildKitCacheBytes,
    rollbackCandidateBytes: reclaimBreakdown.breakdown.rollbackImageBytes,
    historicalApkBytes: reclaimBreakdown.breakdown.historicalApkBytes,
  });

  return {
    buildCacheAnalysis,
    dependencyGraph,
    rollbackCoverage,
    apkForensics,
    logForensics,
    confidenceDistribution,
    cleanupCandidates: cleanupCandidates.slice(0, 50),
    readinessScorePct: readiness.readinessScorePct,
    readinessLabel: readiness.readinessLabel,
    readinessDetail: readiness.readinessDetail,
    safetyGates,
    snapshotStatus,
    riskMatrix,
    unknownItemsPanel,
    dependencyProofPanel,
    orphanAnalysisPanel,
    readinessBreakdown,
    containerdForensics,
    buildCacheGroups: cacheGroups.slice(0, 20),
    forensicReport,
  };
}

export async function fetchBuildCacheRaw(
  getSystemDfJson: () => Promise<unknown>,
): Promise<DockerBuildCacheRaw[]> {
  try {
    const raw = (await getSystemDfJson()) as Parameters<typeof extractBuildCacheRaw>[0];
    return extractBuildCacheRaw(raw);
  } catch {
    return [];
  }
}
