"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { hasPermission } from "../permissions/permissionMap";
import { mapBackendRole, readJwtPayload } from "../services/session";
import { ApiError, apiGet, apiPost } from "../services/apiClient";
import { loadTenantOptions } from "../services/tenantData";
import { PBX_TENANTS_REFRESHED_EVENT, PBX_SYNC_COMPLETE_EVENT } from "./useTenantOptions";
import { bootstrapVisualQaSession, isVisualQaModeEnabled } from "../services/visualQaMode";
import type { AdminScope, Permission, Role, Tenant, User } from "../types/app";

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

export function AppProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>("light");
  const [themeHydrated, setThemeHydrated] = useState(false);
  /** Proven only from JWT `role` or GET `/me` — never assume SUPER_ADMIN without either. */
  const [role, setRole] = useState<Role>("END_USER");
  const [backendJwtRole, setBackendJwtRole] = useState<string | undefined>(undefined);
  const [tenantId, setTenantId] = useState<string>("local");
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [adminScope, setAdminScopeState] = useState<AdminScope>("TENANT");
  const [userAvatarUrl, setUserAvatarUrl] = useState<string | null>(null);
  const [tenantRefreshPending, setTenantRefreshPending] = useState(false);
  /** When set, `can()` uses this list from the API instead of the bundled role map (platform permission overrides). */
  const [portalPermissionOverride, setPortalPermissionOverride] = useState<Permission[] | null | undefined>(undefined);

  useEffect(() => {
    if (isVisualQaModeEnabled()) bootstrapVisualQaSession();

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
    const resolvedTenantId = jwt?.tenantId || storedTenant || "local";
    setTenantId(resolvedTenantId);
  }, []);

  // Hydrated from GET /me. For regular tenant users (who don't load
  // `tenants[]` via the admin switcher), this is the only way to get a real
  // tenant display name — without it the `tenant` object falls back to
  // "My Workspace" and client-side tenant-name filters drop every row.
  const [meTenant, setMeTenant] = useState<{ id: string; name: string | null } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let active = true;
    const load = () => {
      apiGet<{
        portalPermissionSet?: string[] | null;
        tenantId?: string | null;
        tenantName?: string | null;
        avatarUrl?: string | null;
        role?: string | null;
      }>("/me")
        .then((me) => {
          if (!active) return;
          if (Array.isArray(me.portalPermissionSet)) {
            setPortalPermissionOverride(me.portalPermissionSet as Permission[]);
          } else {
            setPortalPermissionOverride(null);
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
        })
        .catch(() => {
          if (!active) return;
          setPortalPermissionOverride(null);
        });
    };
    load();
    const onSaved = () => load();
    window.addEventListener("cc-portal-permissions-saved", onSaved);
    return () => {
      active = false;
      window.removeEventListener("cc-portal-permissions-saved", onSaved);
    };
  }, []);

  const canPermission = useMemo(
    () => (permission: Permission) => {
      if (Array.isArray(portalPermissionOverride)) {
        return portalPermissionOverride.includes(permission);
      }
      return hasPermission(role, permission);
    },
    [portalPermissionOverride, role],
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
        extensionsSkippedTenants?: number | null;
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
      if (result.extensionsFound != null) extParts.push(`${result.extensionsFound} extensions seen`);
      if (result.extensionsUpserted != null && result.extensionsUpserted > 0) extParts.push(`${result.extensionsUpserted} updated`);
      const extSummary = extParts.length ? ` | ${extParts.join(", ")}` : "";
      const didParts: string[] = [];
      if (result.didSource && result.didSource !== "skipped") {
        if (result.didNumbersUpserted != null) didParts.push(`${result.didNumbersUpserted} DIDs synced`);
        if (result.didTenantsProcessed != null) didParts.push(`${result.didTenantsProcessed} tenants`);
      }
      const didSummary = didParts.length ? ` | ${didParts.join(", ")}` : "";
      return {
        ok: true as const,
        message: `PBX sync complete — ${result.pbxTenantCount ?? "?"} tenants (${tenantChanged} changed, ${result.directoryDeleted || 0} deleted)${extSummary}${didSummary}.`,
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
    const pick =
      jwtTid && tenants.some((entry: Tenant) => entry.id === jwtTid)
        ? jwtTid
        : tenants[0]?.id || tenantId;
    setTenantId(pick);
  }, [tenantId, tenants]);

  const user = useMemo<User>(() => {
    const jwt = readJwtPayload();
    return {
      id: jwt?.sub || "local-user",
      name: jwt?.name || jwt?.email || "User",
      email: jwt?.email || "",
      extension: "",
      role,
      tenantId,
      presence: "AVAILABLE",
      avatarUrl: userAvatarUrl,
    };
  }, [role, tenantId, userAvatarUrl]);

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
      meTenant,
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
