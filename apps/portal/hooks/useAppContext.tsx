"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { hasPermission } from "../permissions/permissionMap";
import { mapBackendRole, readJwtPayload, writeAuthToken } from "../services/session";
import { ApiError, apiGet, apiPost } from "../services/apiClient";
import { loadTenantOptions } from "../services/tenantData";
import { PBX_TENANTS_REFRESHED_EVENT, PBX_SYNC_COMPLETE_EVENT } from "./useTenantOptions";
import {
  PORTAL_PERMISSIONS_HYDRATED_EVENT,
  clearCachedPortalPermissions,
  notifyPortalPermissionsHydrated,
  readCachedPortalPermissions,
  writeCachedPortalPermissions,
} from "../services/portalPermissionHydration";
import {
  bootstrapVisualQaSession,
  clearStaleVisualQaSession,
  isVisualQaModeEnabled,
} from "../services/visualQaMode";
import type { AdminScope, Permission, Role, Tenant, User } from "../types/app";

function readInitialRole(): Role {
  if (typeof window === "undefined") return "END_USER";
  const jwt = readJwtPayload();
  return jwt?.role ? mapBackendRole(jwt.role) : "END_USER";
}

function readInitialBackendJwtRole(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const jwt = readJwtPayload();
  return jwt?.role ? String(jwt.role) : undefined;
}

function readInitialPortalPermissionOverride(): Permission[] | null | undefined {
  if (typeof window === "undefined") return undefined;
  return readCachedPortalPermissions() ?? undefined;
}

/** True when we can render routes optimistically (cached perms or signed-in JWT). */
function readInitialPermissionsHydrated(): boolean {
  if (typeof window === "undefined") return false;
  if (readCachedPortalPermissions()) return true;
  return Boolean(readJwtPayload()?.sub);
}

type ThemeMode = "dark" | "light";

type AppContextType = {
  user: User;
  role: Role;
  /** Raw platform role for nav gates (e.g. SUPER_ADMIN): JWT claim until GET /me overwrites when `me.role` is present. */
  backendJwtRole: string | undefined;
  theme: ThemeMode;
  tenantId: string;
  tenant: Tenant;
  tenants: Tenant[];
  adminScope: AdminScope;
  can: (permission: Permission) => boolean;
  /** False until GET /me (or login) has resolved portal permissions — gates nav deny flashes. */
  permissionsHydrated: boolean;
  setTheme: (theme: ThemeMode) => void;
  setTenantId: (tenantId: string) => void;
  setRole: (role: Role) => void;
  setAdminScope: (scope: AdminScope) => void;
  setUserAvatarUrl: (url: string | null) => void;
  refreshPbxTenants: () => Promise<{ ok: true; message: string } | { ok: false; message: string }>;
  tenantRefreshPending: boolean;
};

const FALLBACK_TENANT: Tenant = { id: "local", name: "My Workspace", plan: "Business", status: "ACTIVE" };

const AppContext = createContext<AppContextType | null>(null);

type MeExtension = {
  id?: string | null;
  number?: string | null;
  extNumber?: string | null;
  extensionNumber?: string | null;
  displayName?: string | null;
  name?: string | null;
  label?: string | null;
  status?: string | null;
} | null;

type MeUser = {
  id?: string | null;
  name?: string | null;
  email?: string | null;
  extension?: MeExtension;
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>("light");
  const [themeHydrated, setThemeHydrated] = useState(false);
  /** Proven only from JWT `role` or GET `/me` — never assume SUPER_ADMIN without either. */
  const [role, setRole] = useState<Role>(readInitialRole);
  const [backendJwtRole, setBackendJwtRole] = useState<string | undefined>(readInitialBackendJwtRole);
  const [permissionsHydrated, setPermissionsHydrated] = useState(readInitialPermissionsHydrated);
  const [tenantId, setTenantId] = useState<string>("local");
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [adminScope, setAdminScopeState] = useState<AdminScope>("TENANT");
  const [userAvatarUrl, setUserAvatarUrl] = useState<string | null>(null);
  const [tenantRefreshPending, setTenantRefreshPending] = useState(false);
  /** When set, `can()` uses this list from the API instead of the bundled role map (platform permission overrides). */
  const [portalPermissionOverride, setPortalPermissionOverride] = useState<Permission[] | null | undefined>(
    readInitialPortalPermissionOverride,
  );

  useEffect(() => {
    clearStaleVisualQaSession();
    if (isVisualQaModeEnabled()) bootstrapVisualQaSession();

    const cached = readCachedPortalPermissions();
    if (cached) {
      setPortalPermissionOverride(cached);
      setPermissionsHydrated(true);
    }

    const stored = typeof window !== "undefined" ? localStorage.getItem("cc-theme") : null;
    if (stored === "dark" || stored === "light") setThemeState(stored);
    setThemeHydrated(true);

    const jwt = readJwtPayload();

    const storedScope = typeof window !== "undefined" ? localStorage.getItem("cc-admin-scope") : null;
    // Default to scoped primary workspace (TENANT). GLOBAL is opt-in and only restored from localStorage.
    if (storedScope === "GLOBAL" || storedScope === "TENANT") {
      setAdminScopeState(storedScope);
    } else {
      setAdminScopeState("TENANT");
    }

    if (jwt?.role) {
      setRole(mapBackendRole(jwt.role));
      setBackendJwtRole(String(jwt.role));
    } else {
      setBackendJwtRole(undefined);
    }
    const storedTenant = typeof window !== "undefined" ? localStorage.getItem("cc-tenant-id") : null;
    // For super-admins the stored value is their chosen workspace tenant, which must
    // win over jwt.tenantId (their home/platform tenant). For regular users the JWT
    // tenant is authoritative and storedTenant is a stable echo of it.
    const isSuperAdmin = jwt?.role === "SUPER_ADMIN";
    const resolvedTenantId = (isSuperAdmin ? storedTenant : null) ?? jwt?.tenantId ?? storedTenant ?? "local";
    setTenantId(resolvedTenantId);
  }, []);

  // Hydrated from GET /me. For regular tenant users (who don't load
  // `tenants[]` via the admin switcher), this is the only way to get a real
  // tenant display name — without it the `tenant` object falls back to
  // "My Workspace" and client-side tenant-name filters drop every row.
  const [meTenant, setMeTenant] = useState<{ id: string; name: string | null } | null>(null);
  const [meUser, setMeUser] = useState<MeUser | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let active = true;
    const applyMe = (me: {
      portalPermissionSet?: string[] | null;
      tenantId?: string | null;
      tenantName?: string | null;
      avatarUrl?: string | null;
      role?: string | null;
      token?: string | null;
      id?: string | null;
      name?: string | null;
      email?: string | null;
      extension?: MeExtension;
    }) => {
      if (!active) return;
      if (me.token) {
        writeAuthToken(me.token);
      }
      if (Array.isArray(me.portalPermissionSet)) {
        const perms = me.portalPermissionSet as Permission[];
        setPortalPermissionOverride(perms);
        writeCachedPortalPermissions(perms);
      } else {
        // Keep login/cached permissions when /me omits portalPermissionSet (older API builds).
        const cached = readCachedPortalPermissions();
        if (cached) {
          setPortalPermissionOverride(cached);
        }
      }
      if (me.role != null && String(me.role).trim() !== "") {
        setRole(mapBackendRole(me.role));
        setBackendJwtRole(String(me.role));
      }
      if (me.tenantId) {
        setMeTenant({
          id: me.tenantId,
          name: me.tenantName ?? null,
        });
      }
      if (me.avatarUrl) setUserAvatarUrl(me.avatarUrl);
      setMeUser({
        id: me.id ?? null,
        name: me.name ?? null,
        email: me.email ?? null,
        extension: me.extension ?? null,
      });
      setPermissionsHydrated(true);
      if (Array.isArray(me.portalPermissionSet)) {
        notifyPortalPermissionsHydrated(me.portalPermissionSet as Permission[]);
      } else {
        notifyPortalPermissionsHydrated();
      }
    };

    const load = () => {
      if (!readJwtPayload()?.sub) {
        setPortalPermissionOverride(null);
        clearCachedPortalPermissions();
        setPermissionsHydrated(true);
        return;
      }
      const hydrateTimeout = window.setTimeout(() => {
        if (!active) return;
        setPermissionsHydrated(true);
      }, 3500);
      apiGet<{
        portalPermissionSet?: string[] | null;
        tenantId?: string | null;
        tenantName?: string | null;
        avatarUrl?: string | null;
        role?: string | null;
        token?: string | null;
        id?: string | null;
        name?: string | null;
        email?: string | null;
        extension?: MeExtension;
      }>("/me")
        .then((me) => {
          window.clearTimeout(hydrateTimeout);
          applyMe(me);
        })
        .catch(() => {
          window.clearTimeout(hydrateTimeout);
          if (!active) return;
          const cached = readCachedPortalPermissions();
          if (cached) {
            setPortalPermissionOverride(cached);
          }
          setPermissionsHydrated(true);
        });
    };
    load();
    const onSaved = () => {
      const jwt = readJwtPayload();
      if (jwt?.role) {
        setRole(mapBackendRole(jwt.role));
        setBackendJwtRole(String(jwt.role));
      }
      load();
    };
    const onHydrated = (event: Event) => {
      const detail = (event as CustomEvent<Permission[] | null>).detail;
      if (!active) return;
      if (Array.isArray(detail)) {
        setPortalPermissionOverride(detail);
        writeCachedPortalPermissions(detail);
      }
      setPermissionsHydrated(true);
    };
    window.addEventListener("cc-portal-permissions-saved", onSaved);
    window.addEventListener(PORTAL_PERMISSIONS_HYDRATED_EVENT, onHydrated);
    return () => {
      active = false;
      window.removeEventListener("cc-portal-permissions-saved", onSaved);
      window.removeEventListener(PORTAL_PERMISSIONS_HYDRATED_EVENT, onHydrated);
    };
  }, []);

  const canPermission = useMemo(
    () => (permission: Permission) => {
      // Platform SUPER_ADMIN always has the full portal map — stale cached override lists must not weaken them.
      if (role === "SUPER_ADMIN" || backendJwtRole === "SUPER_ADMIN") {
        return hasPermission("SUPER_ADMIN", permission);
      }
      if (Array.isArray(portalPermissionOverride)) {
        return portalPermissionOverride.includes(permission);
      }
      return hasPermission(role, permission);
    },
    [portalPermissionOverride, role, backendJwtRole],
  );

  const reloadTenantOptions = useCallback(async () => {
    if (!canPermission("can_switch_tenants")) {
      setTenants([]);
      return;
    }
    const rows = await loadTenantOptions();
    setTenants(rows);
  }, [canPermission]);

  const refreshPbxTenants = useCallback(async () => {
    if (tenantRefreshPending) return { ok: false as const, message: "Refresh already running." };
    setTenantRefreshPending(true);
    try {
      const result = await apiPost<{
        ok?: boolean;
        pbxTenantCount?: number;
        directoryCreated?: number;
        directoryUpdated?: number;
        directoryDeleted?: number;
        extensionsFound?: number | null;
        extensionsUpserted?: number | null;
        extensionsDeactivated?: number | null;
        extensionsSkippedTenants?: number | null;
        extensionsAutoProvisioned?: number | null;
        linkedTenants?: number | null;
        didSource?: string | null;
        didTenantsProcessed?: number | null;
        didNumbersUpserted?: number | null;
        didErrors?: number | null;
        lastSyncedAt?: string;
        durationMs?: number;
        retryAfterMs?: number;
      }>("/admin/pbx/refresh-tenants", undefined, undefined, { timeoutMs: 60_000 });
      await reloadTenantOptions();
      // Notify all useTenantOptions consumers to refetch.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(PBX_TENANTS_REFRESHED_EVENT));
        // Full sync complete — includes extension data. Triggers useExtensionOptions refetch.
        window.dispatchEvent(new CustomEvent(PBX_SYNC_COMPLETE_EVENT, { detail: result }));
      }
      const tenantChanged = Number(result.directoryCreated || 0) + Number(result.directoryUpdated || 0);
      const extParts: string[] = [];
      if (result.extensionsFound != null) extParts.push(`${result.extensionsFound} ext`);
      if (result.extensionsUpserted != null && result.extensionsUpserted > 0) extParts.push(`${result.extensionsUpserted} synced`);
      if (result.extensionsDeactivated != null && result.extensionsDeactivated > 0) extParts.push(`${result.extensionsDeactivated} deactivated`);
      if (result.extensionsAutoProvisioned != null && result.extensionsAutoProvisioned > 0) extParts.push(`${result.extensionsAutoProvisioned} tenants auto-linked`);
      const extSummary = extParts.length ? ` | ${extParts.join(", ")}` : "";
      const didParts: string[] = [];
      if (result.didSource && result.didSource !== "skipped") {
        if (result.didNumbersUpserted != null) didParts.push(`${result.didNumbersUpserted} DIDs synced`);
        if (result.didTenantsProcessed != null) didParts.push(`${result.didTenantsProcessed} tenants`);
      }
      const didSummary = didParts.length ? ` | ${didParts.join(", ")}` : "";
      return {
        ok: true as const,
        message: `PBX sync complete — ${result.pbxTenantCount ?? "?"} tenants (${tenantChanged} changed, ${result.directoryDeleted || 0} removed)${extSummary}${didSummary}.`,
        detail: result,
      };
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const retryAfterMs = Number((err.body as { retryAfterMs?: unknown } | null)?.retryAfterMs || 0);
        const waitSec = retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : 30;
        return { ok: false as const, message: `PBX refresh is cooling down. Try again in about ${waitSec}s.` };
      }
      return { ok: false as const, message: err instanceof Error ? err.message : "PBX refresh failed." };
    } finally {
      setTenantRefreshPending(false);
    }
  }, [reloadTenantOptions, tenantRefreshPending]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    if (themeHydrated) localStorage.setItem("cc-theme", theme);
  }, [theme, themeHydrated]);

  useEffect(() => {
    localStorage.setItem("cc-tenant-id", tenantId);
  }, [tenantId]);

  useEffect(() => {
    const normalized = role === "SUPER_ADMIN" ? adminScope : "TENANT";
    if (normalized !== adminScope) setAdminScopeState(normalized);
    localStorage.setItem("cc-admin-scope", normalized);
  }, [adminScope, role]);

  useEffect(() => {
    let active = true;
    if (!canPermission("can_switch_tenants")) {
      // Non-super-admins only see their own tenant
      setTenants([]);
      return;
    }
    reloadTenantOptions()
      .then(() => {
        if (!active) return;
      })
      .catch(() => {
        if (!active) return;
        setTenants([]);
      });
    return () => {
      active = false;
    };
  }, [reloadTenantOptions, role]);

  useEffect(() => {
    if (tenants.length === 0) return;
    if (tenants.some((entry: Tenant) => entry.id === tenantId)) return;
    const jwt = readJwtPayload();
    const jwtTid = jwt?.tenantId;
    // Only fall back to the JWT home tenant if it's actually in the list.
    // Never silently jump to tenants[0] — that would redirect super-admins to
    // the first alphabetical tenant ("A Plus Center") whenever the stored ID
    // briefly doesn't match (e.g. during initial hydration).
    if (jwtTid && tenants.some((entry: Tenant) => entry.id === jwtTid)) {
      setTenantId(jwtTid);
    }
    // else: keep the current tenantId and wait for it to resolve naturally.
  }, [tenantId, tenants]);

  const user = useMemo<User>(() => {
    const jwt = readJwtPayload();
    const extension = meUser?.extension ?? null;
    const extensionNumber = extension?.number || extension?.extNumber || extension?.extensionNumber || "";
    const extensionDisplayName = extension?.displayName || extension?.name || extension?.label || null;
    return {
      id: meUser?.id || jwt?.sub || "local-user",
      name: meUser?.name || jwt?.name || jwt?.email || "User",
      email: meUser?.email || jwt?.email || "",
      extension: extensionNumber,
      extensionDisplayName,
      role,
      tenantId,
      presence: "AVAILABLE",
      avatarUrl: userAvatarUrl,
    };
  }, [meUser, role, tenantId, userAvatarUrl]);

  const tenant = useMemo<Tenant>(() => {
    // 1. Prefer a tenant loaded via the super-admin switcher (rich metadata).
    const fromList = tenants.find((entry: Tenant) => entry.id === tenantId);
    if (fromList) return fromList;
    // 2. Fall back to /me for regular users: gives us the real display name
    //    so tenant-name based client filters match server rows.
    if (meTenant && meTenant.id === tenantId) {
      return {
        id: meTenant.id,
        name: meTenant.name || FALLBACK_TENANT.name,
        plan: FALLBACK_TENANT.plan,
        status: FALLBACK_TENANT.status,
      };
    }
    return tenants[0] || FALLBACK_TENANT;
  }, [tenantId, tenants, meTenant]);

  const ctx = useMemo<AppContextType>(
    () => ({
      user: { ...user, tenantId },
      role,
      backendJwtRole,
      theme,
      tenantId,
      tenant,
      tenants,
      adminScope,
      can: canPermission,
      permissionsHydrated,
      setTheme: setThemeState,
      setTenantId,
      setRole,
      setAdminScope: (scope: AdminScope) => {
        setAdminScopeState(scope);
      },
      setUserAvatarUrl,
      refreshPbxTenants,
      tenantRefreshPending,
    }),
    [
      adminScope,
      backendJwtRole,
      canPermission,
      permissionsHydrated,
      meTenant,
      meUser,
      refreshPbxTenants,
      role,
      tenant,
      tenantId,
      tenantRefreshPending,
      tenants,
      theme,
      user,
      setUserAvatarUrl,
    ]
  );

  return <AppContext.Provider value={ctx}>{children}</AppContext.Provider>;
}

export function useAppContext(): AppContextType {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppContext must be used inside AppProvider");
  return ctx;
}
