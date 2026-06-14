import { toHostDisplayPath } from "../hostVisibility";
import type { StorageMaintenanceConfig } from "../types";

/** Container path for APK downloads (rw-capable via docker run host bind). */
export const APK_CONTAINER_DOWNLOADS = "/var/lib/connect/downloads";

/** Host path for APK downloads (used in docker run -v). */
export const APK_HOST_DOWNLOADS = "/opt/connectcomms/downloads";

export function toHostExecutionPath(pathOrRef: string, config: StorageMaintenanceConfig): string {
  const root = config.hostInventoryRoot.replace(/\/+$/, "");
  if (root && pathOrRef.startsWith(`${root}/`)) {
    return toHostDisplayPath(pathOrRef, root);
  }
  if (pathOrRef.startsWith("/host-inventory/")) {
    return pathOrRef.replace("/host-inventory", "");
  }
  return pathOrRef;
}

export function apkBasename(pathOrRef: string, config: StorageMaintenanceConfig): string {
  const host = toHostExecutionPath(pathOrRef, config);
  const parts = host.split("/");
  return parts[parts.length - 1] ?? "";
}

export function apkContainerPath(pathOrRef: string, config: StorageMaintenanceConfig): string {
  const base = apkBasename(pathOrRef, config);
  if (!base || base.includes("..") || base.includes("/")) {
    throw new Error("invalid_apk_filename");
  }
  return `${APK_CONTAINER_DOWNLOADS}/${base}`;
}

export function apkHostPath(pathOrRef: string, config: StorageMaintenanceConfig): string {
  const base = apkBasename(pathOrRef, config);
  if (!base || base.includes("..") || base.includes("/")) {
    throw new Error("invalid_apk_filename");
  }
  return `${APK_HOST_DOWNLOADS}/${base}`;
}
