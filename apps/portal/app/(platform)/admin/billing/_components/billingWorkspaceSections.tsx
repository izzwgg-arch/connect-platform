"use client";

import Link from "next/link";
import { useState } from "react";
import { apiGet } from "../../../../../services/apiClient";
import { DetailCard } from "../../../../../components/DetailCard";
import { ErrorState } from "../../../../../components/ErrorState";
import { BillingActivityList } from "../../../../../components/billing/BillingActivityList";
import { BillingEmptyState } from "../../../../../components/billing/BillingEmptyState";
import { BillingTableSkeleton } from "../../../../../components/billing/BillingTableSkeleton";
import { dollars, formatDate, invoiceStatusLabel } from "../../../../../lib/billingUi";
import type { TenantDetail } from "./tenantBillingConfigForms";
import { mergeSearchParams } from "./adminBillingLinks";
import { PaymentMethodsModal } from "./adminBillingOpsPanels";
import "./billingPayments.css";
import "./billingPhase8.css";

export function BillingPaymentMethodsSection({ detail }: { detail: TenantDetail }) {
  const methods = detail.paymentMethods || [];
  const autopay = detail.settings?.autoBillingEnabled;
  const billingDay = detail.settings?.billingDayOfMonth;
  const [methodsOpen, setMethodsOpen] = useState(false);

  return (
    <div className="billing-ws-section billing-p8-scope billing-pay-scope" data-testid="billing-admin-methods-panel">
      <div className="billing-ov-summary" style={{ marginBottom: 12 }}>
        <div className="billing-ov-summary__card">
          <label>Autopay</label>
          <strong>{autopay ? "On" : "Off"}</strong>
          <small>{autopay ? "Charges run on the billing calendar." : "Manual collection from invoices."}</small>
        </div>
        <div className="billing-ov-summary__card">
          <label>Billing day</label>
          <strong>{billingDay ? `Day ${billingDay}` : "—"}</strong>
        </div>
        <div className="billing-ov-summary__card">
          <label>Saved methods</label>
          <strong>{methods.length}</strong>
        </div>
      </div>

      <div className="row-actions" style={{ marginBottom: 10 }}>
        <button className="btn primary" type="button" style={{ fontSize: 13 }} onClick={() => setMethodsOpen(true)}>
          Manage cards
        </button>
        <Link
          className="btn ghost"
          style={{ fontSize: 13 }}
          href={`/admin/billing/payments${mergeSearchParams(new URLSearchParams(), { tenantId: detail.tenant.id })}`}
        >
          Open payments
        </Link>
      </div>

      <DetailCard title="Payment methods">
        {methods.length === 0 ? (
          <BillingEmptyState
            title="No payment method on file"
            message="Add a card with the secure form. Saved cards can be charged from Payments or Invoices."
          />
        ) : (
          <div className="billing-pay-pm-grid">
            {methods.map((method: { id: string; brand?: string | null; last4?: string | null; isDefault?: boolean; cardholderName?: string | null; expMonth?: number; expYear?: number }) => (
              <article key={method.id} className={`billing-pay-pm-card${method.isDefault ? " billing-pay-pm-card--default" : ""}`}>
                <div className="billing-pay-pm-card__brand">
                  {(method.brand || "Card").toString()} ···{method.last4 || "----"}
                  {method.isDefault ? <span className="billing-p8-pm-badge" style={{ marginLeft: 8 }}>Default · Autopay</span> : null}
                </div>
                <div className="billing-pay-pm-card__meta">
                    {method.cardholderName || "Cardholder not set"}
                    {method.expMonth && method.expYear ? ` · Expires ${method.expMonth}/${method.expYear}` : ""}
                </div>
              </article>
            ))}
          </div>
        )}
      </DetailCard>

      {methodsOpen ? (
        <PaymentMethodsModal tenantId={detail.tenant.id} tenantName={detail.tenant.name} onClose={() => setMethodsOpen(false)} />
      ) : null}
    </div>
  );
}

export function BillingActivitySection({ detail }: { detail: TenantDetail }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [events, setEvents] = useState<{ id: string; type: string; message: string | null; createdAt: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  async function toggle(invoiceId: string) {
    if (openId === invoiceId) {
      setOpenId(null);
      return;
    }
    setOpenId(invoiceId);
    setLoading(true);
    setErr("");
    setEvents([]);
    try {
      const res = await apiGet<{ events: typeof events }>(`/admin/billing/invoices/${invoiceId}/events`);
      setEvents(res.events || []);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Unable to load activity.");
    } finally {
      setLoading(false);
    }
  }

  const recent = [...(detail.invoices || [])]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 12);

  return (
    <div className="billing-ws-section billing-p8-scope" data-testid="billing-admin-activity-panel">
      <p className="billing-inv-meta" style={{ marginBottom: 10 }}>
        Invoice and payment events for this company.
      </p>
      {recent.length === 0 ? (
        <BillingEmptyState title="No billing activity yet" message="Invoices and payments will appear here once generated." />
      ) : (
        <div className="billing-inv-table billing-inv-table--sticky">
          {recent.map((invoice) => (
            <div key={invoice.id} className={`billing-inv-row-group${openId === invoice.id ? " billing-inv-row-group--open" : ""}`}>
              <div className={`billing-inv-row${openId === invoice.id ? " billing-inv-row--active" : ""}`} style={{ gridTemplateColumns: "1fr auto auto" }}>
                <div>
                  <div className="billing-inv-row__num">{invoice.invoiceNumber || "Invoice"}</div>
                  <div className="billing-inv-row__sub">
                    {formatDate((invoice.createdAt || invoice.dueDate) as string)} · {dollars(invoice.totalCents)}
                  </div>
                </div>
                <span className={`billing-status-pill ${invoice.status === "PAID" ? "good" : invoice.status === "FAILED" ? "bad" : "warn"}`}>
                  {invoiceStatusLabel(invoice.status)}
                </span>
                <button className="btn ghost" type="button" style={{ fontSize: 12 }} onClick={() => void toggle(invoice.id)}>
                  {openId === invoice.id ? "Hide" : "Timeline"}
                </button>
              </div>
              {openId === invoice.id ? (
                <div className="billing-inv-log" style={{ gridColumn: "1 / -1" }}>
                  {loading ? <BillingTableSkeleton variant="invoice" rows={3} /> : null}
                  {err ? <ErrorState message={err} /> : null}
                  {!loading && !err && events.length === 0 ? <p className="muted">No events on this invoice.</p> : null}
                  {!loading && !err && events.length > 0 ? (
                    <BillingActivityList events={events.slice(0, 16).map((ev) => ({ ...ev, id: ev.id }))} />
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
