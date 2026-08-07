"use client";

/* Invoices — the list that feeds the invoice page. Search, filter, and the
   customer/period/amount/standing of every bill. */

import { useMemo, useState } from "react";
import Link from "next/link";
import { BillingNav, Pill, asList, invoiceTone, longDate, money, useApi } from "../_new/ui";
import "../customer/customerBilling.css";

type Invoice = {
  id: string;
  invoiceNumber: string;
  tenantId: string;
  status: string;
  source?: string | null;
  totalCents: number;
  balanceDueCents: number;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  paidAt?: string | null;
  tenant?: { id: string; name?: string } | null;
};

type Filter = "all" | "unpaid" | "PAID" | "MANUAL";

export default function InvoicesListPage() {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const { data, error, loading } = useApi<Invoice[]>(
    "/admin/billing/invoices?limit=100",
    (raw) => asList<Invoice>(raw, "invoices"),
  );

  const rows = useMemo(() => {
    const list = data || [];
    const needle = q.trim().toLowerCase();
    return list.filter((i) => {
      if (filter === "PAID" && i.status !== "PAID") return false;
      if (filter === "MANUAL" && i.source !== "MANUAL") return false;
      if (filter === "unpaid" && !["OPEN", "FAILED", "OVERDUE", "DRAFT"].includes(i.status)) return false;
      if (!needle) return true;
      return (
        String(i.invoiceNumber || "").toLowerCase().includes(needle) ||
        String(i.tenant?.name || "").toLowerCase().includes(needle)
      );
    });
  }, [data, q, filter]);

  const totals = useMemo(() => {
    const list = data || [];
    return {
      owed: list.reduce((s, i) => s + (["OPEN", "FAILED", "OVERDUE"].includes(i.status) ? Number(i.balanceDueCents || 0) : 0), 0),
      paid: list.filter((i) => i.status === "PAID").length,
      unpaid: list.filter((i) => ["OPEN", "FAILED", "OVERDUE"].includes(i.status)).length,
      custom: list.filter((i) => i.source === "MANUAL").length,
    };
  }, [data]);

  return (
    <div className="cbill">
      <BillingNav current="invoices" />
      <div className="cbill-head">
        <div>
          <h2>Invoices</h2>
          <div className="cbill-sub"><span>{(data || []).length} most recent</span></div>
        </div>
        <div className="cbill-toolbar">
          <input className="cbill-input text" placeholder="Search invoice or customer…" value={q}
            onChange={(e) => setQ(e.target.value)} aria-label="Search invoices" />
          <div className="cbill-seg">
            <button type="button" data-on={filter === "all"} onClick={() => setFilter("all")}>All</button>
            <button type="button" data-on={filter === "unpaid"} onClick={() => setFilter("unpaid")}>Unpaid</button>
            <button type="button" data-on={filter === "PAID"} onClick={() => setFilter("PAID")}>Paid</button>
            <button type="button" data-on={filter === "MANUAL"} onClick={() => setFilter("MANUAL")}>Custom</button>
          </div>
        </div>
      </div>

      {error && <div className="cbill-banner bad">{error}</div>}

      <div className="cbill-kpis">
        <div className={totals.owed > 0 ? "cbill-kpi alert" : "cbill-kpi"}>
          <span className="k">Still owed</span><span className="v">{money(totals.owed)}</span>
          <span className="s">{totals.unpaid} unpaid invoices</span>
        </div>
        <div className="cbill-kpi good">
          <span className="k">Paid</span><span className="v">{totals.paid}</span>
          <span className="s">in this view</span>
        </div>
        <div className="cbill-kpi">
          <span className="k">Custom invoices</span><span className="v">{totals.custom}</span>
          <span className="s">never charged automatically</span>
        </div>
        <div className="cbill-kpi">
          <span className="k">Showing</span><span className="v">{rows.length}</span>
          <span className="s">of {(data || []).length}</span>
        </div>
      </div>

      <section className="cbill-card">
        <div className="cbill-table-wrap">
          <table className="cbill-table">
            <thead>
              <tr>
                <th>Invoice</th><th>Customer</th><th>Period</th><th>Due</th>
                <th className="r">Total</th><th className="r">Owed</th><th className="r">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={7} style={{ color: "var(--cb-muted)" }}>Loading…</td></tr>}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={7} style={{ color: "var(--cb-muted)" }}>No invoices match.</td></tr>
              )}
              {rows.map((i) => {
                const tone = invoiceTone(i.status);
                return (
                  <tr key={i.id}>
                    <td>
                      <Link href={`/admin/billing/invoice/${i.id}`}>{i.invoiceNumber}</Link>
                      {i.source === "MANUAL" && <> <Pill tone="off">Custom</Pill></>}
                    </td>
                    <td>
                      {i.tenantId ? (
                        <Link href={`/admin/billing/customer/${i.tenantId}`}>{i.tenant?.name || "Customer"}</Link>
                      ) : (i.tenant?.name || "—")}
                    </td>
                    <td className="n">{longDate(i.periodStart)} – {longDate(i.periodEnd)}</td>
                    <td className="n">{longDate(i.dueDate)}</td>
                    <td className="r n">{money(i.totalCents)}</td>
                    <td className="r n">{i.balanceDueCents > 0 ? money(i.balanceDueCents) : "—"}</td>
                    <td className="r"><Pill tone={tone.tone}>{tone.label}</Pill></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
