"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { hasPermission } from "../permissions/permissionMap";
import { mapBackendRole, readJwtPayload } from "../services/session";
import { apiGet } from "../services/apiClient";
import { loadTenantOptions } from "../services/tenantData";
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
};

const FALLBACK_TENANT: Tenant = { id: "local", name: "My Workspace", plan: "Business", status: "ACTIVE" };

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>("dark");
  /** Proven only from JWT `role` or GET `/me` — never assume SUPER_ADMIN without either. */
  const [role, setRole] = useState<Role>("END_USER");
  const [backendJwtRole, setBackendJwtRole] = useState<string | undefined>(undefined);
  const [tenantId, setTenantId] = useState<string>("local");
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [adminScope, setAdminScopeState] = useState<AdminScope>("TENANT");
  const [userAvatarUrl, setUserAvatarUrl] = useState<string | null>(null);
  /** When set, `can()` uses this list from the API instead of the bundled role map (platform permission overrides). */
  const [portalPermissionOverride, setPortalPermissionOverride] = useState<Permission[] | null | undefined>(undefined);

  useEffect(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem("cc-theme") : null;
    if (stored === "dark" || stored === "light") setThemeState(stored);

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

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cc-theme", theme);
  }, [theme]);

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
    loadTenantOptions()
      .then((rows) => {
        if (!active) return;
        setTenants(rows);
      })
      .catch(() => {
        if (!active) return;
        setTenants([]);
      });
    return () => {
      active = false;
    };
  }, [canPermission, role]);

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
    }),
    [adminScope, backendJwtRole, canPermission, meTenant, role, tenant, tenantId, tenants, theme, user, setUserAvatarUrl]
  );

  return <AppContext.Provider value={ctx}>{children}</AppContext.Provider>;
}

export function useAppContext(): AppContextType {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppContext must be used inside AppProvider");
  return ctx;
}
