"use client";

/* Mockup 1 — This month. The morning screen: is billing on track, and if not, who. */

import { useMemo } from "react";
import Link from "next/link";
import { Pill, asList, dateTime, invoiceTone, money, shortDate, useApi } from "../_new/ui";
import "../customer/customerBilling.css";

type Overview = {
  mrrCents?: number;
  openCents?: number;
  counts?: Record<string, number>;
  tenantsWithoutCards?: number;
  recentFailures?: Array<{
    id: string;
    invoiceNumber: string;
    status: string;
    balanceDueCents: number;
    failedAt?: string | null;
    dueDate?: string | null;
    tenantId: string;
    tenant?: { name?: string } | null;
  }>;
};

type Run = {
  id: string;
  status: string;
  dryRun?: boolean;
  startedAt?: string;
  finishedAt?: string | null;
  totals?: any;
  errorMessage?: string | null;
};

type TenantRow = {
  id: string;
  name: string;
  balanceDueCents?: number;
  billingSettings?: { billingDayOfMonth?: number; autoBillingEnabled?: boolean } | null;
  paymentMethods?: Array<{ id: string; brand?: string | null; last4?: string | null }>;
};

/** Next occurrence of a billing day, so "coming up" is real rather than guessed. */
function nextChargeDate(day: number): Date {
  const now = new Date();
  const d = Math.max(1, Math.min(28, Number(day) || 1));
  let y = now.getFullYear();
  let m = now.getMonth();
  if (now.getDate() > d) {
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return new Date(y, m, d);
}

export default function BillingMonthPage() {
  const overview = useApi<Overview>("/admin/billing/overview");
  const runs = useApi<Run[]>("/admin/billing/runs/recent", (raw) => asList<Run>(raw, "runs"));
  const tenants = useApi<TenantRow[]>("/admin/billing/platform/tenants", (raw) => asList<TenantRow>(raw, "tenants"));

  const o = overview.data;
  const failures = o?.recentFailures || [];

  const coming = useMemo(() => {
    const list = (tenants.data || []).filter((t) => t.billingSettings?.autoBillingEnabled);
    const soon = list
      .map((t) => {
        const day = Number(t.billingSettings?.billingDayOfMonth || 1);
        const charge = nextChargeDate(day);
        const invoice = new Date(charge.getTime() - 3 * 86400000);
        return { t, day, charge, invoice, hasCard: (t.paymentMethods || []).length > 0 };
      })
      .sort((a, b) => a.charge.getTime() - b.charge.getTime());
    return soon.slice(0, 12);
  }, [tenants.data]);

  const noCardCount = useMemo(
    () => (tenants.data || []).filter((t) => (t.paymentMethods || []).length === 0).length,
    [tenants.data],
  );

  const willFail = useMemo(
    () => coming.filter((c) => !c.hasCard),
    [coming],
  );

  const needsYou = failures.length + willFail.length;

  return (
    <div className="cbill">
      <div className="cbill-head">
        <div>
          <h2>This month</h2>
          <div className="cbill-sub">
            <span>{(tenants.data || []).filter((t) => t.billingSettings?.autoBillingEnabled).length} customers being charged</span>
            <span>·</span>
            <span>each on their own day</span>
          </div>
        </div>
        <div className="cbill-toolbar">
          <Link className="cbill-btn" href="/admin/billing/customers">Customers</Link>
          <Link className="cbill-btn" href="/admin/billing/needs-you">Needs you</Link>
        </div>
      </div>

      {overview.error && <div className="cbill-banner bad">{overview.error}</div>}

      <div className="cbill-kpis">
        <div className="cbill-kpi good">
          <span className="k">Collected</span>
          <span className="v">{money(o?.mrrCents)}</span>
          <span className="s">{o?.counts?.paid ?? 0} invoices paid</span>
        </div>
        <div className="cbill-kpi">
          <span className="k">Still owed</span>
          <span className="v">{money(o?.openCents)}</span>
          <span className="s">{(o?.counts?.open ?? 0) + (o?.counts?.overdue ?? 0)} open invoices</span>
        </div>
        <div className={needsYou > 0 ? "cbill-kpi alert" : "cbill-kpi"}>
          <span className="k">Needs you</span>
          <span className="v">{needsYou}</span>
          <span className="s">
            {failures.length} failed · {willFail.length} will fail
          </span>
        </div>
        <div className={noCardCount > 0 ? "cbill-kpi alert" : "cbill-kpi"}>
          <span className="k">No card on file</span>
          <span className="v">{noCardCount}</span>
          <span className="s">cannot be charged at all</span>
        </div>
      </div>

      {failures.length > 0 && (
        <section className="cbill-card">
          <div className="cbill-card-hd">
            <h3>Needs you</h3>
            <Link className="cbill-btn" href="/admin/billing/needs-you">See all</Link>
          </div>
          {failures.slice(0, 6).map((f) => (
            <div className="cbill-att" key={f.id}>
              <div className="cbill-att-i bad">!</div>
              <div className="cbill-att-tx">
                <span className="h">
                  {f.tenant?.name || "Customer"} — payment failed
                </span>
                <span className="d">
                  {f.invoiceNumber} · {money(f.balanceDueCents)} ·{" "}
                  {f.failedAt ? `failed ${shortDate(f.failedAt)}` : `due ${shortDate(f.dueDate)}`}
                </span>
              </div>
              <Pill tone="bad">{invoiceTone(f.status).label}</Pill>
              <Link className="cbill-btn" href={`/admin/billing/invoice/${f.id}`}>Open invoice</Link>
            </div>
          ))}
          {willFail.map((w) => (
            <div className="cbill-att" key={`nocard-${w.t.id}`}>
              <div className="cbill-att-i warn">?</div>
              <div className="cbill-att-tx">
                <span className="h">{w.t.name} — no card on file</span>
                <span className="d">
                  Cannot be charged on {shortDate(w.charge)} · a card is required
                </span>
              </div>
              <Pill tone="bad">Card missing</Pill>
              <Link className="cbill-btn" href={`/admin/billing/customer/${w.t.id}`}>Fix</Link>
            </div>
          ))}
        </section>
      )}

      <section className="cbill-card">
        <div className="cbill-card-hd">
          <h3>Coming up</h3>
          <span className="hint">the invoice is created three days before the charge</span>
        </div>
        <div className="cbill-table-wrap">
          <table className="cbill-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Invoice created</th>
                <th>Card charged</th>
                <th className="r">Card</th>
              </tr>
            </thead>
            <tbody>
              {coming.length === 0 && (
                <tr><td colSpan={4} style={{ color: "var(--cb-muted)" }}>Nothing scheduled.</td></tr>
              )}
              {coming.map((c) => (
                <tr key={c.t.id}>
                  <td><Link href={`/admin/billing/customer/${c.t.id}`}>{c.t.name}</Link></td>
                  <td className="n">{shortDate(c.invoice)}</td>
                  <td className="n">{shortDate(c.charge)}</td>
                  <td className="r">
                    {c.hasCard ? <Pill tone="ok">On file</Pill> : <Pill tone="bad">None</Pill>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="cbill-card">
        <div className="cbill-card-hd">
          <h3>Recent billing runs</h3>
          <span className="hint">every run is recorded</span>
        </div>
        <div className="cbill-table-wrap">
          <table className="cbill-table">
            <thead>
              <tr><th>Started</th><th>Result</th><th>Outcome</th></tr>
            </thead>
            <tbody>
              {(runs.data || []).length === 0 && (
                <tr><td colSpan={3} style={{ color: "var(--cb-muted)" }}>No runs recorded yet.</td></tr>
              )}
              {(runs.data || []).slice(0, 8).map((r) => (
                <tr key={r.id}>
                  <td className="n">{dateTime(r.startedAt)}</td>
                  <td>
                    {r.status === "COMPLETED" ? (
                      <Pill tone="ok">Completed</Pill>
                    ) : r.status === "FAILED" ? (
                      <Pill tone="bad">Failed</Pill>
                    ) : (
                      <Pill tone="info">Running</Pill>
                    )}
                    {r.dryRun ? " (dry run)" : ""}
                  </td>
                  <td style={{ color: "var(--cb-muted)", fontSize: 12.5 }}>
                    {r.errorMessage || (r.totals ? JSON.stringify(r.totals).slice(0, 120) : "—")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
