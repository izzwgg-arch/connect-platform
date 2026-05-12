"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiGet } from "../../../../../services/apiClient";
import { DetailCard } from "../../../../../components/DetailCard";
import { ErrorState } from "../../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../../components/PageHeader";
import { useAppContext } from "../../../../../hooks/useAppContext";
import type { TenantDetail } from "../_components/tenantBillingConfigForms";
import {
  AdminTenantInvoiceBrandingForm,
  AdminTenantMonthlyPricingForm,
  AdminTenantSolaGatewayForm,
} from "../_components/tenantBillingConfigForms";

type TenantRow = { id: string; name: string };

function AdminBillingSettingsBody() {
  const router = useRouter();
  const { can, backendJwtRole } = useAppContext();
  const canPlatformAdminBilling = backendJwtRole === "SUPER_ADMIN" && can("can_view_admin_billing");
  const searchParams = useSearchParams();
  const tenantIdParam = String(searchParams.get("tenantId") || "").trim();

  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [tenantsError, setTenantsError] = useState("");
  const [tenantsLoading, setTenantsLoading] = useState(true);
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);

  const loadTenants = useCallback(async () => {
    setTenantsLoading(true);
    setTenantsError("");
    try {
      const rows = await apiGet<TenantRow[]>("/admin/billing/platform/tenants");
      setTenants(rows.map((r) => ({ id: r.id, name: r.name })));
    } catch (err: any) {
      setTenantsError(err?.message || "Unable to load tenants.");
    } finally {
      setTenantsLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (tenantId: string) => {
    if (!tenantId) return;
    setDetailLoading(true);
    setDetailError("");
    try {
      setDetail(await apiGet<TenantDetail>(`/admin/billing/platform/tenants/${tenantId}`));
    } catch (err: any) {
      setDetailError(err?.message || "Unable to load tenant billing detail.");
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTenants();
  }, [loadTenants]);

  const effectiveTenantId =
    tenantIdParam && tenants.some((t) => t.id === tenantIdParam) ? tenantIdParam : tenants[0]?.id || "";

  useEffect(() => {
    if (effectiveTenantId) void loadDetail(effectiveTenantId);
  }, [effectiveTenantId, loadDetail]);

  if (!canPlatformAdminBilling) {
    return (
      <div className="state-box">
        Platform Admin Billing settings require platform administrator access (JWT <strong>SUPER_ADMIN</strong>) with billing permissions.
      </div>
    );
  }

  return (
    <div className="stack compact-stack billing-admin-shell">
      <PageHeader
        title="Admin Billing — Settings"
        subtitle="Per-tenant pricing, taxes, SOLA gateway, and invoice branding. Operational overview stays on Admin Billing."
      />
      <div className="row-actions">
        <Link className="btn ghost" href="/admin/billing">
          ← Admin Billing overview
        </Link>
      </div>

      {tenantsLoading ? <LoadingSkeleton rows={2} /> : null}
      {tenantsError ? <ErrorState message={tenantsError} /> : null}

      {!tenantsLoading && !tenantsError && tenants.length === 0 ? (
        <div className="state-box">No tenants found.</div>
      ) : null}

      {!tenantsLoading && tenants.length > 0 ? (
        <DetailCard title="Tenant">
          <label className="muted" style={{ display: "block", marginBottom: 8 }}>
            Select tenant
            <select
              className="input"
              style={{ marginTop: 6, width: "100%", maxWidth: 480 }}
              value={effectiveTenantId}
              onChange={(e) => {
                const id = e.target.value;
                router.replace(`/admin/billing/settings?tenantId=${encodeURIComponent(id)}`);
                void loadDetail(id);
              }}
            >
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {!tenantIdParam && tenants[0] ? (
            <p className="muted" style={{ marginTop: 8 }}>
              No <code>tenantId</code> in URL — showing <strong>{tenants[0].name}</strong>. Bookmark this page with{" "}
              <code>?tenantId=…</code> for a direct link.
            </p>
          ) : null}
          {tenantIdParam && tenants.length > 0 && !tenants.some((t) => t.id === tenantIdParam) ? (
            <p className="muted" style={{ marginTop: 8 }}>
              Unknown <code>tenantId</code> in URL — loaded <strong>{tenants.find((t) => t.id === effectiveTenantId)?.name || "first tenant"}</strong> instead.
            </p>
          ) : null}
        </DetailCard>
      ) : null}

      {detailLoading ? <LoadingSkeleton rows={6} /> : null}
      {detailError ? <ErrorState message={detailError} /> : null}

      {detail && !detailLoading ? (
        <>
          <section className="billing-setup-grid">
            <AdminTenantMonthlyPricingForm detail={detail} onSaved={() => void loadDetail(detail.tenant.id)} />
            <AdminTenantInvoiceBrandingForm detail={detail} onSaved={() => void loadDetail(detail.tenant.id)} />
          </section>
          <section className="billing-setup-grid">
            <AdminTenantSolaGatewayForm detail={detail} onSaved={() => void loadDetail(detail.tenant.id)} />
          </section>
        </>
      ) : null}
    </div>
  );
}

export default function AdminBillingSettingsPage() {
  return (
    <Suspense fallback={<LoadingSkeleton rows={4} />}>
      <AdminBillingSettingsBody />
    </Suspense>
  );
}
