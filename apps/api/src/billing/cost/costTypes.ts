/**
 * Customer cost breakdown — the office-only "what this customer cost us" card
 * (Izzy, 2026-09-18). Shared shapes for the feed, the engine and the routes.
 *
 * ⛔ Nothing in this module may ever reach a customer-facing surface: not the
 * invoice PDF, not the billing emails, not the tenant /billing pages. Every
 * route is gated by requirePlatformBilling (SUPER_ADMIN).
 */

/** What a carrier record is for. Stored as a string on CarrierUsageRecord.kind. */
export type UsageKind =
  | "CALL_IN"
  | "CALL_OUT"
  | "SMS_IN"
  | "SMS_OUT"
  | "MMS_IN"
  | "MMS_OUT"
  | "CNAM_LOOKUP"
  | "DID_MONTHLY"
  | "E911_MONTHLY"
  | "CNAM_DAILY"
  | "OTHER";

/**
 * How honest a line is — shown on every row as the "How we know" pill.
 *  CARRIER_CDR    the carrier's own per-record cost
 *  CARRIER_COUNT  the carrier's own count × a rate (the record carries no cost)
 *  OUR_COUNT      our own log × a rate (no carrier feed covers it)
 *  ESTIMATED      metered by us, priced at a vendor list rate
 */
export type CostTier = "CARRIER_CDR" | "CARRIER_COUNT" | "OUR_COUNT" | "ESTIMATED";

export type CostLine = {
  key: string;
  label: string;
  note?: string;
  quantity: number;
  unit: string;
  /** Dollars per unit, null when the carrier priced each record itself. */
  rate: number | null;
  rateKey?: string;
  carrier: string;
  /** Dollars. */
  cost: number;
  tier: CostTier;
};

export type CostGroup = {
  key: "calls" | "texting" | "caller_id" | "numbers" | "one_time";
  label: string;
  lines: CostLine[];
  cost: number;
};

export type CostByNumber = {
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
};

export type CostByDay = { day: string; minutes: number; cost: number };

export type CostBreakdown = {
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  /** True once the period end is in the past. */
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
  byNumber: CostByNumber[];
  byDay: CostByDay[];
  /** Which days of the period the VoIP.ms feed has actually been pulled for. */
  feed: { carrier: string; coveredFrom: string | null; coveredTo: string | null; complete: boolean };
};
