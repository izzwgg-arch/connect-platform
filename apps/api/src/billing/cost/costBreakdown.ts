/**
 * The engine behind "What this customer cost us". Pure aggregation: it reads
 * carrier records (the VoIP.ms feed), our own call log and chat table, and the
 * rates in force, and returns one breakdown for one tenant and one period.
 *
 * Honesty rules, in code not prose:
 *  - a line priced by the carrier itself is CARRIER_CDR;
 *  - a carrier COUNT × a rate is CARRIER_COUNT (VoIP.ms message rows and
 *    CNAM lookups carry no cost of their own — the daily "CNAM Queries"
 *    transaction proves the per-lookup rate);
 *  - anything the carrier cannot tell us per customer is OUR_COUNT: outbound
 *    over the shared Telocall 0001 trunk (one account for every tenant, no
 *    API) is our minutes × the typed Telocall rate, always;
 *  - when the feed has NOT been pulled for the period, calls/texts/CNAM fall
 *    back to our own tables and say OUR_COUNT, and `feed.complete` is false.
 *
 * Billing increments: VoIP.ms bills in 6-second steps (probed: 49 s → 54 s
 * → $0.0081 at $0.009/min). Telocall's increment is unknown; 6-second steps
 * are assumed there too and the line says so.
 */
import type { CostBreakdown, CostByDay, CostByNumber, CostGroup, CostLine } from "./costTypes";
import { rateOf, type RateRow } from "./carrierRates";
import { VOIPMS_CARRIER, ymd } from "./voipmsFeed";

export type BreakdownDb = {
  carrierUsageRecord: { findMany: (args: any) => Promise<any[]> };
  connectCdr: { findMany: (args: any) => Promise<any[]> };
  connectChatMessage: { findMany: (args: any) => Promise<any[]> };
};

export const SHARED_OUTBOUND_TRUNK_LABEL = "Shared trunk 0001 · Telocall";

/** Seconds → billable minutes in 6-second steps. */
export function billableMinutes6s(seconds: number): number {
  if (!(seconds > 0)) return 0;
  return Math.ceil(seconds / 6) * 6 / 60;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
function r4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function humanNumber(e164: string | null): string {
  if (!e164) return "Unattributed";
  const d = e164.replace(/\D/g, "");
  return d.length === 11 ? `${d.slice(1, 4)}-${d.slice(4, 7)}-${d.slice(7)}` : e164;
}

export async function buildCostBreakdown(
  db: BreakdownDb,
  input: { tenantId: string; periodStart: Date; periodEnd: Date; rates: Map<string, RateRow>; now?: Date },
): Promise<CostBreakdown> {
  const { tenantId, periodStart, periodEnd, rates } = input;
  const now = input.now ?? new Date();
  const periodClosed = periodEnd.getTime() <= now.getTime();

  // ── carrier records for this tenant ─────────────────────────────────────
  const feedRows: any[] = await db.carrierUsageRecord.findMany({
    where: { tenantId, occurredAt: { gte: periodStart, lt: periodEnd } },
    select: { kind: true, occurredAt: true, numberE164: true, quantity: true, cost: true, description: true, carrier: true },
  });
  // ── feed coverage: which days of the period were pulled at all (any tenant) ──
  // One tiny indexed probe per day (take: 1) — a month of VoIP.ms records is
  // tens of thousands of rows and must never be loaded just to learn coverage.
  const periodDays: string[] = [];
  for (let d = new Date(periodStart); d < periodEnd && d <= now; d = new Date(d.getTime() + 86_400_000)) periodDays.push(ymd(d));
  const coveredDays = new Set<string>();
  for (const day of periodDays) {
    const dayStart = new Date(`${day}T00:00:00.000Z`);
    const hit: any[] = await db.carrierUsageRecord.findMany({
      where: { carrier: VOIPMS_CARRIER, occurredAt: { gte: dayStart, lt: new Date(dayStart.getTime() + 86_400_000) } },
      select: { id: true },
      take: 1,
    });
    if (hit.length) coveredDays.add(day);
  }
  const covered = periodDays.filter((d) => coveredDays.has(d));
  const feed = {
    carrier: "VoIP.ms",
    coveredFrom: covered.length ? covered[0] : null,
    coveredTo: covered.length ? covered[covered.length - 1] : null,
    // A closed period is complete when every day was pulled; a running one when every day so far was.
    complete: periodDays.length > 0 && covered.length === periodDays.length,
  };
  const haveFeed = covered.length > 0;
  const uncoveredDays = periodDays.filter((d) => !coveredDays.has(d));
  const isCovered = (day: string) => coveredDays.has(day);

  // ── our own records ──────────────────────────────────────────────────────
  const ourCalls: any[] = await db.connectCdr.findMany({
    where: { tenantId, startedAt: { gte: periodStart, lt: periodEnd }, disposition: "answered", direction: { in: ["incoming", "outgoing"] } },
    select: { direction: true, talkSec: true, startedAt: true, fromName: true, toNumber: true, fromNumber: true },
  });

  const telocallRate = rateOf(rates, "telocall.outbound_min");
  const cnamRate = rateOf(rates, "voipms.cnam_lookup");
  const smsRate = rateOf(rates, "voipms.sms");
  const mmsRate = rateOf(rates, "voipms.mms");

  // ── aggregate the feed ───────────────────────────────────────────────────
  const agg = {
    inSec: 0, inCalls: 0, inCost: 0, inCarrierPriced: true,
    outSec: 0, outCalls: 0, outCost: 0,
    smsIn: 0, smsOut: 0, mmsIn: 0, mmsOut: 0,
    cnam: 0,
    didFees: 0, didCost: 0, e911Fees: 0, e911Cost: 0,
    other: [] as Array<{ label: string; cost: number; day: string; numberE164: string | null }>,
  };
  const byNum = new Map<string | null, CostByNumber>();
  const numRow = (n: string | null): CostByNumber => {
    if (!byNum.has(n)) {
      byNum.set(n, { numberE164: n, label: humanNumber(n), inboundMin: 0, inboundCost: 0, outboundMin: 0, outboundCost: 0, messages: 0, messageCost: 0, cnamLookups: 0, cnamCost: 0, monthlyFees: 0, cost: 0 });
    }
    return byNum.get(n)!;
  };
  const byDay = new Map<string, CostByDay>();
  const dayRow = (d: string): CostByDay => {
    if (!byDay.has(d)) byDay.set(d, { day: d, minutes: 0, cost: 0 });
    return byDay.get(d)!;
  };

  for (const r of feedRows) {
    const q = Number(r.quantity) || 0;
    const c = r.cost === null || r.cost === undefined ? null : Number(r.cost);
    const day = ymd(new Date(r.occurredAt));
    switch (r.kind) {
      case "CALL_IN": {
        agg.inSec += q;
        if (q > 0) agg.inCalls += 1;
        if (c === null) agg.inCarrierPriced = false;
        agg.inCost += c ?? 0;
        const n = numRow(r.numberE164);
        n.inboundMin += q / 60;
        n.inboundCost += c ?? 0;
        const dd = dayRow(day);
        dd.minutes += q / 60;
        dd.cost += c ?? 0;
        break;
      }
      case "CALL_OUT": {
        // outbound that fell to the VoIP.ms backup trunk — carrier-priced
        agg.outSec += q;
        if (q > 0) agg.outCalls += 1;
        agg.outCost += c ?? 0;
        const n = numRow(r.numberE164);
        n.outboundMin += q / 60;
        n.outboundCost += c ?? 0;
        const dd = dayRow(day);
        dd.minutes += q / 60;
        dd.cost += c ?? 0;
        break;
      }
      case "SMS_IN": agg.smsIn += q; numRow(r.numberE164).messages += q; numRow(r.numberE164).messageCost += q * smsRate; break;
      case "SMS_OUT": agg.smsOut += q; numRow(r.numberE164).messages += q; numRow(r.numberE164).messageCost += q * smsRate; break;
      case "MMS_IN": agg.mmsIn += q; numRow(r.numberE164).messages += q; numRow(r.numberE164).messageCost += q * mmsRate; break;
      case "MMS_OUT": agg.mmsOut += q; numRow(r.numberE164).messages += q; numRow(r.numberE164).messageCost += q * mmsRate; break;
      case "CNAM_LOOKUP": {
        agg.cnam += q;
        const n = numRow(r.numberE164);
        n.cnamLookups += q;
        n.cnamCost += q * cnamRate;
        break;
      }
      case "DID_MONTHLY": agg.didFees += 1; agg.didCost += c ?? 0; numRow(r.numberE164).monthlyFees += c ?? 0; break;
      case "E911_MONTHLY": agg.e911Fees += 1; agg.e911Cost += c ?? 0; numRow(r.numberE164).monthlyFees += c ?? 0; break;
      case "CNAM_DAILY": break; // account-wide reconciliation row, never a tenant's
      case "OTHER": agg.other.push({ label: String(r.description || "Other carrier charge"), cost: c ?? 0, day, numberE164: r.numberE164 ?? null }); break;
      default: break;
    }
  }

  // ── our outbound (Telocall) and the fallbacks ────────────────────────────
  let ourOutSec = 0;
  let ourOutCalls = 0;
  let ourOutBillableMin = 0;
  let ourInSec = 0;
  let ourInCalls = 0;
  let ourInBillableMin = 0;
  let ourCnam = 0;
  for (const c of ourCalls) {
    const sec = Number(c.talkSec) || 0;
    const day = ymd(new Date(c.startedAt));
    if (c.direction === "outgoing") {
      ourOutSec += sec;
      ourOutCalls += 1;
      const bm = billableMinutes6s(sec);
      ourOutBillableMin += bm;
      const dd = dayRow(day);
      dd.minutes += sec / 60;
      dd.cost += bm * telocallRate;
    } else if (!isCovered(day)) {
      // A day the carrier feed has not been pulled for: our own log stands in.
      ourInSec += sec;
      ourInCalls += 1;
      ourInBillableMin += billableMinutes6s(sec);
      const name = String(c.fromName || "").trim();
      if (name && !/^[\d+\s()-]*$/.test(name)) ourCnam += 1;
      const dd = dayRow(day);
      dd.minutes += sec / 60;
      dd.cost += billableMinutes6s(sec) * rateOf(rates, "voipms.inbound_min");
    }
  }
  // Calls that fell to the backup trunk are in BOTH logs; take them out of the Telocall pool.
  const backupBillableMin = billableMinutes6s(agg.outSec);
  const telocallMin = Math.max(0, ourOutBillableMin - backupBillableMin);
  const telocallCost = telocallMin * telocallRate;
  {
    const t = numRow("__telocall__");
    t.label = SHARED_OUTBOUND_TRUNK_LABEL;
    t.numberE164 = null;
    t.outboundMin += ourOutSec / 60;
    t.outboundCost += telocallCost;
  }

  let ourSmsIn = 0;
  let ourSmsOut = 0;
  let ourMms = 0;
  if (uncoveredDays.length > 0) {
    const msgs: any[] = await db.connectChatMessage.findMany({
      where: { tenantId, createdAt: { gte: periodStart, lt: periodEnd }, thread: { type: "SMS" } },
      select: { direction: true, type: true, createdAt: true, attachments: { select: { id: true }, take: 1 } },
    });
    for (const m of msgs) {
      if (isCovered(ymd(new Date(m.createdAt)))) continue;
      const isMms = (Array.isArray(m.attachments) && m.attachments.length > 0) || (m.type && m.type !== "TEXT");
      if (isMms) ourMms += 1;
      else if (m.direction === "INBOUND") ourSmsIn += 1;
      else ourSmsOut += 1;
    }
  }

  // ── lines ────────────────────────────────────────────────────────────────
  const inboundRate = rateOf(rates, "voipms.inbound_min");
  const inSec = agg.inSec + ourInSec;
  const inCalls = agg.inCalls + ourInCalls;
  const feedInCost = agg.inCarrierPriced ? agg.inCost : billableMinutes6s(agg.inSec) * inboundRate;
  const inCost = feedInCost + ourInBillableMin * inboundRate;
  // All days from the carrier → carrier tier; any day from our own log → say so.
  const allCovered = uncoveredDays.length === 0 && periodDays.length > 0;
  const coverageNote = allCovered
    ? "every day from the carrier's own records"
    : haveFeed
      ? `${covered.length} of ${periodDays.length} days from the carrier's records, ${uncoveredDays.length} from our own log`
      : "the carrier feed has not been pulled for these days — our own log";

  const calls: CostLine[] = [
    {
      key: "inbound",
      label: "Inbound talk time",
      note: `${inCalls.toLocaleString()} answered calls · 6-second steps · ${coverageNote}`,
      quantity: r2(inSec / 60),
      unit: "min",
      rate: allCovered && agg.inCarrierPriced ? null : inboundRate,
      rateKey: "voipms.inbound_min",
      carrier: "VoIP.ms",
      cost: r4(inCost),
      tier: allCovered && agg.inCarrierPriced ? "CARRIER_CDR" : "OUR_COUNT",
    },
    {
      key: "outbound_telocall",
      label: "Outbound talk time, primary route",
      note: `${ourOutCalls.toLocaleString()} answered calls · Telocall has no API — our minutes × the rate in Catalog, 6-second steps assumed`,
      quantity: r2(telocallMin),
      unit: "min",
      rate: telocallRate,
      rateKey: "telocall.outbound_min",
      carrier: "Telocall · shared 0001 trunk",
      cost: r4(telocallCost),
      tier: "OUR_COUNT",
    },
    {
      key: "outbound_backup",
      label: "Outbound over the backup route",
      note: agg.outCalls ? `${agg.outCalls.toLocaleString()} calls fell through to VoIP.ms` : undefined,
      quantity: r2(agg.outSec / 60),
      unit: "min",
      rate: null,
      rateKey: "voipms.outbound_min",
      carrier: "VoIP.ms",
      cost: r4(agg.outCost),
      tier: "CARRIER_CDR",
    },
  ];

  const smsIn = agg.smsIn + ourSmsIn;
  const smsOut = agg.smsOut + ourSmsOut;
  const mmsIn = agg.mmsIn + ourMms;
  const mmsOut = agg.mmsOut;
  const msgTier = allCovered ? "CARRIER_COUNT" : "OUR_COUNT";
  const texting: CostLine[] = [
    { key: "sms_in", label: "Texts received", quantity: smsIn, unit: "msg", rate: smsRate, rateKey: "voipms.sms", carrier: "VoIP.ms", cost: r4(smsIn * smsRate), tier: msgTier },
    { key: "sms_out", label: "Texts sent", quantity: smsOut, unit: "msg", rate: smsRate, rateKey: "voipms.sms", carrier: "VoIP.ms", cost: r4(smsOut * smsRate), tier: msgTier },
    { key: "mms_in", label: "Picture messages received", quantity: mmsIn, unit: "msg", rate: mmsRate, rateKey: "voipms.mms", carrier: "VoIP.ms", cost: r4(mmsIn * mmsRate), tier: msgTier },
    { key: "mms_out", label: "Picture messages sent", quantity: mmsOut, unit: "msg", rate: mmsRate, rateKey: "voipms.mms", carrier: "VoIP.ms", cost: r4(mmsOut * mmsRate), tier: msgTier },
  ];

  const cnam = agg.cnam + ourCnam;
  const callerId: CostLine[] = [
    {
      key: "cnam_lookup",
      label: "Caller-name lookups on inbound calls (CNAM)",
      note: `one lookup per inbound call the carrier logs as 'Doing a CNAM lookup' (its daily 'CNAM Queries' charge is these × the rate) · ${coverageNote}`,
      quantity: cnam,
      unit: "lookup",
      rate: cnamRate,
      rateKey: "voipms.cnam_lookup",
      carrier: "VoIP.ms",
      cost: r4(cnam * cnamRate),
      tier: allCovered ? "CARRIER_COUNT" : "OUR_COUNT",
    },
  ];

  const numbers: CostLine[] = [
    {
      key: "did_monthly",
      label: "Phone numbers, monthly",
      note: agg.didFees ? `${agg.didFees} monthly charge${agg.didFees === 1 ? "" : "s"} in this period` : allCovered ? "no monthly number charge landed in this period" : "monthly charges are only known from the carrier feed — not every day of this period is pulled",
      quantity: agg.didFees,
      unit: "number/mo",
      rate: null,
      rateKey: "voipms.did_monthly",
      carrier: "VoIP.ms",
      cost: r4(agg.didCost),
      tier: "CARRIER_CDR",
    },
    {
      key: "e911_monthly",
      label: "911 address registration, monthly",
      quantity: agg.e911Fees,
      unit: "number/mo",
      rate: null,
      rateKey: "voipms.e911_monthly",
      carrier: "VoIP.ms",
      cost: r4(agg.e911Cost),
      tier: "CARRIER_CDR",
    },
  ];

  const oneTime: CostLine[] = agg.other.map((o, i) => ({
    key: `other_${i}`,
    label: o.label,
    note: `${o.day}${o.numberE164 ? ` · ${humanNumber(o.numberE164)}` : ""}`,
    quantity: 1,
    unit: "charge",
    rate: null,
    carrier: "VoIP.ms",
    cost: r4(o.cost),
    tier: "CARRIER_CDR",
  }));

  const mk = (key: CostGroup["key"], label: string, lines: CostLine[]): CostGroup => ({
    key,
    label,
    lines,
    cost: r4(lines.reduce((s, l) => s + l.cost, 0)),
  });
  const groups: CostGroup[] = [
    mk("calls", "Calls", calls),
    mk("texting", "Texting", texting),
    mk("caller_id", "Caller ID", callerId),
    mk("numbers", "Numbers & 911", numbers),
    mk("one_time", "One-time / other carrier charges", oneTime),
  ];
  const totalCost = r4(groups.reduce((s, g) => s + g.cost, 0));

  for (const n of byNum.values()) {
    n.inboundMin = r2(n.inboundMin);
    n.outboundMin = r2(n.outboundMin);
    n.inboundCost = r4(n.inboundCost);
    n.outboundCost = r4(n.outboundCost);
    n.messageCost = r4(n.messageCost);
    n.cnamCost = r4(n.cnamCost);
    n.monthlyFees = r4(n.monthlyFees);
    n.cost = r4(n.inboundCost + n.outboundCost + n.messageCost + n.cnamCost + n.monthlyFees);
  }
  const byNumber = [...byNum.values()].sort((a, b) => b.cost - a.cost);
  const byDayList = [...byDay.values()]
    .map((d) => ({ day: d.day, minutes: r2(d.minutes), cost: r4(d.cost) }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));

  const messagesIn = smsIn + mmsIn;
  const messagesOut = smsOut + mmsOut;
  return {
    tenantId,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    periodClosed,
    tiles: {
      inboundMinutes: r2(inSec / 60),
      inboundCalls: inCalls,
      inboundCost: r4(inCost),
      outboundMinutes: r2(ourOutSec / 60),
      outboundCalls: ourOutCalls,
      outboundCost: r4(telocallCost + agg.outCost),
      messagesIn,
      messagesOut,
      mms: mmsIn + mmsOut,
      messageCost: groups[1].cost,
      cnamLookups: cnam,
      cnamShare: inCalls > 0 ? Math.round((cnam / inCalls) * 100) / 100 : 0,
      cnamCost: groups[2].cost,
    },
    groups,
    totalCost,
    byNumber,
    byDay: byDayList,
    feed,
  };
}
