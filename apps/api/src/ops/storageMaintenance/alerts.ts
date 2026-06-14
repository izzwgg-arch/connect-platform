import type { DiskMountSnapshot, HealthStatus } from "../hostMetrics";
import type {
  DockerSystemSummary,
  StorageAlert,
  StorageInventoryItem,
  StorageMaintenanceConfig,
} from "./types";

type AlertInput = {
  config: StorageMaintenanceConfig;
  diskMounts: DiskMountSnapshot[];
  docker: DockerSystemSummary;
  items: StorageInventoryItem[];
  containerdBytes: number | null;
};

function rootMount(mounts: DiskMountSnapshot[]): DiskMountSnapshot | null {
  return mounts.find((m) => m.path === "/" || m.path === "C:\\") ?? mounts[0] ?? null;
}

function pctUsed(m: DiskMountSnapshot): number {
  return m.usedPct;
}

function pushAlert(
  alerts: StorageAlert[],
  code: StorageAlert["code"],
  severity: HealthStatus,
  message: string,
  extra?: Partial<StorageAlert>,
): void {
  alerts.push({ code, severity, message, ...extra });
}

export function deriveStorageAlerts(input: AlertInput): StorageAlert[] {
  const { config, diskMounts, docker, items, containerdBytes } = input;
  const alerts: StorageAlert[] = [];
  const root = rootMount(diskMounts);

  if (root) {
    const usedPct = pctUsed(root);
    if (usedPct >= config.diskCriticalPct) {
      pushAlert(alerts, "disk_usage_critical", "critical", `Root disk at ${usedPct}%`, {
        thresholdPct: config.diskCriticalPct,
        observedPct: usedPct,
        observedBytes: root.usedBytes,
      });
    } else if (usedPct >= config.diskWarningPct) {
      pushAlert(alerts, "disk_usage_warning", "warning", `Root disk at ${usedPct}%`, {
        thresholdPct: config.diskWarningPct,
        observedPct: usedPct,
        observedBytes: root.usedBytes,
      });
    }

    if (root.freeBytes <= config.freeSpaceCriticalBytes) {
      pushAlert(alerts, "free_space_critical", "critical", "Root free space below critical threshold", {
        observedBytes: root.freeBytes,
      });
    } else if (root.freeBytes <= config.freeSpaceWarningBytes) {
      pushAlert(alerts, "free_space_low", "warning", "Root free space below warning threshold", {
        observedBytes: root.freeBytes,
      });
    }
  }

  if (containerdBytes != null) {
    if (containerdBytes >= config.containerdCriticalBytes) {
      pushAlert(alerts, "containerd_usage_critical", "critical", "containerd storage above critical threshold", {
        observedBytes: containerdBytes,
      });
    } else if (containerdBytes >= config.containerdWarningBytes) {
      pushAlert(alerts, "containerd_usage_warning", "warning", "containerd storage above warning threshold", {
        observedBytes: containerdBytes,
      });
    }
  }

  const buildBytes = docker.buildCache.totalBytes;
  if (buildBytes != null) {
    if (buildBytes >= config.buildkitCriticalBytes) {
      pushAlert(alerts, "buildkit_cache_critical", "critical", "BuildKit cache above critical threshold", {
        observedBytes: buildBytes,
      });
    } else if (buildBytes >= config.buildkitWarningBytes) {
      pushAlert(alerts, "buildkit_cache_warning", "warning", "BuildKit cache above warning threshold", {
        observedBytes: buildBytes,
      });
    }
  }

  const unknownCount = items.filter((i) => i.classification === "UNKNOWN_REQUIRES_REVIEW").length;
  if (unknownCount > 0) {
    pushAlert(
      alerts,
      "unknown_items_present",
      "warning",
      `${unknownCount} storage item(s) require manual review before any cleanup`,
    );
  }

  return alerts;
}
