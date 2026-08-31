import type { Permission } from "../types/app";
import { normalizeNavVisibility, type PortalNavVisibility } from "@connect/shared";
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

/**
 * The platform owner's per-page sidebar switches, cached for the same session
 * scope as the permission set above.
 *
 * ⛔ Cached for ONE reason: without it, every page load paints the full sidebar
 * and then removes the switched-off entries when GET /me lands — a visible
 * flash of pages the owner deliberately hid. Reading it is best-effort and a
 * miss means "nothing hidden", which is the safe direction (a link too many,
 * never a page exposed — the permission checks are what actually gate).
 */
const NAV_VISIBILITY_CACHE_KEY = "cc-portal-nav-visibility-v1";

type CachedNavVisibility = {
  userId: string;
  tenantId: string;
  visibility: PortalNavVisibility;
};

export function readCachedNavVisibility(): PortalNavVisibility | null {
  if (typeof window === "undefined") return null;
  const scope = cacheScope();
  if (!scope) return null;
  try {
    const raw = sessionStorage.getItem(NAV_VISIBILITY_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedNavVisibility;
    if (parsed.userId !== scope.userId || parsed.tenantId !== scope.tenantId) return null;
    return normalizeNavVisibility(parsed.visibility);
  } catch {
    return null;
  }
}

export function writeCachedNavVisibility(visibility: PortalNavVisibility): void {
  if (typeof window === "undefined") return;
  const scope = cacheScope();
  if (!scope) return;
  try {
    const payload: CachedNavVisibility = {
      userId: scope.userId,
      tenantId: scope.tenantId,
      visibility,
    };
    sessionStorage.setItem(NAV_VISIBILITY_CACHE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore quota / private mode */
  }
}

export function clearCachedNavVisibility(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(NAV_VISIBILITY_CACHE_KEY);
  } catch {
    /* storage blocked — nothing cached to clear */
  }
}
