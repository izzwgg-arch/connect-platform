import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import { promisify } from "node:util";
import {
  listDirectoryFiles,
  parseDockerSystemDfText,
  statDirectoryBytes,
  type DockerContainerRow,
  type DockerImageRow,
  type DockerVolumeRow,
  type StorageScannerDeps,
} from "./scanner";
import type { DockerSystemSummary, StorageMaintenanceConfig } from "./types";

const execFileAsync = promisify(execFile);
const DOCKER_SOCKET = (process.env.STORAGE_DOCKER_SOCKET || process.env.SERVER_HEALTH_DOCKER_SOCKET || "/var/run/docker.sock").trim();

function dockerHttpGet(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, path, method: "GET", timeout: 8000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`docker_http_${res.statusCode}`));
            return;
          }
          resolve(body);
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("docker_timeout"));
    });
    req.end();
  });
}

async function dockerSocketAvailable(): Promise<boolean> {
  try {
    await fs.access(DOCKER_SOCKET);
    return true;
  } catch {
    return false;
  }
}

async function listImages(): Promise<DockerImageRow[]> {
  if (!(await dockerSocketAvailable())) return [];
  const raw = await dockerHttpGet("/images/json");
  return JSON.parse(raw) as DockerImageRow[];
}

async function listContainers(): Promise<DockerContainerRow[]> {
  if (!(await dockerSocketAvailable())) return [];
  const raw = await dockerHttpGet("/containers/json?all=1&size=1");
  return JSON.parse(raw) as DockerContainerRow[];
}

async function listVolumes(): Promise<DockerVolumeRow[]> {
  if (!(await dockerSocketAvailable())) return [];
  const raw = await dockerHttpGet("/volumes");
  const parsed = JSON.parse(raw) as { Volumes?: DockerVolumeRow[] };
  return parsed.Volumes ?? [];
}

async function getDockerSystemDf(): Promise<DockerSystemSummary> {
  if (!(await dockerSocketAvailable())) {
    return {
      imagesCount: 0,
      imagesBytes: null,
      imagesReclaimableBytes: null,
      containersCount: 0,
      containersBytes: null,
      volumesCount: 0,
      volumesBytes: null,
      buildCache: { entryCount: null, totalBytes: null, reclaimableBytes: null, source: "unavailable" },
    };
  }
  try {
    const { stdout } = await execFileAsync("docker", ["system", "df"], {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return parseDockerSystemDfText(stdout);
  } catch {
    return {
      imagesCount: 0,
      imagesBytes: null,
      imagesReclaimableBytes: null,
      containersCount: 0,
      containersBytes: null,
      volumesCount: 0,
      volumesBytes: null,
      buildCache: { entryCount: null, totalBytes: null, reclaimableBytes: null, source: "unavailable" },
    };
  }
}

export function loadStorageMaintenanceConfig(): StorageMaintenanceConfig {
  const gb = (n: number) => n * 1024 * 1024 * 1024;
  return {
    diskWarningPct: Number(process.env.STORAGE_DISK_WARNING_PCT || 70),
    diskCriticalPct: Number(process.env.STORAGE_DISK_CRITICAL_PCT || 80),
    containerdWarningBytes: Number(process.env.STORAGE_CONTAINERD_WARNING_BYTES || gb(300)),
    containerdCriticalBytes: Number(process.env.STORAGE_CONTAINERD_CRITICAL_BYTES || gb(400)),
    buildkitWarningBytes: Number(process.env.STORAGE_BUILDKIT_WARNING_BYTES || gb(200)),
    buildkitCriticalBytes: Number(process.env.STORAGE_BUILDKIT_CRITICAL_BYTES || gb(400)),
    freeSpaceWarningBytes: Number(process.env.STORAGE_FREE_WARNING_BYTES || gb(50)),
    freeSpaceCriticalBytes: Number(process.env.STORAGE_FREE_CRITICAL_BYTES || gb(20)),
    buildCacheRetentionDays: Number(process.env.STORAGE_BUILD_CACHE_RETENTION_DAYS || 14),
    apkRetentionCount: Number(process.env.STORAGE_APK_RETENTION_COUNT || 5),
    diagnosticLogRetentionDays: Number(process.env.STORAGE_DIAG_LOG_RETENTION_DAYS || 30),
    appRoot: process.env.STORAGE_APP_ROOT || "/opt/connectcomms",
    dataRoot: process.env.STORAGE_DATA_ROOT || "/opt/connectcomms/data",
    envRoot: process.env.STORAGE_ENV_ROOT || "/opt/connectcomms/env",
    backupsRoot: process.env.STORAGE_BACKUPS_ROOT || "/opt/connectcomms/backups",
    downloadsRoot: process.env.STORAGE_DOWNLOADS_ROOT || "/opt/connectcomms/downloads",
    monitoringLogsRoot: process.env.STORAGE_MONITORING_LOGS_ROOT || "/opt/connectcomms/monitoring/logs",
    containerdRoot: process.env.STORAGE_CONTAINERD_ROOT || "/var/lib/containerd",
  };
}

export function createProductionStorageScannerDeps(
  config: StorageMaintenanceConfig = loadStorageMaintenanceConfig(),
): StorageScannerDeps {
  return {
    config,
    listImages,
    listContainers,
    listVolumes,
    getDockerSystemDf,
    statPathBytes: statDirectoryBytes,
    listFilesInDir: listDirectoryFiles,
    pathExists: async (path) => {
      try {
        await fs.access(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}
