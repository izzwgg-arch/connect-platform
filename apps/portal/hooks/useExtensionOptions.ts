"use client";

/**
 * useExtensionOptions — canonical shared hook for admin extension dropdowns.
 *
 * Fetches GET /admin/users/catalog returning only the extension list for the
 * requested tenant. Automatically refetches when:
 *   - tenantId or userFacingOnly changes
 *   - "cc-pbx-sync-complete" fires (dispatched by useAppContext.refreshPbxTenants
 *     after the full PBX sync including extension sync completes)
 *
 * This means any admin component using this hook will show updated extensions
 * immediately after "Refresh PBX tenants" without requiring a page reload.
 *
 * Security: backed by /admin/users/catalog which requires canManageUsers.
 * Non-super-admins only see their own tenant's extensions.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "../services/apiClient";
import { PBX_SYNC_COMPLETE_EVENT } from "./useTenantOptions";

export type ExtensionOption = {
  id: string;
  extNumber: string;
  displayName: string;
  pbxUserEmail?: string | null;
  ownerUserId?: string | null;
  status?: string;
  webrtcEnabled?: boolean;
  pbxDeviceName?: string | null;
  provisionStatus?: string | null;
  isUserFacing?: boolean;
};

type CatalogExtensionsResponse = {
  extensions: ExtensionOption[];
  totalExtensions: number;
  filteredOut: number;
};

export function useExtensionOptions(params: { tenantId: string; userFacingOnly?: boolean }) {
  const { tenantId, userFacingOnly = true } = params;

  const [extensions, setExtensions] = useState<ExtensionOption[]>([]);
  const [totalExtensions, setTotalExtensions] = useState(0);
  const [filteredOut, setFilteredOut] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!tenantId) {
      setExtensions([]);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setIsLoading(true);
    try {
      const qs = new URLSearchParams({
        tenantId,
        userFacingOnly: userFacingOnly ? "true" : "false",
      });
      const r = await apiGet<CatalogExtensionsResponse>(`/admin/users/catalog?${qs.toString()}`);
      if (ctrl.signal.aborted) return;
      setExtensions(r.extensions ?? []);
      setTotalExtensions(r.totalExtensions ?? 0);
      setFilteredOut(r.filteredOut ?? 0);
    } catch {
      if (!ctrl.signal.aborted) setExtensions([]);
    } finally {
      if (!ctrl.signal.aborted) setIsLoading(false);
    }
  }, [tenantId, userFacingOnly]);

  useEffect(() => {
    void load();
    return () => { abortRef.current?.abort(); };
  }, [load]);

  // Refetch when full PBX sync completes (extensions may have changed).
  useEffect(() => {
    const handler = () => { void load(); };
    window.addEventListener(PBX_SYNC_COMPLETE_EVENT, handler);
    return () => window.removeEventListener(PBX_SYNC_COMPLETE_EVENT, handler);
  }, [load]);

  return { extensions, totalExtensions, filteredOut, isLoading, reload: load };
}
