import { loadStorageMaintenanceConfig } from "./dockerDeps";
import { appendStorageAuditEvent, listStorageAuditEvents } from "./auditLog";
import { buildStorageDashboardSummary, buildTrendSeries } from "./dashboard";
import { buildCleanupPlan } from "./planBuilder";
import { runStorageScan } from "./scanner";
import type { StorageScannerDeps } from "./scanner";
import type {
  CleanupPlan,
  StorageHealthSnapshot,
  StorageMaintenanceConfig,
  StorageScanSnapshot,
  StorageTrendPoint,
} from "./types";

const MAX_HISTORY = 48;
let latestScan: StorageScanSnapshot | null = null;
let latestPlan: CleanupPlan | null = null;
const history: StorageTrendPoint[] = [];
let scanning = false;
let scanError: string | null = null;

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
  const trends = (["24h", "7d", "30d"] as const).map((window) => buildTrendSeries(history, window));
  return {
    timestamp: new Date().toISOString(),
    latestScan,
    previousScans: [...history],
    trends,
    alerts: buildHealthAlerts(latestScan),
    executions: [],
    dashboard: latestScan?.dashboard ?? null,
    scanning,
    scanError,
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
    latestScan = {
      ...latestScan,
      dashboard: buildStorageDashboardSummary(latestScan, config, plan),
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
    detail: "approval_refused_phase2_not_implemented",
  });
  throw new Error("storage_cleanup_approval_not_implemented");
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

export function resetStorageMaintenanceStateForTests(): void {
  latestScan = null;
  latestPlan = null;
  history.length = 0;
  scanning = false;
  scanError = null;
}
