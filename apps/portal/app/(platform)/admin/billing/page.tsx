"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiDelete, apiGet, apiPost, apiPut } from "../../../../services/apiClient";
import { billingErrorMessage } from "../../../../components/BillingActionToast";
import { BillingActionPanel } from "../../../../components/billing/BillingActionPanel";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { useAppContext } from "../../../../hooks/useAppContext";
import {
  adminTenantStandingHeadline,
  dollars,
  formatDate,
  invoiceCanDelete,
  invoiceStatusLabel,
  nextBillingSummary,
  worstNonTerminalInvoiceStatus,
} from "../../../../lib/billingUi";
import type { TenantDetail } from "./_components/tenantBillingConfigForms";
import { BILLING_SECTION_QUERY, mergeSearchParams, OPS_TAB_QUERY } from "./_components/adminBillingLinks";
import { useAdminBillingTenant } from "./_components/useAdminBillingTenant";

type TenantRow = {
  id: string;
  name: string;
  balanceDueCents: number;
  invoices?: { status?: string; balanceDueCents?: number }[];
};

export default function AdminBillingPage() {
  const { can, backendJwtRole } = useAppContext();
  const canPlatformAdminBilling = backendJwtRole === "SUPER_ADMIN" && can("can_view_admin_billing");
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; invoiceNumber?: string | null; totalCents: number; balanceDueCents: number; status: string } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [autopayBusy, setAutopayBusy] = useState(false);
  const [generateBusy, setGenerateBusy] = useState(false);
  const tenants = useAsyncResource<TenantRow[]>(() => apiGet<TenantRow[]>("/admin/billing/platform/tenants"), []);
  const tenantRows = tenants.status === "success" ? tenants.data : [];
  const tenantIds = useMemo(() => tenantRows.map((t) => t.id), [tenantRows]);
  const { effectiveTenantId: selectedTenantId, isGlobalScope } = useAdminBillingTenant(tenantIds);

  const loadDetail = useCallback(async (tenantId: string) => {
    if (!tenantId) return;
    setDetailLoading(true);
    setDetailError("");
    try {
      setDetail(await apiGet<TenantDetail>(`/admin/billing/platform/tenants/${tenantId}`));
    } catch (err: unknown) {
      setDetailError(err instanceof Error ? err.message : "Unable to load billing detail.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedTenantId) {
      setDetail(null);
      setDetailError("");
      return;
    }
    void loadDetail(selectedTenantId);
  }, [loadDetail, selectedTenantId]);

  if (!canPlatformAdminBilling) {
    return (
      <div className="state-box">
        Platform Admin Billing is only available to platform administrators. Tenant admins should use{" "}
        <a href="/billing">Billing</a>.
      </div>
    );
  }

  if (tenants.status === "loading") return <LoadingSkeleton rows={4} />;
  if (tenants.status === "error") return <ErrorState message={tenants.error} />;

  const payState = detail ? worstNonTerminalInvoiceStatus(detail.invoices) : "—";
  const standing = adminTenantStandingHeadline(payState);
  const chipClass =
    payState === "—" ? "good" : payState === "FAILED" ? "bad" : payState === "OVERDUE" ? "bad" : "warn";
  const nextBill = detail?.settings
    ? nextBillingSummary(detail.settings.billingDayOfMonth, !!detail.settings.autoBillingEnabled)
    : null;
  const unpaid = detail ? (detail.invoices || []).filter((i: any) => !["PAID", "VOID"].includes(String(i.status)) && Number(i.balanceDueCents || 0) > 0).length : 0;
  const failed = detail ? (detail.invoices || []).filter((i: any) => String(i.status) === "FAILED" && Number(i.balanceDueCents || 0) > 0).length : 0;
  // Balance due computed live from loaded invoices (stays fresh after pricing/tax saves)
  const livBalanceDue = detail
    ? Number((detail as TenantDetail & { balanceDueCents?: number }).balanceDueCents ?? (detail.invoices || [])
        .filter((i: any) => !["PAID", "VOID"].includes(String(i.status)) && Number(i.balanceDueCents ?? 0) > 0)
        .reduce((sum: number, i: any) => sum + (i.balanceDueCents ?? 0), 0))
    : null;
  // Next billing date: read from billingScheduleOverride inside settings.metadata
  const scheduleOverride = (() => {
    try {
      const meta = detail?.settings?.metadata;
      if (meta && typeof meta === "object" && !Array.isArray(meta)) {
        const raw = (meta as Record<string, unknown>).billingScheduleOverride;
        if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
      }
    } catch { /* ignore */ }
    return null;
  })();
  const rawNextPaymentDate: string | null = scheduleOverride?.nextPaymentDate
    ? String(scheduleOverride.nextPaymentDate)
    : null;
  const nextPaymentDate = rawNextPaymentDate ? formatDate(rawNextPaymentDate) : null;
  const billingDay = detail?.settings?.billingDayOfMonth;
  const autopayOn = !!detail?.settings?.autoBillingEnabled;

  // Detect if billing date has already passed with no invoice generated
  const nextPaymentDatePassed = (() => {
    if (!rawNextPaymentDate) return false;
    const d = new Date(rawNextPaymentDate + "T00:00:00");
    return d < new Date();
  })();
  const previewTotal: number = detail?.preview?.totalCents ?? 0;
  const previewPeriod =
    detail?.preview?.periodStart && detail?.preview?.periodEnd
      ? `${formatDate(detail.preview.periodStart)} - ${formatDate(detail.preview.periodEnd)}`
      : null;
  const defaultPaymentMethodId = detail?.paymentMethods?.find((m: any) => m.isDefault)?.id
    || detail?.paymentMethods?.[0]?.id
    || null;
  // If no open invoices but billing date already passed, show preview amount as pending
  const showPreviewBalance = livBalanceDue === 0 && nextPaymentDatePassed && previewTotal > 0;
  const recent = detail
    ? [...(detail.invoices || [])].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5)
    : [];
  const tid = detail?.tenant.id || selectedTenantId;
  const qp = (extra: Record<string, string>) =>
    mergeSearchParams(new URLSearchParams(tid ? { tenantId: tid } : {}), extra);

  async function generateItemizedInvoice() {
    if (!selectedTenantId) return;
    setGenerateBusy(true);
    setDetailError("");
    try {
      await apiPost(`/admin/billing/tenants/${selectedTenantId}/invoices`, {});
      await loadDetail(selectedTenantId);
    } catch (err: unknown) {
      setDetailError(billingErrorMessage(err, "Could not generate the itemized invoice."));
    } finally {
      setGenerateBusy(false);
    }
  }

  const globalTotalDue = tenantRows.reduce((sum, t) => sum + (t.balanceDueCents ?? 0), 0);
  const globalNeedsAttention = tenantRows.filter((t) => worstNonTerminalInvoiceStatus(t.invoices) !== "—").length;

  return (
    <div className="billing-ws-section billing-p8-scope" data-testid="billing-admin-overview-panel">
      {detailLoading ? <LoadingSkeleton rows={4} /> : null}
      {detailError ? <ErrorState message={detailError} /> : null}

      {detail && !detailLoading ? (
        <>
          <div className="billing-ov-summary">
            <div className="billing-ov-summary__card">
              <label>Balance due</label>
              <strong style={{ color: showPreviewBalance ? "var(--warn-600, #d97706)" : undefined }}>
                {showPreviewBalance ? dollars(previewTotal) : livBalanceDue !== null ? dollars(livBalanceDue) : "—"}
              </strong>
              <small>
                {showPreviewBalance
                  ? `Invoice not yet generated · due ${nextPaymentDate}`
                  : unpaid > 0
                  ? `${unpaid} open invoice${unpaid !== 1 ? "s" : ""}${failed > 0 ? ` · ${failed} failed` : ""}`
                  : "No outstanding balance"}
              </small>
            </div>
            <div className="billing-ov-summary__card">
              <label>Account standing</label>
              <strong>
                <span className={`billing-p5-status-chip ${chipClass}`} style={{ fontSize: 12 }}>
                  {standing}
                </span>
              </strong>
              <small>{unpaid} open · {failed} failed</small>
            </div>
            <div className="billing-ov-summary__card">
              <label>Next billing date</label>
              <strong style={{ color: nextPaymentDatePassed ? "var(--warn-600, #d97706)" : undefined }}>
                {nextPaymentDate
                  ? `${nextPaymentDate}${nextPaymentDatePassed ? " (past due)" : ""}`
                  : billingDay ? `Day ${billingDay}` : "—"}
              </strong>
              <small>{nextBill || (billingDay ? `Billing day ${billingDay} of each month` : "No billing day set")}</small>
            </div>
            <div className="billing-ov-summary__card">
              <label>Autopay</label>
              <strong style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: autopayOn ? "var(--green-600, #16a34a)" : "var(--text-dim, #6b7280)" }}>
                  {autopayOn ? "On" : "Off"}
                </span>
                <button
                  type="button"
                  className={`btn ${autopayOn ? "ghost" : "primary"}`}
                  style={{ fontSize: 11, padding: "2px 10px", lineHeight: 1.4 }}
                  disabled={autopayBusy || !detail.paymentMethods?.length}
                  title={!detail.paymentMethods?.length ? "Add a payment method first" : undefined}
                  onClick={async () => {
                    if (!detail?.tenant?.id) return;
                    setAutopayBusy(true);
                    try {
                      await apiPut(`/admin/billing/tenants/${detail.tenant.id}/settings`, { autoBillingEnabled: !autopayOn });
                      await loadDetail(detail.tenant.id);
                    } catch (err: unknown) {
                      alert(billingErrorMessage(err, "Failed to update autopay."));
                    } finally {
                      setAutopayBusy(false);
                    }
                  }}
                >
                  {autopayBusy ? "…" : autopayOn ? "Turn off" : "Turn on"}
                </button>
              </strong>
              <small>{detail.paymentMethods?.length ? `${detail.paymentMethods.length} saved card${detail.paymentMethods.length !== 1 ? "s" : ""}` : "No payment method on file"}</small>
            </div>
          </div>

          <div className="billing-ov-links">
            {showPreviewBalance ? (
              <>
                <button
                  className="btn primary"
                  type="button"
                  disabled={generateBusy}
                  onClick={generateItemizedInvoice}
                >
                  {generateBusy ? "Generating..." : "Generate itemized invoice"}
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  disabled={generateBusy}
                  title={!defaultPaymentMethodId ? "Add a payment method first" : undefined}
                  onClick={generateItemizedInvoice}
                >
                  Generate itemized invoice first
                </button>
              </>
            ) : null}
            <Link className="btn ghost" href={`/admin/billing/invoices${qp({ [OPS_TAB_QUERY]: "invoices" })}`}>
              Invoices
            </Link>
            <Link className="btn ghost" href={`/admin/billing/payments${qp({})}`}>
              Payments
            </Link>
            <Link className="btn ghost" href={`/admin/billing/methods${qp({})}`}>
              Payment methods
            </Link>
            <Link className="btn ghost" href={`/admin/billing/settings${qp({ [BILLING_SECTION_QUERY]: "plans-pricing" })}`}>
              Pricing
            </Link>
            <Link className="btn ghost" href={`/admin/billing/collections${qp({})}`}>
              Collections
            </Link>
            <Link className="btn ghost" href={`/admin/billing/activity${qp({})}`}>
              Full activity
            </Link>
          </div>

          <div className="billing-ov-panel">
            <h3>Recent activity</h3>
            {showPreviewBalance ? (
              <div style={{ marginBottom: 12, padding: "10px 12px", border: "1px solid var(--warn-300, #facc15)", borderRadius: 10, background: "color-mix(in srgb, #facc15 10%, var(--surface))" }}>
                <strong style={{ display: "block", marginBottom: 4 }}>Invoice not generated yet</strong>
                <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
                  The next billing date has passed and the current preview is {dollars(previewTotal)}. Generate the itemized invoice first so extensions, DIDs, E911, taxes, discounts, and fees reconcile from line items.
                </p>
                <div className="row-actions" style={{ justifyContent: "flex-start" }}>
                  <button className="btn primary" type="button" disabled={generateBusy} onClick={generateItemizedInvoice}>
                    {generateBusy ? "Generating..." : "Generate itemized invoice"}
                  </button>
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={generateBusy}
                    title={!defaultPaymentMethodId ? "Add a payment method first" : undefined}
                    onClick={generateItemizedInvoice}
                  >
                    Generate itemized invoice first
                  </button>
                  {!defaultPaymentMethodId ? (
                    <Link className="btn ghost" href={`/admin/billing/methods${qp({})}`}>
                      Add payment method
                    </Link>
                  ) : null}
                </div>
              </div>
            ) : null}
            {recent.length === 0 ? (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                No invoices yet for this company.
              </p>
            ) : (
              <div className="billing-inv-table">
                {recent.map((inv) => (
                  <div
                    key={inv.id}
                    className="billing-inv-row"
                    style={{ gridTemplateColumns: invoiceCanDelete(inv) ? "1fr auto auto auto" : "1fr auto auto" }}
                  >
                    <div>
                      <div className="billing-inv-row__num">{inv.invoiceNumber || "Invoice"}</div>
                      <div className="billing-inv-row__sub">
                        {formatDate((inv.createdAt || inv.dueDate) as string)} · {dollars(inv.totalCents)}
                      </div>
                    </div>
                    <span className={`billing-status-pill ${inv.status === "PAID" ? "good" : inv.status === "FAILED" ? "bad" : "warn"}`}>
                      {invoiceStatusLabel(inv.status)}
                    </span>
                    <Link className="btn ghost" style={{ fontSize: 12 }} href={`/admin/billing/invoices${qp({ [OPS_TAB_QUERY]: "invoices" })}`}>
                      Open
                    </Link>
                    {invoiceCanDelete(inv) ? (
                      <button
                        type="button"
                        className="btn ghost"
                        style={{ fontSize: 12, color: "var(--danger, #dc2626)", borderColor: "var(--danger, #dc2626)" }}
                        onClick={() => {
                          setDeleteError("");
                          setDeleteTarget({
                            id: inv.id,
                            invoiceNumber: inv.invoiceNumber,
                            totalCents: inv.totalCents,
                            balanceDueCents: inv.balanceDueCents,
                            status: inv.status,
                          });
                        }}
                      >
                        Delete
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : !detailLoading && !selectedTenantId && isGlobalScope ? (
        <>
          <div className="billing-ov-summary" data-testid="billing-admin-global-overview">
            <div className="billing-ov-summary__card">
              <label>Total balance due</label>
              <strong>{dollars(globalTotalDue)}</strong>
              <small>Across {tenantRows.length} workspaces</small>
            </div>
            <div className="billing-ov-summary__card">
              <label>Workspaces</label>
              <strong>{tenantRows.length}</strong>
              <small>{globalNeedsAttention} need attention</small>
            </div>
            <div className="billing-ov-summary__card">
              <label>Scope</label>
              <strong>All workspaces</strong>
              <small>Use Invoices or Payments for cross-tenant operations</small>
            </div>
          </div>
          <div className="billing-ov-panel">
            <h3>Workspaces</h3>
            <div className="billing-inv-table billing-global-tenant-table">
              <div className="billing-inv-row billing-global-tenant-table__head" style={{ gridTemplateColumns: "1.4fr auto auto auto" }}>
                <span>Company</span>
                <span>Balance due</span>
                <span>Standing</span>
                <span />
              </div>
              {tenantRows.map((row) => {
                const w = worstNonTerminalInvoiceStatus(row.invoices);
                const rowStanding = adminTenantStandingHeadline(w);
                const rowChip = w === "—" ? "good" : w === "FAILED" ? "bad" : w === "OVERDUE" ? "bad" : "warn";
                return (
                  <div key={row.id} className="billing-inv-row" style={{ gridTemplateColumns: "1.4fr auto auto auto" }}>
                    <div>
                      <div className="billing-inv-row__num">{row.name}</div>
                    </div>
                    <div className="billing-inv-row__sub" style={{ alignSelf: "center" }}>
                      {dollars(row.balanceDueCents ?? 0)}
                    </div>
                    <span className={`billing-p5-status-chip ${rowChip}`} style={{ alignSelf: "center", fontSize: 11 }}>
                      {rowStanding}
                    </span>
                    <Link
                      className="btn ghost"
                      style={{ fontSize: 12, alignSelf: "center" }}
                      href={`/admin/billing${mergeSearchParams(new URLSearchParams(), { tenantId: row.id })}`}
                    >
                      Open
                    </Link>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="billing-ov-links">
            <Link className="btn ghost" href="/admin/billing/invoices">
              All invoices
            </Link>
            <Link className="btn ghost" href="/admin/billing/payments">
              All payments
            </Link>
            <Link className="btn ghost" href="/admin/billing/reports">
              Reports
            </Link>
          </div>
        </>
      ) : !detailLoading && !selectedTenantId ? (
        <p className="muted">Select a workspace from the header switcher to view billing for that company.</p>
      ) : null}

      {deleteTarget && selectedTenantId ? (
        <BillingActionPanel
          layout="center"
          centerWidth="min(520px, 96vw)"
          variant="danger"
          onClose={() => { if (!deleteBusy) setDeleteTarget(null); }}
          eyebrow={detail?.tenant.name || "Company"}
          title="Delete this invoice permanently?"
          subtitle="Removes the invoice and line items. This cannot be undone."
          summary={(
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li><strong>Invoice</strong> {deleteTarget.invoiceNumber || deleteTarget.id.slice(0, 8)}</li>
              <li><strong>Total</strong> {dollars(deleteTarget.totalCents)}</li>
              <li><strong>Balance due</strong> {dollars(deleteTarget.balanceDueCents)}</li>
              <li><strong>Status</strong> {invoiceStatusLabel(deleteTarget.status)}</li>
            </ul>
          )}
          notice={deleteError ? deleteError : undefined}
          footer={(
            <>
              <button className="btn ghost" type="button" disabled={deleteBusy} onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button
                className="btn danger"
                type="button"
                disabled={deleteBusy}
                onClick={async () => {
                  setDeleteBusy(true);
                  setDeleteError("");
                  try {
                    await apiDelete(`/admin/billing/invoices/${deleteTarget.id}`);
                    setDeleteTarget(null);
                    await loadDetail(selectedTenantId);
                  } catch (err: unknown) {
                    setDeleteError(billingErrorMessage(err, "Delete failed."));
                  } finally {
                    setDeleteBusy(false);
                  }
                }}
              >
                {deleteBusy ? "Deleting…" : "Delete permanently"}
              </button>
            </>
          )}
        />
      ) : null}

    </div>
  );
}
