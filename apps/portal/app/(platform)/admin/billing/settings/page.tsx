"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiDelete, apiGet, apiPost, apiPut } from "../../../../../services/apiClient";
import { DetailCard } from "../../../../../components/DetailCard";
import { ErrorState } from "../../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { billingErrorMessage } from "../../../../../components/BillingActionToast";
import { useAppContext } from "../../../../../hooks/useAppContext";
import type { TenantDetail } from "../_components/tenantBillingConfigForms";
import {
  AdminBillingPricingWarningsBanner,
  AdminCurrentBillingPlanAssignCard,
  AdminTenantInvoiceBrandingForm,
  AdminTenantMonthlyPricingForm,
  AdminTenantPricingSourceCard,
  AdminTenantSolaGatewayForm,
} from "../_components/tenantBillingConfigForms";
import { dollars, formatDate, humanizePricingStateMode } from "../../../../../lib/billingUi";
import { BILLING_SECTION_QUERY, mergeSearchParams, OPS_TAB_QUERY, type BillingSettingsSection } from "../_components/adminBillingLinks";

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

type BillingPlanRow = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  extensionPriceCents: number;
  additionalPhoneNumberPriceCents: number;
  smsPriceCents: number;
  firstPhoneNumberFree: boolean;
};

type ScheduledPlanChange = {
  nextBillingPlanId: string | null;
  nextBillingPlanEffectiveAt: string | null;
  nextBillingPlan: BillingPlanRow | null;
};

type PreviewLineItem = {
  type: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  taxable: boolean;
};

type InvoicePreviewScheduledChange = {
  planId: string;
  planName: string;
  effectiveAt: string;
};

type InvoicePreviewPricingResolution = {
  mode: string;
  banner: string;
  activePlanName?: string | null;
  fieldBadges?: Record<string, string>;
};

type InvoicePreviewExplanation = {
  pricingMode: string;
  effectiveSource: string;
  activePlanId?: string | null;
  activePlanName?: string | null;
  tenantOverridesDetected: boolean;
  scheduledPlanApplies: boolean;
  scheduledPlanSummary: string | null;
  explanationLines: string[];
};

function effectivePricingSourceLabel(source: string): string {
  if (source === "legacy_chain") return "Standard blend";
  if (source === "billing_plan_catalog") return "Active billing plan";
  if (source === "billing_plan_defaults") return "Plan defaults";
  if (source === "tenant_row_custom") return "Custom company row";
  return source;
}

function modeBadgeStyles(mode: string): CSSProperties {
  const base: CSSProperties = { fontSize: 11, padding: "2px 10px", borderRadius: 999, fontWeight: 600 };
  if (mode === "catalog") return { ...base, background: "#dcfce7", color: "#166534", border: "1px solid #86efac" };
  if (mode === "custom") return { ...base, background: "#fef9c3", color: "#854d0e", border: "1px solid #facc15" };
  return { ...base, background: "#f1f5f9", color: "#334155", border: "1px solid #cbd5e1" };
}

type PricingQuadSnapshot = {
  extensionPriceCents: number;
  additionalPhoneNumberPriceCents: number;
  smsPriceCents: number;
  firstPhoneNumberFree: boolean;
};

type TenantPricingDiagnostics = {
  tenantId: string;
  fetchedAt: string;
  mode: string;
  billingPlanCurrent: { id: string; code: string; name: string; active: boolean } | null;
  billingPlanEffectiveForPreview: { id: string; name: string; active: boolean } | null;
  tenantStoredPricing: PricingQuadSnapshot;
  effectiveInvoicePricing: PricingQuadSnapshot;
  catalogBaselinePricing: PricingQuadSnapshot | null;
  differsFromPlan: {
    tenantRowVsCurrentPlanFk: Record<string, boolean>;
    tenantRowVsEffectiveInvoice: Record<string, boolean>;
  };
  scheduledPlanChange: null | {
    nextBillingPlanId: string;
    nextPlanName: string;
    effectiveAt: string;
    nextPlanActive: boolean | null;
  };
  previewPeriod: { periodStart: string; periodEnd: string };
  warnings: string[];
  notices: string[];
  explanationLines: string[];
  pricingPreviewExplanation: InvoicePreviewExplanation;
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
  scheduledPlanChange?: InvoicePreviewScheduledChange;
  pricingResolution?: InvoicePreviewPricingResolution;
  pricingPreviewExplanation?: InvoicePreviewExplanation;
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function ScheduledPlanChangeCard({ tenantId, onChanged }: { tenantId: string; onChanged: () => void }) {
  const [plans, setPlans] = useState<BillingPlanRow[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledPlanChange | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // Default effective date = first of next month UTC
  const defaultEffective = () => {
    const d = new Date();
    const y = d.getUTCMonth() === 11 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
    const m = (d.getUTCMonth() + 1) % 12;
    return new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)).toISOString().slice(0, 10);
  };

  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(defaultEffective);

  const load = useCallback(async () => {
    setLoading(true);
    setToast(null);
    try {
      const [p, s] = await Promise.all([
        apiGet<BillingPlanRow[]>("/admin/billing/platform/billing-plans"),
        apiGet<ScheduledPlanChange>(`/admin/billing/platform/tenants/${tenantId}/scheduled-plan-change`),
      ]);
      setPlans(p);
      setScheduled(s);
      if (!selectedPlanId && p.length > 0) setSelectedPlanId(p[0].id);
    } catch (err: unknown) {
      setToast({ type: "err", text: billingErrorMessage(err, "Failed to load billing plans.") });
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const schedulablePlans = useMemo(() => plans.filter((plan) => plan.active !== false), [plans]);

  async function scheduleChange() {
    if (!selectedPlanId || !effectiveDate) return;
    setSaving(true);
    setToast(null);
    try {
      const effectiveAtIso = new Date(effectiveDate + "T00:00:00.000Z").toISOString();
      const result = await apiPost<ScheduledPlanChange>(
        `/admin/billing/platform/tenants/${tenantId}/scheduled-plan-change`,
        { nextBillingPlanId: selectedPlanId, effectiveAt: effectiveAtIso },
      );
      setScheduled(result);
      setToast({ type: "ok", text: `Plan change scheduled: "${result.nextBillingPlan?.name}" effective ${effectiveDate}.` });
      onChanged();
    } catch (err: unknown) {
      setToast({ type: "err", text: billingErrorMessage(err, "Failed to schedule plan change.") });
    } finally {
      setSaving(false);
    }
  }

  async function cancelChange() {
    setSaving(true);
    setToast(null);
    try {
      await apiDelete<ScheduledPlanChange>(`/admin/billing/platform/tenants/${tenantId}/scheduled-plan-change`);
      setScheduled({ nextBillingPlanId: null, nextBillingPlanEffectiveAt: null, nextBillingPlan: null });
      setToast({ type: "ok", text: "Scheduled plan change cancelled." });
      onChanged();
    } catch (err: unknown) {
      setToast({ type: "err", text: billingErrorMessage(err, "Failed to cancel scheduled change.") });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <DetailCard title="Scheduled Plan Change"><LoadingSkeleton rows={3} /></DetailCard>;

  const hasScheduled = !!scheduled?.nextBillingPlanId;
  const effectiveDateLabel = scheduled?.nextBillingPlanEffectiveAt
    ? formatDate(scheduled.nextBillingPlanEffectiveAt)
    : null;

  return (
    <DetailCard title="Scheduled Plan Change">
      <div style={{ fontSize: 12, background: "#fefce8", border: "1px solid #fbbf24", borderRadius: 5, padding: "6px 10px", marginBottom: 12, color: "#92400e" }}>
        <strong>Next billing cycle only.</strong> The new plan takes effect when the worker creates the invoice for the effective period. No proration. No mid-cycle changes.
      </div>

      {hasScheduled ? (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, background: "#eff6ff", border: "1px solid #93c5fd", borderRadius: 5, padding: "8px 12px", marginBottom: 10 }}>
            <strong>⚡ Scheduled:</strong> Switch to plan <strong>&quot;{scheduled.nextBillingPlan?.name}&quot;</strong>
            {effectiveDateLabel ? <> effective <strong>{effectiveDateLabel}</strong></> : null}.
          </div>
          <button
            className="btn ghost"
            type="button"
            onClick={() => void cancelChange()}
            disabled={saving}
            style={{ fontSize: 13, color: "var(--danger, #dc2626)" }}
          >
            {saving ? "Cancelling…" : "Cancel scheduled change"}
          </button>
        </div>
      ) : (
        <div>
          <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 10 }}>
            No plan change scheduled. Select a plan and effective date to schedule one.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 10 }}>
            <label style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
              New plan
              <select
                value={selectedPlanId}
                onChange={(e) => setSelectedPlanId(e.target.value)}
                disabled={saving || schedulablePlans.length === 0}
                style={{ fontSize: 13, minWidth: 180 }}
              >
                {schedulablePlans.length === 0 ? (
                  <option value="">No active plans</option>
                ) : (
                  schedulablePlans.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))
                )}
              </select>
            </label>
            <label style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
              Effective (1st of month)
              <input
                type="date"
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
                disabled={saving}
                style={{ fontSize: 13 }}
              />
            </label>
            <button
              className="btn primary"
              type="button"
              onClick={() => void scheduleChange()}
              disabled={saving || !selectedPlanId || !effectiveDate}
              style={{ fontSize: 13, marginBottom: 0 }}
            >
              {saving ? "Scheduling…" : "Schedule plan change"}
            </button>
          </div>
          {selectedPlanId && schedulablePlans.find((p) => p.id === selectedPlanId) ? (
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
              {(() => {
                const p = schedulablePlans.find((pp) => pp.id === selectedPlanId)!;
                return `${p.name}: $${(p.extensionPriceCents / 100).toFixed(2)}/ext · $${(p.additionalPhoneNumberPriceCents / 100).toFixed(2)}/phone · $${(p.smsPriceCents / 100).toFixed(2)}/SMS${p.firstPhoneNumberFree ? " · 1st phone free" : ""}`;
              })()}
            </div>
          ) : null}
        </div>
      )}

      {toast ? (
        <div className={`billing-status-pill ${toast.type === "ok" ? "ok" : "bad"}`} style={{ fontSize: 13, marginTop: 8 }}>
          {toast.text}
        </div>
      ) : null}
    </DetailCard>
  );
}

function AdminPreviewPeriodCard({
  month,
  year,
  onMonth,
  onYear,
}: {
  month: number;
  year: number;
  onMonth: (m: number) => void;
  onYear: (y: number) => void;
}) {
  const yearFloor = new Date().getFullYear();
  const yearOptions: number[] = [];
  for (let y = yearFloor; y <= yearFloor + 2; y++) yearOptions.push(y);

  return (
    <DetailCard title="Preview period (UTC calendar month)" dataTestId="billing-admin-preview-period-card">
      <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>
        Used for <strong>Pricing explanation</strong> and <strong>Invoice preview</strong>. Read-only — nothing is charged from this page.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select value={month} onChange={(e) => onMonth(Number(e.target.value))} style={{ fontSize: 13 }}>
          {MONTHS.map((name, i) => (
            <option key={i + 1} value={i + 1}>
              {name}
            </option>
          ))}
        </select>
        <select value={year} onChange={(e) => onYear(Number(e.target.value))} style={{ fontSize: 13 }}>
          {yearOptions.map((yOpt) => (
            <option key={yOpt} value={yOpt}>
              {yOpt}
            </option>
          ))}
        </select>
      </div>
    </DetailCard>
  );
}

function AdminPricingDiagnosticsCard({ tenantId, month, year }: { tenantId: string; month: number; year: number }) {
  const [data, setData] = useState<TenantPricingDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const d = await apiGet<TenantPricingDiagnostics>(
        `/admin/billing/platform/tenants/${tenantId}/pricing-diagnostics?periodMonth=${month}&periodYear=${year}`,
      );
      setData(d);
    } catch (e: unknown) {
      setError(billingErrorMessage(e, "Failed to load pricing diagnostics."));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [tenantId, month, year]);

  useEffect(() => {
    void load();
  }, [load]);

  const expl = data?.pricingPreviewExplanation;

  return (
    <DetailCard title="Pricing explanation" dataTestId="billing-admin-pricing-diagnostics">
      <div style={{ fontSize: 12, background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: 5, padding: "6px 10px", marginBottom: 12, color: "#475569" }}>
        Same period as <strong>Preview period</strong>. Shows how amounts are derived (catalog vs tenant row vs effective plan for this month).
      </div>
      <div style={{ marginBottom: 12 }}>
        <button
          className="btn ghost"
          type="button"
          data-testid="billing-admin-refresh-diagnostics"
          onClick={() => void load()}
          disabled={loading}
          style={{ fontSize: 13 }}
        >
          {loading ? "Refreshing…" : "Refresh explanation"}
        </button>
      </div>
      {error ? <div style={{ color: "var(--danger, #dc2626)", fontSize: 13 }}>{error}</div> : null}
      {!data && loading ? <LoadingSkeleton rows={4} /> : null}
      {data && !loading ? (
        <div style={{ fontSize: 13 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
            <span style={modeBadgeStyles(data.mode)}>{humanizePricingStateMode(data.mode)}</span>
            <span style={{ color: "var(--muted)", fontSize: 12 }}>
              Source:&nbsp;<strong>{effectivePricingSourceLabel(String(expl?.effectiveSource ?? ""))}</strong>
              {expl?.activePlanName ? <> · Plan:&nbsp;<strong>{expl.activePlanName}</strong></> : <> · Plan:&nbsp;<em>(none)</em></>}
            </span>
          </div>
          {expl?.scheduledPlanSummary ? (
            <div style={{ fontSize: 12, background: "#fefce8", border: "1px solid #fbbf24", borderRadius: 5, padding: "6px 10px", marginBottom: 10, color: "#92400e" }}>
              {expl.scheduledPlanSummary}
            </div>
          ) : null}
          {data.billingPlanCurrent && data.billingPlanEffectiveForPreview && data.billingPlanEffectiveForPreview.id !== data.billingPlanCurrent.id ? (
            <div style={{ fontSize: 12, marginBottom: 10 }}>
              Current FK plan:&nbsp;<strong>{data.billingPlanCurrent.name}</strong> · Effective for this preview:&nbsp;
              <strong>{data.billingPlanEffectiveForPreview.name}</strong>
            </div>
          ) : null}
          {(data.warnings || []).length > 0 ? (
            <div style={{ marginBottom: 12 }}>
              {data.warnings.map((w: string) => (
                <div key={w} className="billing-status-pill warn" style={{ marginBottom: 8, whiteSpace: "normal", fontSize: 13, lineHeight: 1.45 }}>
                  {w}
                </div>
              ))}
            </div>
          ) : null}
          {(data.notices || []).length > 0 ? (
            <div style={{ marginBottom: 12, fontSize: 12 }}>
              {(data.notices || []).map((n: string) => (
                <div key={n} style={{ color: "var(--muted)", marginBottom: 6 }}>
                  {n}
                </div>
              ))}
            </div>
          ) : null}
          {(expl?.explanationLines || []).length > 0 ? (
            <ul style={{ fontSize: 12, paddingLeft: 18, margin: "0 0 12px", color: "#334155" }}>
              {(expl!.explanationLines || []).map((line: string, i: number) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          ) : null}
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border, #e5e7eb)" }}>
                <th style={{ textAlign: "left", padding: "4px 6px", fontWeight: 600 }}>Field</th>
                <th style={{ textAlign: "right", padding: "4px 6px", fontWeight: 600 }}>Tenant stored</th>
                <th style={{ textAlign: "right", padding: "4px 6px", fontWeight: 600 }}>Catalog baseline</th>
                <th style={{ textAlign: "right", padding: "4px 6px", fontWeight: 600 }}>Invoice pricing</th>
                <th style={{ textAlign: "center", padding: "4px 6px", fontWeight: 600 }} title="Compared to FK billingPlanId row">
                  Row vs plan FK
                </th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["extensionPriceCents", "Extension"],
                  ["additionalPhoneNumberPriceCents", "Phone add-on"],
                  ["smsPriceCents", "SMS"],
                  ["firstPhoneNumberFree", "1st phone free"],
                ] as const
              ).map(([key, label]) => {
                const isBool = key === "firstPhoneNumberFree";
                const stored = data.tenantStoredPricing[key];
                const baseRow = data.catalogBaselinePricing?.[key];
                const invoiceRow = data.effectiveInvoicePricing[key];
                const flagged = !!(data.differsFromPlan?.tenantRowVsCurrentPlanFk as Record<string, boolean>)[key];
                const fmtMoney = (c: unknown) => dollars(Number(c ?? 0));
                return (
                  <tr key={key} style={{ borderBottom: "1px solid var(--border-light, #f3f4f6)" }}>
                    <td style={{ padding: "4px 6px" }}>{label}</td>
                    <td style={{ textAlign: "right", padding: "4px 6px" }}>{isBool ? (stored ? "Yes" : "No") : fmtMoney(stored)}</td>
                    <td style={{ textAlign: "right", padding: "4px 6px" }}>
                      {!data.catalogBaselinePricing ? "—" : isBool ? (baseRow ? "Yes" : "No") : fmtMoney(baseRow)}
                    </td>
                    <td style={{ textAlign: "right", padding: "4px 6px", fontWeight: 600 }}>
                      {isBool ? (invoiceRow ? "Yes" : "No") : fmtMoney(invoiceRow)}
                    </td>
                    <td style={{ textAlign: "center", padding: "4px 6px" }}>{flagged ? <span style={{ color: "#b45309" }}>Mismatch</span> : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>
            Labels: Legacy / From plan / Tenant override come from invoice preview badges; see <strong>Billing pricing source</strong>.
          </div>
        </div>
      ) : null}
      {!loading && !data && !error ? <p style={{ fontSize: 13, color: "var(--muted)" }}>No diagnostics.</p> : null}
    </DetailCard>
  );
}

function AdminInvoicePreviewCard({
  tenantId,
  month,
  year,
}: {
  tenantId: string;
  month: number;
  year: number;
}) {
  const [preview, setPreview] = useState<InvoicePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setPreview(null);
    setError("");
  }, [tenantId, month, year]);

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
    <DetailCard title="Invoice Preview" dataTestId="billing-admin-invoice-preview-card">
      <div style={{ fontSize: 12, background: "#eff6ff", border: "1px solid #93c5fd", borderRadius: 5, padding: "6px 10px", marginBottom: 12, color: "#1e40af" }}>
        <strong>Preview only</strong> — no invoice is created and no charge is run. Period matches <strong>Preview period</strong> above.
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
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
          {preview.pricingResolution?.banner ? (
            <div style={{ fontSize: 12, background: "#f8fafc", border: "1px solid #cbd5e1", borderRadius: 5, padding: "6px 10px", marginBottom: 8, color: "#334155" }}>
              <strong>Pricing:</strong> {preview.pricingResolution.banner}
            </div>
          ) : null}
          {preview.scheduledPlanChange ? (
            <div style={{ fontSize: 12, background: "#fefce8", border: "1px solid #fbbf24", borderRadius: 5, padding: "6px 10px", marginBottom: 8, color: "#92400e" }}>
              ⚡ <strong>Scheduled plan change applied:</strong> This preview uses prices from plan &quot;{preview.scheduledPlanChange.planName}&quot;
              {" "}(effective {formatDate(preview.scheduledPlanChange.effectiveAt)}).
            </div>
          ) : null}
          {preview.pricingPreviewExplanation ? (
            <div style={{ fontSize: 12, border: "1px solid var(--border, #e5e7eb)", borderRadius: 6, padding: "8px 12px", marginBottom: 8, background: "#fafafa" }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <span style={modeBadgeStyles(preview.pricingPreviewExplanation.pricingMode)}>
                  {humanizePricingStateMode(preview.pricingPreviewExplanation.pricingMode)}
                </span>
                <span style={{ color: "#334155" }}>
                  Source:&nbsp;<strong>{effectivePricingSourceLabel(preview.pricingPreviewExplanation.effectiveSource)}</strong>
                  {preview.pricingPreviewExplanation.activePlanName ? (
                    <> · Active plan:&nbsp;<strong>{preview.pricingPreviewExplanation.activePlanName}</strong></>
                  ) : null}
                  {preview.pricingPreviewExplanation.tenantOverridesDetected ? (
                    <span style={{ color: "#b45309", marginLeft: 6 }}>
                      Company row amounts differ — line items follow the resolved rules, not stale row values.
                    </span>
                  ) : null}
                </span>
              </div>
              {preview.pricingPreviewExplanation.explanationLines?.length ? (
                <ul style={{ paddingLeft: 18, margin: 0, color: "#475569", lineHeight: 1.45 }}>
                  {preview.pricingPreviewExplanation.explanationLines.map((line: string, i: number) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
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
        <p style={{ fontSize: 13, color: "var(--muted)" }}>
          Pick the month in <strong>Preview period</strong> above and click Preview to estimate the invoice.
        </p>
      ) : null}
    </DetailCard>
  );
}

function AdminBillingSettingsBody() {
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
  const [previewMonth, setPreviewMonth] = useState(() => new Date().getMonth() + 1);
  const [previewYear, setPreviewYear] = useState(() => new Date().getFullYear());

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

  const billingSectionRaw = searchParams.get(BILLING_SECTION_QUERY);

  useEffect(() => {
    if (!billingSectionRaw || typeof document === "undefined") return;
    const map: Record<string, string> = {
      "plans-pricing": "billing-section-plans-pricing",
      collections: "billing-section-collections",
      "tax-billing": "billing-section-tax-billing",
      gateway: "billing-section-gateway",
      preview: "billing-section-preview",
      "pricing-explanation": "billing-section-pricing-explanation",
    };
    const id = map[billingSectionRaw];
    if (!id) return;
    const t = window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
    return () => window.clearTimeout(t);
  }, [billingSectionRaw, detail?.tenant.id]);

  const sectionAnchorStyle: CSSProperties = { scrollMarginTop: 108 };

  if (!canPlatformAdminBilling) {
    return (
      <div className="state-box">
        Platform Admin Billing settings require platform administrator access (JWT <strong>SUPER_ADMIN</strong>) with billing permissions.
      </div>
    );
  }

  const qp = mergeSearchParams(
    new URLSearchParams({ ...(effectiveTenantId ? { tenantId: effectiveTenantId } : {}) }),
    {},
  );

  function settingsSectionHref(section: BillingSettingsSection) {
    if (!effectiveTenantId) return "/admin/billing/settings";
    return `/admin/billing/settings${mergeSearchParams(new URLSearchParams({ tenantId: effectiveTenantId }), { [BILLING_SECTION_QUERY]: section })}`;
  }

  return (
    <div className="stack compact-stack billing-admin-shell billing-p5-scope">
      <div style={{ marginBottom: 4 }}>
        <h2 style={{ margin: "0 0 6px", fontSize: "1.1rem", fontWeight: 700 }}>Company billing setup</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13, maxWidth: 720 }}>
          Plans, gateway, collections, branding, and tax details for the company selected above. Operational actions stay under{" "}
          <strong>Invoices &amp; payments</strong> and <strong>Summary</strong>.
        </p>
        {tenantIdParam && tenants.length > 0 && !tenants.some((t) => t.id === tenantIdParam) ? (
          <p className="muted" style={{ marginTop: 8, marginBottom: 0, fontSize: 13 }}>
            The URL company id did not match a tenant — loaded <strong>{tenants.find((t) => t.id === effectiveTenantId)?.name || "first company"}</strong> instead.
          </p>
        ) : null}
      </div>

      <div className="row-actions" style={{ flexWrap: "wrap", gap: 8 }}>
        <Link className="btn ghost" href={`/admin/billing${qp}`}>
          ← Billing overview
        </Link>
        <Link
          className="btn ghost"
          href={`/admin/billing/invoices${mergeSearchParams(new URLSearchParams(), { tenantId: effectiveTenantId, [OPS_TAB_QUERY]: "invoices" })}`}
        >
          Invoices &amp; payments
        </Link>
        <Link className="btn ghost" href="/admin/billing/plans">
          Billing plans (catalog)
        </Link>
      </div>

      {tenantsLoading ? <LoadingSkeleton rows={2} /> : null}
      {tenantsError ? <ErrorState message={tenantsError} /> : null}

      {!tenantsLoading && !tenantsError && tenants.length === 0 ? (
        <div className="state-box">No tenants found.</div>
      ) : null}

      {detailLoading ? <LoadingSkeleton rows={6} /> : null}
      {detailError ? <ErrorState message={detailError} /> : null}

      {detail && !detailLoading ? (
        <div className="billing-p5-settings-shell">
          <nav className="billing-p5-settings-nav" aria-label="Billing settings sections">
            <h3>Billing setup</h3>
            <Link href={settingsSectionHref("plans-pricing")}>Plans &amp; unit pricing</Link>
            <h3>Payment collection</h3>
            <Link href={settingsSectionHref("gateway")}>Payment gateway</Link>
            <Link href={settingsSectionHref("collections")}>Collections automation</Link>
            <h3>Tax &amp; invoicing</h3>
            <Link href={settingsSectionHref("tax-billing")}>Branding &amp; tax fields</Link>
            <h3>Preview &amp; diagnostics</h3>
            <Link href={settingsSectionHref("preview")}>Schedules &amp; invoice preview</Link>
            <Link href={settingsSectionHref("pricing-explanation")}>Pricing diagnostics</Link>
          </nav>
          <div className="billing-p5-settings-main">
            <div id="billing-section-plans-pricing" className="billing-p5-settings-section" style={sectionAnchorStyle}>
              <h3 className="billing-p5-settings-section__title">Plans &amp; unit economics</h3>
              <p className="billing-p5-settings-section__summary">
                Connect catalog plans, reconcile pricing sources, and tune recurring line items before invoices generate.
              </p>
              <AdminBillingPricingWarningsBanner
                tenantId={detail.tenant.id}
                previewMonth={previewMonth}
                previewYear={previewYear}
              />
              <section className="billing-setup-grid">
                <AdminCurrentBillingPlanAssignCard
                  tenantId={detail.tenant.id}
                  tenantName={detail.tenant.name}
                  previewMonth={previewMonth}
                  previewYear={previewYear}
                  onAssigned={() => void loadDetail(detail.tenant.id)}
                />
                <AdminTenantPricingSourceCard
                  detail={detail}
                  onSaved={() => void loadDetail(detail.tenant.id)}
                  previewPeriodMonth={previewMonth}
                  previewPeriodYear={previewYear}
                />
                <AdminTenantMonthlyPricingForm detail={detail} onSaved={() => void loadDetail(detail.tenant.id)} />
              </section>
            </div>

            <div id="billing-section-tax-billing" className="billing-p5-settings-section" style={sectionAnchorStyle}>
              <h3 className="billing-p5-settings-section__title">Customer invoice presentation</h3>
              <p className="billing-p5-settings-section__summary">
                Names, logos, and support contacts that appear on PDFs and billing emails — tuned for customer trust, not internal jargon.
              </p>
              <section className="billing-setup-grid">
                <AdminTenantInvoiceBrandingForm detail={detail} onSaved={() => void loadDetail(detail.tenant.id)} />
              </section>
            </div>

            <div id="billing-section-gateway" className="billing-p5-settings-section" style={sectionAnchorStyle}>
              <h3 className="billing-p5-settings-section__title">Payment gateway</h3>
              <p className="billing-p5-settings-section__summary">Processor credentials and capture behavior for this company.</p>
              <section className="billing-setup-grid">
                <AdminTenantSolaGatewayForm detail={detail} onSaved={() => void loadDetail(detail.tenant.id)} />
              </section>
            </div>

            <div id="billing-section-collections" className="billing-p5-settings-section" style={sectionAnchorStyle}>
              <h3 className="billing-p5-settings-section__title">Collections automation</h3>
              <p className="billing-p5-settings-section__summary">Dunning cadence overrides for this tenant — worker enforced on each sweep.</p>
              <section className="billing-setup-grid">
                <AdminTenantCollectionsConfigForm tenantId={detail.tenant.id} onSaved={() => void loadDetail(detail.tenant.id)} />
              </section>
            </div>

            <div id="billing-section-preview" className="billing-p5-settings-section" style={sectionAnchorStyle}>
              <h3 className="billing-p5-settings-section__title">Schedules &amp; invoice preview</h3>
              <p className="billing-p5-settings-section__summary">
                Model upcoming invoices for a UTC month. Nothing here charges a card or posts to the ledger.
              </p>
              <ScheduledPlanChangeCard tenantId={detail.tenant.id} onChanged={() => void loadDetail(detail.tenant.id)} />
              <AdminPreviewPeriodCard month={previewMonth} year={previewYear} onMonth={setPreviewMonth} onYear={setPreviewYear} />
              <AdminInvoicePreviewCard tenantId={detail.tenant.id} month={previewMonth} year={previewYear} />
            </div>

            <div id="billing-section-pricing-explanation" className="billing-p5-settings-section" style={sectionAnchorStyle}>
              <h3 className="billing-p5-settings-section__title">Pricing diagnostics</h3>
              <p className="billing-p5-settings-section__summary">
                Deep read on how catalog rows, tenant overrides, and effective invoice math align for operators.
              </p>
              <AdminPricingDiagnosticsCard tenantId={detail.tenant.id} month={previewMonth} year={previewYear} />
            </div>
          </div>
        </div>
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
