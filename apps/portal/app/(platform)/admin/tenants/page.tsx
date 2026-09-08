"use client";

import { useState } from "react";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { DataTable } from "../../../../components/DataTable";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";

export default function AdminTenantsPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const tenants = useAsyncResource(() => apiGet<any[]>("/admin/tenants"), [refreshKey]);

  const toggleLinkedSip = async (tenantId: string, enabled: boolean) => {
    setTogglingId(tenantId);
    setToggleError(null);
    try {
      await apiPost(`/admin/tenants/${tenantId}/linked-sip-call-visibility`, { enabled });
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      const detail = e?.body?.detail || e?.message || "Could not update the setting.";
      setToggleError(`Linked SIP visibility for this tenant was not changed — ${detail}`);
    } finally {
      setTogglingId(null);
    }
  };

  const rows = tenants.status === "success"
    ? tenants.data.map((tenant, idx) => ({
        id: String(tenant.id || idx),
        name: String(tenant.name || "-"),
        approved: tenant.isApproved === false ? "No" : "Yes",
        createdAt: String(tenant.createdAt || "-"),
        linkedSipEnabled: tenant.linkedSipCallVisibilityEnabled === true,
      }))
    : [];

  return (
    <PermissionGate permission="can_view_admin" fallback={<div className="state-box">You do not have tenant admin access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="Tenant Administration" subtitle="Manage tenant inventory and platform tenant context mapping." />
        {toggleError ? <ErrorState message={toggleError} /> : null}
        {tenants.status === "loading" ? <LoadingSkeleton rows={6} /> : null}
        {tenants.status === "error" ? <ErrorState message={tenants.error} /> : null}
        {tenants.status === "success" && rows.length === 0 ? <EmptyState title="No tenants found" message="Create or sync tenants from admin PBX controls." /> : null}
        {tenants.status === "success" && rows.length > 0 ? (
          <DataTable
            rows={rows}
            columns={[
              { key: "name", label: "Tenant", render: (r) => r.name },
              { key: "approved", label: "Approved", render: (r) => r.approved },
              {
                key: "linkedSip",
                label: "Linked SIP call visibility",
                render: (r) => (
                  <button
                    type="button"
                    className={r.linkedSipEnabled ? "btn primary" : "btn ghost"}
                    disabled={togglingId === r.id}
                    onClick={() => toggleLinkedSip(r.id, !r.linkedSipEnabled)}
                    title="When ON, this tenant's admins also see call history and recordings for extensions from other companies that are linked to its users as extra SIP accounts — those extensions only."
                  >
                    {togglingId === r.id ? "Saving…" : r.linkedSipEnabled ? "On" : "Off"}
                  </button>
                ),
              },
              { key: "createdAt", label: "Created", render: (r) => r.createdAt }
            ]}
          />
        ) : null}
      </div>
    </PermissionGate>
  );
}
