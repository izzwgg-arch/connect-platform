"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiGet, apiPut } from "../../../../../services/apiClient";
import { DetailCard } from "../../../../../components/DetailCard";
import { ErrorState } from "../../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { PageHeader } from "../../../../../components/PageHeader";
import { billingErrorMessage } from "../../../../../components/BillingActionToast";
import { useAppContext } from "../../../../../hooks/useAppContext";
import type { TenantDetail } from "../_components/tenantBillingConfigForms";
import {
  AdminTenantInvoiceBrandingForm,
  AdminTenantMonthlyPricingForm,
  AdminTenantSolaGatewayForm,
} from "../_components/tenantBillingConfigForms";
import { dollars, formatDate } from "../../../../../lib/billingUi";

type TenantRow = { id: string; name: string };

type CollectionsConfig = {
  dunningEnabled: boolean | null;
  maxAttempts: number | null;
  retryDelayHours: number | null;
};

function AdminTenantCollectionsConfigForm({ tenantId, onSaved }: { tenantId: string; onSaved: () => void }) {
  const [config, setConfig] = useState<CollectionsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const r = await apiGet<{ tenantId: string; collections: CollectionsConfig }>(
        `/admin/billing/platform/tenants/${tenantId}/collections-config`,
      );
      setConfig(r.collections);
    } catch (err: unknown) {
      setError(billingErrorMessage(err, "Failed to load collections config."));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <LoadingSkeleton rows={3} />;
  if (error) return <ErrorState message={error} />;
  if (!config) return null;

  return (
    <DetailCard title="Collections Automation">
      <div style={{ fontSize: 12, background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 5, padding: "6px 10px", marginBottom: 12, color: "#166534" }}>
        <strong>Worker enforcement active.</strong> Per-tenant dunning overrides (max attempts, retry delay) are applied on every dunning sweep.
      </div>
      <form
        className="billing-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setToast(null);
          try {
            const fd = new FormData(e.currentTarget);
            const dunningRaw = fd.get("dunningEnabled") as string;
            const payload: Record<string, unknown> = {
              dunningEnabled: dunningRaw === "true" ? true : dunningRaw === "false" ? false : null,
              maxAttempts: fd.get("maxAttempts") ? Number(fd.get("maxAttempts")) : null,
              retryDelayHours: fd.get("retryDelayHours") ? Number(fd.get("retryDelayHours")) : null,
            };
            const updated = await apiPut<{ tenantId: string; collections: CollectionsConfig }>(
              `/admin/billing/platform/tenants/${tenantId}/collections-config`,
              payload,
            );
            setConfig(updated.collections);
            setToast({ type: "ok", text: "Collections config saved." });
            onSaved();
          } catch (err: unknown) {
            setToast({ type: "err", text: billingErrorMessage(err, "Save failed.") });
          } finally {
            setSaving(false);
          }
        }}
      >
        <label>
          Dunning / autopay retry
          <select name="dunningEnabled" defaultValue={config.dunningEnabled === null ? "null" : String(config.dunningEnabled)}>
            <option value="null">Use global default (inherit autoBillingEnabled)</option>
            <option value="true">Enabled — retry failed invoices on this tenant</option>
            <option value="false">Disabled — skip autopay retries for this tenant</option>
          </select>
        </label>
        <label>
          Max retry attempts (blank = global default, currently 3)
          <input
            name="maxAttempts"
            type="number"
            min={1}
            max={10}
            defaultValue={config.maxAttempts ?? ""}
            placeholder="e.g. 4"
          />
        </label>
        <label>
          Retry delay hours (blank = global default, currently 72)
          <input
            name="retryDelayHours"
            type="number"
            min={1}
            max={336}
            defaultValue={config.retryDelayHours ?? ""}
            placeholder="e.g. 48"
          />
        </label>
        {toast ? (
          <div className={`billing-status-pill ${toast.type === "ok" ? "ok" : "bad"}`} style={{ fontSize: 13 }}>
            {toast.text}
          </div>
        ) : null}
        <button className="btn primary" type="submit" disabled={saving} style={{ fontSize: 13 }}>
          {saving ? "Saving…" : "Save collections config"}
        </button>
      </form>
    </DetailCard>
  );
}

type PreviewLineItem = {
  type: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  taxable: boolean;
};

type InvoicePreview = {
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  lineItems: PreviewLineItem[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function AdminInvoicePreviewCard({ tenantId }: { tenantId: string }) {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [preview, setPreview] = useState<InvoicePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const yearOptions: number[] = [];
  for (let y = now.getFullYear(); y <= now.getFullYear() + 2; y++) yearOptions.push(y);

  async function loadPreview() {
    setLoading(true);
    setError("");
    setPreview(null);
    try {
      const data = await apiGet<InvoicePreview>(
        `/admin/billing/platform/tenants/${tenantId}/invoice-preview?periodMonth=${month}&periodYear=${year}`,
      );
      setPreview(data);
    } catch (err: unknown) {
      setError(billingErrorMessage(err, "Failed to load invoice preview."));
    } finally {
      setLoading(false);
    }
  }

  return (
    <DetailCard title="Invoice Preview">
      <div style={{ fontSize: 12, background: "#eff6ff", border: "1px solid #93c5fd", borderRadius: 5, padding: "6px 10px", marginBottom: 12, color: "#1e40af" }}>
        <strong>Preview only</strong> — no invoice is created and no charge is run.
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <select
          value={month}
          onChange={(e) => { setMonth(Number(e.target.value)); setPreview(null); }}
          style={{ fontSize: 13 }}
        >
          {MONTHS.map((name, i) => (
            <option key={i + 1} value={i + 1}>{name}</option>
          ))}
        </select>
        <select
          value={year}
          onChange={(e) => { setYear(Number(e.target.value)); setPreview(null); }}
          style={{ fontSize: 13 }}
        >
          {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <button
          className="btn ghost"
          type="button"
          onClick={() => void loadPreview()}
          disabled={loading}
          style={{ fontSize: 13 }}
        >
          {loading ? "Loading…" : "Preview next invoice"}
        </button>
      </div>

      {error ? <div style={{ color: "var(--danger, #dc2626)", fontSize: 13 }}>{error}</div> : null}

      {preview ? (
        <div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
            Period: {formatDate(preview.periodStart)} – {formatDate(preview.periodEnd)}
            {" · "}
            Due: {formatDate(preview.dueDate)}
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border, #e5e7eb)" }}>
                <th style={{ textAlign: "left", padding: "4px 6px", fontWeight: 600 }}>Description</th>
                <th style={{ textAlign: "right", padding: "4px 6px", fontWeight: 600 }}>Qty</th>
                <th style={{ textAlign: "right", padding: "4px 6px", fontWeight: 600 }}>Unit</th>
                <th style={{ textAlign: "right", padding: "4px 6px", fontWeight: 600 }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {preview.lineItems.map((item, idx) => (
                <tr key={idx} style={{ borderBottom: "1px solid var(--border-light, #f3f4f6)" }}>
                  <td style={{ padding: "4px 6px" }}>{item.description}</td>
                  <td style={{ textAlign: "right", padding: "4px 6px" }}>{item.quantity}</td>
                  <td style={{ textAlign: "right", padding: "4px 6px" }}>{item.unitPriceCents < 0 ? `(${dollars(-item.unitPriceCents)})` : dollars(item.unitPriceCents)}</td>
                  <td style={{ textAlign: "right", padding: "4px 6px", color: item.amountCents < 0 ? "var(--danger, #dc2626)" : undefined }}>
                    {item.amountCents < 0 ? `(${dollars(-item.amountCents)})` : dollars(item.amountCents)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: "2px solid var(--border, #e5e7eb)" }}>
                <td colSpan={3} style={{ padding: "4px 6px", textAlign: "right", fontWeight: 600, fontSize: 13 }}>Total</td>
                <td style={{ padding: "4px 6px", textAlign: "right", fontWeight: 700, fontSize: 14 }}>{dollars(preview.totalCents)}</td>
              </tr>
            </tfoot>
          </table>
          {preview.taxCents > 0 ? (
            <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>
              Includes {dollars(preview.taxCents)} in taxes and fees.
            </p>
          ) : null}
        </div>
      ) : null}

      {!preview && !loading && !error ? (
        <p style={{ fontSize: 13, color: "var(--muted)" }}>Select a period and click Preview to see the estimated invoice.</p>
      ) : null}
    </DetailCard>
  );
}

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
            <AdminTenantCollectionsConfigForm tenantId={detail.tenant.id} onSaved={() => void loadDetail(detail.tenant.id)} />
          </section>
          <AdminInvoicePreviewCard tenantId={detail.tenant.id} />
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
