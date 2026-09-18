"use client";

/* Office-only drill-down of "What this customer cost us": by number, by day,
   and where the money went. Reached from the cost card on an invoice
   (?invoiceId=…) or with an explicit ?from=YYYY-MM-DD&to=YYYY-MM-DD.
   Registered in layout.tsx's REBUILT list via its parent /admin/billing/customer. */

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { BillingNav, Pill, longDate, useApi } from "../../../_new/ui";
import { CostTable, CostTiles, FeedNote, TierLegend, dollars, type CostResponse } from "../../../_new/CostCard";
import "../../customerBilling.css";

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(d.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export default function CustomerCostPage() {
  const params = useParams();
  const tenantId = String((params as any)?.tenantId || "");
  const sp = useSearchParams();
  const invoiceId = sp.get("invoiceId") || "";
  const from = sp.get("from") || "";
  const to = sp.get("to") || "";
  const query = invoiceId ? `?invoiceId=${encodeURIComponent(invoiceId)}` : from && to ? `?from=${from}&to=${to}` : "";
  const res = useApi<CostResponse>(tenantId ? `/admin/billing/cost/tenants/${tenantId}${query}` : null);
  const b = res.data?.breakdown;
  const periodFrom = b ? b.periodStart.slice(0, 10) : "";
  const periodTo = b ? b.periodEnd.slice(0, 10) : "";
  const span = b ? Math.max(1, Math.round((new Date(b.periodEnd).getTime() - new Date(b.periodStart).getTime()) / 86_400_000)) : 30;

  const shares = useMemo(() => {
    if (!b) return [];
    const total = b.totalCost || 0;
    const items = [
      { label: "Inbound calls", cost: b.groups.find((g) => g.key === "calls")?.lines.find((l) => l.key === "inbound")?.cost || 0 },
      { label: "Outbound calls", cost: (b.groups.find((g) => g.key === "calls")?.lines || []).filter((l) => l.key !== "inbound").reduce((s, l) => s + l.cost, 0) },
      { label: "Caller ID lookups", cost: b.groups.find((g) => g.key === "caller_id")?.cost || 0, warn: true },
      { label: "Texting", cost: b.groups.find((g) => g.key === "texting")?.cost || 0 },
      { label: "Numbers & 911", cost: b.groups.find((g) => g.key === "numbers")?.cost || 0 },
      { label: "One-time / other", cost: b.groups.find((g) => g.key === "one_time")?.cost || 0 },
    ];
    return items
      .map((i) => ({ ...i, pct: total > 0 ? Math.round((i.cost / total) * 100) : 0 }))
      .sort((a, z) => z.cost - a.cost);
  }, [b]);

  const maxDayMin = b ? Math.max(1, ...b.byDay.map((d) => d.minutes)) : 1;
  const busiest = b && b.byDay.length ? b.byDay.reduce((a, d) => (d.minutes > a.minutes ? d : a), b.byDay[0]) : null;
  const cnamShare = shares.find((s) => s.label === "Caller ID lookups");

  return (
    <div className="cbill">
      <BillingNav current="customers" />
      <div className="cbill-head">
        <div>
          <h2>{res.data?.tenant?.name || "Customer"} — cost by number and by day</h2>
          <div className="cbill-sub">
            <Pill tone="warn">Office only</Pill>
            {res.data?.invoice ? (
              <Link href={`/admin/billing/invoice/${res.data.invoice.id}`}>← invoice {res.data.invoice.invoiceNumber}</Link>
            ) : (
              <Link href={`/admin/billing/customer/${tenantId}`}>← customer</Link>
            )}
            {b && (
              <>
                <span>·</span>
                <span>service {longDate(b.periodStart)} – {longDate(b.periodEnd)}</span>
                <span>·</span>
                <span>{b.periodClosed ? "period closed" : "period running"}</span>
              </>
            )}
          </div>
        </div>
        {b && (
          <div style={{ display: "flex", gap: 8 }}>
            <Link className="cbill-btn" href={`/admin/billing/customer/${tenantId}/cost?from=${shiftDays(periodFrom, -span)}&to=${periodFrom}`}>Previous period</Link>
            <Link className="cbill-btn" href={`/admin/billing/customer/${tenantId}/cost?from=${periodTo}&to=${shiftDays(periodTo, span)}`}>Next period</Link>
          </div>
        )}
      </div>

      {res.error && <div className="cbill-banner bad">{res.error}</div>}
      {res.loading && <p className="cbill-sub">Adding up the carrier records…</p>}

      {b && (
        <>
          <section className="cbill-card">
            <div className="cbill-card-hd">
              <h3>The period</h3>
              <FeedNote b={b} />
            </div>
            <CostTiles b={b} revenueCents={res.data?.revenueCents} marginCents={res.data?.marginCents} marginPct={res.data?.marginPct} />
          </section>

          <section className="cbill-card">
            <div className="cbill-card-hd">
              <h3>By number</h3>
              <span className="hint">every number that carried this customer's traffic, including the shared outbound trunk</span>
            </div>
            <div className="cbill-table-wrap">
              <table className="cbill-table">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th className="r">Inbound min</th>
                    <th className="r">Outbound min</th>
                    <th className="r">Texts</th>
                    <th className="r">Caller ID lookups</th>
                    <th className="r">Monthly fees</th>
                    <th className="r">Cost</th>
                    <th style={{ width: 140 }}>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {b.byNumber.length === 0 && <tr><td colSpan={8} style={{ color: "var(--cb-muted)" }}>No carrier traffic in this period.</td></tr>}
                  {b.byNumber.map((n) => (
                    <tr key={n.numberE164 || n.label}>
                      <td><div className="n" style={{ fontWeight: 600 }}>{n.label}</div></td>
                      <td className="r n">{n.inboundMin ? `${Math.round(n.inboundMin).toLocaleString()}` : "—"}<div className="src" style={{ fontSize: 10.5, color: "var(--cb-muted)" }}>{n.inboundCost ? dollars(n.inboundCost) : ""}</div></td>
                      <td className="r n">{n.outboundMin ? `${Math.round(n.outboundMin).toLocaleString()}` : "—"}<div style={{ fontSize: 10.5, color: "var(--cb-muted)" }}>{n.outboundCost ? dollars(n.outboundCost) : ""}</div></td>
                      <td className="r n">{n.messages || "—"}<div style={{ fontSize: 10.5, color: "var(--cb-muted)" }}>{n.messageCost ? dollars(n.messageCost) : ""}</div></td>
                      <td className="r n">{n.cnamLookups || "—"}<div style={{ fontSize: 10.5, color: "var(--cb-muted)" }}>{n.cnamCost ? dollars(n.cnamCost) : ""}</div></td>
                      <td className="r n">{n.monthlyFees ? dollars(n.monthlyFees) : "—"}</td>
                      <td className="r n" style={{ fontWeight: 660 }}>{dollars(n.cost)}</td>
                      <td>
                        <div style={{ height: 8, borderRadius: 4, background: "var(--cb-line-soft)", overflow: "hidden" }}>
                          <i style={{ display: "block", height: "100%", width: `${b.totalCost > 0 ? Math.round((n.cost / b.totalCost) * 100) : 0}%`, background: "var(--cb-accent)" }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="cbill-grid">
            <section className="cbill-card">
              <div className="cbill-card-hd">
                <h3>By day</h3>
                <span className="hint">talk minutes, both directions{busiest ? ` · busiest ${busiest.day} (${Math.round(busiest.minutes).toLocaleString()} min, ${dollars(busiest.cost)})` : ""}</span>
              </div>
              <div className="cbill-table-wrap">
                <table className="cbill-table">
                  <thead><tr><th>Day</th><th className="r">Minutes</th><th style={{ width: 220 }} /><th className="r">Cost</th></tr></thead>
                  <tbody>
                    {b.byDay.length === 0 && <tr><td colSpan={4} style={{ color: "var(--cb-muted)" }}>No calls in this period.</td></tr>}
                    {b.byDay.map((d) => (
                      <tr key={d.day}>
                        <td className="n">{d.day}</td>
                        <td className="r n">{Math.round(d.minutes).toLocaleString()}</td>
                        <td>
                          <div style={{ height: 8, borderRadius: 4, background: "var(--cb-line-soft)", overflow: "hidden" }}>
                            <i style={{ display: "block", height: "100%", width: `${Math.round((d.minutes / maxDayMin) * 100)}%`, background: "var(--cb-accent)" }} />
                          </div>
                        </td>
                        <td className="r n">{dollars(d.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <div className="cbill-col">
              <section className="cbill-card">
                <div className="cbill-card-hd">
                  <h3>Where the money went</h3>
                  <span className="hint">share of {dollars(b.totalCost)}</span>
                </div>
                <div className="cbill-card-bd">
                  {shares.map((s) => (
                    <div key={s.label} style={{ padding: "9px 0", borderBottom: "1px solid var(--cb-line-soft)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                        <span>{s.label}</span>
                        <span className="n">{dollars(s.cost)} · {s.pct}%</span>
                      </div>
                      <div style={{ height: 8, borderRadius: 4, background: "var(--cb-line-soft)", overflow: "hidden", marginTop: 6 }}>
                        <i style={{ display: "block", height: "100%", width: `${s.pct}%`, background: s.warn ? "var(--cb-warn)" : "var(--cb-accent)" }} />
                      </div>
                    </div>
                  ))}
                  {cnamShare && cnamShare.pct >= 15 && (
                    <div className="hint" style={{ marginTop: 12, padding: "10px 12px", border: "1px solid var(--cb-warn-soft)", background: "var(--cb-warn-soft)", borderRadius: 8, color: "var(--cb-ink)" }}>
                      Caller-name lookups are {cnamShare.pct}% of this customer's cost. Each inbound call with a name is one lookup — this is the carrier's own count.
                    </div>
                  )}
                </div>
              </section>
            </div>
          </div>

          <section className="cbill-card">
            <div className="cbill-card-hd"><h3>Every line</h3><FeedNote b={b} /></div>
            <CostTable b={b} revenueCents={res.data?.revenueCents} marginCents={res.data?.marginCents} marginPct={res.data?.marginPct} />
            <TierLegend />
          </section>
        </>
      )}
    </div>
  );
}
