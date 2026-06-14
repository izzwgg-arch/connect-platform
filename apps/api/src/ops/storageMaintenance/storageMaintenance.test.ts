import test from "node:test";
import assert from "node:assert/strict";
import { classifyStorageItem } from "./classifier";
import { loadStorageMaintenanceConfig } from "./dockerDeps";
import { buildCleanupPlan } from "./planBuilder";
import {
  isProtectedImageRef,
  isProtectedPath,
  isProtectedVolumeName,
  validateCleanupCommand,
} from "./protectionRules";
import { clearStorageAuditEventsForTests } from "./auditLog";
import {
  executeStorageScan,
  generateCleanupPlanFromLatestScan,
  resetStorageMaintenanceStateForTests,
} from "./service";
import { parseDockerSystemDfText } from "./scanner";
import type { StorageScannerDeps } from "./scanner";
import type { DockerSystemSummary, StorageScanSnapshot } from "./types";

const config = loadStorageMaintenanceConfig();

test("protected paths cannot be classified as safe delete targets", () => {
  assert.equal(isProtectedPath("/opt/connectcomms/data/postgres", config), true);
  assert.equal(isProtectedPath("/opt/connectcomms/env/.env", config), true);
  const item = classifyStorageItem(
    {
      kind: "filesystem_path",
      label: "postgres",
      pathOrRef: "/opt/connectcomms/data/postgres",
      sizeBytes: 1,
    },
    config,
  );
  assert.equal(item.classification, "PROTECTED_NEVER_DELETE");
});

test("active volume cannot be classified deletable", () => {
  assert.equal(isProtectedVolumeName("app_chat-attachments"), true);
  const item = classifyStorageItem(
    {
      kind: "docker_volume",
      label: "chat",
      pathOrRef: "app_chat-attachments",
      sizeBytes: 1000,
      metadata: { links: 2 },
    },
    config,
  );
  assert.equal(item.classification, "ACTIVE_REQUIRED");
});

test("active image cannot be classified safe candidate", () => {
  assert.equal(isProtectedImageRef("app-api", "latest", 1), true);
  const item = classifyStorageItem(
    {
      kind: "docker_image",
      label: "app-api:latest",
      pathOrRef: "app-api:latest",
      sizeBytes: 1e9,
      metadata: { repository: "app-api", tag: "latest", containers: 1 },
    },
    config,
  );
  assert.equal(item.classification, "ACTIVE_REQUIRED");
});

test("unknown detached volume requires review", () => {
  const item = classifyStorageItem(
    {
      kind: "docker_volume",
      label: "mystery",
      pathOrRef: "orphan_volume_123",
      sizeBytes: 500,
      metadata: { links: 0 },
    },
    config,
  );
  assert.equal(item.classification, "UNKNOWN_REQUIRES_REVIEW");
});

test("validateCleanupCommand refuses wildcard and dangerous prune commands", () => {
  assert.equal(validateCleanupCommand("docker system prune -a").ok, false);
  assert.equal(validateCleanupCommand("docker volume prune").ok, false);
  assert.equal(validateCleanupCommand("rm -rf /").ok, false);
  assert.equal(validateCleanupCommand("find /tmp -delete").ok, false);
  assert.equal(validateCleanupCommand("docker builder prune --filter until=24h --dry-run").ok, true);
  assert.equal(validateCleanupCommand("docker image rm abc123def456").ok, true);
});

test("parseDockerSystemDfText extracts build cache totals", () => {
  const summary = parseDockerSystemDfText(`
TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          19        15        440.7GB   438.6GB (99%)
Containers      15        15        79.68MB   0B (0%)
Local Volumes   10        10        776.4MB   0B (0%)
Build Cache     2744      0         534GB     522.7GB
`);
  assert.equal(summary.buildCache.entryCount, 2744);
  assert.equal(summary.buildCache.totalBytes, 534 * 1e9);
});

function mockDeps(overrides: Partial<StorageScannerDeps> = {}): StorageScannerDeps {
  return {
    config,
    listImages: async () => [
      {
        Id: "sha256:activeimage0001",
        RepoTags: ["app-api:latest"],
        Size: 1e9,
        Containers: 1,
      },
      {
        Id: "sha256:candidateimg01",
        RepoTags: ["app-api_candidate:latest"],
        Size: 1e9,
        Containers: 0,
      },
      {
        Id: "sha256:unusedimg0001",
        RepoTags: ["postgres:16-alpine"],
        Size: 4e8,
        Containers: 0,
      },
    ],
    listContainers: async () => [
      { Id: "c1", Names: ["/app-api-1"], Image: "app-api", State: "running", SizeRw: 1000 },
    ],
    listVolumes: async () => [
      { Name: "app_chat-attachments", UsageData: { Size: 1000, RefCount: 2 } },
      { Name: "orphan_volume_123", UsageData: { Size: 500, RefCount: 0 } },
    ],
    getDockerSystemDf: async (): Promise<DockerSystemSummary> => ({
      imagesCount: 3,
      imagesBytes: 2e9,
      imagesReclaimableBytes: 1e9,
      containersCount: 1,
      containersBytes: 1000,
      volumesCount: 2,
      volumesBytes: 1500,
      buildCache: {
        entryCount: 10,
        totalBytes: 500 * 1e9,
        reclaimableBytes: 480 * 1e9,
        source: "docker_system_df",
      },
    }),
    statPathBytes: async (path) => (path.includes("containerd") ? 400 * 1e9 : 1e6),
    listFilesInDir: async () => [
      { name: "a.apk", path: "/opt/connectcomms/downloads/a.apk", sizeBytes: 1e8, mtimeMs: 3 },
      { name: "b.apk", path: "/opt/connectcomms/downloads/b.apk", sizeBytes: 1e8, mtimeMs: 2 },
      { name: "c.apk", path: "/opt/connectcomms/downloads/c.apk", sizeBytes: 1e8, mtimeMs: 1 },
    ],
    pathExists: async (path) => !path.includes("missing"),
    ...overrides,
  };
}

test("dry-run scan produces inventory without mutation hooks", async () => {
  clearStorageAuditEventsForTests();
  resetStorageMaintenanceStateForTests();
  const scan = await executeStorageScan(mockDeps(), "test-user");
  assert.equal(scan.readOnly, true);
  assert.ok(scan.items.length > 5);
  assert.ok(scan.reclaimEstimateBytes >= 0);
  assert.ok(scan.items.some((i) => i.kind === "docker_build_cache"));
});

test("unknown item blocks cleanup plan", () => {
  const scan: StorageScanSnapshot = {
    scanId: "scan-1",
    timestamp: new Date().toISOString(),
    hostname: "test",
    durationMs: 1,
    readOnly: true,
    diskMounts: [{ path: "/", totalBytes: 1e12, usedBytes: 800e9, freeBytes: 200e9, usedPct: 80 }],
    docker: {
      imagesCount: 0,
      imagesBytes: null,
      imagesReclaimableBytes: null,
      containersCount: 0,
      containersBytes: null,
      volumesCount: 0,
      volumesBytes: null,
      buildCache: {
        entryCount: 10,
        totalBytes: 500e9,
        reclaimableBytes: 480e9,
        source: "docker_system_df",
      },
    },
    items: [
      {
        id: "unknown:1",
        kind: "filesystem_path",
        label: "mystery",
        pathOrRef: "/var/lib/docker/unknown",
        sizeBytes: 100,
        classification: "UNKNOWN_REQUIRES_REVIEW",
        evidence: "test",
        reclaimableBytes: null,
      },
      {
        id: "buildcache:aggregate",
        kind: "docker_build_cache",
        label: "cache",
        pathOrRef: "docker_buildkit_cache",
        sizeBytes: 500e9,
        classification: "SAFE_CANDIDATE",
        evidence: "test",
        reclaimableBytes: 480e9,
        metadata: { reclaimableBytes: 480e9 },
      },
    ],
    reclaimEstimateBytes: 480e9,
    alerts: [],
    unknownCount: 1,
    protectedCount: 0,
  };
  const plan = buildCleanupPlan(scan, { ...config, apkRetentionCount: 1 });
  assert.equal(plan.blocked, true);
  assert.ok(plan.unknownHits.length > 0);
});

test("BuildKit cache plan generated with dry-run command only", async () => {
  clearStorageAuditEventsForTests();
  resetStorageMaintenanceStateForTests();
  await executeStorageScan(mockDeps(), "test-user");
  const plan = generateCleanupPlanFromLatestScan("test-user", config);
  const buildAction = plan.actions.find((a) => a.kind === "docker_builder_prune_filtered");
  assert.ok(buildAction);
  assert.ok(buildAction?.dryRunCommand?.includes("--dry-run"));
  assert.equal(validateCleanupCommand(buildAction!.command).ok, true);
});

test("old APK retention plan lists explicit file paths", async () => {
  clearStorageAuditEventsForTests();
  resetStorageMaintenanceStateForTests();
  await executeStorageScan(mockDeps(), "test-user");
  const plan = generateCleanupPlanFromLatestScan("test-user", { ...config, apkRetentionCount: 1 });
  const apkActions = plan.actions.filter((a) => a.kind === "apk_file_rm");
  assert.equal(apkActions.length, 2);
  for (const action of apkActions) {
    assert.ok(action.command.includes("/opt/connectcomms/downloads/"));
    assert.equal(action.command.includes("*"), false);
  }
});

test("audit log created for scan and plan", async () => {
  clearStorageAuditEventsForTests();
  resetStorageMaintenanceStateForTests();
  await executeStorageScan(mockDeps(), "auditor");
  generateCleanupPlanFromLatestScan("auditor", config);
  const { getStorageAuditHistory } = await import("./service");
  const events = getStorageAuditHistory();
  assert.ok(events.some((e) => e.type === "scan_completed"));
  assert.ok(events.some((e) => e.type === "plan_generated" || e.type === "plan_blocked"));
});
