"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useAppContext } from "../../../../../hooks/useAppContext";

/** Resolve admin billing tenant from global workspace + optional deep-link ?tenantId=. */
export function useAdminBillingTenant(validTenantIds?: string[]) {
  const { tenantId: globalTenantId, tenant, adminScope } = useAppContext();
  const rawSearchParams = useSearchParams();
  const urlTenantId = String(rawSearchParams.get("tenantId") || "").trim();

  const isGlobalScope = adminScope === "GLOBAL";

  const effectiveTenantId = useMemo(() => {
    const isValid = (id: string) => !validTenantIds?.length || validTenantIds.includes(id);

    if (urlTenantId && isValid(urlTenantId)) return urlTenantId;

    if (isGlobalScope) return "";

    if (globalTenantId && globalTenantId !== "local" && isValid(globalTenantId)) {
      return globalTenantId;
    }

    return "";
  }, [urlTenantId, isGlobalScope, globalTenantId, validTenantIds]);

  const displayName = useMemo(() => {
    if (isGlobalScope && !effectiveTenantId) return "All workspaces";
    if (tenant?.name && tenant.id === effectiveTenantId) return tenant.name;
    return effectiveTenantId ? "Workspace" : "";
  }, [effectiveTenantId, isGlobalScope, tenant?.id, tenant?.name]);

  return {
    adminScope,
    isGlobalScope,
    globalTenantId,
    urlTenantId,
    effectiveTenantId,
    displayName,
  };
}
