/**
 * The rates the cost card multiplies by. Defaults below are what we know as of
 * 2026-09-18; a typed row in CarrierRate (Catalog → "What the carriers charge
 * us") overrides its default from its effectiveFrom onward. Versioned by
 * insertion — a closed period keeps costing at the rate that was in force.
 *
 * Provenance of the defaults:
 *  - VoIP.ms inbound $0.009/min, CNAM $0.008/lookup, DID $1.10/mo, E911
 *    $1.50/mo: read off the live account on 2026-09-17 (getCDR `rate`, the
 *    "CNAM Queries" daily transaction = lookups × 0.008 exactly, the
 *    "Frais mensuel de DID" / "e911" transactions).
 *  - Telocall $0.006/min: Izzy, 2026-09-18 ("talocall 00.06").
 *  - VoIP.ms SMS/MMS: list price; the carrier's message records carry no cost.
 */
import type { CostTier } from "./costTypes";

export type RateDef = {
  key: string;
  carrier: string;
  label: string;
  unit: string;
  rate: number;
  /** The tier a line priced with this rate gets when the record carries no cost. */
  tier: CostTier;
  group: "calls" | "texting" | "caller_id" | "numbers";
};

export const DEFAULT_RATES: RateDef[] = [
  { key: "voipms.inbound_min", carrier: "VoIP.ms", label: "Inbound to a per-minute number", unit: "min", rate: 0.009, tier: "CARRIER_CDR", group: "calls" },
  { key: "voipms.outbound_min", carrier: "VoIP.ms", label: "Outbound over the backup route", unit: "min", rate: 0.01, tier: "CARRIER_CDR", group: "calls" },
  { key: "telocall.outbound_min", carrier: "Telocall", label: "Outbound, primary (shared 0001 trunk)", unit: "min", rate: 0.006, tier: "OUR_COUNT", group: "calls" },
  { key: "telnyx.inbound_min", carrier: "Telnyx", label: "Inbound to a Telnyx number", unit: "min", rate: 0.0035, tier: "CARRIER_CDR", group: "calls" },
  { key: "voipms.sms", carrier: "VoIP.ms", label: "Text sent or received", unit: "msg", rate: 0.0075, tier: "CARRIER_COUNT", group: "texting" },
  { key: "voipms.mms", carrier: "VoIP.ms", label: "Picture message sent or received", unit: "msg", rate: 0.02, tier: "CARRIER_COUNT", group: "texting" },
  { key: "telnyx.sms_out", carrier: "Telnyx", label: "Text sent", unit: "msg", rate: 0.004, tier: "CARRIER_CDR", group: "texting" },
  { key: "voipms.cnam_lookup", carrier: "VoIP.ms", label: "Caller-name lookup (CNAM)", unit: "lookup", rate: 0.008, tier: "CARRIER_COUNT", group: "caller_id" },
  { key: "voipms.did_monthly", carrier: "VoIP.ms", label: "Phone number, per-minute plan", unit: "number/mo", rate: 1.1, tier: "CARRIER_CDR", group: "numbers" },
  { key: "voipms.e911_monthly", carrier: "VoIP.ms", label: "911 address registration", unit: "number/mo", rate: 1.5, tier: "CARRIER_CDR", group: "numbers" },
  { key: "telnyx.did_monthly", carrier: "Telnyx", label: "Phone number", unit: "number/mo", rate: 1.0, tier: "CARRIER_CDR", group: "numbers" },
  { key: "telnyx.e911_monthly", carrier: "Telnyx", label: "911 address registration", unit: "number/mo", rate: 1.0, tier: "CARRIER_CDR", group: "numbers" },
  { key: "telnyx.tendlc_monthly", carrier: "Telnyx", label: "Texting registration campaign (10DLC)", unit: "campaign/mo", rate: 1.5, tier: "CARRIER_CDR", group: "numbers" },
];

export type RateRow = {
  key: string;
  carrier: string;
  label: string;
  unit: string;
  rate: number;
  effectiveFrom: Date | null;
  source: "DEFAULT" | "TYPED" | "FEED";
  note: string | null;
  group: RateDef["group"];
  tier: CostTier;
};

type RateDb = {
  carrierRate: {
    findMany: (args: any) => Promise<any[]>;
    create: (args: any) => Promise<any>;
  };
};

/**
 * Rates in force at `asOf`: every default, overridden by the newest typed row
 * whose effectiveFrom <= asOf. Unknown keys from the DB are kept too so a rate
 * added later still shows on the Catalog screen.
 */
export async function loadRates(db: RateDb, asOf: Date = new Date()): Promise<Map<string, RateRow>> {
  const out = new Map<string, RateRow>();
  for (const d of DEFAULT_RATES) {
    out.set(d.key, { ...d, effectiveFrom: null, source: "DEFAULT", note: null });
  }
  const rows = await db.carrierRate.findMany({
    where: { effectiveFrom: { lte: asOf } },
    orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }],
  });
  for (const r of rows) {
    const base = out.get(r.key);
    out.set(r.key, {
      key: r.key,
      carrier: r.carrier || base?.carrier || "",
      label: r.label || base?.label || r.key,
      unit: r.unit || base?.unit || "",
      rate: Number(r.rate),
      effectiveFrom: r.effectiveFrom ? new Date(r.effectiveFrom) : null,
      source: r.source === "FEED" ? "FEED" : "TYPED",
      note: r.note ?? null,
      group: base?.group || "calls",
      tier: base?.tier || "OUR_COUNT",
    });
  }
  return out;
}

export function rateOf(rates: Map<string, RateRow>, key: string): number {
  const r = rates.get(key);
  if (!r) throw new Error(`unknown carrier rate: ${key}`);
  return r.rate;
}

/** A typed rate: a new versioned row. Validated here so the route stays thin. */
export async function saveTypedRate(
  db: RateDb,
  input: { key: string; rate: number; effectiveFrom?: Date; note?: string | null; userId?: string | null },
): Promise<RateRow> {
  const def = DEFAULT_RATES.find((d) => d.key === input.key);
  if (!def) throw new Error("unknown_rate_key");
  if (!Number.isFinite(input.rate) || input.rate < 0 || input.rate > 1000) throw new Error("invalid_rate");
  const effectiveFrom = input.effectiveFrom ?? new Date();
  const row = await db.carrierRate.create({
    data: {
      key: def.key,
      carrier: def.carrier,
      label: def.label,
      unit: def.unit,
      rate: input.rate,
      effectiveFrom,
      source: "TYPED",
      note: input.note ?? null,
      createdById: input.userId ?? null,
    },
  });
  return { ...def, rate: Number(row.rate), effectiveFrom, source: "TYPED", note: row.note ?? null };
}
