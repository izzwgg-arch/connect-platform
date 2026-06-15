import type {
  BuildKitInvestigation,
  CleanupExecutionRecord,
  CleanupStage,
  CleanupStageResult,
  StorageMaintenanceConfig,
  StorageScanSnapshot,
} from "../types";
import { selectApkRetentionCandidates } from "../planBuilder";
import { isProtectedImageRef } from "../protectionRules";
import {
  dockerBuilderPruneDryRun,
  dockerBuilderPruneUnusedOnly,
  dockerImageRm,
  journalVacuumTo1G,
  removeApkViaHostBind,
  type CommandRunResult,
} from "./commandRunner";
import { apkHostPath } from "./executionPaths";

function stageLabel(stage: CleanupStage): string {
  return (
    {
      1: "Remove postgres:16-alpine",
      2: "Remove historical APKs",
      3: "Vacuum systemd journal",
      4: "Prune unused BuildKit cache",
    } as const
  )[stage];
}

export async function executeStage1(
  scan: StorageScanSnapshot,
  config: StorageMaintenanceConfig,
): Promise<CleanupStageResult> {
  const target = scan.items.find(
    (i) =>
      i.kind === "docker_image" &&
      i.classification === "SAFE_CANDIDATE" &&
      i.pathOrRef.includes("postgres:16-alpine"),
  );
  if (!target) {
    return {
      stage: 1,
      label: stageLabel(1),
      stopped: true,
      stopReason: "target_not_found:postgres:16-alpine",
      reclaimedBytes: 0,
      commands: [],
      warnings: [],
    };
  }
  const repo = String(target.metadata?.repository ?? "postgres");
  const tag = String(target.metadata?.tag ?? "16-alpine");
  if (isProtectedImageRef(repo, tag, Number(target.metadata?.containers ?? 0))) {
    return {
      stage: 1,
      label: stageLabel(1),
      stopped: true,
      stopReason: "protected_image_ref",
      reclaimedBytes: 0,
      commands: [],
      warnings: [],
    };
  }
  const imageRef = target.pathOrRef;
  const cmd = await dockerImageRm(imageRef);
  if (cmd.exitCode !== 0) {
    return {
      stage: 1,
      label: stageLabel(1),
      stopped: true,
      stopReason: `command_failed:${cmd.stderr.slice(0, 200)}`,
      reclaimedBytes: 0,
      commands: [cmd],
      warnings: [],
    };
  }
  return {
    stage: 1,
    label: stageLabel(1),
    stopped: false,
    stopReason: null,
    reclaimedBytes: target.sizeBytes ?? 0,
    commands: [cmd],
    warnings: [],
  };
}

export async function executeStage2(
  scan: StorageScanSnapshot,
  config: StorageMaintenanceConfig,
): Promise<CleanupStageResult> {
  const apks = selectApkRetentionCandidates(scan.items, config.apkRetentionCount);
  const commands: CommandRunResult[] = [];
  let reclaimed = 0;
  const warnings: string[] = [];

  for (const apk of apks) {
    if (apk.metadata?.isLatestRelease === true) {
      warnings.push(`skipped_latest:${apk.label}`);
      continue;
    }
    const hostPath = apkHostPath(apk.pathOrRef, config);
    const cmd = await removeApkViaHostBind(hostPath);
    commands.push(cmd);
    if (cmd.exitCode !== 0) {
      return {
        stage: 2,
        label: stageLabel(2),
        stopped: true,
        stopReason: `apk_delete_failed:${apk.label}`,
        reclaimedBytes: reclaimed,
        commands,
        warnings,
      };
    }
    reclaimed += apk.sizeBytes ?? 0;
  }

  return {
    stage: 2,
    label: stageLabel(2),
    stopped: false,
    stopReason: null,
    reclaimedBytes: reclaimed,
    commands,
    warnings,
  };
}

export async function executeStage3(): Promise<CleanupStageResult> {
  const cmd = await journalVacuumTo1G();
  if (cmd.exitCode !== 0) {
    return {
      stage: 3,
      label: stageLabel(3),
      stopped: true,
      stopReason: `journal_vacuum_failed:${cmd.stderr.slice(0, 200)}`,
      reclaimedBytes: 0,
      commands: [cmd],
      warnings: [],
    };
  }
  return {
    stage: 3,
    label: stageLabel(3),
    stopped: false,
    stopReason: null,
    reclaimedBytes: null,
    commands: [cmd],
    warnings: ["journal_reclaim_bytes_measured_post_scan"],
  };
}

export async function executeStage4(
  scan: StorageScanSnapshot,
  config: StorageMaintenanceConfig,
  investigation: BuildKitInvestigation,
): Promise<CleanupStageResult> {
  if (!investigation.safeToPrune) {
    return {
      stage: 4,
      label: stageLabel(4),
      stopped: true,
      stopReason: investigation.cleanupBlockedReason ?? `buildkit_not_safe:confidence=${investigation.confidencePct}`,
      reclaimedBytes: 0,
      commands: [],
      warnings: investigation.whyNot99Plus,
      buildKitInvestigation: investigation,
    };
  }

  const dry = await dockerBuilderPruneDryRun(config.buildCacheRetentionDays);
  const prune = await dockerBuilderPruneUnusedOnly(config.buildCacheRetentionDays);
  const commands = [dry, prune];
  if (prune.exitCode !== 0) {
    return {
      stage: 4,
      label: stageLabel(4),
      stopped: true,
      stopReason: `builder_prune_failed:${prune.stderr.slice(0, 200)}`,
      reclaimedBytes: 0,
      commands,
      warnings: investigation.whyNot99Plus,
      buildKitInvestigation: investigation,
    };
  }

  return {
    stage: 4,
    label: stageLabel(4),
    stopped: false,
    stopReason: null,
    reclaimedBytes: investigation.inactiveBytes,
    commands,
    warnings: investigation.whyNot99Plus,
    buildKitInvestigation: investigation,
  };
}

export function appendStageToExecution(
  record: CleanupExecutionRecord,
  result: CleanupStageResult,
): CleanupExecutionRecord {
  const stages = [...record.stages, result];
  const stopped = result.stopped;
  return {
    ...record,
    stages,
    status: stopped ? "stopped" : record.status === "completed" ? "completed" : "running",
    stoppedReason: stopped ? result.stopReason : record.stoppedReason,
    reclaimedBytes: (record.reclaimedBytes ?? 0) + (result.reclaimedBytes ?? 0),
    completedAt: stopped ? new Date().toISOString() : record.completedAt,
  };
}
