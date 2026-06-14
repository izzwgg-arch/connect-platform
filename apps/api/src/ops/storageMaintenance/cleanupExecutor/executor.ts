import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StorageScannerDeps } from "../scanner";
import type {
  BuildKitInvestigation,
  CleanupExecutionRecord,
  CleanupStage,
  StorageMaintenanceConfig,
  StorageScanSnapshot,
} from "../types";
import { evaluateHealthGate } from "./healthGate";
import {
  captureInventoryFingerprint,
  compareInventoryFingerprints,
  readRootDiskBytes,
} from "./inventoryFingerprint";
import { investigateBuildKitCache } from "./buildKitInvestigation";
import { verifyBuildDryRun } from "./commandRunner";
import { writePreCleanupSnapshot } from "./preCleanupSnapshot";
import {
  appendStageToExecution,
  executeStage1,
  executeStage2,
  executeStage3,
  executeStage4,
} from "./stages";

const execFileAsync = promisify(execFile);

export function isCleanupExecutionEnabled(): boolean {
  return (process.env.STORAGE_CLEANUP_ENABLED || "").trim() === "1";
}

export type ExecutorContext = {
  config: StorageMaintenanceConfig;
  deps: StorageScannerDeps;
  getLatestScan: () => StorageScanSnapshot | null;
  getApprovedPlanId: () => string | null;
  setApprovedPlanId: (id: string | null) => void;
  getPreCleanupSnapshotPath: () => string | null;
  setPreCleanupSnapshotPath: (p: string | null) => void;
  getExecutions: () => CleanupExecutionRecord[];
  pushExecution: (r: CleanupExecutionRecord) => void;
  updateExecution: (id: string, r: CleanupExecutionRecord) => void;
  onAudit: (detail: string, metadata?: Record<string, unknown>) => void;
};

async function getSystemDfVText(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", ["system", "df", "-v"], {
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return String(stdout);
  } catch {
    return "";
  }
}

function assertPreconditions(
  ctx: ExecutorContext,
  scan: StorageScanSnapshot | null,
): { scan: StorageScanSnapshot } {
  if (!isCleanupExecutionEnabled()) throw new Error("storage_cleanup_disabled");
  if (!scan) throw new Error("storage_scan_required");
  if (scan.unknownCount > 0) throw new Error("unknown_assets_present");
  const gates = scan.dashboard?.operationsCenter?.safetyGates;
  if (gates?.blocked) throw new Error(`safety_gates_blocked:${gates.reasons.join(",")}`);
  if (!ctx.getApprovedPlanId()) throw new Error("cleanup_not_approved");
  if (!ctx.getPreCleanupSnapshotPath()) throw new Error("precleanup_snapshot_required");
  return { scan };
}

export async function runPreCleanupPreparation(
  ctx: ExecutorContext,
  actorUserId: string | null,
): Promise<{ snapshotPath: string; healthGate: ReturnType<typeof evaluateHealthGate> }> {
  const scan = ctx.getLatestScan();
  if (!scan) throw new Error("storage_scan_required");
  if (scan.unknownCount > 0) throw new Error("unknown_assets_present");

  const containers = await ctx.deps.listContainers();
  const healthGate = evaluateHealthGate(containers);
  if (!healthGate.passed) {
    throw new Error(`health_gate_failed:${healthGate.failures.join(",")}`);
  }

  const disk = await readRootDiskBytes(ctx.config);
  const inventory = await captureInventoryFingerprint(
    {
      listImages: ctx.deps.listImages,
      listContainers: ctx.deps.listContainers,
      listVolumes: ctx.deps.listVolumes,
      getDockerSystemDfText: getSystemDfVText,
    },
    disk,
  );

  const snap = await writePreCleanupSnapshot(ctx.config, scan, inventory, true);
  ctx.setPreCleanupSnapshotPath(snap.path);
  ctx.onAudit(`precleanup_snapshot_written path=${snap.path}`, { actorUserId, healthGate });
  return { snapshotPath: snap.path, healthGate };
}

export function approveCleanupPlan(ctx: ExecutorContext, planId: string, actorUserId: string | null): void {
  if (!isCleanupExecutionEnabled()) throw new Error("storage_cleanup_disabled");
  ctx.setApprovedPlanId(planId);
  ctx.onAudit(`cleanup_plan_approved planId=${planId}`, { actorUserId });
}

export async function runCleanupStage(
  ctx: ExecutorContext,
  stage: CleanupStage,
  actorUserId: string | null,
): Promise<CleanupExecutionRecord> {
  const { scan } = assertPreconditions(ctx, ctx.getLatestScan());
  const containers = await ctx.deps.listContainers();
  const healthBefore = evaluateHealthGate(containers);
  if (!healthBefore.passed) throw new Error(`health_gate_failed:${healthBefore.failures.join(",")}`);

  const diskBefore = await readRootDiskBytes(ctx.config);
  const inventoryBefore = await captureInventoryFingerprint(
    {
      listImages: ctx.deps.listImages,
      listContainers: ctx.deps.listContainers,
      listVolumes: ctx.deps.listVolumes,
      getDockerSystemDfText: getSystemDfVText,
    },
    diskBefore,
  );

  const executionId = randomUUID();
  let record: CleanupExecutionRecord = {
    executionId,
    startedAt: new Date().toISOString(),
    completedAt: null,
    actorUserId,
    planId: ctx.getApprovedPlanId(),
    preCleanupSnapshotPath: ctx.getPreCleanupSnapshotPath(),
    status: "running",
    stoppedReason: null,
    stages: [],
    reclaimedBytes: 0,
    diskBefore,
    diskAfter: null,
    healthBefore,
    healthAfter: null,
    inventoryBefore,
    inventoryAfter: null,
    inventoryCompareOk: null,
    buildVerification: [],
    warnings: [],
  };

  ctx.pushExecution(record);
  ctx.onAudit(`cleanup_stage_${stage}_started`, { executionId, actorUserId });

  let stageResult;
  const systemDfV = stage === 4 ? await getSystemDfVText() : "";
  switch (stage) {
    case 1:
      stageResult = await executeStage1(scan, ctx.config);
      break;
    case 2:
      stageResult = await executeStage2(scan, ctx.config);
      break;
    case 3:
      stageResult = await executeStage3();
      break;
    case 4:
      stageResult = await executeStage4(scan, ctx.config, systemDfV);
      break;
    default:
      throw new Error("invalid_cleanup_stage");
  }

  record = appendStageToExecution(record, stageResult);

  const containersAfter = await ctx.deps.listContainers();
  const healthAfter = evaluateHealthGate(containersAfter);
  const diskAfter = await readRootDiskBytes(ctx.config);
  const inventoryAfter = await captureInventoryFingerprint(
    {
      listImages: ctx.deps.listImages,
      listContainers: ctx.deps.listContainers,
      listVolumes: ctx.deps.listVolumes,
      getDockerSystemDfText: getSystemDfVText,
    },
    diskAfter,
  );
  const compare = compareInventoryFingerprints(inventoryBefore, inventoryAfter);

  record = {
    ...record,
    diskAfter,
    healthAfter,
    inventoryAfter,
    inventoryCompareOk: compare.ok,
    warnings: [...record.warnings, ...stageResult.warnings, ...compare.violations],
    status: stageResult.stopped || !healthAfter.passed || !compare.ok ? "stopped" : "completed",
    stoppedReason:
      stageResult.stopReason ??
      (!healthAfter.passed ? `health_gate_failed_after:${healthAfter.failures.join(",")}` : null) ??
      (!compare.ok ? `inventory_changed:${compare.violations.join(",")}` : null),
    completedAt: new Date().toISOString(),
  };

  if (stage === 4 && !stageResult.stopped) {
    for (const svc of ["api", "portal", "worker", "telephony"] as const) {
      const dry = await verifyBuildDryRun(svc);
      record.buildVerification.push({
        service: svc,
        ok: dry.exitCode === 0,
        command: dry.command,
        detail: dry.exitCode === 0 ? "dry_run_ok" : dry.stderr.slice(0, 300),
      });
    }
  }

  ctx.updateExecution(executionId, record);
  ctx.onAudit(`cleanup_stage_${stage}_finished status=${record.status}`, {
    executionId,
    reclaimedBytes: record.reclaimedBytes,
    stopped: record.status === "stopped",
  });

  if (record.status === "stopped") {
    throw new Error(record.stoppedReason ?? "cleanup_stage_stopped");
  }

  return record;
}

export async function investigateBuildKit(ctx: ExecutorContext): Promise<BuildKitInvestigation> {
  const text = await getSystemDfVText();
  return investigateBuildKitCache(text);
}
