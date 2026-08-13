import type { DiskMountSnapshot, HealthStatus } from "../hostMetrics";

export const STORAGE_CLASSIFICATIONS = [
  "PROTECTED_NEVER_DELETE",
  "ACTIVE_REQUIRED",
  "ROLLBACK_CANDIDATE",
  "SAFE_CANDIDATE",
  "UNKNOWN_REQUIRES_REVIEW",
] as const;

export type StorageClassification = (typeof STORAGE_CLASSIFICATIONS)[number];

export type StorageItemKind =
  | "filesystem_path"
  | "docker_build_cache"
  | "docker_image"
  | "docker_container"
  | "docker_volume"
  | "bind_mount"
  | "apk_download"
  | "log_directory"
  | "diagnostic_dump";

export type StorageInventoryItem = {
  id: string;
  kind: StorageItemKind;
  label: string;
  pathOrRef: string;
  sizeBytes: number | null;
  classification: StorageClassification;
  evidence: string;
  reclaimableBytes: number | null;
  metadata?: Record<string, string | number | boolean | null>;
};

export type StorageAlertCode =
  | "disk_usage_warning"
  | "disk_usage_critical"
  | "containerd_usage_warning"
  | "containerd_usage_critical"
  | "buildkit_cache_warning"
  | "buildkit_cache_critical"
  | "free_space_low"
  | "free_space_critical"
  | "protected_item_in_plan"
  | "cleanup_failed"
  | "unknown_items_present"
  | "scan_completed";

export type StorageAlert = {
  code: StorageAlertCode;
  severity: HealthStatus;
  message: string;
  thresholdPct?: number;
  observedPct?: number;
  observedBytes?: number;
};

export type BuildKitInventoryStatus =
  | "OK"
  | "UNAVAILABLE"
  | "PERMISSION_DENIED"
  | "PARSE_FAILED"
  | "TIMEOUT";

export type DockerBuildCacheSummary = {
  entryCount: number | null;
  totalBytes: number | null;
  reclaimableBytes: number | null;
  source: "docker_system_df" | "unavailable";
  inventoryStatus?: BuildKitInventoryStatus;
  inventoryError?: string | null;
  hostDetectedTotalBytes?: number | null;
  hostDetectedEntryCount?: number | null;
  collectionSource?: "docker_system_df_api" | "docker_system_df_cli" | "docker_builder_du" | "none";
};

export type DockerSystemSummary = {
  imagesCount: number;
  imagesBytes: number | null;
  imagesReclaimableBytes: number | null;
  containersCount: number;
  containersBytes: number | null;
  volumesCount: number;
  volumesBytes: number | null;
  buildCache: DockerBuildCacheSummary;
};

export type StorageRiskLevel = "low" | "medium" | "high" | "critical";

export type ConsumerRiskLevel = "low" | "medium" | "high" | "critical";

export type ConsumerActionability = "locked" | "review" | "eligible" | "blocked";

export type StorageDistributionCategory =
  | "build_cache"
  | "application"
  | "downloads"
  | "logs"
  | "database"
  | "redis"
  | "docker_volumes"
  | "other";

export type StorageConsumerRow = {
  rank: number;
  path: string;
  label: string;
  sizeBytes: number | null;
  classification: StorageClassification;
  risk: ConsumerRiskLevel;
  actionability: ConsumerActionability;
  kind: StorageItemKind;
};

export type StorageDistributionSlice = {
  category: StorageDistributionCategory;
  label: string;
  sizeBytes: number;
  pct: number;
};

export type ProtectedAssetRow = {
  id: string;
  label: string;
  category: "volume" | "image" | "path" | "database" | "bind_mount" | "service";
  pathOrRef: string;
  sizeBytes: number | null;
  status: "protected" | "locked";
  detail: string;
};

export type CleanupReadinessRow = {
  category: string;
  sizeBytes: number;
  risk: ConsumerRiskLevel;
  status: "eligible" | "review_required" | "blocked";
  classification: StorageClassification;
};

export type TrendDirection = "increasing" | "stable" | "decreasing";

export type StorageTrendPoint = {
  timestamp: string;
  scanId: string;
  diskUsedPct: number | null;
  usedBytes: number | null;
  freeBytes: number | null;
  totalBytes: number | null;
  reclaimEstimateBytes: number;
};

export type StorageTrendSeries = {
  window: "24h" | "7d" | "30d";
  direction: TrendDirection;
  directionPctDelta: number | null;
  points: StorageTrendPoint[];
};

export type ContainerdBreakdown = {
  totalBytes: number | null;
  overlaySnapshotsBytes: number | null;
  contentBlobsBytes: number | null;
  snapshotCount: number | null;
};

export type HostVisibilitySnapshot = {
  hostInventoryRoot: string | null;
  dockerSocket: string;
  dockerSocketReachable: boolean;
  containerdMount: boolean;
  connectcommsMount: boolean;
  varLogMount: boolean;
};

export type StorageDashboardSummary = {
  totalDiskBytes: number | null;
  usedBytes: number | null;
  freeBytes: number | null;
  usedPct: number | null;
  buildCacheBytes: number | null;
  containerdBytes: number | null;
  containerdOverlayBytes: number | null;
  containerdContentBytes: number | null;
  reclaimableBytes: number;
  protectedDataBytes: number;
  riskLevel: StorageRiskLevel;
  projectedUsageAfterCleanupBytes: number | null;
  projectedRecoveryBytes: number;
  projectedFreeBytesAfterCleanup: number | null;
  largestConsumers: StorageConsumerRow[];
  protectedAssets: ProtectedAssetRow[];
  distribution: StorageDistributionSlice[];
  cleanupReadiness: CleanupReadinessRow[];
  operationsCenter: StorageOperationsCenter | null;
};

export type ConfidenceLabel = "SAFE" | "LIKELY_SAFE" | "REVIEW_REQUIRED" | "BLOCKED" | "UNKNOWN";

export type BuildCacheEntryRow = {
  cacheId: string;
  sizeBytes: number;
  createdAt: string | null;
  lastUsedAt: string | null;
  ageDays: number | null;
  buildStage: string | null;
  sourceDockerfile: string | null;
  relatedImage: string | null;
  referencedByActiveImage: boolean;
  referencedByRunningContainer: boolean;
  referencedByRollbackImage: boolean;
  confidencePct: number;
  confidenceLabel: ConfidenceLabel;
};

export type BuildCacheAnalysis = {
  totalEntries: number;
  totalBytes: number;
  referencedBytes: number;
  unusedBytes: number;
  unknownBytes: number;
  entries: BuildCacheEntryRow[];
  topEntries: BuildCacheEntryRow[];
};

export type DependencyGraphNode = {
  service: string;
  containerName: string;
  containerId: string;
  image: string;
  imageId: string | null;
  state: string;
  sizeBytes: number | null;
  classification: StorageClassification;
  protectedByRunningContainer: boolean;
  layerCount: number | null;
};

export type DependencyGraphSummary = {
  nodes: DependencyGraphNode[];
  runningContainerCount: number;
  mappedServiceCount: number;
  incomplete: boolean;
  incompleteReason: string | null;
};

export type RollbackCoverageRow = {
  service: string;
  image: string;
  tag: string;
  sizeBytes: number | null;
  classification: StorageClassification;
  rollbackAvailable: boolean;
  deploymentHint: string | null;
};

export type ApkForensicsRow = {
  filename: string;
  path: string;
  sizeBytes: number;
  buildDate: string | null;
  version: string | null;
  releaseDate: string | null;
  isLatestRelease: boolean;
  referencedByDownloadPage: boolean;
};

export type ApkForensicsSummary = {
  totalBytes: number;
  latestReleases: ApkForensicsRow[];
  historicalReleases: ApkForensicsRow[];
  entries: ApkForensicsRow[];
};

export type LogForensicsRow = {
  path: string;
  label: string;
  sizeBytes: number | null;
  oldestFile: string | null;
  newestFile: string | null;
  oldestDate: string | null;
  newestDate: string | null;
  growthRateBytesPerDay: number | null;
};

export type LogForensicsSummary = {
  totalBytes: number;
  locations: LogForensicsRow[];
};

export type ConfidenceDistributionSlice = {
  label: ConfidenceLabel;
  count: number;
  sizeBytes: number;
  pct: number;
};

export type CleanupCandidateRow = {
  id: string;
  label: string;
  pathOrRef: string;
  sizeBytes: number | null;
  classification: StorageClassification;
  confidencePct: number;
  confidenceLabel: ConfidenceLabel;
  kind: StorageItemKind;
};

export type RuntimeUsageProof =
  | "USED_NOW"
  | "USED_DURING_DEPLOY"
  | "USED_FOR_ROLLBACK"
  | "USED_FOR_RECOVERY"
  | "NOT_USED"
  | "LIKELY_SAFE";

export type BlockerRow = {
  id: string;
  label: string;
  pathOrRef: string;
  reason: string;
  sizeBytes: number | null;
};

export type SafetyGateResult = {
  blocked: boolean;
  reasons: string[];
  blockers: BlockerRow[];
};

export type SnapshotStatus = {
  available: boolean;
  latestPath: string | null;
  latestTimestamp: string | null;
  latestScanId: string | null;
  storageRoot: string;
};

export type ForensicDossier = {
  path: string;
  sizeBytes: number | null;
  firstDiscoveredAt: string | null;
  lastModifiedAt: string | null;
  owner: string | null;
  filesystem: string | null;
  mountPoint: string | null;
  containerDependency: string[];
  dockerDependency: string[];
  imageDependency: string[];
  serviceDependency: string[];
  processDependency: string[];
  runtimeDependency: RuntimeUsageProof;
  rollbackDependency: string[];
  backupDependency: string[];
  deploymentDependency: string[];
  classificationFailureReason: string | null;
  activeReferenceProof: string[];
};

export type UnknownItemForensicRow = {
  itemId: string;
  item: string;
  sizeBytes: number | null;
  reasonUnknown: string;
  risk: ConsumerRiskLevel;
  dependencies: string[];
  confidencePct: number;
  confidenceLabel: ConfidenceLabel;
  actionNeeded: string;
  forensic: ForensicDossier;
};

export type DependencyProofRow = {
  asset: string;
  referencedBy: string[];
  evidence: string[];
  confidencePct: number;
};

export type OrphanAnalysisRow = {
  item: string;
  sizeBytes: number | null;
  reason: string;
  proof: string[];
  confidencePct: number;
  runtimeUsage: RuntimeUsageProof;
};

export type ReadinessCategoryBreakdown = {
  category: string;
  readinessPct: number;
  itemCount: number;
  unknownCount: number;
  blocked: boolean;
  detail: string;
};

export type ReadinessBreakdownSummary = {
  categories: ReadinessCategoryBreakdown[];
  overallPct: number;
};

export type ContainerdCategory = "ACTIVE" | "ROLLBACK" | "ORPHANED" | "UNKNOWN";

export type ContainerdForensicsSummary = {
  totalBytes: number;
  overlayBytes: number;
  contentBytes: number;
  snapshotCount: number | null;
  buildCacheBytes: number;
  buildCacheEntries: number;
  categories: Array<{
    category: ContainerdCategory;
    label: string;
    sizeBytes: number;
    entryCount: number;
    referencedCount: number;
    unreferencedCount: number;
    activeDependencyCount: number;
  }>;
};

export type BuildCacheGroupRow = {
  group: string;
  sizeBytes: number;
  entryCount: number;
  oldestAgeDays: number | null;
  newestAgeDays: number | null;
  lastUsedAgeDays: number | null;
  referenceCount: number;
  productionDependent: boolean;
  confidencePct: number;
};

export type ForensicFinalReport = {
  totalInventoryCount: number;
  unknownInventoryCount: number;
  unknownInventorySizeBytes: number;
  largestUnknownItem: string | null;
  largestUnknownSizeBytes: number | null;
  readinessScorePct: number;
  safetyGatesPass: boolean;
  stepsToReach95: string[];
  stepsToReach100: string[];
  buildKitIndependentOfProduction: { proven: boolean; evidence: string };
  containerdIndependentOfProduction: { proven: boolean; evidence: string };
  candidateImagesUnnecessary: { proven: boolean; evidence: string };
  oldApksUnnecessary: { proven: boolean; evidence: string };
};

export type StorageOperationsCenter = {
  buildCacheAnalysis: BuildCacheAnalysis;
  dependencyGraph: DependencyGraphSummary;
  rollbackCoverage: RollbackCoverageRow[];
  apkForensics: ApkForensicsSummary;
  logForensics: LogForensicsSummary;
  confidenceDistribution: ConfidenceDistributionSlice[];
  cleanupCandidates: CleanupCandidateRow[];
  readinessScorePct: number;
  readinessLabel: "READY_FOR_REVIEW" | "BLOCKED" | "HIGH_RISK" | "INCOMPLETE";
  readinessDetail: string;
  safetyGates: SafetyGateResult;
  snapshotStatus: SnapshotStatus;
  riskMatrix: Array<{
    category: string;
    risk: ConsumerRiskLevel;
    sizeBytes: number;
    confidenceLabel: ConfidenceLabel;
    blocked: boolean;
  }>;
  unknownItemsPanel: UnknownItemForensicRow[];
  dependencyProofPanel: DependencyProofRow[];
  orphanAnalysisPanel: OrphanAnalysisRow[];
  readinessBreakdown: ReadinessBreakdownSummary;
  containerdForensics: ContainerdForensicsSummary;
  buildCacheGroups: BuildCacheGroupRow[];
  forensicReport: ForensicFinalReport;
};

export type StorageScanSnapshot = {
  scanId: string;
  timestamp: string;
  hostname: string;
  durationMs: number;
  readOnly: true;
  diskMounts: DiskMountSnapshot[];
  docker: DockerSystemSummary;
  items: StorageInventoryItem[];
  reclaimEstimateBytes: number;
  alerts: StorageAlert[];
  unknownCount: number;
  protectedCount: number;
  dashboard: StorageDashboardSummary;
  hostVisibility: HostVisibilitySnapshot;
  containerd: ContainerdBreakdown;
};

export type CleanupPlanActionKind =
  | "docker_builder_prune_filtered"
  | "docker_image_rm"
  | "apk_file_rm"
  | "log_directory_trim"
  | "journalctl_vacuum";

export type CleanupPlanAction = {
  id: string;
  kind: CleanupPlanActionKind;
  label: string;
  targetRef: string;
  estimatedReclaimBytes: number | null;
  command: string;
  dryRunCommand: string | null;
  classification: StorageClassification;
  blocked: boolean;
  blockReason: string | null;
};

export type CleanupPlan = {
  planId: string;
  createdAt: string;
  scanId: string;
  phase: "dry_run_only" | "phase5_controlled";
  approvalRequired: true;
  approvalToken: string | null;
  actions: CleanupPlanAction[];
  totalEstimatedReclaimBytes: number;
  blocked: boolean;
  blockReasons: string[];
  protectedHits: string[];
  unknownHits: string[];
  alerts: StorageAlert[];
};

export type CleanupStage = 1 | 2 | 3 | 4;

export type HealthGateServiceRow = {
  service: string;
  label: string;
  containerName: string | null;
  running: boolean;
  healthy: boolean;
  detail: string;
};

export type HealthGateResult = {
  passed: boolean;
  checkedAt: string;
  services: HealthGateServiceRow[];
  failures: string[];
};

export type InventoryFingerprint = {
  capturedAt: string;
  diskUsedBytes: number | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  imageRefs: string[];
  containerNames: string[];
  volumeNames: string[];
  rollbackImageRefs: string[];
  protectedImageRefs: string[];
  dockerSystemDfExcerpt: string;
};

export type BuildKitCacheEntryStat = {
  cacheId: string;
  cacheType: string;
  sizeBytes: number;
  usageCount: number;
  referenced: boolean;
  incomplete?: boolean;
  reclaimable?: boolean;
  lastUsedAt?: string | null;
  createdAt?: string | null;
};

export type BuildKitInvestigation = {
  investigatedAt: string;
  totalEntries: number;
  activeReferences: number;
  inactiveReferences: number;
  unknownReferences: number;
  totalBytes: number;
  activeBytes: number;
  inactiveBytes: number;
  unknownBytes: number;
  confidencePct: number;
  confidenceLabel: "HIGH" | "MEDIUM" | "LOW";
  whyNot99Plus: string[];
  safeToPrune: boolean;
  inventoryStatus: BuildKitInventoryStatus;
  inventoryError: string | null;
  collectionSource: DockerBuildCacheSummary["collectionSource"];
  cleanupBlockedReason: string | null;
  entries: BuildKitCacheEntryStat[];
};

export type CleanupStageResult = {
  stage: CleanupStage;
  label: string;
  stopped: boolean;
  stopReason: string | null;
  reclaimedBytes: number | null;
  commands: Array<{
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
  }>;
  warnings: string[];
  buildKitInvestigation?: BuildKitInvestigation;
};

export type CleanupExecutionRecord = {
  executionId: string;
  startedAt: string;
  completedAt: string | null;
  actorUserId: string | null;
  planId: string | null;
  preCleanupSnapshotPath: string | null;
  status: "running" | "completed" | "stopped" | "failed";
  stoppedReason: string | null;
  stages: CleanupStageResult[];
  reclaimedBytes: number;
  diskBefore: { usedBytes: number | null; freeBytes: number | null; totalBytes: number | null };
  diskAfter: { usedBytes: number | null; freeBytes: number | null; totalBytes: number | null } | null;
  healthBefore: HealthGateResult;
  healthAfter: HealthGateResult | null;
  inventoryBefore: InventoryFingerprint;
  inventoryAfter: InventoryFingerprint | null;
  inventoryCompareOk: boolean | null;
  buildVerification: Array<{ service: string; ok: boolean; command: string; detail: string }>;
  warnings: string[];
};

export type PreCleanupSnapshotPayload = {
  generatedAt: string;
  scanId: string;
  phase: "precleanup_phase5";
  readOnly: false;
  healthGatePassed: boolean;
  inventory: InventoryFingerprint;
  scan: StorageScanSnapshot;
  dependencyGraph: DependencyGraphSummary | null;
  rollbackCoverage: RollbackCoverageRow[] | null;
  reclaimCandidates: CleanupCandidateRow[];
  safetyGates: SafetyGateResult | null;
};

export type StorageAuditEventType =
  | "scan_started"
  | "scan_completed"
  | "plan_generated"
  | "plan_blocked"
  | "approval_requested"
  | "approval_granted"
  | "execution_refused"
  | "execution_started"
  | "execution_completed"
  | "execution_stopped";

export type StorageAuditEvent = {
  id: string;
  at: string;
  type: StorageAuditEventType;
  actorUserId: string | null;
  scanId: string | null;
  planId: string | null;
  detail: string;
  metadata?: Record<string, unknown>;
};

export type StorageHealthSnapshot = {
  timestamp: string;
  latestScan: StorageScanSnapshot | null;
  previousScans: StorageTrendPoint[];
  trends: StorageTrendSeries[];
  alerts: StorageAlert[];
  executions: CleanupExecutionRecord[];
  dashboard: StorageDashboardSummary | null;
  scanning: boolean;
  scanError: string | null;
  snapshotGenerating: boolean;
  snapshotError: string | null;
  cleanupEnabled: boolean;
  approvedPlanId: string | null;
  preCleanupSnapshotPath: string | null;
  buildKitInventory?: {
    hostDetectedTotalBytes: number | null;
    apiEntryCount: number;
    inventoryStatus: BuildKitInventoryStatus;
    inventoryError: string | null;
    collectionSource: DockerBuildCacheSummary["collectionSource"];
    cleanupBlockedReason: string | null;
    safeToPrune: boolean;
  };
};

export type StorageMaintenanceConfig = {
  diskWarningPct: number;
  diskCriticalPct: number;
  containerdWarningBytes: number;
  containerdCriticalBytes: number;
  buildkitWarningBytes: number;
  buildkitCriticalBytes: number;
  freeSpaceWarningBytes: number;
  freeSpaceCriticalBytes: number;
  buildCacheRetentionDays: number;
  apkRetentionCount: number;
  diagnosticLogRetentionDays: number;
  appRoot: string;
  appCloneRoot: string;
  dataRoot: string;
  envRoot: string;
  backupsRoot: string;
  downloadsRoot: string;
  monitoringLogsRoot: string;
  containerdRoot: string;
  journalRoot: string;
  deployLogsRoot: string;
  hostInventoryRoot: string;
  preflightSnapshotRoot: string;
};
