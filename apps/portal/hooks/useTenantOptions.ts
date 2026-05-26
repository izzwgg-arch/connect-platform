"use client";

/**
 * useTenantOptions — canonical shared hook for admin tenant dropdowns.
 *
 * Fetches GET /admin/tenant-options which returns merged Connect + PBX tenants.
 * Automatically refetches when the "cc-pbx-tenants-refreshed" browser event fires
 * (dispatched by useAppContext.refreshPbxTenants after a successful PBX sync).
 *
 * source values:
 *   "connect" — a Connect Tenant row with no PBX link
 *   "linked"  — a Connect Tenant row linked to a VitalPBX tenant via TenantPbxLink
 *   "pbx"     — a VitalPBX tenant in PbxTenantDirectory with no Connect Tenant row yet
 *
 * Security: the endpoint gates on canManageUsers (SUPER_ADMIN / TENANT_ADMIN / ADMIN).
 * Non-super-admins only receive their own tenant.
 * End-users never receive this list.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "../services/apiClient";

export const PBX_TENANTS_REFRESHED_EVENT = "cc-pbx-tenants-refreshed";

export type TenantOption = {
  id: string;
  name: string;
  source: "connect" | "pbx" | "linked";
  pbxTenantId: string | null;
  pbxTenantCode: string | null;
  pbxSlug: string | null;
};

type OptionsResponse = { options: TenantOption[] };

/**
 * Returns all tenant options (Connect + PBX-only) for SUPER_ADMIN,
 * or just the caller's own tenant for TENANT_ADMIN/ADMIN.
 *
 * connectOnly: when true, filters to source "connect" | "linked" only
 * (i.e. tenants that have a real Connect Tenant row — required when creating users
 * or filtering users, since users must belong to a real Connect tenant).
 */
export function useTenantOptions(opts?: { connectOnly?: boolean }) {
  const { connectOnly = false } = opts ?? {};

  const [allOptions, setAllOptions] = useState<TenantOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setIsLoading(true);
    try {
      const result = await apiGet<OptionsResponse>("/admin/tenant-options");
      if (ctrl.signal.aborted) return;
      setAllOptions(result.options ?? []);
    } catch {
      if (!ctrl.signal.aborted) setAllOptions([]);
    } finally {
      if (!ctrl.signal.aborted) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      abortRef.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    const handler = () => {
      void load();
    };
    window.addEventListener(PBX_TENANTS_REFRESHED_EVENT, handler);
    return () => window.removeEventListener(PBX_TENANTS_REFRESHED_EVENT, handler);
  }, [load]);

  const options = connectOnly
    ? allOptions.filter((o) => o.source === "connect" || o.source === "linked")
    : allOptions;

  return { options, allOptions, isLoading };
}
