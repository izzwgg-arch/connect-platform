"use client";

/* "What this customer cost us" — office-only. Rendered on the invoice page and
   reused by the drill-down. The api behind it is SUPER_ADMIN-gated; anyone
   else gets a 403 and this card renders nothing at all. It never appears on
   the customer's invoice, PDF, email or their own /billing pages. */

import Link from "next/link";
import { useMemo } from "react";
import { Pill, longDate, money, useApi, type PillTone } from "./ui";

export type CostTier = "CARRIER_CDR" | "CARRIER_COUNT" | "OUR_COUNT" | "ESTIMATED";
export type CostLine = {
  key: string;
  label: string;
  note?: string;
  quantity: number;
  unit: string;
  rate: number | null;
  carrier: string;
  cost: number;
  tier: CostTier;
};
export type CostGroup = { key: string; label: string; lines: CostLine[]; cost: number };
export type CostBreakdown = {
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  periodClosed: boolean;
  tiles: {
    inboundMinutes: number;
    inboundCalls: number;
    inboundCost: number;
    outboundMinutes: number;
    outboundCalls: number;
    outboundCost: number;
    messagesIn: number;
    messagesOut: number;
    mms: number;
    messageCost: number;
    cnamLookups: number;
    cnamShare: number;
    cnamCost: number;
  };
  groups: CostGroup[];
  totalCost: number;
  byNumber: Array<{
    numberE164: string | null;
    label: string;
    inboundMin: number;
    inboundCost: number;
    outboundMin: number;
    outboundCost: number;
    messages: number;
    messageCost: number;
    cnamLookups: number;
    cnamCost: number;
    monthlyFees: number;
    cost: number;
  }>;
  byDay: Array<{ day: string; minutes: number; cost: number }>;
  feed: { carrier: string; coveredFrom: string | null; coveredTo: string | null; complete: boolean };
};
export type CostResponse = {
  invoice?: { id: string; invoiceNumber: string; tenantId: string; tenantName?: string | null; status: string; totalCents: number; periodStart: string; periodEnd: string; isCycle?: boolean } | null;
  tenant?: { id: string; name: string } | null;
  breakdown: CostBreakdown;
  revenueCents?: number;
  costCents?: number;
  marginCents?: number;
  marginPct?: number | null;
};

const TIER: Record<CostTier, { tone: PillTone; label: string; help: string }> = {
  CARRIER_CDR: { tone: "ok", label: "Carrier record", help: "the carrier's own per-call or per-charge record, pulled from its API" },
  CARRIER_COUNT: { tone: "ok", label: "Carrier count × rate", help: "the carrier's own count; its record carries no price, so it is multiplied by the rate in Catalog" },
  OUR_COUNT: { tone: "warn", label: "Our count × rate", help: "our own log multiplied by a rate you typed — no carrier feed can tell us this per customer" },
  ESTIMATED: { tone: "warn", label: "Estimated", help: "metered by us, priced at the vendor's list rate" },
};

/** Dollars (fractions of a cent are normal here) → "$1,234.56". */
export function dollars(n: number | null | undefined, digits = 2): string {
  const v = Number(n ?? 0);
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
function rateText(l: CostLine): string {
  if (l.rate === null) return "carrier-priced";
  const digits = l.rate < 0.1 ? 4 : 2;
  return `${dollars(l.rate, digits)} / ${l.unit}`;
}
function qty(l: CostLine): string {
  const n = Number(l.quantity || 0);
  const s = n.toLocaleString(undefined, { maximumFractionDigits: n < 100 ? 1 : 0 });
  return l.unit === "min" ? `${s} min` : s;
}

export function TierPill({ tier }: { tier: CostTier }) {
  const t = TIER[tier] || TIER.ESTIMATED;
  return (
    <span title={t.help}>
      <Pill tone={t.tone}>{t.label}</Pill>
    </span>
  );
}

const tile: React.CSSProperties = { flex: "1 1 0", minWidth: 0, padding: "12px 14px", border: "1px solid var(--cb-line-soft)", borderRadius: 9, background: "var(--cb-surface)" };
const tileK: React.CSSProperties = { fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--cb-muted)", fontWeight: 660 };
const tileV: React.CSSProperties = { fontSize: 22, fontWeight: 660, letterSpacing: "-.03em", marginTop: 4, fontFamily: "ui-monospace, monospace", fontVariantNumeric: "tabular-nums" };
const tileS: React.CSSProperties = { fontSize: 11.5, color: "var(--cb-muted)", marginTop: 3 };

export function CostTiles({ b, revenueCents, marginCents, marginPct }: { b: CostBreakdown; revenueCents?: number; marginCents?: number; marginPct?: number | null }) {
  const t = b.tiles;
  const hasRevenue = typeof revenueCents === "number";
  const share = hasRevenue && revenueCents! > 0 ? Math.min(100, Math.round((b.totalCost * 100) / (revenueCents! / 100))) : 0;
  return (
    <>
      {hasRevenue && (
        <div style={{ display: "flex", gap: 10, padding: "14px 15px 4px" }}>
          <div style={tile}>
            <div style={tileK}>They paid us</div>
            <div style={tileV}>{money(revenueCents)}</div>
            <div style={tileS}>the invoice total</div>
          </div>
          <div style={tile}>
            <div style={tileK}>It cost us</div>
            <div style={tileV}>{dollars(b.totalCost)}</div>
            <div style={tileS}>carriers, this service period</div>
          </div>
          <div style={{ ...tile, borderColor: (marginCents ?? 0) >= 0 ? "var(--cb-good)" : "var(--cb-crit)" }}>
            <div style={{ ...tileK, color: (marginCents ?? 0) >= 0 ? "var(--cb-good)" : "var(--cb-crit)" }}>Margin</div>
            <div style={{ ...tileV, color: (marginCents ?? 0) >= 0 ? "var(--cb-good)" : "var(--cb-crit)" }}>{money(marginCents ?? 0)}</div>
            <div style={tileS}>{marginPct === null || marginPct === undefined ? "no revenue on this invoice" : `${marginPct}% of the invoice`}</div>
            <div style={{ height: 8, borderRadius: 4, background: "var(--cb-line-soft)", overflow: "hidden", marginTop: 8 }}>
              <i style={{ display: "block", height: "100%", width: `${100 - share}%`, background: "var(--cb-good)" }} />
            </div>
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 10, padding: hasRevenue ? "10px 15px 14px" : "14px 15px" }}>
        <div style={tile}>
          <div style={tileK}>Inbound minutes</div>
          <div style={tileV}>{Math.round(t.inboundMinutes).toLocaleString()}</div>
          <div style={tileS}>{t.inboundCalls.toLocaleString()} answered calls · <b>{dollars(t.inboundCost)}</b></div>
        </div>
        <div style={tile}>
          <div style={tileK}>Outbound minutes</div>
          <div style={tileV}>{Math.round(t.outboundMinutes).toLocaleString()}</div>
          <div style={tileS}>{t.outboundCalls.toLocaleString()} answered calls · <b>{dollars(t.outboundCost)}</b></div>
        </div>
        <div style={tile}>
          <div style={tileK}>Texts &amp; pictures</div>
          <div style={tileV}>{(t.messagesIn + t.messagesOut).toLocaleString()}</div>
          <div style={tileS}>{t.messagesIn.toLocaleString()} in · {t.messagesOut.toLocaleString()} out · {t.mms.toLocaleString()} with pictures · <b>{dollars(t.messageCost)}</b></div>
        </div>
        <div style={tile}>
          <div style={tileK}>Caller ID lookups</div>
          <div style={tileV}>{t.cnamLookups.toLocaleString()}</div>
          <div style={tileS}>{Math.round(t.cnamShare * 100)}% of inbound calls named · <b>{dollars(t.cnamCost)}</b></div>
        </div>
      </div>
    </>
  );
}

export function CostTable({ b, revenueCents, marginCents, marginPct }: { b: CostBreakdown; revenueCents?: number; marginCents?: number; marginPct?: number | null }) {
  const hasRevenue = typeof revenueCents === "number";
  return (
    <div className="cbill-table-wrap">
      <table className="cbill-table">
        <thead>
          <tr>
            <th>What we were charged for</th>
            <th className="r">Quantity</th>
            <th className="r">Rate</th>
            <th>Carrier</th>
            <th className="r">Our cost</th>
            <th>How we know</th>
          </tr>
        </thead>
        <tbody>
          {b.groups.map((g) => (
            <GroupRows key={g.key} g={g} />
          ))}
          <tr>
            <td colSpan={4} className="r" style={{ fontWeight: 680, borderTop: "1px solid var(--cb-line)" }}>Total cost to us</td>
            <td className="r n" style={{ fontWeight: 680, borderTop: "1px solid var(--cb-line)" }}>{dollars(b.totalCost)}</td>
            <td style={{ borderTop: "1px solid var(--cb-line)" }} />
          </tr>
          {hasRevenue && (
            <>
              <tr>
                <td colSpan={4} className="r" style={{ fontWeight: 680 }}>Invoice total (what they paid)</td>
                <td className="r n" style={{ fontWeight: 680 }}>{money(revenueCents)}</td>
                <td />
              </tr>
              <tr>
                <td colSpan={4} className="r" style={{ fontWeight: 680, color: (marginCents ?? 0) >= 0 ? "var(--cb-good)" : "var(--cb-crit)" }}>Margin</td>
                <td className="r n" style={{ fontWeight: 680, color: (marginCents ?? 0) >= 0 ? "var(--cb-good)" : "var(--cb-crit)" }}>
                  {money(marginCents ?? 0)}{marginPct === null || marginPct === undefined ? "" : ` · ${marginPct}%`}
                </td>
                <td />
              </tr>
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}

function GroupRows({ g }: { g: CostGroup }) {
  const lines = g.lines.filter((l) => l.quantity > 0 || l.cost !== 0 || g.key === "calls" || g.key === "caller_id");
  if (g.key === "one_time" && lines.length === 0) {
    return (
      <>
        <tr><td colSpan={6} style={{ background: "var(--cb-surface-2)", fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", fontWeight: 680, color: "var(--cb-muted)", padding: "7px 15px" }}>{g.label}</td></tr>
        <tr><td colSpan={4} style={{ color: "var(--cb-muted)" }}>Nothing one-time in this period</td><td className="r n">$0.00</td><td /></tr>
      </>
    );
  }
  return (
    <>
      <tr><td colSpan={6} style={{ background: "var(--cb-surface-2)", fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase", fontWeight: 680, color: "var(--cb-muted)", padding: "7px 15px" }}>{g.label}</td></tr>
      {lines.map((l) => (
        <tr key={l.key}>
          <td>
            {l.label}
            {l.note && <div style={{ fontSize: 10.5, color: "var(--cb-muted)", marginTop: 2 }}>{l.note}</div>}
          </td>
          <td className="r n">{qty(l)}</td>
          <td className="r n" style={{ color: "var(--cb-muted)" }}>{rateText(l)}</td>
          <td>{l.carrier}</td>
          <td className="r n">{dollars(l.cost)}</td>
          <td><TierPill tier={l.tier} /></td>
        </tr>
      ))}
    </>
  );
}

export function FeedNote({ b }: { b: CostBreakdown }) {
  const f = b.feed;
  if (f.complete) return <span className="hint">{f.carrier} records pulled for every day of this period</span>;
  if (!f.coveredFrom) {
    return (
      <span className="hint" style={{ color: "var(--cb-warn)" }}>
        {f.carrier} records have not been pulled for this period yet — calls, texts and lookups below come from our own logs. Pull history from Catalog → Carrier rates.
      </span>
    );
  }
  return (
    <span className="hint" style={{ color: "var(--cb-warn)" }}>
      {f.carrier} records cover {f.coveredFrom} to {f.coveredTo} only — the rest of the period is not in the feed yet
    </span>
  );
}

export function TierLegend() {
  return (
    <div className="hint" style={{ padding: "10px 15px", borderTop: "1px solid var(--cb-line)", display: "flex", gap: 18, flexWrap: "wrap" }}>
      {(Object.keys(TIER) as CostTier[]).map((k) => (
        <span key={k} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <TierPill tier={k} /> {TIER[k].help}
        </span>
      ))}
    </div>
  );
}

/** The card on the invoice page. */
export function CustomerCostCard({ invoiceId, tenantId }: { invoiceId: string; tenantId: string }) {
  const res = useApi<CostResponse>(invoiceId ? `/admin/billing/cost/invoices/${invoiceId}` : null);
  const b = res.data?.breakdown;
  const period = useMemo(() => (b ? `${longDate(b.periodStart)} – ${longDate(b.periodEnd)}` : ""), [b]);
  // A 403 means not platform staff — this card simply does not exist for them.
  if (res.error && /forbidden|403/i.test(res.error)) return null;
  return (
    <section className="cbill-card">
      <div className="cbill-card-hd">
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h3>What this customer cost us</h3>
          <Pill tone="warn">Office only</Pill>
          <span className="hint">never on the customer's invoice, PDF or email</span>
        </div>
        <div className="cbill-toolbar">
          {b && <span className="hint">service {period} · {b.periodClosed ? "period closed" : "period running"}</span>}
          <Link className="cbill-btn" href={`/admin/billing/customer/${tenantId}/cost?invoiceId=${invoiceId}`}>By number &amp; day</Link>
        </div>
      </div>
      {res.loading && <div className="cbill-card-bd"><p className="cbill-sub">Adding up the carrier records…</p></div>}
      {res.error && !res.loading && <div className="cbill-card-bd"><p className="cbill-sub" style={{ color: "var(--cb-crit)" }}>{res.error}</p></div>}
      {b && (
        <>
          <CostTiles b={b} revenueCents={res.data?.revenueCents} marginCents={res.data?.marginCents} marginPct={res.data?.marginPct} />
          <div style={{ padding: "0 15px 10px" }}><FeedNote b={b} /></div>
          <CostTable b={b} revenueCents={res.data?.revenueCents} marginCents={res.data?.marginCents} marginPct={res.data?.marginPct} />
          <TierLegend />
        </>
      )}
    </section>
  );
}
