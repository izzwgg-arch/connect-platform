import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  extractBuildCacheRaw,
  parseDockerSystemDfJson,
  type DockerBuildCacheRaw,
} from "./dockerSystemDfApi";
import { parseBuildKitCacheFromSystemDfV, investigateBuildKitFromRaw } from "./cleanupExecutor/buildKitInvestigation";
import type {
  BuildKitInvestigation,
  BuildKitInventoryStatus,
  DockerSystemSummary,
} from "./types";

const execFileAsync = promisify(execFile);

export type BuildKitInventoryCollection = {
  status: BuildKitInventoryStatus;
  errorMessage: string | null;
  collectionSource: "docker_system_df_api" | "docker_system_df_cli" | "docker_builder_du" | "none";
  hostDetectedTotalBytes: number | null;
  hostDetectedEntryCount: number | null;
  rawEntries: DockerBuildCacheRaw[];
  summary: DockerSystemSummary;
  durationMs: number;
};

export type DockerSystemDfPayload = BuildKitInventoryCollection;

type DockerHttpGet = (path: string, timeoutMs: number) => Promise<string>;

function classifyDockerError(err: unknown): { status: BuildKitInventoryStatus; message: string } {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("docker_timeout") || msg.includes("ETIMEDOUT") || msg.includes("timeout")) {
    return { status: "TIMEOUT", message: `Docker API request timed out: ${msg}` };
  }
  if (msg.includes("docker_http_403") || msg.includes("EACCES") || msg.includes("permission denied")) {
    return { status: "PERMISSION_DENIED", message: `Docker socket permission denied: ${msg}` };
  }
  if (msg.includes("ENOENT") || msg.includes("docker_socket")) {
    return { status: "UNAVAILABLE", message: `Docker socket unavailable: ${msg}` };
  }
  return { status: "UNAVAILABLE", message: msg };
}

function parseBuilderDuText(text: string): DockerBuildCacheRaw[] {
  const lines = text.split("\n");
  const entries: DockerBuildCacheRaw[] = [];
  let header = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("ID ") && trimmed.includes("RECLAIMABLE")) {
      header = true;
      continue;
    }
    if (!header) continue;
    if (trimmed.startsWith("Reclaimable:") || trimmed.startsWith("Total:")) break;
    const parts = trimmed.split(/\s{2,}/).map((p) => p.trim());
    if (parts.length < 3) continue;
    const [id, reclaimableRaw, sizeRaw] = parts;
    if (!id || id === "ID") continue;
    const size = parseHumanSize(sizeRaw ?? "0");
    const reclaimable = reclaimableRaw?.toLowerCase() === "true";
    const incomplete = id.endsWith("*");
    entries.push({
      ID: id.replace(/\*$/, ""),
      Size: size,
      Reclaimable: reclaimable,
      InUse: !reclaimable,
      Type: incomplete ? "incomplete" : "regular",
      UsageCount: reclaimable ? 0 : 1,
    });
  }
  return entries;
}

function parseHumanSize(raw: string): number {
  const m = raw.trim().match(/^([\d.]+)\s*(B|kB|KB|MB|GB|TB)$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2]!.toUpperCase();
  const mult =
    unit === "TB" ? 1e12 : unit === "GB" ? 1e9 : unit === "MB" ? 1e6 : unit === "KB" ? 1e3 : 1;
  return Math.round(n * mult);
}

function enrichSummaryWithInventory(
  summary: DockerSystemSummary,
  collection: Pick<BuildKitInventoryCollection, "status" | "errorMessage" | "hostDetectedTotalBytes" | "hostDetectedEntryCount" | "rawEntries" | "collectionSource">,
): DockerSystemSummary {
  return {
    ...summary,
    buildCache: {
      ...summary.buildCache,
      entryCount: collection.rawEntries.length > 0 ? collection.rawEntries.length : summary.buildCache.entryCount,
      inventoryStatus: collection.status,
      inventoryError: collection.errorMessage,
      hostDetectedTotalBytes: collection.hostDetectedTotalBytes,
      hostDetectedEntryCount: collection.hostDetectedEntryCount,
      collectionSource: collection.collectionSource,
    },
  };
}

async function tryDockerCliSystemDfV(dockerSocket: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${dockerSocket}:/var/run/docker.sock:ro`,
        "docker:27-cli",
        "system",
        "df",
        "-v",
      ],
      { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
    );
    return String(stdout);
  } catch {
    return null;
  }
}

async function tryDockerCliBuilderDu(dockerSocket: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${dockerSocket}:/var/run/docker.sock:ro`,
        "docker:27-cli",
        "builder",
        "du",
      ],
      { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
    );
    return String(stdout);
  } catch {
    return null;
  }
}

export async function collectBuildKitInventory(input: {
  dockerHttpGet: DockerHttpGet;
  dockerSocket: string;
  dockerSocketReachable: boolean;
  systemDfTimeoutMs?: number;
  hostHasDockerCli?: boolean;
}): Promise<BuildKitInventoryCollection> {
  const started = Date.now();
  const timeoutMs = input.systemDfTimeoutMs ?? 600_000;

  if (!input.dockerSocketReachable) {
    const summary = emptySummary("UNAVAILABLE", "Docker socket not reachable from API container");
    return {
      status: "UNAVAILABLE",
      errorMessage: "Docker socket not reachable from API container",
      collectionSource: "none",
      hostDetectedTotalBytes: null,
      hostDetectedEntryCount: null,
      rawEntries: [],
      summary,
      durationMs: Date.now() - started,
    };
  }

  try {
    const rawText = await input.dockerHttpGet("/system/df", timeoutMs);
    const parsed = JSON.parse(rawText) as Parameters<typeof parseDockerSystemDfJson>[0];
    const summary = parseDockerSystemDfJson(parsed);
    const rawEntries = extractBuildCacheRaw(parsed);

    if (rawEntries.length > 0) {
      return {
        status: "OK",
        errorMessage: null,
        collectionSource: "docker_system_df_api",
        hostDetectedTotalBytes: summary.buildCache.totalBytes,
        hostDetectedEntryCount: summary.buildCache.entryCount,
        rawEntries,
        summary: enrichSummaryWithInventory(summary, {
          status: "OK",
          errorMessage: null,
          hostDetectedTotalBytes: summary.buildCache.totalBytes,
          hostDetectedEntryCount: rawEntries.length,
          rawEntries,
          collectionSource: "docker_system_df_api",
        }),
        durationMs: Date.now() - started,
      };
    }

    const hostHasCache =
      summary.buildCache.totalBytes != null && summary.buildCache.totalBytes > 0;
    const errMsg = hostHasCache
      ? `Docker /system/df returned summary (${summary.buildCache.totalBytes} bytes) but BuildCache array was empty`
      : "Docker /system/df returned empty BuildCache array";

    if (input.hostHasDockerCli) {
      const dfV = await tryDockerCliSystemDfV(input.dockerSocket);
      if (dfV) {
        const textEntries = parseBuildKitCacheFromSystemDfV(dfV);
        if (textEntries.length > 0) {
          const rawFromText: DockerBuildCacheRaw[] = textEntries.map((e) => ({
            ID: e.cacheId,
            Size: e.sizeBytes,
            Type: e.cacheType,
            UsageCount: e.usageCount,
            InUse: e.referenced,
            Reclaimable: !e.referenced,
          }));
          return {
            status: "OK",
            errorMessage: null,
            collectionSource: "docker_system_df_cli",
            hostDetectedTotalBytes: summary.buildCache.totalBytes,
            hostDetectedEntryCount: rawFromText.length,
            rawEntries: rawFromText,
            summary: enrichSummaryWithInventory(summary, {
              status: "OK",
              errorMessage: null,
              hostDetectedTotalBytes: summary.buildCache.totalBytes,
              hostDetectedEntryCount: rawFromText.length,
              rawEntries: rawFromText,
              collectionSource: "docker_system_df_cli",
            }),
            durationMs: Date.now() - started,
          };
        }
      }

      const builderDu = await tryDockerCliBuilderDu(input.dockerSocket);
      if (builderDu) {
        const rawFromDu = parseBuilderDuText(builderDu);
        if (rawFromDu.length > 0) {
          return {
            status: "OK",
            errorMessage: null,
            collectionSource: "docker_builder_du",
            hostDetectedTotalBytes: summary.buildCache.totalBytes,
            hostDetectedEntryCount: rawFromDu.length,
            rawEntries: rawFromDu,
            summary: enrichSummaryWithInventory(summary, {
              status: "OK",
              errorMessage: null,
              hostDetectedTotalBytes: summary.buildCache.totalBytes,
              hostDetectedEntryCount: rawFromDu.length,
              rawEntries: rawFromDu,
              collectionSource: "docker_builder_du",
            }),
            durationMs: Date.now() - started,
          };
        }
        return {
          status: "PARSE_FAILED",
          errorMessage: `${errMsg}; docker builder du output could not be parsed`,
          collectionSource: "docker_builder_du",
          hostDetectedTotalBytes: summary.buildCache.totalBytes,
          hostDetectedEntryCount: summary.buildCache.entryCount,
          rawEntries: [],
          summary: enrichSummaryWithInventory(summary, {
            status: "PARSE_FAILED",
            errorMessage: `${errMsg}; docker builder du output could not be parsed`,
            hostDetectedTotalBytes: summary.buildCache.totalBytes,
            hostDetectedEntryCount: summary.buildCache.entryCount,
            rawEntries: [],
            collectionSource: "docker_builder_du",
          }),
          durationMs: Date.now() - started,
        };
      }
    }

    return {
      status: hostHasCache ? "PARSE_FAILED" : "UNAVAILABLE",
      errorMessage: errMsg,
      collectionSource: "docker_system_df_api",
      hostDetectedTotalBytes: summary.buildCache.totalBytes,
      hostDetectedEntryCount: summary.buildCache.entryCount,
      rawEntries: [],
      summary: enrichSummaryWithInventory(summary, {
        status: hostHasCache ? "PARSE_FAILED" : "UNAVAILABLE",
        errorMessage: errMsg,
        hostDetectedTotalBytes: summary.buildCache.totalBytes,
        hostDetectedEntryCount: summary.buildCache.entryCount,
        rawEntries: [],
        collectionSource: "docker_system_df_api",
      }),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const { status, message } = classifyDockerError(err);
    const summary = emptySummary(status, message);
    return {
      status,
      errorMessage: message,
      collectionSource: "none",
      hostDetectedTotalBytes: null,
      hostDetectedEntryCount: null,
      rawEntries: [],
      summary,
      durationMs: Date.now() - started,
    };
  }
}

function emptySummary(status: BuildKitInventoryStatus, errorMessage: string): DockerSystemSummary {
  return {
    imagesCount: 0,
    imagesBytes: null,
    imagesReclaimableBytes: null,
    containersCount: 0,
    containersBytes: null,
    volumesCount: 0,
    volumesBytes: null,
    buildCache: {
      entryCount: null,
      totalBytes: null,
      reclaimableBytes: null,
      source: "unavailable",
      inventoryStatus: status,
      inventoryError: errorMessage,
      hostDetectedTotalBytes: null,
      hostDetectedEntryCount: null,
      collectionSource: "none",
    },
  };
}

export function buildKitCleanupBlockedReason(
  collection: Pick<BuildKitInventoryCollection, "status" | "errorMessage" | "rawEntries">,
  investigation: BuildKitInvestigation,
): string {
  if (collection.status !== "OK") {
    return `buildkit_inventory_${collection.status.toLowerCase()}:${collection.errorMessage ?? "unknown"}`;
  }
  if (collection.rawEntries.length === 0) {
    return "buildkit_inventory_empty";
  }
  if (!investigation.safeToPrune) {
    return `buildkit_not_safe:confidence=${investigation.confidencePct}`;
  }
  return "cleanup_blocked_pending_approval";
}

export function investigateFromCollection(collection: BuildKitInventoryCollection): BuildKitInvestigation {
  const inv = investigateBuildKitFromRaw(collection.rawEntries);
  const blockedReason = buildKitCleanupBlockedReason(collection, inv);
  if (collection.status !== "OK") {
    return {
      ...inv,
      confidencePct: 0,
      confidenceLabel: "LOW",
      safeToPrune: false,
      inventoryStatus: collection.status,
      inventoryError: collection.errorMessage,
      collectionSource: collection.collectionSource,
      cleanupBlockedReason: blockedReason,
      whyNot99Plus: [
        `inventory_status:${collection.status}`,
        collection.errorMessage ?? "build_cache_inventory_unavailable",
        ...inv.whyNot99Plus,
      ],
    };
  }
  if (collection.rawEntries.length === 0) {
    return {
      ...inv,
      confidencePct: 0,
      confidenceLabel: "LOW",
      safeToPrune: false,
      inventoryStatus: "PARSE_FAILED",
      inventoryError: collection.errorMessage ?? "build_cache_inventory_empty",
      collectionSource: collection.collectionSource,
      cleanupBlockedReason: blockedReason,
      whyNot99Plus: ["build_cache_inventory_empty", ...inv.whyNot99Plus],
    };
  }
  return {
    ...inv,
    inventoryStatus: "OK",
    inventoryError: null,
    collectionSource: collection.collectionSource,
    cleanupBlockedReason: blockedReason,
  };
}
