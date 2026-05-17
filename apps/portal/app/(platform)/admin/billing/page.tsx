"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet } from "../../../../services/apiClient";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { useAppContext } from "../../../../hooks/useAppContext";
import {
  adminTenantStandingHeadline,
  dollars,
  formatDate,
  invoiceStatusLabel,
  nextBillingSummary,
  worstNonTerminalInvoiceStatus,
} from "../../../../lib/billingUi";
import type { TenantDetail } from "./_components/tenantBillingConfigForms";
import { parseStoredPricingMode } from "./_components/tenantBillingConfigForms";
import { BILLING_SECTION_QUERY, mergeSearchParams, OPS_TAB_QUERY } from "./_components/adminBillingLinks";

type TenantRow = {
  id: string;
  name: string;
  balanceDueCents: number;
  invoices?: { status?: string }[];
};

export default function AdminBillingPage() {
  const searchParams = useSearchParams();
  const { can, backendJwtRole } = useAppContext();
  const canPlatformAdminBilling = backendJwtRole === "SUPER_ADMIN" && can("can_view_admin_billing");
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const tenants = useAsyncResource<TenantRow[]>(() => apiGet<TenantRow[]>("/admin/billing/platform/tenants"), []);
  const tenantRows = tenants.status === "success" ? tenants.data : [];
  const tidParam = String(searchParams.get("tenantId") || "").trim();
  const selectedTenantId = useMemo(() => {
    if (tidParam && tenantRows.some((t) => t.id === tidParam)) return tidParam;
    return tenantRows[0]?.id || "";
  }, [tidParam, tenantRows]);

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
    if (selectedTenantId) void loadDetail(selectedTenantId);
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
  const unpaid = detail ? (detail.invoices || []).filter((i) => !["PAID", "VOID"].includes(String(i.status))).length : 0;
  const failed = detail ? (detail.invoices || []).filter((i) => String(i.status) === "FAILED").length : 0;
  const recent = detail
    ? [...(detail.invoices || [])].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5)
    : [];
  const tid = detail?.tenant.id || selectedTenantId;
  const qp = (extra: Record<string, string>) =>
    mergeSearchParams(new URLSearchParams(tid ? { tenantId: tid } : {}), extra);

  return (
    <div className="billing-ws-section billing-p8-scope" data-testid="billing-admin-overview-panel">
      {detailLoading ? <LoadingSkeleton rows={4} /> : null}
      {detailError ? <ErrorState message={detailError} /> : null}

      {detail && !detailLoading ? (
        <>
          <div className="billing-ov-summary">
            <div className="billing-ov-summary__card">
              <label>Balance due</label>
              <strong>{dollars(selectedTenantId ? tenantRows.find((t) => t.id === selectedTenantId)?.balanceDueCents ?? 0 : 0)}</strong>
              <small>Outstanding on open invoices</small>
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
              <label>Next billing</label>
              <strong>{nextBill ? "Scheduled" : "—"}</strong>
              <small>{nextBill || "Set billing day and autopay under Payment methods."}</small>
            </div>
            <div className="billing-ov-summary__card">
              <label>Payment methods</label>
              <strong>{detail.paymentMethods?.length || 0}</strong>
              <small>{detail.settings?.autoBillingEnabled ? "Autopay enabled" : "Autopay off"}</small>
            </div>
          </div>

          <div className="billing-ov-links">
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
            {recent.length === 0 ? (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                No invoices yet for this company.
              </p>
            ) : (
              <div className="billing-inv-table">
                {recent.map((inv) => (
                  <div key={inv.id} className="billing-inv-row" style={{ gridTemplateColumns: "1fr auto auto" }}>
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
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : !detailLoading && !selectedTenantId ? (
        <p className="muted">Select a company from the rail to view billing summary.</p>
      ) : null}
    </div>
  );
}
