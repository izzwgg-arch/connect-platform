import fs from "node:fs/promises";
import path from "node:path";
import type { SnapshotStatus, StorageMaintenanceConfig, StorageScanSnapshot } from "../types";

export type PreflightSnapshotPayload = {
  generatedAt: string;
  scanId: string;
  readOnly: true;
  phase: "preflight_proof";
  scan: StorageScanSnapshot;
};

let latestSnapshotMeta: { path: string; timestamp: string; scanId: string } | null = null;

export function getSnapshotStatus(config: StorageMaintenanceConfig, scanId?: string): SnapshotStatus {
  const hostPath = config.hostInventoryRoot
    ? "/opt/connectcomms/backups/storage-preflight"
    : config.preflightSnapshotRoot;
  return {
    available: latestSnapshotMeta != null,
    latestPath: latestSnapshotMeta?.path ?? null,
    latestTimestamp: latestSnapshotMeta?.timestamp ?? null,
    latestScanId: latestSnapshotMeta?.scanId ?? scanId ?? null,
    storageRoot: hostPath,
  };
}

export async function ensureSnapshotDir(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
}

export async function writePreflightSnapshot(
  config: StorageMaintenanceConfig,
  scan: StorageScanSnapshot,
): Promise<{ path: string; timestamp: string }> {
  const root = config.preflightSnapshotRoot;
  await ensureSnapshotDir(root);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `storage-preflight-${timestamp}-${scan.scanId.slice(0, 8)}.json`;
  const filePath = path.join(root, filename);
  const payload: PreflightSnapshotPayload = {
    generatedAt: new Date().toISOString(),
    scanId: scan.scanId,
    readOnly: true,
    phase: "preflight_proof",
    scan,
  };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  latestSnapshotMeta = { path: filePath, timestamp: payload.generatedAt, scanId: scan.scanId };
  return { path: filePath, timestamp: payload.generatedAt };
}

export async function loadLatestSnapshotFromDisk(config: StorageMaintenanceConfig): Promise<void> {
  try {
    const entries = await fs.readdir(config.preflightSnapshotRoot);
    const jsonFiles = entries.filter((f) => f.startsWith("storage-preflight-") && f.endsWith(".json")).sort();
    const latest = jsonFiles[jsonFiles.length - 1];
    if (!latest) return;
    const filePath = path.join(config.preflightSnapshotRoot, latest);
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as PreflightSnapshotPayload;
    latestSnapshotMeta = {
      path: filePath,
      timestamp: parsed.generatedAt,
      scanId: parsed.scanId,
    };
  } catch {
    // no snapshots yet
  }
}

export function resetSnapshotStateForTests(): void {
  latestSnapshotMeta = null;
}
