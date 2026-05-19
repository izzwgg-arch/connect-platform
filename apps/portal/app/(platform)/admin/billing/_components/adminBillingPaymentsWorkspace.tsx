"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useAsyncResource } from "../../../../../hooks/useAsyncResource";
import { useAdminBillingTenant } from "./useAdminBillingTenant";
import { apiGet, apiPut } from "../../../../../services/apiClient";
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
import { SolaLinkedSchedulesSection } from "./billingWorkspaceSections";
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

type ScheduleOverride = {
  nextPaymentDate?: string | null;
  skipNextPayment?: boolean;
  skipReason?: string | null;
  updatedBy?: string;
  updatedAt?: string;
};

function parseScheduleOverrideFromSettings(settings: Record<string, unknown> | null | undefined): ScheduleOverride | null {
  if (!settings) return null;
  const meta = settings.metadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const raw = (meta as Record<string, unknown>).billingScheduleOverride;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as ScheduleOverride;
}

function BillingScheduleOverrideCard({ tenantId, settings, onSaved }: { tenantId: string; settings: Record<string, unknown> | null; onSaved: () => void }) {
  const existing = parseScheduleOverrideFromSettings(settings);
  const [nextPaymentDate, setNextPaymentDate] = useState(existing?.nextPaymentDate ?? "");
  const [skipNext, setSkipNext] = useState(existing?.skipNextPayment ?? false);
  const [skipReason, setSkipReason] = useState(existing?.skipReason ?? "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const autoBillingEnabled = (settings as any)?.autoBillingEnabled ?? false;
  const billingDay = (settings as any)?.billingDayOfMonth;

  async function save(clearOverride = false) {
    setSaving(true);
    setMsg(null);
    try {
      await apiPut(`/admin/billing/tenants/${tenantId}/settings`, {
        billingScheduleOverride: clearOverride ? null : {
          nextPaymentDate: nextPaymentDate || null,
          skipNextPayment: skipNext,
          skipReason: skipReason.trim() || null,
        },
      });
      setMsg({ kind: "ok", text: clearOverride ? "Schedule override cleared." : "Schedule override saved." });
      onSaved();
    } catch (err: unknown) {
      setMsg({ kind: "err", text: err instanceof Error ? err.message : "Could not save override." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section style={{ marginBottom: 16, padding: "14px 16px", borderRadius: 8, border: "1px solid var(--border, #e0e0e0)", background: "var(--surface, #fff)" }} aria-label="Billing schedule override">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <strong style={{ fontSize: 14 }}>Billing schedule</strong>
        {autoBillingEnabled ? (
          <span style={{ fontSize: 11, background: "#dcfce7", color: "#166534", borderRadius: 4, padding: "1px 5px" }}>Autopay on · Day {billingDay ?? "?"}</span>
        ) : (
          <span style={{ fontSize: 11, background: "#f3f4f6", color: "#6b7280", borderRadius: 4, padding: "1px 5px" }}>Autopay off</span>
        )}
        {existing ? (
          <span style={{ fontSize: 11, background: "#fef9c3", color: "#713f12", borderRadius: 4, padding: "1px 5px" }}>Override active</span>
        ) : null}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          Next payment date (YYYY-MM-DD)
          <input
            type="date"
            value={nextPaymentDate || ""}
            onChange={(e) => setNextPaymentDate(e.target.value)}
            style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border, #d1d5db)", fontSize: 13 }}
          />
          <span style={{ fontSize: 11, color: "#6b7280" }}>Overrides the billing day for this tenant. Leave blank to use default schedule.</span>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          Skip reason (optional)
          <input
            type="text"
            value={skipReason}
            maxLength={200}
            placeholder="e.g. Transitioning from Sola"
            onChange={(e) => setSkipReason(e.target.value)}
            style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border, #d1d5db)", fontSize: 13 }}
          />
        </label>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 10, cursor: "pointer" }}>
        <input type="checkbox" checked={skipNext} onChange={(e) => setSkipNext(e.target.checked)} />
        Skip next scheduled billing run for this tenant
        <span style={{ fontSize: 11, color: "#6b7280" }}>(flag clears after skipping)</span>
      </label>
      {existing ? (
        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
          Override set by {existing.updatedBy || "admin"}{existing.updatedAt ? ` on ${existing.updatedAt.slice(0, 10)}` : ""}
          {existing.nextPaymentDate ? ` · Next: ${existing.nextPaymentDate}` : ""}
          {existing.skipNextPayment ? " · Skip next: YES" : ""}
        </div>
      ) : null}
      <div className="row-actions">
        <button className="btn primary" type="button" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save schedule override"}
        </button>
        {existing ? (
          <button className="btn ghost" type="button" disabled={saving} onClick={() => void save(true)} style={{ color: "#f87171" }}>
            Clear override
          </button>
        ) : null}
      </div>
      {msg ? (
        <p style={{ margin: "8px 0 0", fontSize: 13, color: msg.kind === "ok" ? "#16a34a" : "#dc2626" }}>{msg.text}</p>
      ) : null}
    </section>
  );
}

function prevMonthLabel() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return d.toLocaleString("en-US", { month: "long", year: "numeric" });
}

function prevMonthPeriod() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const last = new Date(y, d.getMonth() + 1, 0).getDate();
  return { start: `${y}-${m}-01`, end: `${y}-${m}-${last}` };
}

function PastDueBillingPanel({
  tenantId,
  tenantName,
  balanceDue,
  isLiveCharge,
  onSuccess,
}: {
  tenantId: string;
  tenantName: string;
  balanceDue: number;
  isLiveCharge: boolean;
  onSuccess: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);
  const [mode, setMode] = useState<"prior_period" | "custom">("prior_period");
  const [customDesc, setCustomDesc] = useState("");
  const [customAmount, setCustomAmount] = useState("");
  const [collectMode, setCollectMode] = useState<"none" | "card_on_file" | "new_card">("card_on_file");

  const period = prevMonthPeriod();
  const periodLabel = prevMonthLabel();

  const resolvedDesc = mode === "prior_period"
    ? `Monthly service — ${periodLabel} (${period.start} – ${period.end})`
    : customDesc.trim();
  const resolvedAmountCents = mode === "prior_period"
    ? (balanceDue > 0 ? balanceDue : undefined)
    : (customAmount ? Math.round(parseFloat(customAmount) * 100) : undefined);

  const canProceed = resolvedDesc.length > 0 && (resolvedAmountCents ?? 0) > 0;

  if (chargeOpen) {
    return (
      <OneTimeChargeDrawer
        tenantId={tenantId}
        tenantName={tenantName}
        isLiveCharge={isLiveCharge}
        initialDescription={resolvedDesc}
        initialAmountCents={resolvedAmountCents}
        initialChargeMode={collectMode}
        onClose={() => { setChargeOpen(false); setOpen(false); }}
        onSuccess={() => { setChargeOpen(false); setOpen(false); onSuccess(); }}
      />
    );
  }

  return (
    <section style={{ marginBottom: 14, borderRadius: 8, border: "1px solid var(--border, #e0e0e0)", overflow: "hidden" }} aria-label="Past-due billing panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ width: "100%", textAlign: "left", padding: "10px 16px", background: balanceDue > 0 ? "#fef2f2" : "var(--surface, #fff)", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 14, fontWeight: 600 }}
      >
        <span>
          {balanceDue > 0 ? (
            <span style={{ color: "#dc2626", marginRight: 8 }}>⚠</span>
          ) : null}
          Bill prior period / past-due balance
          {balanceDue > 0 ? (
            <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#dc2626" }}>{dollars(balanceDue)} outstanding</span>
          ) : null}
        </span>
        <span style={{ fontSize: 11, color: "#6b7280" }}>{open ? "▲ collapse" : "▼ expand"}</span>
      </button>
      {open ? (
        <div style={{ padding: "14px 16px", background: "var(--surface, #fff)", borderTop: "1px solid var(--border, #e0e0e0)" }}>
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "#6b7280" }}>
            Create an invoice for a prior period or custom amount. No charge runs until you confirm.
          </p>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button
              type="button"
              className={`billing-p8-filter-pill${mode === "prior_period" ? " active" : ""}`}
              onClick={() => setMode("prior_period")}
            >
              Prior period ({periodLabel})
            </button>
            <button
              type="button"
              className={`billing-p8-filter-pill${mode === "custom" ? " active" : ""}`}
              onClick={() => setMode("custom")}
            >
              Custom invoice
            </button>
          </div>

          {mode === "prior_period" ? (
            <div style={{ fontSize: 13, marginBottom: 12, background: "#f9fafb", borderRadius: 6, padding: "8px 12px" }}>
              <p style={{ margin: 0 }}>Period: <strong>{periodLabel}</strong> ({period.start} – {period.end})</p>
              <p style={{ margin: "4px 0 0" }}>Description: <em>{resolvedDesc}</em></p>
              <p style={{ margin: "4px 0 0" }}>Amount: <strong>{balanceDue > 0 ? dollars(balanceDue) : "Enter on next step"}</strong>
                {balanceDue > 0 ? <span style={{ fontSize: 11, color: "#6b7280", marginLeft: 6 }}>(pre-filled from outstanding balance)</span> : null}
              </p>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                Description
                <input
                  type="text"
                  value={customDesc}
                  onChange={(e) => setCustomDesc(e.target.value)}
                  placeholder="e.g. April service balance"
                  style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border, #d1d5db)", fontSize: 13 }}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                Amount ($)
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={customAmount}
                  onChange={(e) => setCustomAmount(e.target.value)}
                  placeholder="0.00"
                  style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border, #d1d5db)", fontSize: 13 }}
                />
              </label>
            </div>
          )}

          <div style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 13, fontWeight: 600, margin: "0 0 6px" }}>Collection method</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {([
                ["none", "Invoice only (no charge)"],
                ["card_on_file", "Charge card on file"],
                ["new_card", "Enter new card"],
              ] as const).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  className={`billing-p8-filter-pill${collectMode === val ? " active" : ""}`}
                  onClick={() => setCollectMode(val)}
                >
                  {label}
                </button>
              ))}
            </div>
            {collectMode === "none" ? (
              <p style={{ margin: "6px 0 0", fontSize: 12, color: "#6b7280" }}>An invoice will be created and you can send a payment link separately.</p>
            ) : collectMode === "card_on_file" ? (
              <p style={{ margin: "6px 0 0", fontSize: 12, color: "#6b7280" }}>You will choose from saved cards on the next step. A confirmation is required before any charge.</p>
            ) : (
              <p style={{ margin: "6px 0 0", fontSize: 12, color: "#6b7280" }}>You will enter card details via hosted form on the next step. A confirmation is required before any charge.</p>
            )}
          </div>

          <div className="row-actions">
            <button
              type="button"
              className="btn primary"
              disabled={!canProceed}
              onClick={() => setChargeOpen(true)}
            >
              Continue →
            </button>
            <button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
          </div>
          {!canProceed && mode === "custom" ? (
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "#dc2626" }}>Enter a description and amount to continue.</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

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
          <Link href="/admin/billing/sola-imports" className="btn ghost" data-testid="billing-pay-sola-imports">
            Sola imports
          </Link>
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

      {/* Past-due / prior period billing panel */}
      <PastDueBillingPanel
        tenantId={tenantId}
        tenantName={tenantName}
        balanceDue={balanceDue}
        isLiveCharge={pmData.status === "success" ? pmData.data.isLiveCharge : false}
        onSuccess={refresh}
      />

      {/* Billing schedule override — set next payment date or skip next billing run */}
      {tenantDetail.status === "success" ? (
        <BillingScheduleOverrideCard
          tenantId={tenantId}
          settings={tenantDetail.data.settings}
          onSaved={refresh}
        />
      ) : null}

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

      {/* Linked Sola recurring schedules for this tenant — lazy load on demand */}
      <section style={{ marginBottom: 14 }} aria-label="Linked Sola schedules">
        <SolaLinkedSchedulesSection tenantId={tenantId} compact />
      </section>

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

