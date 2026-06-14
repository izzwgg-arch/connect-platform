import { loadStorageMaintenanceConfig } from "./dockerDeps";
import { appendStorageAuditEvent, listStorageAuditEvents } from "./auditLog";
import { buildStorageDashboardSummary, buildTrendSeries } from "./dashboard";
import { buildCleanupPlan } from "./planBuilder";
import {
  approveCleanupPlan,
  investigateBuildKit,
  isCleanupExecutionEnabled,
  runCleanupStage,
  runPreCleanupPreparation,
  type ExecutorContext,
} from "./cleanupExecutor/executor";
import {
  loadLatestSnapshotFromDisk,
  resetSnapshotStateForTests,
  writePreflightSnapshot,
} from "./proofSystem/snapshotGenerator";
import { runStorageScan } from "./scanner";
import type { StorageScannerDeps } from "./scanner";
import type {
  CleanupExecutionRecord,
  CleanupPlan,
  CleanupStage,
  StorageHealthSnapshot,
  StorageMaintenanceConfig,
  StorageScanSnapshot,
  StorageTrendPoint,
} from "./types";

const MAX_HISTORY = 48;
let latestScan: StorageScanSnapshot | null = null;
let latestPlan: CleanupPlan | null = null;
const history: StorageTrendPoint[] = [];
const executions: CleanupExecutionRecord[] = [];
let approvedPlanId: string | null = null;
let preCleanupSnapshotPath: string | null = null;
let scanning = false;
let scanError: string | null = null;
let snapshotGenerating = false;
let snapshotError: string | null = null;
let snapshotBootstrapped = false;

async function bootstrapSnapshots(): Promise<void> {
  if (snapshotBootstrapped) return;
  snapshotBootstrapped = true;
  await loadLatestSnapshotFromDisk(loadStorageMaintenanceConfig()).catch(() => undefined);
}

function rootMountFromScan(scan: StorageScanSnapshot | null) {
  if (!scan?.diskMounts?.length) return null;
  return scan.diskMounts.find((m) => m.path === "/" || m.path === "C:\\") ?? scan.diskMounts[0] ?? null;
}

function diskUsedPct(scan: StorageScanSnapshot | null): number | null {
  return rootMountFromScan(scan)?.usedPct ?? null;
}

function pushHistory(scan: StorageScanSnapshot): void {
  const root = rootMountFromScan(scan);
  history.unshift({
    scanId: scan.scanId,
    timestamp: scan.timestamp,
    diskUsedPct: root?.usedPct ?? null,
    usedBytes: root?.usedBytes ?? null,
    freeBytes: root?.freeBytes ?? null,
    totalBytes: root?.totalBytes ?? null,
    reclaimEstimateBytes: scan.reclaimEstimateBytes,
  });
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
}

function buildHealthAlerts(scan: StorageScanSnapshot | null): StorageHealthSnapshot["alerts"] {
  const alerts = [...(scan?.alerts ?? [])];
  if (scan) {
    alerts.push({
      code: "scan_completed" as StorageHealthSnapshot["alerts"][number]["code"],
      severity: "ok",
      message: `Storage scan completed — ${scan.items.length} items inventoried in ${scan.durationMs}ms`,
    });
  }
  return alerts;
}

export function getStorageHealthSnapshot(): StorageHealthSnapshot {
  void bootstrapSnapshots();
  const trends = (["24h", "7d", "30d"] as const).map((window) => buildTrendSeries(history, window));
  return {
    timestamp: new Date().toISOString(),
    latestScan,
    previousScans: [...history],
    trends,
    alerts: buildHealthAlerts(latestScan),
    executions: [...executions],
    dashboard: latestScan?.dashboard ?? null,
    scanning,
    scanError,
    snapshotGenerating,
    snapshotError,
    cleanupEnabled: isCleanupExecutionEnabled(),
    approvedPlanId,
    preCleanupSnapshotPath,
  };
}

function buildExecutorContext(deps: StorageScannerDeps): ExecutorContext {
  const config = deps.config;
  return {
    config,
    deps,
    getLatestScan: () => latestScan,
    getApprovedPlanId: () => approvedPlanId,
    setApprovedPlanId: (id) => {
      approvedPlanId = id;
    },
    getPreCleanupSnapshotPath: () => preCleanupSnapshotPath,
    setPreCleanupSnapshotPath: (p) => {
      preCleanupSnapshotPath = p;
    },
    getExecutions: () => executions,
    pushExecution: (r) => {
      executions.unshift(r);
      if (executions.length > 20) executions.length = 20;
    },
    updateExecution: (id, r) => {
      const idx = executions.findIndex((e) => e.executionId === id);
      if (idx >= 0) executions[idx] = r;
    },
    onAudit: (detail, metadata) => {
      appendStorageAuditEvent({
        type: "execution_started",
        actorUserId: (metadata?.actorUserId as string) ?? null,
        planId: latestPlan?.planId ?? null,
        scanId: latestScan?.scanId ?? null,
        detail,
        metadata,
      });
    },
  };
}

export function getLatestStorageScan(): StorageScanSnapshot | null {
  return latestScan;
}

export function getLatestCleanupPlan(): CleanupPlan | null {
  return latestPlan;
}

export function isStorageScanInProgress(): boolean {
  return scanning;
}

export async function executeStorageScan(
  deps: StorageScannerDeps,
  actorUserId: string | null,
): Promise<StorageScanSnapshot> {
  if (scanning) {
    throw new Error("storage_scan_in_progress");
  }
  scanning = true;
  scanError = null;
  appendStorageAuditEvent({
    type: "scan_started",
    actorUserId,
    detail: "read_only_storage_scan_started",
  });
  try {
    const scan = await runStorageScan(deps);
    latestScan = scan;
    pushHistory(scan);
    appendStorageAuditEvent({
      type: "scan_completed",
      actorUserId,
      scanId: scan.scanId,
      detail: `read_only_storage_scan_completed items=${scan.items.length} reclaim_estimate=${scan.reclaimEstimateBytes}`,
      metadata: { durationMs: scan.durationMs, unknownCount: scan.unknownCount },
    });
    return scan;
  } catch (err) {
    scanError = err instanceof Error ? err.message : "scan_failed";
    throw err;
  } finally {
    scanning = false;
  }
}

export type StorageScanQueueResult = {
  accepted: boolean;
  scanning: boolean;
};

/** Fire-and-forget scan for long-running host inventory (avoids HTTP/nginx timeouts). */
export function queueStorageScan(deps: StorageScannerDeps, actorUserId: string | null): StorageScanQueueResult {
  if (scanning) {
    return { accepted: true, scanning: true };
  }
  scanning = true;
  scanError = null;
  appendStorageAuditEvent({
    type: "scan_started",
    actorUserId,
    detail: "read_only_storage_scan_started_async",
  });
  void (async () => {
    try {
      const scan = await runStorageScan(deps);
      latestScan = scan;
      pushHistory(scan);
      appendStorageAuditEvent({
        type: "scan_completed",
        actorUserId,
        scanId: scan.scanId,
        detail: `read_only_storage_scan_completed items=${scan.items.length} reclaim_estimate=${scan.reclaimEstimateBytes}`,
        metadata: { durationMs: scan.durationMs, unknownCount: scan.unknownCount },
      });
    } catch (err) {
      scanError = err instanceof Error ? err.message : "scan_failed";
      appendStorageAuditEvent({
        type: "scan_completed",
        actorUserId,
        detail: `read_only_storage_scan_failed ${scanError}`,
      });
    } finally {
      scanning = false;
    }
  })();
  return { accepted: true, scanning: true };
}

export function generateCleanupPlanFromLatestScan(
  actorUserId: string | null,
  config: StorageMaintenanceConfig = loadStorageMaintenanceConfig(),
): CleanupPlan {
  if (!latestScan) {
    throw new Error("storage_scan_required");
  }
  const plan = buildCleanupPlan(latestScan, config);
  latestPlan = plan;
  if (latestScan) {
    const ops = latestScan.dashboard?.operationsCenter ?? null;
    latestScan = {
      ...latestScan,
      dashboard: {
        ...buildStorageDashboardSummary(latestScan, config, plan),
        operationsCenter: ops,
      },
    };
  }
  appendStorageAuditEvent({
    type: plan.blocked ? "plan_blocked" : "plan_generated",
    actorUserId,
    scanId: plan.scanId,
    planId: plan.planId,
    detail: plan.blocked
      ? `cleanup_plan_blocked reasons=${plan.blockReasons.join(";")}`
      : `cleanup_plan_generated actions=${plan.actions.length}`,
    metadata: {
      totalEstimatedReclaimBytes: plan.totalEstimatedReclaimBytes,
      blocked: plan.blocked,
    },
  });
  return plan;
}

export function refuseStorageCleanupApproval(actorUserId: string | null): never {
  appendStorageAuditEvent({
    type: "approval_requested",
    actorUserId,
    planId: latestPlan?.planId ?? null,
    scanId: latestScan?.scanId ?? null,
    detail: "approval_refused_cleanup_disabled",
  });
  throw new Error("storage_cleanup_approval_not_enabled");
}

export function approveStorageCleanupPlan(
  deps: StorageScannerDeps,
  actorUserId: string | null,
  planId: string,
): { approved: boolean; planId: string } {
  if (!latestPlan || latestPlan.planId !== planId) {
    throw new Error("cleanup_plan_mismatch");
  }
  if (latestPlan.blocked) throw new Error("cleanup_plan_blocked");
  const ctx = buildExecutorContext(deps);
  approveCleanupPlan(ctx, planId, actorUserId);
  appendStorageAuditEvent({
    type: "approval_granted",
    actorUserId,
    planId,
    scanId: latestScan?.scanId ?? null,
    detail: "cleanup_plan_approved_phase5",
  });
  return { approved: true, planId };
}

export async function prepareStorageCleanup(
  deps: StorageScannerDeps,
  actorUserId: string | null,
): Promise<{ snapshotPath: string }> {
  const ctx = buildExecutorContext(deps);
  const result = await runPreCleanupPreparation(ctx, actorUserId);
  return { snapshotPath: result.snapshotPath };
}

export async function executeStorageCleanupStage(
  deps: StorageScannerDeps,
  actorUserId: string | null,
  stage: CleanupStage,
): Promise<CleanupExecutionRecord> {
  const ctx = buildExecutorContext(deps);
  try {
    const record = await runCleanupStage(ctx, stage, actorUserId);
    appendStorageAuditEvent({
      type: "execution_completed",
      actorUserId,
      planId: latestPlan?.planId ?? null,
      scanId: latestScan?.scanId ?? null,
      detail: `cleanup_stage_${stage}_completed reclaimed=${record.reclaimedBytes}`,
      metadata: { stage, executionId: record.executionId },
    });
    return record;
  } catch (err) {
    appendStorageAuditEvent({
      type: "execution_stopped",
      actorUserId,
      planId: latestPlan?.planId ?? null,
      scanId: latestScan?.scanId ?? null,
      detail: err instanceof Error ? err.message : "cleanup_stage_failed",
      metadata: { stage },
    });
    throw err;
  }
}

export async function getBuildKitInvestigation(deps: StorageScannerDeps) {
  const ctx = buildExecutorContext(deps);
  return investigateBuildKit(ctx);
}

export function refuseStorageCleanupExecution(actorUserId: string | null): never {
  appendStorageAuditEvent({
    type: "execution_refused",
    actorUserId,
    planId: latestPlan?.planId ?? null,
    scanId: latestScan?.scanId ?? null,
    detail: "execution_refused_phase1_read_only",
  });
  throw new Error("storage_cleanup_execution_forbidden_phase1");
}

export function getStorageAuditHistory(limit = 50) {
  return listStorageAuditEvents(limit);
}

export type SnapshotQueueResult = { accepted: boolean; generating: boolean };

export function queuePreflightSnapshot(actorUserId: string | null): SnapshotQueueResult {
  if (!latestScan) {
    snapshotError = "storage_scan_required";
    return { accepted: false, generating: false };
  }
  if (snapshotGenerating) return { accepted: true, generating: true };
  snapshotGenerating = true;
  snapshotError = null;
  const config = loadStorageMaintenanceConfig();
  void (async () => {
    try {
      const result = await writePreflightSnapshot(config, latestScan!);
      appendStorageAuditEvent({
        type: "scan_completed",
        actorUserId,
        scanId: latestScan!.scanId,
        detail: `preflight_snapshot_written path=${result.path}`,
      });
      if (latestScan?.dashboard?.operationsCenter) {
        latestScan = {
          ...latestScan,
          dashboard: {
            ...latestScan.dashboard,
            operationsCenter: {
              ...latestScan.dashboard.operationsCenter,
              snapshotStatus: {
                available: true,
                latestPath: result.path,
                latestTimestamp: result.timestamp,
                latestScanId: latestScan.scanId,
                storageRoot: config.preflightSnapshotRoot,
              },
            },
          },
        };
      }
    } catch (err) {
      snapshotError = err instanceof Error ? err.message : "snapshot_failed";
    } finally {
      snapshotGenerating = false;
    }
  })();
  return { accepted: true, generating: true };
}

export function resetStorageMaintenanceStateForTests(): void {
  latestScan = null;
  latestPlan = null;
  history.length = 0;
  executions.length = 0;
  approvedPlanId = null;
  preCleanupSnapshotPath = null;
  scanning = false;
  scanError = null;
  snapshotGenerating = false;
  snapshotError = null;
  snapshotBootstrapped = false;
  resetSnapshotStateForTests();
}
