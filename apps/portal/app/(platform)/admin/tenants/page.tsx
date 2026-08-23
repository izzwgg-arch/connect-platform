"use client";

import { useState } from "react";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet, apiPost, apiPut } from "../../../../services/apiClient";
import { DataTable } from "../../../../components/DataTable";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { ConnectSelect } from "../../../../components/ConnectSelect";

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

  // Per-tenant sign-in code (2FA-by-code, 2026-08-19). SUPER_ADMIN only on the api.
  const setLoginOtp = async (tenantId: string, required: boolean, channel?: string) => {
    setTogglingId(tenantId);
    setToggleError(null);
    try {
      await apiPut(`/admin/tenants/${tenantId}/login-otp`, { required, ...(channel ? { channel } : {}) });
      setRefreshKey((k) => k + 1);
    } catch (e: any) {
      const detail = e?.body?.message || e?.body?.error || e?.message || "Could not update the setting.";
      setToggleError(`Sign-in code for this tenant was not changed — ${detail}`);
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
        loginOtpRequired: tenant.loginOtpRequired === true,
        loginOtpChannel: String(tenant.loginOtpChannel || "EITHER"),
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
              {
                key: "loginOtp",
                label: "Sign-in code (2FA)",
                render: (r) => (
                  <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <button
                      type="button"
                      className={r.loginOtpRequired ? "btn primary" : "btn ghost"}
                      disabled={togglingId === r.id}
                      onClick={() => setLoginOtp(r.id, !r.loginOtpRequired)}
                      title="When ON, everyone in this tenant enters a one-time code (text or email) after their password unless they chose to remember their device for 90 days; sessions expire after 90 days. Users who already use an authenticator app are not asked twice. Off by default. ⛔ Phone-app users cannot finish sign-in on the current app until the build with the code step ships."
                    >
                      {togglingId === r.id ? "Saving…" : r.loginOtpRequired ? "On" : "Off"}
                    </button>
                    {r.loginOtpRequired ? (
                      <ConnectSelect
                        size="sm"
                        value={r.loginOtpChannel}
                        disabled={togglingId === r.id}
                        onChange={(v) => setLoginOtp(r.id, true, v)}
                        ariaLabel="How the code is sent"
                        options={[
                          { value: "EITHER", label: "Text or email" },
                          { value: "SMS", label: "Text only" },
                          { value: "EMAIL", label: "Email only" },
                        ]}
                      />
                    ) : null}
                  </span>
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
