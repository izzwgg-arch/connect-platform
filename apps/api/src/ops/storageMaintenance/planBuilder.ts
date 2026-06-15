import { randomUUID } from "node:crypto";
import { deriveStorageAlerts } from "./alerts";
import {
  isProtectedPath,
  scanCommandForProtectedPaths,
  validateCleanupCommand,
} from "./protectionRules";
import type {
  CleanupPlan,
  CleanupPlanAction,
  StorageInventoryItem,
  StorageMaintenanceConfig,
  StorageScanSnapshot,
} from "./types";

function daysToDuration(days: number): string {
  const h = Math.max(1, Math.round(days * 24));
  return `${h}h`;
}

export function selectApkRetentionCandidates(
  items: StorageInventoryItem[],
  retentionCount: number,
): StorageInventoryItem[] {
  const apks = items
    .filter((i) => i.kind === "apk_download")
    .sort((a, b) => Number(b.metadata?.mtimeMs ?? 0) - Number(a.metadata?.mtimeMs ?? 0));
  if (apks.length <= retentionCount) return [];
  return apks.slice(retentionCount);
}

function selectInactiveSafeImages(items: StorageInventoryItem[]): StorageInventoryItem[] {
  return items.filter(
    (i) =>
      i.kind === "docker_image" &&
      i.classification === "SAFE_CANDIDATE" &&
      Number(i.metadata?.containers ?? 0) === 0,
  );
}

function selectRollbackImages(items: StorageInventoryItem[]): StorageInventoryItem[] {
  return items.filter((i) => i.kind === "docker_image" && i.classification === "ROLLBACK_CANDIDATE");
}

function guardedAction(
  partial: Omit<CleanupPlanAction, "blocked" | "blockReason"> & { blocked?: boolean; blockReason?: string | null },
  config: StorageMaintenanceConfig,
): CleanupPlanAction {
  const cmdCheck = validateCleanupCommand(partial.command);
  const dryCheck = partial.dryRunCommand ? validateCleanupCommand(partial.dryRunCommand) : { ok: true as const };
  const protectedHits = scanCommandForProtectedPaths(partial.command, config);
  if (partial.targetRef && isProtectedPath(partial.targetRef, config)) {
    protectedHits.push(partial.targetRef);
  }

  let blocked = partial.blocked ?? false;
  let blockReason = partial.blockReason ?? null;

  if (!cmdCheck.ok) {
    blocked = true;
    blockReason = cmdCheck.reason;
  } else if (!dryCheck.ok) {
    blocked = true;
    blockReason = dryCheck.reason;
  } else if (protectedHits.length > 0) {
    blocked = true;
    blockReason = `protected_path_in_command:${protectedHits.join(",")}`;
  } else if (partial.classification === "PROTECTED_NEVER_DELETE" || partial.classification === "ACTIVE_REQUIRED") {
    blocked = true;
    blockReason = `classification_blocked:${partial.classification}`;
  } else if (partial.classification === "UNKNOWN_REQUIRES_REVIEW") {
    blocked = true;
    blockReason = "unknown_requires_review";
  }

  return {
    ...partial,
    blocked,
    blockReason,
  };
}

export function buildCleanupPlan(
  scan: StorageScanSnapshot,
  config: StorageMaintenanceConfig,
): CleanupPlan {
  const planId = randomUUID();
  const actions: CleanupPlanAction[] = [];

  const buildCache = scan.items.find((i) => i.kind === "docker_build_cache");
  const inventoryStatus = scan.docker.buildCache.inventoryStatus ?? "UNAVAILABLE";
  const inventoryOk = inventoryStatus === "OK" && (scan.docker.buildCache.entryCount ?? 0) > 0;
  if (buildCache?.sizeBytes) {
    const filter = `until=${daysToDuration(config.buildCacheRetentionDays)}`;
    const dryRunCommand = `docker builder prune --filter ${filter} --dry-run`;
    const command = `docker builder prune --filter ${filter} --keep-storage 10GB`;
    actions.push(
      guardedAction(
        {
          id: `action:buildcache:${planId.slice(0, 8)}`,
          kind: "docker_builder_prune_filtered",
          label: `Prune BuildKit cache older than ${config.buildCacheRetentionDays} days`,
          targetRef: "docker_buildkit_cache",
          estimatedReclaimBytes: Number(buildCache.metadata?.reclaimableBytes ?? buildCache.reclaimableBytes ?? 0) || null,
          command,
          dryRunCommand,
          classification: buildCache.classification,
          blocked: !inventoryOk,
          blockReason: inventoryOk
            ? null
            : `build_cache_inventory_${inventoryStatus.toLowerCase()}:${scan.docker.buildCache.inventoryError ?? "incomplete"}`,
        },
        config,
      ),
    );
  }

  for (const image of selectInactiveSafeImages(scan.items)) {
    const imageId = String(image.metadata?.imageId ?? image.pathOrRef);
    actions.push(
      guardedAction(
        {
          id: `action:image:${imageId}`,
          kind: "docker_image_rm",
          label: `Remove unused image ${image.label}`,
          targetRef: imageId,
          estimatedReclaimBytes: image.sizeBytes,
          command: `docker image rm ${imageId}`,
          dryRunCommand: `docker image inspect ${imageId}`,
          classification: image.classification,
        },
        config,
      ),
    );
  }

  for (const image of selectRollbackImages(scan.items)) {
    const imageId = String(image.metadata?.imageId ?? image.pathOrRef);
    actions.push(
      guardedAction(
        {
          id: `action:rollback:${imageId}`,
          kind: "docker_image_rm",
          label: `Remove rollback candidate image ${image.label}`,
          targetRef: imageId,
          estimatedReclaimBytes: image.sizeBytes,
          command: `docker image rm ${imageId}`,
          dryRunCommand: `docker image inspect ${imageId}`,
          classification: image.classification,
          blocked: true,
          blockReason: "rollback_candidate_requires_explicit_approval_policy",
        },
        config,
      ),
    );
  }

  for (const apk of selectApkRetentionCandidates(scan.items, config.apkRetentionCount)) {
    actions.push(
      guardedAction(
        {
          id: `action:apk:${apk.label}`,
          kind: "apk_file_rm",
          label: `Remove old APK ${apk.label}`,
          targetRef: apk.pathOrRef,
          estimatedReclaimBytes: apk.sizeBytes,
          command: `rm ${apk.pathOrRef}`,
          dryRunCommand: `ls -la ${apk.pathOrRef}`,
          classification: apk.classification,
        },
        config,
      ),
    );
  }

  const monitoringLogs = scan.items.find((i) => i.pathOrRef === config.monitoringLogsRoot);
  if (monitoringLogs) {
    actions.push(
      guardedAction(
        {
          id: `action:logs:monitoring`,
          kind: "log_directory_trim",
          label: `Trim monitoring logs older than ${config.diagnosticLogRetentionDays} days`,
          targetRef: config.monitoringLogsRoot,
          estimatedReclaimBytes: null,
          command: `find ${config.monitoringLogsRoot} -type f -mtime +${config.diagnosticLogRetentionDays} -print`,
          dryRunCommand: `find ${config.monitoringLogsRoot} -type f -mtime +${config.diagnosticLogRetentionDays} -print`,
          classification: monitoringLogs.classification,
          blocked: true,
          blockReason: "find_print_only_phase1_no_delete",
        },
        config,
      ),
    );
  }

  actions.push(
    guardedAction(
      {
        id: `action:journal:vacuum`,
        kind: "journalctl_vacuum",
        label: "Vacuum systemd journal to 1G max",
        targetRef: "/var/log/journal",
        estimatedReclaimBytes: scan.items.find((i) => i.pathOrRef.includes("/var/log/journal"))?.sizeBytes ?? null,
        command: "journalctl --vacuum-size=1G",
        dryRunCommand: "journalctl --disk-usage",
        classification: "SAFE_CANDIDATE",
      },
      config,
    ),
  );

  const protectedHits = actions
    .filter((a) => a.blockReason?.includes("protected_path"))
    .map((a) => a.targetRef);
  const unknownHits = scan.items
    .filter((i) => i.classification === "UNKNOWN_REQUIRES_REVIEW")
    .map((i) => i.pathOrRef);

  const blockReasons = [
    ...new Set(actions.filter((a) => a.blocked).map((a) => a.blockReason).filter(Boolean) as string[]),
  ];
  const executableActions = actions.filter((a) => !a.blocked);
  const totalEstimatedReclaimBytes = executableActions.reduce(
    (sum, a) => sum + (a.estimatedReclaimBytes ?? 0),
    0,
  );

  const planAlerts = deriveStorageAlerts({
    config,
    diskMounts: scan.diskMounts,
    docker: scan.docker,
    items: scan.items,
    containerdBytes: scan.items.find((i) => i.pathOrRef === config.containerdRoot)?.sizeBytes ?? null,
  });
  if (protectedHits.length > 0) {
    planAlerts.push({
      code: "protected_item_in_plan",
      severity: "critical",
      message: "Cleanup plan touched protected paths and was blocked",
    });
  }

  return {
    planId,
    createdAt: new Date().toISOString(),
    scanId: scan.scanId,
    phase: "dry_run_only",
    approvalRequired: true,
    approvalToken: null,
    actions,
    totalEstimatedReclaimBytes,
    blocked: executableActions.length === 0 || protectedHits.length > 0 || unknownHits.length > 0,
    blockReasons,
    protectedHits,
    unknownHits,
    alerts: planAlerts,
  };
}
