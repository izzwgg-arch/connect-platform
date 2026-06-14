import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DockerContainerRow, DockerImageRow, DockerVolumeRow } from "../scanner";
import type { InventoryFingerprint, StorageMaintenanceConfig } from "../types";

const execFileAsync = promisify(execFile);

export type InventoryCaptureDeps = {
  listImages: () => Promise<DockerImageRow[]>;
  listContainers: () => Promise<DockerContainerRow[]>;
  listVolumes: () => Promise<DockerVolumeRow[]>;
  getDockerSystemDfText: () => Promise<string>;
};

export async function captureInventoryFingerprint(
  deps: InventoryCaptureDeps,
  disk: { usedBytes: number | null; freeBytes: number | null; totalBytes: number | null },
): Promise<InventoryFingerprint> {
  const [images, containers, volumes, systemDfText] = await Promise.all([
    deps.listImages(),
    deps.listContainers(),
    deps.listVolumes(),
    deps.getDockerSystemDfText().catch(() => ""),
  ]);

  const imageRefs = images
    .flatMap((i) => (i.RepoTags?.length ? i.RepoTags : [i.Id]))
    .sort();
  const containerNames = containers
    .flatMap((c) => c.Names ?? [])
    .map((n) => n.replace(/^\//, ""))
    .sort();
  const volumeNames = volumes.map((v) => v.Name).sort();

  return {
    capturedAt: new Date().toISOString(),
    diskUsedBytes: disk.usedBytes,
    diskFreeBytes: disk.freeBytes,
    diskTotalBytes: disk.totalBytes,
    imageRefs,
    containerNames,
    volumeNames,
    rollbackImageRefs: imageRefs.filter((r) => r.includes("candidate")),
    protectedImageRefs: imageRefs.filter(
      (r) =>
        r.includes("postgres:15") ||
        r.startsWith("app-api:") ||
        r.startsWith("app-portal:") ||
        r.startsWith("app-worker:") ||
        r.includes("redis") ||
        r.includes("minio"),
    ),
    dockerSystemDfExcerpt: systemDfText.slice(0, 8000),
  };
}

export function compareInventoryFingerprints(
  before: InventoryFingerprint,
  after: InventoryFingerprint,
): { ok: boolean; violations: string[] } {
  const violations: string[] = [];

  for (const name of before.containerNames) {
    if (!after.containerNames.includes(name)) {
      violations.push(`missing_container:${name}`);
    }
  }
  for (const vol of before.volumeNames) {
    if (!after.volumeNames.includes(vol)) {
      violations.push(`missing_volume:${vol}`);
    }
  }
  for (const img of before.protectedImageRefs) {
    if (!after.imageRefs.includes(img)) {
      violations.push(`missing_protected_image:${img}`);
    }
  }
  for (const rb of before.rollbackImageRefs) {
    if (!after.rollbackImageRefs.includes(rb)) {
      violations.push(`missing_rollback_image:${rb}`);
    }
  }

  return { ok: violations.length === 0, violations };
}

export async function readRootDiskBytes(config: StorageMaintenanceConfig): Promise<{
  usedBytes: number | null;
  freeBytes: number | null;
  totalBytes: number | null;
}> {
  const path = config.hostInventoryRoot ? `${config.hostInventoryRoot.replace(/\/+$/, "")}/` : "/";
  try {
    const { stdout } = await execFileAsync("df", ["-B1", path], { timeout: 30_000 });
    const line = String(stdout).trim().split("\n")[1];
    if (!line) return { usedBytes: null, freeBytes: null, totalBytes: null };
    const parts = line.split(/\s+/);
    return {
      totalBytes: Number(parts[1]) || null,
      usedBytes: Number(parts[2]) || null,
      freeBytes: Number(parts[3]) || null,
    };
  } catch {
    return { usedBytes: null, freeBytes: null, totalBytes: null };
  }
}
