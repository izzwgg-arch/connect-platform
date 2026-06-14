import {
  isProtectedImageRef,
  isProtectedPath,
  isProtectedVolumeName,
} from "./protectionRules";
import type {
  StorageClassification,
  StorageInventoryItem,
  StorageItemKind,
  StorageMaintenanceConfig,
} from "./types";

export type ClassifyInput = {
  kind: StorageItemKind;
  label: string;
  pathOrRef: string;
  sizeBytes: number | null;
  metadata?: Record<string, string | number | boolean | null>;
};

function classifyFilesystemPath(path: string, config: StorageMaintenanceConfig): StorageClassification {
  if (isProtectedPath(path, config)) return "PROTECTED_NEVER_DELETE";
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith(`${config.appRoot}/app`)) return "ACTIVE_REQUIRED";
  if (normalized.startsWith(config.downloadsRoot)) return "SAFE_CANDIDATE";
  if (normalized.startsWith(config.monitoringLogsRoot)) return "SAFE_CANDIDATE";
  if (normalized.includes("/var/log/journal")) return "SAFE_CANDIDATE";
  if (normalized.startsWith("/var/log/connect-deploys")) return "UNKNOWN_REQUIRES_REVIEW";
  if (normalized.startsWith(config.containerdRoot)) return "SAFE_CANDIDATE";
  if (normalized.startsWith("/var/lib/docker")) return "UNKNOWN_REQUIRES_REVIEW";
  return "UNKNOWN_REQUIRES_REVIEW";
}

function classifyDockerImage(
  repository: string,
  tag: string,
  containers: number,
): StorageClassification {
  if (isProtectedImageRef(repository, tag, containers)) {
    return containers > 0 ? "ACTIVE_REQUIRED" : "PROTECTED_NEVER_DELETE";
  }
  if (tag.includes("candidate") || repository.includes("candidate")) return "ROLLBACK_CANDIDATE";
  if (containers === 0) return "SAFE_CANDIDATE";
  return "ACTIVE_REQUIRED";
}

export function classifyStorageItem(
  input: ClassifyInput,
  config: StorageMaintenanceConfig,
): Pick<StorageInventoryItem, "classification" | "evidence" | "reclaimableBytes"> {
  const { kind, pathOrRef, metadata = {} } = input;
  let classification: StorageClassification = "UNKNOWN_REQUIRES_REVIEW";
  let evidence = "default_unknown";

  switch (kind) {
    case "filesystem_path":
    case "log_directory":
    case "diagnostic_dump":
      classification = classifyFilesystemPath(pathOrRef, config);
      evidence = `path_policy:${classification}`;
      break;
    case "docker_build_cache":
      classification = "SAFE_CANDIDATE";
      evidence = "buildkit_cache_rebuildable";
      break;
    case "docker_image": {
      const repo = String(metadata.repository ?? pathOrRef.split(":")[0] ?? "");
      const tag = String(metadata.tag ?? "latest");
      const containers = Number(metadata.containers ?? 0);
      classification = classifyDockerImage(repo, tag, containers);
      evidence = `image_policy containers=${containers} repo=${repo}:${tag}`;
      break;
    }
    case "docker_container": {
      const status = String(metadata.status ?? "");
      classification = status.includes("running") ? "ACTIVE_REQUIRED" : "UNKNOWN_REQUIRES_REVIEW";
      evidence = `container_status:${status || "unknown"}`;
      break;
    }
    case "docker_volume": {
      const links = Number(metadata.links ?? 0);
      const name = pathOrRef;
      if (isProtectedVolumeName(name)) {
        classification = links > 0 ? "ACTIVE_REQUIRED" : "PROTECTED_NEVER_DELETE";
        evidence = `protected_volume_name links=${links}`;
      } else if (links > 0) {
        classification = "ACTIVE_REQUIRED";
        evidence = `attached_volume links=${links}`;
      } else {
        classification = "UNKNOWN_REQUIRES_REVIEW";
        evidence = "detached_volume";
      }
      break;
    }
    case "bind_mount":
      classification = isProtectedPath(pathOrRef, config) ? "PROTECTED_NEVER_DELETE" : "ACTIVE_REQUIRED";
      evidence = `bind_mount_policy:${classification}`;
      break;
    case "apk_download":
      classification = "SAFE_CANDIDATE";
      evidence = "apk_retention_candidate";
      break;
    default:
      classification = "UNKNOWN_REQUIRES_REVIEW";
      evidence = "unhandled_kind";
  }

  const reclaimable =
    classification === "SAFE_CANDIDATE" || classification === "ROLLBACK_CANDIDATE"
      ? input.sizeBytes
      : null;

  return {
    classification,
    evidence,
    reclaimableBytes: reclaimable,
  };
}

export function buildInventoryItem(
  id: string,
  input: ClassifyInput,
  config: StorageMaintenanceConfig,
): StorageInventoryItem {
  const classified = classifyStorageItem(input, config);
  return {
    id,
    kind: input.kind,
    label: input.label,
    pathOrRef: input.pathOrRef,
    sizeBytes: input.sizeBytes,
    metadata: input.metadata,
    ...classified,
  };
}
