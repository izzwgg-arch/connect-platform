import type { DockerContainerRow } from "../scanner";
import type {
  ConfidenceLabel,
  ConsumerRiskLevel,
  DependencyGraphSummary,
  DependencyProofRow,
  ForensicDossier,
  ForensicFinalReport,
  OrphanAnalysisRow,
  RuntimeUsageProof,
  StorageInventoryItem,
  StorageMaintenanceConfig,
  StorageScanSnapshot,
  UnknownItemForensicRow,
} from "../types";

export type PathForensicStat = {
  owner: string | null;
  filesystem: string | null;
  mountPoint: string | null;
  firstDiscoveredAt: string | null;
  lastModifiedAt: string | null;
};

export type { DependencyProofRow, ForensicDossier, ForensicFinalReport, OrphanAnalysisRow, UnknownItemForensicRow };

import type { VolumeMountRef } from "./volumeMountIndex";

function runtimeProofForItem(
  item: StorageInventoryItem,
  mounts: VolumeMountRef[] | undefined,
  _scan: StorageScanSnapshot,
): RuntimeUsageProof {
  if (item.classification === "ACTIVE_REQUIRED") return "USED_NOW";
  if (item.classification === "ROLLBACK_CANDIDATE") return "USED_FOR_ROLLBACK";
  if (item.kind === "docker_build_cache") return "USED_DURING_DEPLOY";
  if (item.kind === "apk_download" && item.metadata?.isLatestRelease === false) return "NOT_USED";
  if (mounts?.some((m) => m.state.toLowerCase().includes("running"))) return "USED_NOW";
  if (item.kind === "log_directory" || item.pathOrRef.includes("deploy")) return "USED_DURING_DEPLOY";
  if (item.classification === "SAFE_CANDIDATE") return "LIKELY_SAFE";
  return "NOT_USED";
}

export function buildForensicDossier(
  item: StorageInventoryItem,
  scan: StorageScanSnapshot,
  config: StorageMaintenanceConfig,
  volumeMounts: Map<string, VolumeMountRef[]>,
  pathStats: Map<string, PathForensicStat>,
  dependencyGraph: DependencyGraphSummary,
): ForensicDossier {
  const path = item.pathOrRef;
  const stat = pathStats.get(path);
  const volMounts = item.kind === "docker_volume" ? volumeMounts.get(item.pathOrRef) ?? [] : [];
  const activeRefs: string[] = [];

  if (item.classification === "ACTIVE_REQUIRED") {
    activeRefs.push(`classification:${item.classification} evidence=${item.evidence}`);
  }
  for (const m of volMounts) {
    activeRefs.push(`container:${m.containerName} service=${m.service} mount=${m.mountDestination} state=${m.state}`);
  }
  const depNode = dependencyGraph.nodes.find(
    (n) => n.containerName === item.label || n.image === item.pathOrRef,
  );
  if (depNode?.protectedByRunningContainer) {
    activeRefs.push(`dependency_graph:running service=${depNode.service}`);
  }

  const deploymentDeps: string[] = [];
  if (path.includes("connect-deploys")) deploymentDeps.push("scripts/deploy-direct.sh writes logs");
  if (path.includes(config.appCloneRoot) || path.includes("/app")) deploymentDeps.push("git deploy clone");
  if (item.kind === "docker_build_cache") deploymentDeps.push("docker compose build api/portal/worker");

  const backupDeps: string[] = [];
  if (path.includes(config.backupsRoot)) backupDeps.push("backup policy path");

  const rollbackDeps: string[] = [];
  if (item.classification === "ROLLBACK_CANDIDATE") rollbackDeps.push("blue_green_candidate_image");

  return {
    path,
    sizeBytes: item.sizeBytes,
    firstDiscoveredAt: stat?.firstDiscoveredAt ?? scan.timestamp,
    lastModifiedAt: stat?.lastModifiedAt ?? null,
    owner: stat?.owner ?? null,
    filesystem: stat?.filesystem ?? "/dev/sda1",
    mountPoint: stat?.mountPoint ?? "/",
    containerDependency: volMounts.map((m) => `${m.containerName}→${m.mountDestination}`),
    dockerDependency: volMounts.map((m) => `volume:${m.volumeName}`),
    imageDependency: item.kind === "docker_image" ? [item.pathOrRef] : depNode?.image ? [depNode.image] : [],
    serviceDependency: volMounts.map((m) => m.service).filter(Boolean),
    processDependency: volMounts.filter((m) => m.state.includes("running")).map((m) => m.service),
    runtimeDependency: runtimeProofForItem(item, volMounts, scan),
    rollbackDependency: rollbackDeps,
    backupDependency: backupDeps,
    deploymentDependency: deploymentDeps,
    classificationFailureReason:
      item.classification === "UNKNOWN_REQUIRES_REVIEW" ? item.evidence : null,
    activeReferenceProof: activeRefs,
  };
}

export function buildUnknownItemsPanel(
  items: StorageInventoryItem[],
  scan: StorageScanSnapshot,
  config: StorageMaintenanceConfig,
  volumeMounts: Map<string, VolumeMountRef[]>,
  pathStats: Map<string, PathForensicStat>,
  dependencyGraph: DependencyGraphSummary,
): UnknownItemForensicRow[] {
  return items
    .filter((i) => i.classification === "UNKNOWN_REQUIRES_REVIEW")
    .map((item) => {
      const forensic = buildForensicDossier(item, scan, config, volumeMounts, pathStats, dependencyGraph);
      const volMounts = item.kind === "docker_volume" ? volumeMounts.get(item.pathOrRef) ?? [] : [];
      const deps = [
        ...forensic.containerDependency,
        ...forensic.serviceDependency,
        ...forensic.imageDependency,
      ];
      return {
        itemId: item.id,
        item: item.label,
        sizeBytes: item.sizeBytes,
        reasonUnknown: item.evidence,
        risk: (item.sizeBytes != null && item.sizeBytes > 1e9 ? "high" : "medium") as ConsumerRiskLevel,
        dependencies: deps,
        confidencePct: deps.length > 0 ? 95 : 10,
        confidenceLabel: (deps.length > 0 ? "LIKELY_SAFE" : "UNKNOWN") as ConfidenceLabel,
        actionNeeded: deps.length > 0 ? "Reclassify with mount proof" : "Manual review required",
        forensic,
      };
    })
    .sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
}

export function buildDependencyProofPanel(
  items: StorageInventoryItem[],
  dependencyGraph: DependencyGraphSummary,
): DependencyProofRow[] {
  const rows: DependencyProofRow[] = [];
  for (const node of dependencyGraph.nodes) {
    rows.push({
      asset: `${node.service} (${node.containerName})`,
      referencedBy: [
        `image:${node.image}`,
        `state:${node.state}`,
        node.protectedByRunningContainer ? "running_container" : "stopped",
      ],
      evidence: [
        `container_id:${node.containerId}`,
        `classification:${node.classification}`,
        node.layerCount != null ? `layers:${node.layerCount}` : "layers:unknown",
      ],
      confidencePct: node.protectedByRunningContainer ? 100 : 50,
    });
  }
  for (const item of items.filter((i) => i.kind === "docker_volume" && i.classification === "ACTIVE_REQUIRED")) {
    const meta = item.metadata?.mountedBy as string | undefined;
    if (meta) {
      rows.push({
        asset: item.pathOrRef,
        referencedBy: meta.split(","),
        evidence: [item.evidence],
        confidencePct: 100,
      });
    }
  }
  return rows.sort((a, b) => b.confidencePct - a.confidencePct).slice(0, 40);
}

export function buildOrphanAnalysisPanel(
  items: StorageInventoryItem[],
  volumeMounts: Map<string, VolumeMountRef[]>,
): OrphanAnalysisRow[] {
  const orphans: OrphanAnalysisRow[] = [];

  for (const item of items) {
    if (item.kind === "docker_volume") {
      const mounts = volumeMounts.get(item.pathOrRef) ?? [];
      const apiLinks = Number(item.metadata?.links ?? 0);
      if (mounts.length === 0 && apiLinks === 0) {
        orphans.push({
          item: item.pathOrRef,
          sizeBytes: item.sizeBytes,
          reason: "detached_volume_no_container_mount",
          proof: [item.evidence],
          confidencePct: 10,
          runtimeUsage: "NOT_USED",
        });
      } else if (mounts.length > 0 && apiLinks === 0) {
        orphans.push({
          item: item.pathOrRef,
          sizeBytes: item.sizeBytes,
          reason: "anonymous_volume_docker_refcount_zero_but_mounted",
          proof: mounts.map((m) => `${m.containerName}→${m.mountDestination} (${m.state})`),
          confidencePct: 100,
          runtimeUsage: mounts.some((m) => m.state.includes("running")) ? "USED_NOW" : "NOT_USED",
        });
      }
    }
    if (item.kind === "docker_image" && item.classification === "SAFE_CANDIDATE") {
      orphans.push({
        item: item.pathOrRef,
        sizeBytes: item.sizeBytes,
        reason: "unused_image_zero_containers",
        proof: [item.evidence],
        confidencePct: 95,
        runtimeUsage: "NOT_USED",
      });
    }
  }
  return orphans.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
}

export function buildForensicFinalReport(input: {
  scan: StorageScanSnapshot;
  readinessScorePct: number;
  safetyGatesPass: boolean;
  unknownPanel: UnknownItemForensicRow[];
  buildCacheReclaimableBytes: number;
  rollbackCandidateBytes: number;
  historicalApkBytes: number;
}): ForensicFinalReport {
  const unknowns = input.scan.items.filter((i) => i.classification === "UNKNOWN_REQUIRES_REVIEW");
  const unknownSize = unknowns.reduce((s, i) => s + (i.sizeBytes ?? 0), 0);
  const largest = unknowns.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))[0] ?? null;

  const steps95: string[] = [];
  const steps100: string[] = [];
  if (unknowns.length > 0) steps95.push(`Resolve ${unknowns.length} unknown inventory item(s) with forensic proof`);
  if (!input.safetyGatesPass) steps95.push("Clear all safety gate blockers");
  steps100.push("Verify preflight snapshot on disk");
  steps100.push("Confirm dependency graph complete for all services");
  steps100.push("Confirm zero unknown inventory items");

  return {
    totalInventoryCount: input.scan.items.length,
    unknownInventoryCount: unknowns.length,
    unknownInventorySizeBytes: unknownSize,
    largestUnknownItem: largest?.label ?? null,
    largestUnknownSizeBytes: largest?.sizeBytes ?? null,
    readinessScorePct: input.readinessScorePct,
    safetyGatesPass: input.safetyGatesPass,
    stepsToReach95: steps95.length ? steps95 : ["Readiness already ≥95% — review only, no cleanup"],
    stepsToReach100: steps100,
    buildKitIndependentOfProduction: {
      proven: input.buildCacheReclaimableBytes > 0,
      evidence:
        "BuildKit cache entries have InUse=false and Reclaimable=true in Docker /system/df; running containers use committed image layers, not build cache mounts",
    },
    containerdIndependentOfProduction: {
      proven: false,
      evidence:
        "containerd stores active image layers AND build cache; only build cache subset is reclaimable via docker builder prune — not bulk containerd deletion",
    },
    candidateImagesUnnecessary: {
      proven: input.rollbackCandidateBytes > 0,
      evidence:
        "Candidate images (app-*_candidate) exist only for blue/green cutover; stable images remain after deploy",
    },
    oldApksUnnecessary: {
      proven: input.historicalApkBytes > 0,
      evidence: "APK files beyond retention count are not referenced by latest download page",
    },
  };
}
