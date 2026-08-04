import type { Permission } from "../types/app";
import { readJwtPayload } from "./session";

/** Bump when permission shape changes (e.g. CRM bootstrap) to drop stale session caches. */
const CACHE_KEY = "cc-portal-permissions-v3";
export const PORTAL_PERMISSIONS_HYDRATED_EVENT = "cc-portal-permissions-hydrated";

type CachedPermissions = {
  userId: string;
  tenantId: string;
  permissions: Permission[];
};

function cacheScope(): { userId: string; tenantId: string } | null {
  const jwt = readJwtPayload();
  if (!jwt?.sub) return null;
  return { userId: String(jwt.sub), tenantId: String(jwt.tenantId || "") };
}

export function readCachedPortalPermissions(): Permission[] | null {
  if (typeof window === "undefined") return null;
  const scope = cacheScope();
  if (!scope) return null;
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedPermissions;
    if (parsed.userId !== scope.userId || parsed.tenantId !== scope.tenantId) return null;
    if (!Array.isArray(parsed.permissions)) return null;
    return parsed.permissions;
  } catch {
    return null;
  }
}

export function writeCachedPortalPermissions(permissions: Permission[]): void {
  if (typeof window === "undefined") return;
  const scope = cacheScope();
  if (!scope) return;
  try {
    const payload: CachedPermissions = {
      userId: scope.userId,
      tenantId: scope.tenantId,
      permissions,
    };
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore quota / private mode */
  }
}

export function clearCachedPortalPermissions(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(CACHE_KEY);
  } catch {
    /* storage blocked — nothing cached to clear */
  }
}

export function notifyPortalPermissionsHydrated(permissions?: Permission[]): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(PORTAL_PERMISSIONS_HYDRATED_EVENT, {
      detail: permissions,
    }),
  );
}

/** Apply permissions returned from POST /auth/login before navigation. */
export function applyPortalPermissionsFromLogin(permissions: Permission[] | null | undefined): void {
  if (!Array.isArray(permissions)) return;
  writeCachedPortalPermissions(permissions);
  notifyPortalPermissionsHydrated(permissions);
}
