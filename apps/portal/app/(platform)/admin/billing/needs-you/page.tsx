"use client";

/* Mockup 7 — Needs you. Everything stuck, with the one action that unsticks it,
   and a second panel for what Connect already handled by itself. */

import { useMemo } from "react";
import Link from "next/link";
import { Pill, asList, invoiceTone, money, shortDate, useApi } from "../_new/ui";
import "../customer/customerBilling.css";

type Overview = {
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

type TenantRow = {
  id: string;
  name: string;
  balanceDueCents?: number;
  billingSettings?: {
    billingDayOfMonth?: number;
    autoBillingEnabled?: boolean;
    billingEmail?: string | null;
  } | null;
  paymentMethods?: Array<{ id: string }>;
};

export default function BillingNeedsYouPage() {
  const overview = useApi<Overview>("/admin/billing/overview");
  const tenants = useApi<TenantRow[]>("/admin/billing/platform/tenants", (raw) => asList<TenantRow>(raw, "tenants"));

  const failures = overview.data?.recentFailures || [];

  const problems = useMemo(() => {
    const list = tenants.data || [];
    const noCard = list.filter(
      (t) => t.billingSettings?.autoBillingEnabled && (t.paymentMethods || []).length === 0,
    );
    const noEmail = list.filter((t) => !String(t.billingSettings?.billingEmail || "").trim());
    const day1 = list.filter((t) => Number(t.billingSettings?.billingDayOfMonth) === 1);
    const notCollecting = list.filter(
      (t) => t.billingSettings?.autoBillingEnabled === false && (t.paymentMethods || []).length > 0,
    );
    return { noCard, noEmail, day1, notCollecting };
  }, [tenants.data]);

  const total =
    failures.length +
    problems.noCard.length +
    problems.noEmail.length +
    problems.day1.length +
    problems.notCollecting.length;

  return (
    <div className="cbill">
      <div className="cbill-head">
        <div>
          <h2>Needs you</h2>
          <div className="cbill-sub">
            <span>{total} items</span>
            <span>·</span>
            <span>Connect already tried everything it is allowed to try</span>
          </div>
        </div>
        <div className="cbill-toolbar">
          <Link className="cbill-btn" href="/admin/billing/month">This month</Link>
        </div>
      </div>

      {overview.error && <div className="cbill-banner bad">{overview.error}</div>}
      {total === 0 && !overview.loading && !tenants.loading && (
        <div className="cbill-banner ok">Nothing needs you. Every customer is billable and up to date.</div>
      )}

      {failures.length > 0 && (
        <section className="cbill-card">
          <div className="cbill-card-hd">
            <h3>Payments that failed</h3>
            <span className="hint">retries are already exhausted or in progress</span>
          </div>
          {failures.map((f) => (
            <div className="cbill-att" key={f.id}>
              <div className="cbill-att-i bad">!</div>
              <div className="cbill-att-tx">
                <span className="h">{f.tenant?.name || "Customer"} — {invoiceTone(f.status).label.toLowerCase()}</span>
                <span className="d">
                  {f.invoiceNumber} · {money(f.balanceDueCents)} ·{" "}
                  {f.failedAt ? `last tried ${shortDate(f.failedAt)}` : `due ${shortDate(f.dueDate)}`}
                </span>
              </div>
              <Pill tone="bad">{money(f.balanceDueCents)}</Pill>
              <Link className="cbill-btn" href={`/admin/billing/invoice/${f.id}`}>Open invoice</Link>
              <Link className="cbill-btn" href={`/admin/billing/customer/${f.tenantId}`}>Customer</Link>
            </div>
          ))}
        </section>
      )}

      {problems.noCard.length > 0 && (
        <section className="cbill-card">
          <div className="cbill-card-hd">
            <h3>No card on file</h3>
            <span className="hint">these customers cannot be charged at all</span>
          </div>
          {problems.noCard.map((t) => (
            <div className="cbill-att" key={t.id}>
              <div className="cbill-att-i bad">!</div>
              <div className="cbill-att-tx">
                <span className="h">{t.name}</span>
                <span className="d">Set to be charged automatically, but there is no card to charge</span>
              </div>
              <Pill tone="bad">Card missing</Pill>
              <Link className="cbill-btn" href={`/admin/billing/customer/${t.id}`}>Add a card</Link>
            </div>
          ))}
        </section>
      )}

      {problems.notCollecting.length > 0 && (
        <section className="cbill-card">
          <div className="cbill-card-hd">
            <h3>Not being collected from</h3>
            <span className="hint">they have a card, but automatic charging is off</span>
          </div>
          {problems.notCollecting.map((t) => (
            <div className="cbill-att" key={t.id}>
              <div className="cbill-att-i warn">?</div>
              <div className="cbill-att-tx">
                <span className="h">{t.name}</span>
                <span className="d">
                  A card is on file but nothing is charged. {Number(t.balanceDueCents || 0) > 0
                    ? `They currently owe ${money(t.balanceDueCents)}.`
                    : "No balance outstanding."}
                </span>
              </div>
              <Pill tone="warn">Switched off</Pill>
              <Link className="cbill-btn" href={`/admin/billing/customer/${t.id}`}>Review</Link>
            </div>
          ))}
        </section>
      )}

      {problems.day1.length > 0 && (
        <section className="cbill-card">
          <div className="cbill-card-hd">
            <h3>Billing day still set to the 1st</h3>
            <span className="hint">the default nobody chose — their cycle matches nothing they bought</span>
          </div>
          {problems.day1.map((t) => (
            <div className="cbill-att" key={t.id}>
              <div className="cbill-att-i warn">1</div>
              <div className="cbill-att-tx">
                <span className="h">{t.name}</span>
                <span className="d">Pick the day they actually agreed to be charged on</span>
              </div>
              <Pill tone="warn">Day 1</Pill>
              <Link className="cbill-btn" href={`/admin/billing/customer/${t.id}`}>Set the day</Link>
            </div>
          ))}
        </section>
      )}

      {problems.noEmail.length > 0 && (
        <section className="cbill-card">
          <div className="cbill-card-hd">
            <h3>No billing email</h3>
            <span className="hint">these customers receive no invoices, reminders or receipts</span>
          </div>
          {problems.noEmail.map((t) => (
            <div className="cbill-att" key={t.id}>
              <div className="cbill-att-i warn">@</div>
              <div className="cbill-att-tx">
                <span className="h">{t.name}</span>
                <span className="d">Nothing is being sent to this customer</span>
              </div>
              <Pill tone="warn">Not set</Pill>
              <Link className="cbill-btn" href={`/admin/billing/customer/${t.id}`}>Add an address</Link>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
