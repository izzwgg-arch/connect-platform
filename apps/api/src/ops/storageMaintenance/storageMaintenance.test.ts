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
import {
  buildCleanupReadiness,
  buildProtectedAssets,
  buildStorageDashboardSummary,
  buildStorageDistribution,
  buildTrendSeries,
  classificationActionability,
  classificationRisk,
  computeReclaimSimulation,
  computeRiskLevel,
  computeTrendDirection,
  rankLargestConsumers,
} from "./dashboard";
import { parseDockerSystemDfText, type StorageScannerDeps } from "./scanner";
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
  const scanBase = {
    scanId: "scan-1",
    timestamp: new Date().toISOString(),
    hostname: "test",
    durationMs: 1,
    readOnly: true as const,
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
        source: "docker_system_df" as const,
      },
    },
    items: [
      {
        id: "unknown:1",
        kind: "filesystem_path" as const,
        label: "mystery",
        pathOrRef: "/var/lib/docker/unknown",
        sizeBytes: 100,
        classification: "UNKNOWN_REQUIRES_REVIEW" as const,
        evidence: "test",
        reclaimableBytes: null,
      },
      {
        id: "buildcache:aggregate",
        kind: "docker_build_cache" as const,
        label: "cache",
        pathOrRef: "docker_buildkit_cache",
        sizeBytes: 500e9,
        classification: "SAFE_CANDIDATE" as const,
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
  const scan: StorageScanSnapshot = {
    ...scanBase,
    dashboard: buildStorageDashboardSummary(scanBase, config),
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

test("rankLargestConsumers returns top paths by size", async () => {
  const scan = await executeStorageScan(mockDeps(), "rank-test");
  const ranked = rankLargestConsumers(scan.items, 5);
  assert.ok(ranked.length > 0);
  assert.equal(ranked[0]!.rank, 1);
  assert.ok((ranked[0]!.sizeBytes ?? 0) >= (ranked[ranked.length - 1]!.sizeBytes ?? 0));
});

test("reclaim simulation uses actual scan totals", async () => {
  const scan = await executeStorageScan(mockDeps(), "sim-test");
  const sim = computeReclaimSimulation(scan);
  assert.equal(sim.projectedRecoveryBytes, scan.reclaimEstimateBytes);
  const root = scan.diskMounts.find((m) => m.path === "/" || m.path === "C:\\") ?? scan.diskMounts[0];
  if (root?.usedBytes != null) {
    assert.equal(sim.projectedUsageAfterCleanupBytes, Math.max(0, root.usedBytes - scan.reclaimEstimateBytes));
  }
});

test("risk scoring reflects disk pressure", () => {
  const highDiskScan = {
    scanId: "r1",
    timestamp: new Date().toISOString(),
    hostname: "t",
    durationMs: 1,
    readOnly: true as const,
    diskMounts: [{ path: "/", totalBytes: 678e9, usedBytes: 545e9, freeBytes: 133e9, usedPct: 81 }],
    docker: {
      imagesCount: 0,
      imagesBytes: null,
      imagesReclaimableBytes: null,
      containersCount: 0,
      containersBytes: null,
      volumesCount: 0,
      volumesBytes: null,
      buildCache: { entryCount: 100, totalBytes: 537e9, reclaimableBytes: 523e9, source: "docker_system_df" as const },
    },
    items: [],
    reclaimEstimateBytes: 523e9,
    alerts: [],
    unknownCount: 0,
    protectedCount: 0,
  };
  const risk = computeRiskLevel(highDiskScan, config);
  assert.ok(risk === "high" || risk === "critical");
});

test("classification badges map risk and actionability", () => {
  assert.equal(classificationRisk("PROTECTED_NEVER_DELETE"), "critical");
  assert.equal(classificationRisk("SAFE_CANDIDATE"), "low");
  assert.equal(classificationActionability("PROTECTED_NEVER_DELETE"), "locked");
  assert.equal(classificationActionability("SAFE_CANDIDATE"), "eligible");
});

test("protected asset detection includes postgres paths", async () => {
  const scan = await executeStorageScan(mockDeps(), "prot-test");
  const assets = buildProtectedAssets(scan.items, config);
  assert.ok(assets.some((a) => a.label.toLowerCase().includes("postgres") || a.pathOrRef.includes("postgres")));
});

test("projected usage calculations on dashboard summary", async () => {
  const scan = await executeStorageScan(mockDeps(), "dash-test");
  const dash = buildStorageDashboardSummary(scan, config);
  assert.ok(dash.totalDiskBytes != null);
  assert.ok(dash.largestConsumers.length > 0);
  assert.ok(dash.distribution.length > 0);
  assert.ok(dash.cleanupReadiness.some((r) => r.category === "BuildKit Cache"));
  assert.equal(dash.projectedRecoveryBytes, scan.reclaimEstimateBytes);
});

test("trend direction and API contract fields", () => {
  const points = [
    { timestamp: new Date(Date.now() - 3600_000).toISOString(), scanId: "a", diskUsedPct: 78, usedBytes: 500e9, freeBytes: 140e9, totalBytes: 640e9, reclaimEstimateBytes: 100e9 },
    { timestamp: new Date().toISOString(), scanId: "b", diskUsedPct: 81, usedBytes: 545e9, freeBytes: 133e9, totalBytes: 678e9, reclaimEstimateBytes: 523e9 },
  ];
  const dir = computeTrendDirection(points);
  assert.equal(dir.direction, "increasing");
  const series = buildTrendSeries(points, "24h");
  assert.equal(series.window, "24h");
  assert.ok(series.points.length >= 2);
});

test("storage distribution categories sum from scan items", async () => {
  const scan = await executeStorageScan(mockDeps(), "dist-test");
  const dist = buildStorageDistribution(scan, config);
  assert.ok(dist.some((d) => d.category === "build_cache"));
  const buildSlice = dist.find((d) => d.category === "build_cache");
  assert.ok((buildSlice?.sizeBytes ?? 0) > 0);
});

test("cleanup readiness rows include blocked protected data", async () => {
  const scan = await executeStorageScan(mockDeps(), "ready-test");
  const readiness = buildCleanupReadiness(scan, null);
  assert.ok(readiness.some((r) => r.category === "BuildKit Cache" && r.status === "eligible"));
});
