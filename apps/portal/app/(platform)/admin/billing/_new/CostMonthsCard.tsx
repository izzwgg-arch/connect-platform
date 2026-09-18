"use client";

/* Customer page: what they cost us, month by month (office-only). One row per
   cycle invoice; the running period shows what has accrued so far. */

import Link from "next/link";
import { Pill, longDate, money, useApi } from "./ui";
import { dollars } from "./CostCard";

type MonthRow = {
  invoice: { id: string; invoiceNumber: string; status: string; totalCents: number; periodStart: string; periodEnd: string; paidAt?: string | null };
  state: "closed" | "running" | "future";
  feedComplete: boolean;
  tiles?: { inboundMinutes: number; outboundMinutes: number; cnamLookups: number; cnamCost: number };
  revenueCents: number;
  costCents: number;
  marginCents: number;
  marginPct: number | null;
};

export function CostMonthsCard({ tenantId }: { tenantId: string }) {
  const res = useApi<{ months: MonthRow[] }>(tenantId ? `/admin/billing/cost/tenants/${tenantId}/months?limit=6` : null);
  if (res.error && /forbidden|403/i.test(res.error)) return null;
  const months = res.data?.months || [];
  const closed = months.filter((m) => m.state === "closed");
  const paid = closed.reduce((s, m) => s + m.revenueCents, 0);
  const cost = closed.reduce((s, m) => s + m.costCents, 0);
  const cnam = closed.reduce((s, m) => s + (m.tiles?.cnamCost || 0), 0);
  const cnamPct = cost > 0 ? Math.round((cnam / (cost / 100)) * 100) : 0;
  const tile: React.CSSProperties = { flex: "1 1 0", minWidth: 0, padding: "12px 14px", border: "1px solid var(--cb-line-soft)", borderRadius: 9 };
  const k: React.CSSProperties = { fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--cb-muted)", fontWeight: 660 };
  const v: React.CSSProperties = { fontSize: 22, fontWeight: 660, letterSpacing: "-.03em", marginTop: 4, fontFamily: "ui-monospace, monospace" };
  const s: React.CSSProperties = { fontSize: 11.5, color: "var(--cb-muted)", marginTop: 3 };

  return (
    <section className="cbill-card">
      <div className="cbill-card-hd">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3>What they cost us, month by month</h3>
          <Pill tone="warn">Office only</Pill>
        </div>
        <span className="hint">bar = cost as a share of what they paid</span>
      </div>
      {res.loading && <div className="cbill-card-bd"><p className="cbill-sub">Adding up the carrier records…</p></div>}
      {res.error && !res.loading && <div className="cbill-card-bd"><p className="cbill-sub" style={{ color: "var(--cb-crit)" }}>{res.error}</p></div>}
      {!res.loading && !res.error && months.length === 0 && <div className="cbill-card-bd"><p className="cbill-sub">No cycle invoices yet.</p></div>}
      {months.length > 0 && (
        <>
          {closed.length > 0 && (
            <div style={{ display: "flex", gap: 10, padding: "14px 15px 4px" }}>
              <div style={tile}><div style={k}>Last {closed.length} closed month{closed.length === 1 ? "" : "s"}</div><div style={v}>{money(paid)}</div><div style={s}>paid to us</div></div>
              <div style={tile}><div style={k}>Cost us</div><div style={v}>{money(cost)}</div><div style={s}>{paid > 0 ? `${Math.round((cost / paid) * 100)}% of revenue` : ""}</div></div>
              <div style={{ ...tile, borderColor: paid - cost >= 0 ? "var(--cb-good)" : "var(--cb-crit)" }}><div style={{ ...k, color: "var(--cb-good)" }}>Margin</div><div style={{ ...v, color: "var(--cb-good)" }}>{money(paid - cost)}</div><div style={s}>across those months</div></div>
              {cnamPct >= 15 && (
                <div style={{ ...tile, borderColor: "var(--cb-warn)" }}><div style={{ ...k, color: "var(--cb-warn)" }}>Watch</div><div style={v}>CNAM</div><div style={s}>{dollars(cnam)} on caller-name lookups — {cnamPct}% of their cost</div></div>
              )}
            </div>
          )}
          <div className="cbill-table-wrap" style={{ marginTop: 8 }}>
            <table className="cbill-table">
              <thead>
                <tr>
                  <th>Service period</th>
                  <th className="r">They paid</th>
                  <th className="r">Cost us</th>
                  <th className="r">Margin</th>
                  <th style={{ width: 200 }}>Cost share</th>
                  <th>Period</th>
                </tr>
              </thead>
              <tbody>
                {months.map((m) => {
                  const share = m.revenueCents > 0 ? Math.min(100, Math.round((m.costCents / m.revenueCents) * 100)) : 0;
                  return (
                    <tr key={m.invoice.id}>
                      <td>
                        {longDate(m.invoice.periodStart)} – {longDate(m.invoice.periodEnd)}
                        <div style={{ fontSize: 10.5 }}><Link href={`/admin/billing/invoice/${m.invoice.id}`}>{m.invoice.invoiceNumber}</Link></div>
                      </td>
                      <td className="r n">{money(m.revenueCents)}</td>
                      <td className="r n">{m.state === "future" ? "—" : money(m.costCents)}{m.state === "running" && <div style={{ fontSize: 10.5, color: "var(--cb-muted)" }}>so far</div>}</td>
                      <td className="r n" style={{ color: m.state === "closed" ? (m.marginCents >= 0 ? "var(--cb-good)" : "var(--cb-crit)") : "var(--cb-muted)" }}>
                        {m.state === "closed" ? `${money(m.marginCents)}${m.marginPct === null ? "" : ` · ${m.marginPct}%`}` : "—"}
                      </td>
                      <td>
                        <div style={{ height: 8, borderRadius: 4, background: "var(--cb-line-soft)", overflow: "hidden" }}>
                          <i style={{ display: "block", height: "100%", width: `${share}%`, background: m.state === "closed" ? "var(--cb-accent)" : "var(--cb-muted)" }} />
                        </div>
                      </td>
                      <td>
                        {m.state === "closed" ? <Pill tone={m.feedComplete ? "ok" : "warn"}>{m.feedComplete ? "Closed" : "Closed · feed incomplete"}</Pill> : m.state === "running" ? <Pill tone="info">Running</Pill> : <Pill tone="off">Not started</Pill>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
