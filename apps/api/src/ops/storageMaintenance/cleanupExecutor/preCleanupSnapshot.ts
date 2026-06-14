import fs from "node:fs/promises";
import path from "node:path";
import type {
  InventoryFingerprint,
  PreCleanupSnapshotPayload,
  StorageMaintenanceConfig,
  StorageScanSnapshot,
} from "../types";

export async function writePreCleanupSnapshot(
  config: StorageMaintenanceConfig,
  scan: StorageScanSnapshot,
  inventory: InventoryFingerprint,
  healthGatePassed: boolean,
): Promise<{ path: string; timestamp: string }> {
  const root = config.preflightSnapshotRoot;
  await fs.mkdir(root, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `storage-precleanup-${timestamp}-${scan.scanId.slice(0, 8)}.json`;
  const filePath = path.join(root, filename);
  const ops = scan.dashboard?.operationsCenter ?? null;
  const payload: PreCleanupSnapshotPayload = {
    generatedAt: new Date().toISOString(),
    scanId: scan.scanId,
    phase: "precleanup_phase5",
    readOnly: false,
    healthGatePassed,
    inventory,
    scan,
    dependencyGraph: ops?.dependencyGraph ?? null,
    rollbackCoverage: ops?.rollbackCoverage ?? null,
    reclaimCandidates: ops?.cleanupCandidates ?? [],
    safetyGates: ops?.safetyGates ?? null,
  };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  return { path: filePath, timestamp: payload.generatedAt };
}
