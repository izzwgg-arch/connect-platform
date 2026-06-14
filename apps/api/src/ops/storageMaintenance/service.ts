import { loadStorageMaintenanceConfig } from "./dockerDeps";
import { appendStorageAuditEvent, listStorageAuditEvents } from "./auditLog";
import { buildCleanupPlan } from "./planBuilder";
import { runStorageScan } from "./scanner";
import type { StorageScannerDeps } from "./scanner";
import type {
  CleanupPlan,
  StorageHealthSnapshot,
  StorageMaintenanceConfig,
  StorageScanSnapshot,
} from "./types";

const MAX_HISTORY = 48;
let latestScan: StorageScanSnapshot | null = null;
let latestPlan: CleanupPlan | null = null;
const history: StorageHealthSnapshot["previousScans"] = [];
let scanning = false;

function diskUsedPct(scan: StorageScanSnapshot | null): number | null {
  if (!scan?.diskMounts?.length) return null;
  const root = scan.diskMounts.find((m) => m.path === "/") ?? scan.diskMounts[0];
  return root?.usedPct ?? null;
}

function pushHistory(scan: StorageScanSnapshot): void {
  history.unshift({
    scanId: scan.scanId,
    timestamp: scan.timestamp,
    diskUsedPct: diskUsedPct(scan),
    reclaimEstimateBytes: scan.reclaimEstimateBytes,
  });
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
}

export function getStorageHealthSnapshot(): StorageHealthSnapshot {
  return {
    timestamp: new Date().toISOString(),
    latestScan,
    previousScans: [...history],
    alerts: latestScan?.alerts ?? [],
    executions: [],
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
  if (scanning && latestScan) return latestScan;
  scanning = true;
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
  } finally {
    scanning = false;
  }
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
}
