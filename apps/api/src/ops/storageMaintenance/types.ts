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
  | "unknown_items_present";

export type StorageAlert = {
  code: StorageAlertCode;
  severity: HealthStatus;
  message: string;
  thresholdPct?: number;
  observedPct?: number;
  observedBytes?: number;
};

export type DockerBuildCacheSummary = {
  entryCount: number | null;
  totalBytes: number | null;
  reclaimableBytes: number | null;
  source: "docker_system_df" | "unavailable";
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
  phase: "dry_run_only";
  approvalRequired: true;
  approvalToken: null;
  actions: CleanupPlanAction[];
  totalEstimatedReclaimBytes: number;
  blocked: boolean;
  blockReasons: string[];
  protectedHits: string[];
  unknownHits: string[];
  alerts: StorageAlert[];
};

export type StorageAuditEventType =
  | "scan_started"
  | "scan_completed"
  | "plan_generated"
  | "plan_blocked"
  | "approval_requested"
  | "execution_refused";

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
  previousScans: Array<{
    scanId: string;
    timestamp: string;
    diskUsedPct: number | null;
    reclaimEstimateBytes: number;
  }>;
  alerts: StorageAlert[];
  executions: [];
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
  dataRoot: string;
  envRoot: string;
  backupsRoot: string;
  downloadsRoot: string;
  monitoringLogsRoot: string;
  containerdRoot: string;
};
