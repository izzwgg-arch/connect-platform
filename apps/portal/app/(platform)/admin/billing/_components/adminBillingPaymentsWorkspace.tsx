"use client";

import { useMemo, useState } from "react";
import { useAsyncResource } from "../../../../../hooks/useAsyncResource";
import { useAdminBillingTenant } from "./useAdminBillingTenant";
import { apiGet } from "../../../../../services/apiClient";
import { ErrorState } from "../../../../../components/ErrorState";
import { BillingEmptyState } from "../../../../../components/billing/BillingEmptyState";
import { BillingFinanceChip } from "../../../../../components/billing/BillingFinanceChip";
import { BillingTableSkeleton } from "../../../../../components/billing/BillingTableSkeleton";
import {
  dollars,
  formatDateTime,
  transactionFinanceStatusTone,
  transactionStatusLabel,
} from "../../../../../lib/billingUi";
import { PaymentMethodsModal } from "./adminBillingOpsPanels";
import { OneTimeChargeDrawer, PaymentTransactionDrawer } from "./adminBillingPaymentDrawers";
import type { TenantDetail } from "./tenantBillingConfigForms";
import "./billingPayments.css";
import "./billingInvoices.css";
import "./billingPhase8.css";

type TxRow = {
  id: string;
  tenantId: string;
  invoiceId: string | null;
  amountCents: number;
  status: string;
  responseMessage: string | null;
  createdAt: string;
  tenant: { id: string; name: string };
  invoice: { id: string; invoiceNumber: string | null } | null;
  paymentMethod: { id: string; brand: string | null; last4: string | null } | null;
};

type TxListResult = { transactions: TxRow[]; total: number; page: number; pages: number; limit: number };

type AdminPaymentMethod = {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  cardholderName?: string | null;
  isDefault: boolean;
};

const TX_FILTERS = ["ALL", "APPROVED", "PENDING", "DECLINED", "ERROR", "REFUNDED", "VOIDED"] as const;

function cardShort(m: { brand: string | null; last4: string | null } | null) {
  if (!m) return "—";
  return `${m.brand || "Card"} ···${m.last4 || "----"}`;
}

function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div className="row-actions" style={{ justifyContent: "flex-end", marginTop: 10 }}>
      <button className="btn ghost" type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>← Prev</button>
      <span className="muted" style={{ padding: "0 8px", lineHeight: "32px" }}>Page {page} of {pages}</span>
      <button className="btn ghost" type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next →</button>
    </div>
  );
}

export function PaymentsWorkspace() {
  const { effectiveTenantId: tenantId } = useAdminBillingTenant();

  const [statusFilter, setStatusFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [listRev, setListRev] = useState(0);
  const [detailTxId, setDetailTxId] = useState<string | null>(null);
  const [chargeOpen, setChargeOpen] = useState(false);
  const [methodsOpen, setMethodsOpen] = useState(false);
  const [chargeMethodId, setChargeMethodId] = useState<string | null>(null);

  const tenantDetail = useAsyncResource<TenantDetail>(
    () => (tenantId ? apiGet(`/admin/billing/platform/tenants/${tenantId}`) : Promise.reject(new Error("no_tenant"))),
    [tenantId, listRev],
  );

  const pmData = useAsyncResource<{ methods: AdminPaymentMethod[]; isLiveCharge: boolean }>(
    () => apiGet(`/admin/billing/platform/tenants/${tenantId}/payment-methods`),
    [tenantId, listRev],
  );

  const txUrl = useMemo(() => {
    const p = new URLSearchParams();
    p.set("tenantId", tenantId);
    if (statusFilter !== "ALL") p.set("status", statusFilter);
    p.set("page", String(page));
    p.set("limit", "50");
    return `/admin/billing/transactions?${p.toString()}`;
  }, [tenantId, statusFilter, page, listRev]);

  const txData = useAsyncResource<TxListResult>(
    () => (tenantId ? apiGet<TxListResult>(txUrl) : Promise.reject(new Error("no_tenant"))),
    [txUrl, tenantId],
  );

  const tenantName = tenantDetail.status === "success" ? tenantDetail.data.tenant.name : "";
  const isLiveCharge = pmData.status === "success" ? pmData.data.isLiveCharge : false;
  const methods = pmData.status === "success" ? pmData.data.methods : [];
  const balanceDue = Number(
    tenantDetail.status === "success"
      ? (tenantDetail.data as TenantDetail & { balanceDueCents?: number }).balanceDueCents
        ?? tenantDetail.data.invoices?.reduce((s, inv) => s + Number(inv.balanceDueCents ?? 0), 0)
        ?? 0
      : 0,
  );

  const summary = useMemo(() => {
    const rows = txData.status === "success" ? txData.data.transactions : [];
    let approved = 0;
    let failed = 0;
    for (const r of rows) {
      if (r.status === "APPROVED") approved += 1;
      if (r.status === "DECLINED" || r.status === "ERROR") failed += 1;
    }
    return { approved, failed };
  }, [txData]);

  function refresh() {
    setListRev((r) => r + 1);
  }

  if (!tenantId) {
    return (
      <div className="billing-ws-section billing-p8-scope billing-pay-scope" data-testid="billing-admin-payments-workspace">
        <BillingEmptyState
          title="Select a workspace"
          message="Choose a company in the header workspace switcher to run charges, manage cards, and review tenant payments. In All workspaces mode, use the transaction list below for cross-tenant payment history."
        />
      </div>
    );
  }

  return (
    <div className="billing-ws-section billing-p8-scope billing-pay-scope" data-testid="billing-admin-payments-workspace">
      <header className="billing-pay-head">
        <div>
          <h2>Payments</h2>
          <p>Charge customers, manage cards on file, and review processor activity for {tenantName || "this company"}.</p>
        </div>
        <div className="billing-pay-actions">
          <button className="btn primary" type="button" onClick={() => setChargeOpen(true)} data-testid="billing-pay-charge-customer">
            Charge customer
          </button>
          <button className="btn ghost" type="button" onClick={() => setMethodsOpen(true)} data-testid="billing-pay-add-method">
            Add payment method
          </button>
        </div>
      </header>

      <div className="billing-pay-summary">
        <div className="billing-pay-chip">
          <label>Payment methods</label>
          <strong>{methods.length}</strong>
          <small>{methods.find((m) => m.isDefault) ? "Default on file" : methods.length ? "No default set" : "None saved"}</small>
        </div>
        <div className={`billing-pay-chip billing-pay-chip--balance${balanceDue <= 0 ? " billing-pay-chip--clear" : ""}`}>
          <label>Outstanding balance</label>
          <strong>{dollars(balanceDue)}</strong>
          <small>Open invoice balances</small>
        </div>
        <div className="billing-pay-chip">
          <label>Successful (this page)</label>
          <strong>{summary.approved}</strong>
          <small>Approved on current view</small>
        </div>
        <div className="billing-pay-chip">
          <label>Failed (this page)</label>
          <strong>{summary.failed}</strong>
          <small>Declined or error on current view</small>
        </div>
      </div>

      {methods.length > 0 ? (
        <section style={{ marginBottom: 14 }} aria-label="Saved payment methods">
          <p className="billing-inv-meta" style={{ marginBottom: 8 }}>Cards on file</p>
          <div className="billing-pay-pm-grid">
            {methods.map((m) => (
              <article key={m.id} className={`billing-pay-pm-card${m.isDefault ? " billing-pay-pm-card--default" : ""}`}>
                <div className="billing-pay-pm-card__brand">
                  {cardShort(m)}
                  {m.isDefault ? <span className="billing-p8-pm-badge" style={{ marginLeft: 8 }}>Default</span> : null}
                </div>
                <div className="billing-pay-pm-card__meta">
                  {m.cardholderName || "Cardholder not set"}
                  {m.expMonth && m.expYear ? ` · Exp ${m.expMonth}/${m.expYear}` : ""}
                </div>
                <div className="billing-pay-pm-card__actions">
                  <button className="btn ghost" type="button" style={{ fontSize: 12 }} onClick={() => { setChargeMethodId(m.id); setChargeOpen(true); }}>
                    Charge this card
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <div className="billing-inv-toolbar billing-inv-toolbar--sticky" style={{ marginBottom: 10 }}>
        <div className="billing-p8-filter-bar">
          {TX_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              className={`billing-p8-filter-pill${statusFilter === s ? " active" : ""}`}
              onClick={() => { setStatusFilter(s); setPage(1); }}
            >
              {s === "ALL" ? "All" : transactionStatusLabel(s)}
            </button>
          ))}
        </div>
      </div>

      {txData.status === "loading" ? <BillingTableSkeleton variant="tx" rows={8} /> : null}
      {txData.status === "error" ? <ErrorState message={txData.error} /> : null}

      {txData.status === "success" ? (
        <>
          <p className="billing-inv-meta">
            {txData.data.total} transaction{txData.data.total !== 1 ? "s" : ""}
            {statusFilter !== "ALL" ? ` · ${transactionStatusLabel(statusFilter)}` : ""}
          </p>
          {txData.data.transactions.length === 0 ? (
            <BillingEmptyState
              title="No transactions yet"
              message="Charges and payment attempts appear here. Use Charge customer to run a one-time payment."
            />
          ) : (
            <div className="billing-p8-table-scroll">
              <div className="billing-p8-tx-table">
                <div className="billing-pay-tx-head" aria-hidden>
                  <span>Date</span>
                  <span>Invoice</span>
                  <span>Amount</span>
                  <span>Status</span>
                  <span>Method</span>
                  <span />
                </div>
                {txData.data.transactions.map((r) => (
                  <div
                    key={r.id}
                    role="button"
                    tabIndex={0}
                    className={`billing-pay-tx-row${detailTxId === r.id ? " billing-pay-tx-row--active" : ""}`}
                    onClick={() => setDetailTxId(r.id)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDetailTxId(r.id); } }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{formatDateTime(r.createdAt)}</div>
                    </div>
                    <div>{r.invoice?.invoiceNumber || "—"}</div>
                    <div className="billing-pay-tx-row__amount">{dollars(r.amountCents)}</div>
                    <BillingFinanceChip status={r.status} label={transactionStatusLabel(r.status)} tone={transactionFinanceStatusTone(r.status)} />
                    <div>
                      <span className="billing-p8-tx-method">{cardShort(r.paymentMethod)}</span>
                      {(r.status === "DECLINED" || r.status === "ERROR") && r.responseMessage ? (
                        <div className="billing-p8-tx-row__fail">{r.responseMessage}</div>
                      ) : null}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <button
                        className="btn ghost billing-pay-menu__btn"
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setDetailTxId(r.id); }}
                      >
                        Details
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <Pager page={txData.data.page} pages={txData.data.pages} onPage={setPage} />
        </>
      ) : null}

      {chargeOpen ? (
        <OneTimeChargeDrawer
          tenantId={tenantId}
          tenantName={tenantName}
          isLiveCharge={isLiveCharge}
          initialPaymentMethodId={chargeMethodId}
          onClose={() => { setChargeOpen(false); setChargeMethodId(null); }}
          onSuccess={refresh}
        />
      ) : null}

      {methodsOpen ? (
        <PaymentMethodsModal tenantId={tenantId} tenantName={tenantName} onClose={() => { setMethodsOpen(false); refresh(); }} />
      ) : null}

      {detailTxId ? (
        <PaymentTransactionDrawer
          txId={detailTxId}
          isLiveCharge={isLiveCharge}
          onClose={() => setDetailTxId(null)}
          onUpdated={() => { refresh(); setDetailTxId(null); }}
        />
      ) : null}
    </div>
  );
}

