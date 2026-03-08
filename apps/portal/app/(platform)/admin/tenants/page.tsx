"use client";

import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet } from "../../../../services/apiClient";
import { DataTable } from "../../../../components/DataTable";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";

export default function AdminTenantsPage() {
  const tenants = useAsyncResource(() => apiGet<any[]>("/admin/tenants"), []);
  const rows = tenants.status === "success"
    ? tenants.data.map((tenant, idx) => ({
        id: String(tenant.id || idx),
        name: String(tenant.name || "-"),
        approved: tenant.isApproved === false ? "No" : "Yes",
        createdAt: String(tenant.createdAt || "-")
      }))
    : [];

  return (
    <PermissionGate permission="can_view_admin" fallback={<div className="state-box">You do not have tenant admin access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="Tenant Administration" subtitle="Manage tenant inventory and platform tenant context mapping." />
        {tenants.status === "loading" ? <LoadingSkeleton rows={6} /> : null}
        {tenants.status === "error" ? <ErrorState message={tenants.error} /> : null}
        {tenants.status === "success" && rows.length === 0 ? <EmptyState title="No tenants found" message="Create or sync tenants from admin PBX controls." /> : null}
        {tenants.status === "success" && rows.length > 0 ? (
          <DataTable
            rows={rows}
            columns={[
              { key: "name", label: "Tenant", render: (r) => r.name },
              { key: "approved", label: "Approved", render: (r) => r.approved },
              { key: "createdAt", label: "Created", render: (r) => r.createdAt }
            ]}
          />
        ) : null}
      </div>
    </PermissionGate>
  );
}
