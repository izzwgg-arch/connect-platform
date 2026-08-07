"use client";

/* Mockup 4 — Timeline. Past and future in one list, so "did the email go out?"
   and "why didn't this generate?" are answered without reading a log. */

import { useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { BillingNav, Pill, asList, dateTime, longDate, money, ordinal, useApi } from "../../../_new/ui";
import "../../customerBilling.css";

type Invoice = {
  id: string;
  invoiceNumber: string;
  status: string;
  source?: string | null;
  totalCents: number;
  balanceDueCents: number;
  periodStart: string;
  periodEnd: string;
  issueDate?: string;
  dueDate: string;
  paidAt?: string | null;
  failedAt?: string | null;
  createdAt?: string;
  lastEmailedAt?: string | null;
};

type Settings = {
  billingDayOfMonth: number;
  autoBillingEnabled: boolean;
  billingEmail?: string | null;
};

type Entry = {
  at: Date;
  future: boolean;
  tone: "ok" | "bad" | "now" | "future";
  title: string;
  detail: string;
};

function nextChargeDate(day: number, from = new Date()): Date {
  const d = Math.max(1, Math.min(28, Number(day) || 1));
  let y = from.getFullYear();
  let m = from.getMonth();
  if (from.getDate() > d) { m += 1; if (m > 11) { m = 0; y += 1; } }
  return new Date(y, m, d, 9, 0, 0);
}

export default function CustomerTimelinePage() {
  const params = useParams();
  const tenantId = String((params as any)?.tenantId || "");

  const settings = useApi<Settings>(tenantId ? `/admin/billing/tenants/${tenantId}/settings` : null);
  const invoices = useApi<Invoice[]>(
    tenantId ? `/admin/billing/invoices?tenantId=${tenantId}&limit=50` : null,
    (raw) => asList<Invoice>(raw, "invoices"),
  );

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    const list = invoices.data || [];

    for (const inv of list) {
      const created = inv.issueDate || inv.createdAt;
      if (created) {
        out.push({
          at: new Date(created),
          future: false,
          tone: "ok",
          title: `Invoice ${inv.invoiceNumber} created`,
          detail: `${money(inv.totalCents)} · covers ${longDate(inv.periodStart)} – ${longDate(inv.periodEnd)}${
            inv.source === "MANUAL" ? " · custom invoice" : ""
          }`,
        });
      }
      if (inv.lastEmailedAt) {
        out.push({
          at: new Date(inv.lastEmailedAt),
          future: false,
          tone: "ok",
          title: "Invoice emailed",
          detail: `${inv.invoiceNumber} sent to the billing contact`,
        });
      }
      if (inv.failedAt) {
        out.push({
          at: new Date(inv.failedAt),
          future: false,
          tone: "bad",
          title: "Card declined",
          detail: `${inv.invoiceNumber} · ${money(inv.balanceDueCents)} still owed`,
        });
      }
      if (inv.paidAt) {
        out.push({
          at: new Date(inv.paidAt),
          future: false,
          tone: "ok",
          title: `Paid — ${money(inv.totalCents)}`,
          detail: `${inv.invoiceNumber} settled in full`,
        });
      }
    }

    // The future, from the customer's own schedule. These are the events the
    // billing run will actually perform — not a guess.
    const s = settings.data;
    if (s?.autoBillingEnabled) {
      let cursor = new Date();
      for (let n = 0; n < 3; n++) {
        const charge = nextChargeDate(s.billingDayOfMonth, cursor);
        const invoiceAt = new Date(charge.getTime() - 3 * 86400000);
        const covered = (invoices.data || []).some(
          (inv) => inv.status === "PAID" && new Date(inv.periodEnd) > charge,
        );
        out.push({
          at: invoiceAt,
          future: true,
          tone: "future",
          title: "Invoice will be created and emailed",
          detail: s.billingEmail ? `To ${s.billingEmail} · three days before the charge` : "⚠ no billing email on file",
        });
        out.push({
          at: charge,
          future: true,
          tone: "future",
          title: covered ? "Charge will be skipped — already paid for" : "Card will be charged",
          detail: covered
            ? "This period is already covered by a paid invoice"
            : `On the ${ordinal(s.billingDayOfMonth)}, and on no other day`,
        });
        cursor = new Date(charge.getTime() + 86400000);
      }
    }

    return out.sort((a, b) => b.at.getTime() - a.at.getTime());
  }, [invoices.data, settings.data]);

  const s = settings.data;

  return (
    <div className="cbill">
      <BillingNav current="customers" />
      <div className="cbill-head">
        <div>
          <h2>Billing timeline</h2>
          <div className="cbill-sub">
            <span>Everything Connect has done, and everything it will do next</span>
            {s && (
              <>
                <span>·</span>
                <span>charged on the {ordinal(s.billingDayOfMonth)}</span>
              </>
            )}
          </div>
        </div>
        <div className="cbill-toolbar">
          <Link className="cbill-btn" href={`/admin/billing/customer/${tenantId}`}>Setup</Link>
        </div>
      </div>

      {settings.error && <div className="cbill-banner bad">{settings.error}</div>}
      {invoices.error && <div className="cbill-banner bad">{invoices.error}</div>}
      {s && !s.autoBillingEnabled && (
        <div className="cbill-banner warn">
          <span>
            <strong>Nothing is scheduled.</strong> Automatic charging is off for this customer, so no
            future invoices or charges appear below.
          </span>
        </div>
      )}

      <section className="cbill-card">
        <div className="cbill-card-hd">
          <h3>Timeline</h3>
          <span className="hint">future entries are the scheduled run, shown dashed</span>
        </div>
        <div className="cbill-card-bd" style={{ paddingTop: 8, paddingBottom: 12 }}>
          {entries.length === 0 && !invoices.loading && (
            <p className="cbill-sub">Nothing has happened yet for this customer.</p>
          )}
          <div className="cbill-tl">
            {entries.map((e, idx) => (
              <div className={`cbill-tl-item${e.future ? " future" : ""}`} key={idx}>
                <div className="cbill-tl-when">
                  {dateTime(e.at).split(" · ")[0]}
                  <br />
                  {dateTime(e.at).split(" · ")[1] || ""}
                </div>
                <div className="cbill-tl-rail">
                  <span className={`cbill-tl-dot${e.future ? " future" : e.tone === "bad" ? " bad" : ""}`} />
                </div>
                <div className="cbill-tl-what">
                  <span className="h">{e.title}</span>
                  <span className="d">{e.detail}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="cbill-card">
        <div className="cbill-card-hd"><h3>Their invoices</h3></div>
        <div className="cbill-table-wrap">
          <table className="cbill-table">
            <thead>
              <tr><th>Invoice</th><th>Period</th><th className="r">Total</th><th className="r">Status</th></tr>
            </thead>
            <tbody>
              {(invoices.data || []).length === 0 && (
                <tr><td colSpan={4} style={{ color: "var(--cb-muted)" }}>No invoices yet.</td></tr>
              )}
              {(invoices.data || []).map((inv) => (
                <tr key={inv.id}>
                  <td><Link href={`/admin/billing/invoice/${inv.id}`}>{inv.invoiceNumber}</Link></td>
                  <td className="n">{longDate(inv.periodStart)} – {longDate(inv.periodEnd)}</td>
                  <td className="r n">{money(inv.totalCents)}</td>
                  <td className="r">
                    <Pill tone={inv.status === "PAID" ? "ok" : inv.status === "FAILED" || inv.status === "OVERDUE" ? "bad" : "info"}>
                      {inv.status === "PAID" ? "Paid" : inv.status === "OPEN" ? "Waiting" : inv.status}
                    </Pill>
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
