"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
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

type SolaScheduleRow = {
  id: string;
  customerName: string | null;
  customerEmail: string | null;
  companyName: string | null;
  brand: string | null;
  last4: string | null;
  amountCents: number | null;
  intervalType: string | null;
  intervalCount: number | null;
  nextRunAt: string | null;
  isActive: boolean;
  mappingStatus: string;
  cutoverStatus: string | null;
  linkedPaymentMethodId: string | null;
};

/** Compact section showing mapped Sola recurring schedules for the tenant. */
export function SolaLinkedSchedulesSection({ tenantId, compact }: { tenantId: string; compact?: boolean }) {
  const [schedules, setSchedules] = useState<SolaScheduleRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await apiGet<{ schedules: SolaScheduleRow[] }>(
        `/admin/billing/platform/sola-import/schedules?status=MAPPED&tenantId=${encodeURIComponent(tenantId)}&limit=10`,
      );
      setSchedules(result.schedules || []);
      setLoaded(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Unable to load Sola schedules.");
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  // Auto-load for non-compact mode; lazy for compact
  useEffect(() => {
    if (!compact) void load();
  }, [compact, load]);

  if (!loaded && !loading && compact) {
    return (
      <div style={{ marginTop: 12 }}>
        <button className="btn ghost" type="button" style={{ fontSize: 12 }} onClick={() => void load()}>
          Check linked Sola schedules
        </button>
      </div>
    );
  }

  if (loading) return <BillingTableSkeleton variant="invoice" rows={2} />;
  if (error) return <ErrorState message={error} />;

  if (loaded && schedules.length === 0) {
    return compact ? null : (
      <div style={{ fontSize: 13, color: "var(--text-dim, #6b7280)", padding: "10px 0" }}>
        No mapped Sola schedules for this company. <Link href="/admin/billing/sola-imports" style={{ fontSize: 12 }}>Manage Sola imports →</Link>
      </div>
    );
  }

  return (
    <div data-testid="sola-linked-schedules" style={{ marginTop: compact ? 14 : 0 }}>
      {compact ? (
        <p className="billing-inv-meta" style={{ marginBottom: 8 }}>
          Linked Sola schedules{" "}
          <span style={{ fontSize: 11, background: "#fef9c3", color: "#713f12", borderRadius: 4, padding: "1px 5px", fontWeight: 600 }}>
            Old schedule may still charge
          </span>
        </p>
      ) : (
        <p className="billing-inv-meta" style={{ marginBottom: 8 }}>
          Linked Sola recurring schedules
          <span style={{ marginLeft: 8, fontSize: 11, background: "#fef9c3", color: "#713f12", borderRadius: 4, padding: "1px 5px", fontWeight: 600 }}>
            ⚠ Old schedule still active in Sola until disabled
          </span>
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {schedules.map((s) => {
          const card = s.last4 ? `${s.brand || "Card"} ···${s.last4}` : "Card not shown";
          const freq = s.intervalCount && s.intervalType
            ? `Every ${s.intervalCount} ${s.intervalType}${s.intervalCount > 1 ? "s" : ""}`
            : "—";
          const nextRun = s.nextRunAt ? formatDate(s.nextRunAt) : "Unknown";
          return (
            <div
              key={s.id}
              style={{
                padding: "10px 12px",
                borderRadius: 8,
                border: `1px solid ${s.isActive ? "#fde68a" : "var(--border, #e0e0e0)"}`,
                background: s.isActive ? "#fffbeb" : "transparent",
                fontSize: 13,
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                <div style={{ flex: 1 }}>
                  <strong>{s.customerName || s.companyName || "Customer"}</strong>
                  {s.customerEmail ? <span style={{ marginLeft: 6, fontSize: 11, color: "#6b7280" }}>{s.customerEmail}</span> : null}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <span
                    style={{
                      fontSize: 11,
                      borderRadius: 4,
                      padding: "1px 6px",
                      background: s.isActive ? "#dcfce7" : "#f3f4f6",
                      color: s.isActive ? "#166534" : "#6b7280",
                      fontWeight: 600,
                    }}
                  >
                    {s.isActive ? "Active in Sola" : "Inactive"}
                  </span>
                </div>
              </div>
              <div style={{ marginTop: 6, display: "flex", gap: 16, flexWrap: "wrap", color: "#6b7280", fontSize: 12 }}>
                <span>Card: {card}</span>
                <span>Amount: {s.amountCents != null ? dollars(s.amountCents) : "—"}</span>
                <span>Frequency: {freq}</span>
                <span>Next Sola run: {nextRun}</span>
              </div>
              {s.cutoverStatus === "CUTOVER_COMPLETE" ? (
                <p style={{ margin: "6px 0 0", fontSize: 12, color: "#166534" }}>
                  ✓ Cutover complete — Connect owns billing. Old Sola schedule disabled.
                </p>
              ) : s.isActive ? (
                <p style={{ margin: "6px 0 0", fontSize: 12, color: "#92400e" }}>
                  ⚠ Old schedule still active. Disable it and complete cutover before enabling Connect autopay.{" "}
                  <Link href="/admin/billing/sola-imports" style={{ fontSize: 12 }}>Manage in Sola imports →</Link>
                </p>
              ) : null}
              {s.cutoverStatus && s.cutoverStatus !== "CUTOVER_COMPLETE" && (
                <p style={{ margin: "4px 0 0", fontSize: 11, color: "#6b7280" }}>
                  Cutover status: <strong>{s.cutoverStatus}</strong>
                  {!s.linkedPaymentMethodId && " · Card token not yet linked"}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

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

      <div style={{ marginTop: 12 }}>
        <DetailCard title="Linked Sola schedules" dataTestId="billing-sola-schedules-card">
          <SolaLinkedSchedulesSection tenantId={detail.tenant.id} />
        </DetailCard>
      </div>

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
