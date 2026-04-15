"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { hasPermission } from "../permissions/permissionMap";
import { mapBackendRole, readJwtPayload } from "../services/session";
import { loadTenantOptions } from "../services/tenantData";
import type { AdminScope, Permission, Role, Tenant, User } from "../types/app";

type ThemeMode = "dark" | "light";

type AppContextType = {
  user: User;
  role: Role;
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
};

const FALLBACK_TENANT: Tenant = { id: "local", name: "My Workspace", plan: "Business", status: "ACTIVE" };

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>("dark");
  const [role, setRole] = useState<Role>("SUPER_ADMIN");
  const [tenantId, setTenantId] = useState<string>("local");
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [adminScope, setAdminScopeState] = useState<AdminScope>("TENANT");

  useEffect(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem("cc-theme") : null;
    if (stored === "dark" || stored === "light") setThemeState(stored);

    const jwt = readJwtPayload();
    const resolvedRole = jwt?.role ? mapBackendRole(jwt.role) : "SUPER_ADMIN";

    const storedScope = typeof window !== "undefined" ? localStorage.getItem("cc-admin-scope") : null;
    const scopeMigrated = typeof window !== "undefined" ? localStorage.getItem("cc-scope-migrated") : null;

    if (resolvedRole === "SUPER_ADMIN" && !scopeMigrated && storedScope === "TENANT") {
      // One-time migration: SUPER_ADMINs who had the old "TENANT" default stored
      // are reset to GLOBAL so they see all tenant calls by default.
      // A deliberate tenant selection after this will re-store "TENANT" and set the migrated flag.
      setAdminScopeState("GLOBAL");
      localStorage.setItem("cc-admin-scope", "GLOBAL");
      localStorage.setItem("cc-scope-migrated", "1");
    } else if (storedScope === "GLOBAL" || storedScope === "TENANT") {
      setAdminScopeState(storedScope);
    } else if (resolvedRole === "SUPER_ADMIN") {
      // No scope stored yet — default SUPER_ADMIN to GLOBAL.
      setAdminScopeState("GLOBAL");
    }

    if (jwt?.role) setRole(resolvedRole);
    const storedTenant = typeof window !== "undefined" ? localStorage.getItem("cc-tenant-id") : null;
    const resolvedTenantId = jwt?.tenantId || storedTenant || "local";
    setTenantId(resolvedTenantId);
  }, []);

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
    if (!hasPermission(role, "can_switch_tenants")) {
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
  }, [role]);

  useEffect(() => {
    if (tenants.length > 0 && !tenants.some((entry: Tenant) => entry.id === tenantId)) {
      setTenantId(tenants[0]?.id || tenantId);
    }
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
    };
  }, [role, tenantId]);

  const tenant = useMemo<Tenant>(() => {
    return tenants.find((entry: Tenant) => entry.id === tenantId) || tenants[0] || FALLBACK_TENANT;
  }, [tenantId, tenants]);

  const ctx = useMemo<AppContextType>(
    () => ({
      user: { ...user, tenantId },
      role,
      theme,
      tenantId,
      tenant,
      tenants,
      adminScope,
      can: (permission: Permission) => hasPermission(role, permission),
      setTheme: setThemeState,
      setTenantId,
      setRole,
      setAdminScope: (scope: AdminScope) => {
        // Mark migration done so future explicit tenant selections are respected.
        if (typeof window !== "undefined") localStorage.setItem("cc-scope-migrated", "1");
        setAdminScopeState(scope);
      }
    }),
    [adminScope, role, tenant, tenantId, tenants, theme, user]
  );

  return <AppContext.Provider value={ctx}>{children}</AppContext.Provider>;
}

export function useAppContext(): AppContextType {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppContext must be used inside AppProvider");
  return ctx;
}
