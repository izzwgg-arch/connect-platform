"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { hasPermission } from "../permissions/permissionMap";
import { mockTenants, mockUsers } from "../services/mockData";
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

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>("dark");
  const [role, setRole] = useState<Role>("SUPER_ADMIN");
  const [tenantId, setTenantId] = useState<string>(mockTenants[0].id);
  const [tenants, setTenants] = useState<Tenant[]>(mockTenants);
  const [adminScope, setAdminScopeState] = useState<AdminScope>("TENANT");

  useEffect(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem("cc-theme") : null;
    if (stored === "dark" || stored === "light") setThemeState(stored);
    const storedScope = typeof window !== "undefined" ? localStorage.getItem("cc-admin-scope") : null;
    if (storedScope === "GLOBAL" || storedScope === "TENANT") setAdminScopeState(storedScope);
    const jwt = readJwtPayload();
    if (jwt?.role) setRole(mapBackendRole(jwt.role));
    if (jwt?.tenantId) setTenantId(jwt.tenantId);
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
      setTenants(mockTenants);
      return;
    }
    loadTenantOptions()
      .then((rows) => {
        if (!active) return;
        setTenants(rows.length > 0 ? rows : mockTenants);
      })
      .catch(() => {
        if (!active) return;
        setTenants(mockTenants);
      });
    return () => {
      active = false;
    };
  }, [role]);

  useEffect(() => {
    if (!tenants.some((entry) => entry.id === tenantId)) {
      setTenantId(tenants[0]?.id || mockTenants[0].id);
    }
  }, [tenantId, tenants]);

  const user = useMemo(() => {
    const match = mockUsers.find((entry) => entry.role === role);
    return match || mockUsers[0];
  }, [role]);

  const tenant = useMemo(() => {
    return tenants.find((entry) => entry.id === tenantId) || tenants[0] || mockTenants[0];
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
      setAdminScope: setAdminScopeState
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
