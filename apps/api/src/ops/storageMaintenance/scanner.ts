import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import { collectHostMetrics } from "../hostMetrics";
import { buildInventoryItem } from "./classifier";
import { deriveStorageAlerts } from "./alerts";
import { buildStorageDashboardSummary } from "./dashboard";
import type {
  ContainerdBreakdown,
  DockerSystemSummary,
  HostVisibilitySnapshot,
  StorageInventoryItem,
  StorageMaintenanceConfig,
  StorageScanSnapshot,
} from "./types";

export type DockerImageRow = {
  Id: string;
  RepoTags: string[];
  Size: number;
  Containers: number;
};

export type DockerContainerRow = {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  SizeRw?: number;
};

export type DockerVolumeRow = {
  Name: string;
  UsageData?: { Size: number; RefCount: number };
};

export type StorageScannerDeps = {
  config: StorageMaintenanceConfig;
  listImages: () => Promise<DockerImageRow[]>;
  listContainers: () => Promise<DockerContainerRow[]>;
  listVolumes: () => Promise<DockerVolumeRow[]>;
  getDockerSystemDf: () => Promise<DockerSystemSummary>;
  statPathBytes: (path: string) => Promise<number | null>;
  listFilesInDir: (dir: string) => Promise<Array<{ name: string; path: string; sizeBytes: number; mtimeMs: number }>>;
  pathExists: (path: string) => Promise<boolean>;
  probeHostVisibility?: () => Promise<HostVisibilitySnapshot>;
};

function parseDockerSize(raw: string): number | null {
  const s = raw.trim();
  const m = s.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toUpperCase();
  const mult =
    unit === "TB" ? 1e12 :
    unit === "GB" ? 1e9 :
    unit === "MB" ? 1e6 :
    unit === "KB" ? 1e3 : 1;
  return Math.round(n * mult);
}

export function parseDockerSystemDfText(raw: string): DockerSystemSummary {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  let imagesCount = 0;
  let imagesBytes: number | null = null;
  let imagesReclaimableBytes: number | null = null;
  let containersCount = 0;
  let containersBytes: number | null = null;
  let volumesCount = 0;
  let volumesBytes: number | null = null;
  let buildEntryCount: number | null = null;
  let buildTotalBytes: number | null = null;
  let buildReclaimableBytes: number | null = null;

  for (const line of lines) {
    if (line.startsWith("Images")) {
      const parts = line.split(/\s+/);
      imagesCount = Number(parts[1]) || 0;
      imagesBytes = parseDockerSize(parts[3] || "");
      const reclaim = parts[4]?.match(/([\d.]+[KMGT]?B)/i);
      imagesReclaimableBytes = reclaim ? parseDockerSize(reclaim[1]) : null;
    } else if (line.startsWith("Containers")) {
      const parts = line.split(/\s+/);
      containersCount = Number(parts[1]) || 0;
      containersBytes = parseDockerSize(parts[3] || "");
    } else if (line.startsWith("Local Volumes")) {
      const parts = line.split(/\s+/);
      volumesCount = Number(parts[2]) || 0;
      volumesBytes = parseDockerSize(parts[4] || "");
    } else if (line.startsWith("Build Cache")) {
      const parts = line.split(/\s+/);
      buildEntryCount = Number(parts[2]) || null;
      buildTotalBytes = parseDockerSize(parts[4] || "");
      const reclaim = parts[5]?.match(/([\d.]+[KMGT]?B)/i);
      buildReclaimableBytes = reclaim ? parseDockerSize(reclaim[1]) : null;
    }
  }

  return {
    imagesCount,
    imagesBytes,
    imagesReclaimableBytes,
    containersCount,
    containersBytes,
    volumesCount,
    volumesBytes,
    buildCache: {
      entryCount: buildEntryCount,
      totalBytes: buildTotalBytes,
      reclaimableBytes: buildReclaimableBytes,
      source: buildTotalBytes != null ? "docker_system_df" : "unavailable",
    },
  };
}

async function scanFilesystemPaths(
  deps: StorageScannerDeps,
): Promise<StorageInventoryItem[]> {
  const { config } = deps;
  const paths = [
    { path: config.containerdRoot, label: "containerd storage (/var/lib/containerd)" },
    { path: config.appRoot, label: "App root (/opt/connectcomms)" },
    { path: config.appCloneRoot, label: "Deploy clone (/opt/connectcomms/app)" },
    { path: config.downloadsRoot, label: "Mobile APK downloads" },
    { path: config.monitoringLogsRoot, label: "Monitoring logs" },
    { path: config.backupsRoot, label: "Backups" },
    { path: config.dataRoot, label: "Production data (/opt/connectcomms/data)" },
    { path: config.journalRoot, label: "systemd journal" },
    { path: config.deployLogsRoot, label: "Deploy logs" },
  ];
  const items: StorageInventoryItem[] = [];
  for (const entry of paths) {
    if (!(await deps.pathExists(entry.path))) continue;
    const sizeBytes = await deps.statPathBytes(entry.path);
    items.push(
      buildInventoryItem(
        `fs:${entry.path}`,
        {
          kind: entry.path.includes("log") || entry.label.includes("journal") ? "log_directory" : "filesystem_path",
          label: entry.label,
          pathOrRef: entry.path,
          sizeBytes,
        },
        config,
      ),
    );
  }
  return items;
}

async function countOverlaySnapshots(snapshotsDir: string): Promise<number | null> {
  try {
    const entries = await fs.readdir(snapshotsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).length;
  } catch {
    return null;
  }
}

async function scanContainerdBreakdown(
  deps: StorageScannerDeps,
): Promise<{ breakdown: ContainerdBreakdown; items: StorageInventoryItem[] }> {
  const { config } = deps;
  const root = config.containerdRoot;
  const overlayRoot = `${root.replace(/\/+$/, "")}/io.containerd.snapshotter.v1.overlayfs`;
  const contentRoot = `${root.replace(/\/+$/, "")}/io.containerd.content.v1.content`;
  const snapshotsDir = `${overlayRoot}/snapshots`;

  const empty: ContainerdBreakdown = {
    totalBytes: null,
    overlaySnapshotsBytes: null,
    contentBlobsBytes: null,
    snapshotCount: null,
  };

  if (!(await deps.pathExists(root))) {
    return { breakdown: empty, items: [] };
  }

  const hasContent = await deps.pathExists(contentRoot);
  const hasOverlay = await deps.pathExists(overlayRoot);
  const hasSnapshots = await deps.pathExists(snapshotsDir);

  const [contentBytes, snapshotCount] = await Promise.all([
    hasContent ? deps.statPathBytes(contentRoot) : Promise.resolve(null),
    hasSnapshots ? countOverlaySnapshots(snapshotsDir) : Promise.resolve(null),
  ]);
  const overlayBytes = hasOverlay ? await deps.statPathBytes(overlayRoot) : null;
  const totalBytes =
    (await deps.statPathBytes(root)) ??
    (overlayBytes != null && contentBytes != null ? overlayBytes + contentBytes : null);

  const items: StorageInventoryItem[] = [];
  if (overlayBytes != null) {
    items.push(
      buildInventoryItem(
        "containerd:overlay",
        {
          kind: "filesystem_path",
          label: "containerd overlay snapshots",
          pathOrRef: overlayRoot,
          sizeBytes: overlayBytes,
          metadata: { snapshotCount: snapshotCount ?? 0 },
        },
        config,
      ),
    );
  }
  if (contentBytes != null) {
    items.push(
      buildInventoryItem(
        "containerd:content",
        {
          kind: "filesystem_path",
          label: "containerd content blobs",
          pathOrRef: contentRoot,
          sizeBytes: contentBytes,
        },
        config,
      ),
    );
  }

  return {
    breakdown: {
      totalBytes,
      overlaySnapshotsBytes: overlayBytes,
      contentBlobsBytes: contentBytes,
      snapshotCount,
    },
    items,
  };
}

const EMPTY_HOST_VISIBILITY: HostVisibilitySnapshot = {
  hostInventoryRoot: null,
  dockerSocket: "/var/run/docker.sock",
  dockerSocketReachable: false,
  containerdMount: false,
  connectcommsMount: false,
  varLogMount: false,
};

async function scanApkDownloads(deps: StorageScannerDeps): Promise<StorageInventoryItem[]> {
  const { config } = deps;
  if (!(await deps.pathExists(config.downloadsRoot))) return [];
  const files = await deps.listFilesInDir(config.downloadsRoot);
  return files
    .filter((f) => f.name.endsWith(".apk"))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((f, idx) =>
      buildInventoryItem(
        `apk:${f.name}`,
        {
          kind: "apk_download",
          label: f.name,
          pathOrRef: f.path,
          sizeBytes: f.sizeBytes,
          metadata: { sortIndex: idx, mtimeMs: f.mtimeMs },
        },
        config,
      ),
    );
}

function scanDockerImages(rows: DockerImageRow[], config: StorageMaintenanceConfig): StorageInventoryItem[] {
  return rows.map((row) => {
    const tag = row.RepoTags?.[0] ?? row.Id.slice(0, 12);
    const [repository = tag, tagName = "latest"] = tag.includes(":") ? tag.split(":") : [tag, "latest"];
    return buildInventoryItem(
      `image:${row.Id.slice(0, 12)}`,
      {
        kind: "docker_image",
        label: tag,
        pathOrRef: tag,
        sizeBytes: row.Size ?? null,
        metadata: {
          repository,
          tag: tagName,
          containers: row.Containers ?? 0,
          imageId: row.Id.slice(0, 12),
        },
      },
      config,
    );
  });
}

function scanDockerContainers(rows: DockerContainerRow[], config: StorageMaintenanceConfig): StorageInventoryItem[] {
  return rows.map((row) => {
    const name = (row.Names?.[0] ?? row.Id.slice(0, 12)).replace(/^\//, "");
    return buildInventoryItem(
      `container:${row.Id.slice(0, 12)}`,
      {
        kind: "docker_container",
        label: name,
        pathOrRef: row.Image,
        sizeBytes: row.SizeRw ?? null,
        metadata: { status: row.State, containerId: row.Id.slice(0, 12) },
      },
      config,
    );
  });
}

function scanDockerVolumes(rows: DockerVolumeRow[], config: StorageMaintenanceConfig): StorageInventoryItem[] {
  return rows.map((row) =>
    buildInventoryItem(
      `volume:${row.Name}`,
      {
        kind: "docker_volume",
        label: row.Name,
        pathOrRef: row.Name,
        sizeBytes: row.UsageData?.Size ?? null,
        metadata: { links: row.UsageData?.RefCount ?? 0 },
      },
      config,
    ),
  );
}

export async function runStorageScan(deps: StorageScannerDeps): Promise<StorageScanSnapshot> {
  const started = Date.now();
  const scanId = randomUUID();
  const host = await collectHostMetrics(null, {
    scope: "unavailable",
    scopeNote: "storage_scan",
    consumers: [],
    sampledAt: new Date().toISOString(),
  });

  const hostVisibility = deps.probeHostVisibility
    ? await deps.probeHostVisibility().catch(() => EMPTY_HOST_VISIBILITY)
    : EMPTY_HOST_VISIBILITY;

  const [images, containers, volumes, dockerSummary, fsItems, apkItems, containerdScan] = await Promise.all([
    deps.listImages().catch(() => [] as DockerImageRow[]),
    deps.listContainers().catch(() => [] as DockerContainerRow[]),
    deps.listVolumes().catch(() => [] as DockerVolumeRow[]),
    deps.getDockerSystemDf().catch(
      (): DockerSystemSummary => ({
        imagesCount: 0,
        imagesBytes: null,
        imagesReclaimableBytes: null,
        containersCount: 0,
        containersBytes: null,
        volumesCount: 0,
        volumesBytes: null,
        buildCache: { entryCount: null, totalBytes: null, reclaimableBytes: null, source: "unavailable" },
      }),
    ),
    scanFilesystemPaths(deps),
    scanApkDownloads(deps),
    scanContainerdBreakdown(deps),
  ]);

  const items: StorageInventoryItem[] = [
    ...fsItems,
    ...containerdScan.items,
    ...scanDockerImages(images, deps.config),
    ...scanDockerContainers(containers, deps.config),
    ...scanDockerVolumes(volumes, deps.config),
    ...apkItems,
  ];

  if (dockerSummary.buildCache.totalBytes != null) {
    items.push(
      buildInventoryItem(
        "buildcache:aggregate",
        {
          kind: "docker_build_cache",
          label: "Docker BuildKit cache (aggregate)",
          pathOrRef: "docker_buildkit_cache",
          sizeBytes: dockerSummary.buildCache.totalBytes,
          metadata: {
            entryCount: dockerSummary.buildCache.entryCount ?? 0,
            reclaimableBytes: dockerSummary.buildCache.reclaimableBytes ?? 0,
          },
        },
        deps.config,
      ),
    );
  }

  const reclaimEstimateBytes = items.reduce((sum, item) => sum + (item.reclaimableBytes ?? 0), 0);
  const unknownCount = items.filter((i) => i.classification === "UNKNOWN_REQUIRES_REVIEW").length;
  const protectedCount = items.filter((i) => i.classification === "PROTECTED_NEVER_DELETE").length;
  const containerdBytes =
    containerdScan.breakdown.totalBytes ??
    fsItems.find((i) => i.pathOrRef === deps.config.containerdRoot)?.sizeBytes ??
    null;
  const alerts = deriveStorageAlerts({
    config: deps.config,
    diskMounts: host.storage,
    docker: dockerSummary,
    items,
    containerdBytes,
  });

  const scanWithoutDashboard = {
    scanId,
    timestamp: new Date().toISOString(),
    hostname: os.hostname(),
    durationMs: Date.now() - started,
    readOnly: true as const,
    diskMounts: host.storage,
    docker: dockerSummary,
    items,
    reclaimEstimateBytes,
    alerts,
    unknownCount,
    protectedCount,
    hostVisibility,
    containerd: containerdScan.breakdown,
  };

  return {
    ...scanWithoutDashboard,
    dashboard: buildStorageDashboardSummary(scanWithoutDashboard, deps.config),
  };
}

export async function statDirectoryBytes(dir: string): Promise<number | null> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const full = `${dir.replace(/\/+$/, "")}/${entry.name}`;
      try {
        const st = await fs.stat(full);
        if (st.isFile()) total += st.size;
        else if (st.isDirectory()) {
          const nested = await statDirectoryBytes(full);
          if (nested != null) total += nested;
        }
      } catch {
        // skip unreadable entry
      }
    }
    return total;
  } catch {
    return null;
  }
}

export async function listDirectoryFiles(
  dir: string,
): Promise<Array<{ name: string; path: string; sizeBytes: number; mtimeMs: number }>> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: Array<{ name: string; path: string; sizeBytes: number; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = `${dir.replace(/\/+$/, "")}/${entry.name}`;
      try {
        const st = await fs.stat(full);
        out.push({ name: entry.name, path: full, sizeBytes: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // skip
      }
    }
    return out;
  } catch {
    return [];
  }
}
