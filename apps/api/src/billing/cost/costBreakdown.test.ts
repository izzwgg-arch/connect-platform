import assert from "node:assert/strict";
import test, { mock } from "node:test";

mock.module("@connect/db", { namedExports: { db: {} } });
mock.module("../../voipMsAccounts", {
  namedExports: { loadVoipMsAccountCreds: async () => null, VOIPMS_PRIMARY_ACCOUNT_ID: "default" },
});

const load = async () => ({ ...(await import("./costBreakdown")), ...(await import("./carrierRates")) });

const P0 = new Date("2026-08-03T00:00:00Z");
const P1 = new Date("2026-09-03T00:00:00Z");
const T = "t-gesheft";

function inPeriod(row: any, field: string, where: any): boolean {
  const w = where?.[field];
  if (!w) return true;
  const v = new Date(row[field]).getTime();
  if (w.gte && v < new Date(w.gte).getTime()) return false;
  if (w.lt && v >= new Date(w.lt).getTime()) return false;
  return true;
}

function fakeDb(o: { feed?: any[]; cdr?: any[]; msgs?: any[]; rateRows?: any[] }) {
  const feed = o.feed ?? [];
  return {
    carrierRate: { findMany: async () => o.rateRows ?? [], create: async () => ({}) },
    carrierUsageRecord: {
      findMany: async (args: any) => {
        const w = args.where || {};
        let rows = feed.filter((r) => inPeriod(r, "occurredAt", w));
        if (w.tenantId !== undefined) rows = rows.filter((r) => r.tenantId === w.tenantId);
        if (w.carrier) rows = rows.filter((r) => r.carrier === w.carrier);
        if (args.take) rows = rows.slice(0, args.take);
        return rows;
      },
    },
    connectCdr: {
      findMany: async (args: any) => (o.cdr ?? []).filter((r) => r.tenantId === args.where.tenantId && inPeriod(r, "startedAt", args.where)),
    },
    connectChatMessage: {
      findMany: async (args: any) => (o.msgs ?? []).filter((r) => r.tenantId === args.where.tenantId && inPeriod(r, "createdAt", args.where)),
    },
  };
}

const rec = (kind: string, day: string, extra: any = {}) => ({
  carrier: "VOIPMS",
  kind,
  tenantId: T,
  occurredAt: new Date(`${day}T12:00:00Z`),
  numberE164: "+18452449666",
  quantity: 1,
  cost: null,
  ...extra,
});

test("6-second billing steps", async () => {
  const { buildCostBreakdown, billableMinutes6s, SHARED_OUTBOUND_TRUNK_LABEL, loadRates } = await load();
  assert.equal(billableMinutes6s(49), 0.9); // 54 s
  assert.equal(billableMinutes6s(60), 1);
  assert.equal(billableMinutes6s(61), 1.1);
  assert.equal(billableMinutes6s(0), 0);
});

test("with the carrier feed on every day: inbound is carrier-priced, CNAM/texts are carrier counts × rate, Telocall is our minutes × rate, fees come from transactions", async () => {
  const { buildCostBreakdown, billableMinutes6s, SHARED_OUTBOUND_TRUNK_LABEL, loadRates } = await load();
  const S = new Date("2026-08-10T00:00:00Z");
  const E = new Date("2026-08-14T00:00:00Z"); // 4 days: 10, 11, 12, 13
  const feed = [
    rec("CALL_IN", "2026-08-10", { quantity: 49, cost: 0.0081 }),
    rec("CALL_IN", "2026-08-10", { quantity: 0, cost: 0 }), // no-answer row: not a call
    rec("CNAM_LOOKUP", "2026-08-10"),
    rec("CNAM_LOOKUP", "2026-08-11"),
    rec("SMS_IN", "2026-08-11"),
    rec("MMS_IN", "2026-08-11"),
    rec("SMS_OUT", "2026-08-12"),
    rec("DID_MONTHLY", "2026-08-12", { cost: 1.1 }),
    rec("E911_MONTHLY", "2026-08-12", { cost: 1.5 }),
    rec("CNAM_DAILY", "2026-08-10", { tenantId: null, numberE164: null, cost: 4.152 }),
    rec("OTHER", "2026-08-13", { cost: 25, description: "Port-in fee: 8452449666" }),
    // a call that fell to the VoIP.ms backup trunk: in BOTH logs
    rec("CALL_OUT", "2026-08-13", { quantity: 120, cost: 0.02 }),
  ];
  const cdr = [
    { tenantId: T, direction: "outgoing", disposition: "answered", talkSec: 120, startedAt: new Date("2026-08-13T10:00:00Z"), fromName: "" },
    { tenantId: T, direction: "outgoing", disposition: "answered", talkSec: 61, startedAt: new Date("2026-08-11T10:00:00Z"), fromName: "" },
    // our own copy of the inbound call — a covered day, so the carrier's row wins and this is NOT double counted
    { tenantId: T, direction: "incoming", disposition: "answered", talkSec: 49, startedAt: new Date("2026-08-10T10:00:00Z"), fromName: "SOME CALLER" },
  ];
  const db = fakeDb({ feed, cdr });
  const rates = await loadRates(db as any, E);
  const b = await buildCostBreakdown(db as any, { tenantId: T, periodStart: S, periodEnd: E, rates, now: new Date("2026-09-18T00:00:00Z") });

  assert.equal(b.periodClosed, true);
  assert.equal(b.feed.complete, true);
  assert.equal(b.feed.coveredFrom, "2026-08-10");
  assert.equal(b.feed.coveredTo, "2026-08-13");

  const line = (g: string, k: string) => b.groups.find((x) => x.key === g)!.lines.find((l) => l.key === k)!;
  const inbound = line("calls", "inbound");
  assert.equal(inbound.tier, "CARRIER_CDR");
  assert.equal(inbound.cost, 0.0081);
  assert.equal(b.tiles.inboundCalls, 1);
  assert.equal(b.tiles.inboundMinutes, 0.82);

  const telocall = line("calls", "outbound_telocall");
  assert.equal(telocall.tier, "OUR_COUNT");
  // ours: 120 s (2.0 min) + 61 s (1.1 min) = 3.1 billable; backup took 2.0 → Telocall 1.1 min × 0.006
  assert.equal(telocall.quantity, 1.1);
  assert.equal(telocall.cost, 0.0066);
  const backup = line("calls", "outbound_backup");
  assert.equal(backup.tier, "CARRIER_CDR");
  assert.equal(backup.cost, 0.02);

  const cnam = line("caller_id", "cnam_lookup");
  assert.equal(cnam.tier, "CARRIER_COUNT");
  assert.equal(cnam.quantity, 2);
  assert.equal(cnam.cost, 0.016);

  assert.equal(line("texting", "sms_in").quantity, 1);
  assert.equal(line("texting", "sms_out").quantity, 1);
  assert.equal(line("texting", "mms_in").quantity, 1);
  assert.equal(line("texting", "sms_in").tier, "CARRIER_COUNT");
  assert.equal(b.groups.find((g) => g.key === "texting")!.cost, 0.035);

  assert.equal(line("numbers", "did_monthly").cost, 1.1);
  assert.equal(line("numbers", "e911_monthly").cost, 1.5);
  const oneTime = b.groups.find((g) => g.key === "one_time")!;
  assert.equal(oneTime.lines.length, 1);
  assert.equal(oneTime.lines[0].cost, 25);

  assert.equal(b.totalCost, 0.0081 + 0.0066 + 0.02 + 0.035 + 0.016 + 2.6 + 25);

  const trunk = b.byNumber.find((n) => n.label === SHARED_OUTBOUND_TRUNK_LABEL)!;
  assert.equal(trunk.outboundMin, 3.02);
  assert.equal(trunk.outboundCost, 0.0066);
  const main = b.byNumber.find((n) => n.numberE164 === "+18452449666")!;
  assert.equal(main.cnamLookups, 2);
  assert.equal(main.monthlyFees, 2.6);
  assert.ok(b.byDay.some((d) => d.day === "2026-08-13" && d.cost > 0));
});

test("a period the feed only partly covers is HYBRID per day: uncovered days come from our own log, the line says the split and drops to OUR_COUNT", async () => {
  const { buildCostBreakdown, loadRates } = await load();
  const S = new Date("2026-08-10T00:00:00Z");
  const E = new Date("2026-08-14T00:00:00Z"); // 10, 11, 12 covered; 13 not
  const feed = [
    rec("CALL_IN", "2026-08-10", { quantity: 60, cost: 0.009 }),
    rec("CNAM_LOOKUP", "2026-08-10"),
    rec("SMS_IN", "2026-08-11"),
    rec("CNAM_DAILY", "2026-08-12", { tenantId: null, numberE164: null, cost: 1 }),
  ];
  const cdr = [
    { tenantId: T, direction: "incoming", disposition: "answered", talkSec: 60, startedAt: new Date("2026-08-10T10:00:00Z"), fromName: "COVERED DAY" }, // ignored: carrier has it
    { tenantId: T, direction: "incoming", disposition: "answered", talkSec: 120, startedAt: new Date("2026-08-13T10:00:00Z"), fromName: "UNCOVERED DAY" },
  ];
  const msgs = [
    { tenantId: T, direction: "INBOUND", type: "TEXT", attachments: [], createdAt: new Date("2026-08-11T09:00:00Z") }, // covered day: carrier count wins
    { tenantId: T, direction: "OUTBOUND", type: "TEXT", attachments: [], createdAt: new Date("2026-08-13T09:00:00Z") },
  ];
  const db = fakeDb({ feed, cdr, msgs });
  const rates = await loadRates(db as any, E);
  const b = await buildCostBreakdown(db as any, { tenantId: T, periodStart: S, periodEnd: E, rates, now: new Date("2026-09-18T00:00:00Z") });
  assert.equal(b.feed.complete, false);
  assert.equal(b.feed.coveredFrom, "2026-08-10");
  assert.equal(b.feed.coveredTo, "2026-08-12");
  const line = (g: string, k: string) => b.groups.find((x) => x.key === g)!.lines.find((l) => l.key === k)!;
  const inbound = line("calls", "inbound");
  assert.equal(inbound.tier, "OUR_COUNT");
  assert.equal(inbound.quantity, 3, "1 min from the carrier + 2 min from our log");
  assert.equal(inbound.cost, 0.027);
  assert.match(inbound.note!, /3 of 4 days from the carrier's records, 1 from our own log/);
  assert.equal(b.tiles.inboundCalls, 2);
  const cnam = line("caller_id", "cnam_lookup");
  assert.equal(cnam.quantity, 2, "1 carrier lookup + 1 named call on the uncovered day");
  assert.equal(cnam.tier, "OUR_COUNT");
  assert.equal(line("texting", "sms_in").quantity, 1);
  assert.equal(line("texting", "sms_out").quantity, 1, "the outbound text on the uncovered day is counted from our table");
  assert.equal(line("texting", "sms_out").tier, "OUR_COUNT");
});

test("without the carrier feed: everything falls back to our own tables and says OUR_COUNT; the feed is reported as absent", async () => {
  const { buildCostBreakdown, billableMinutes6s, SHARED_OUTBOUND_TRUNK_LABEL, loadRates } = await load();
  const cdr = [
    { tenantId: T, direction: "incoming", disposition: "answered", talkSec: 120, startedAt: new Date("2026-08-10T10:00:00Z"), fromName: "WIRELESS CALLER" },
    { tenantId: T, direction: "incoming", disposition: "answered", talkSec: 30, startedAt: new Date("2026-08-10T11:00:00Z"), fromName: "8455550101" },
    { tenantId: T, direction: "outgoing", disposition: "answered", talkSec: 600, startedAt: new Date("2026-08-11T10:00:00Z"), fromName: "" },
  ];
  const msgs = [
    { tenantId: T, direction: "INBOUND", type: "TEXT", attachments: [], createdAt: new Date("2026-08-12T00:00:00Z") },
    { tenantId: T, direction: "INBOUND", type: "TEXT", attachments: [{ id: "a" }], createdAt: new Date("2026-08-12T00:00:00Z") },
    { tenantId: T, direction: "OUTBOUND", type: "TEXT", attachments: [], createdAt: new Date("2026-08-12T00:00:00Z") },
  ];
  const db = fakeDb({ cdr, msgs });
  const rates = await loadRates(db as any, P1);
  const b = await buildCostBreakdown(db as any, { tenantId: T, periodStart: P0, periodEnd: P1, rates });
  assert.equal(b.feed.coveredFrom, null);
  assert.equal(b.feed.complete, false);
  const line = (g: string, k: string) => b.groups.find((x) => x.key === g)!.lines.find((l) => l.key === k)!;
  assert.equal(line("calls", "inbound").tier, "OUR_COUNT");
  assert.equal(line("calls", "inbound").cost, 2.5 * 0.009);
  assert.equal(line("caller_id", "cnam_lookup").tier, "OUR_COUNT");
  assert.equal(line("caller_id", "cnam_lookup").quantity, 1, "a numeric-only caller name is not a CNAM hit");
  assert.equal(line("texting", "sms_in").tier, "OUR_COUNT");
  assert.equal(line("texting", "sms_in").quantity, 1);
  assert.equal(line("texting", "mms_in").quantity, 1);
  assert.equal(line("texting", "sms_out").quantity, 1);
  assert.equal(line("calls", "outbound_telocall").cost, 10 * 0.006);
  assert.equal(line("numbers", "did_monthly").cost, 0);
});

test("a typed Telocall rate overrides the default from its effective date; older periods keep the old rate", async () => {
  const { buildCostBreakdown, billableMinutes6s, SHARED_OUTBOUND_TRUNK_LABEL, loadRates } = await load();
  const rateRows = [{ key: "telocall.outbound_min", carrier: "Telocall", label: "x", unit: "min", rate: "0.0090", effectiveFrom: new Date("2026-09-01T00:00:00Z"), source: "TYPED", note: null }];
  const db = fakeDb({ rateRows });
  const aug = await loadRates({ ...db, carrierRate: { findMany: async (a: any) => rateRows.filter((r) => r.effectiveFrom <= a.where.effectiveFrom.lte), create: async () => ({}) } } as any, new Date("2026-08-31T00:00:00Z"));
  assert.equal(aug.get("telocall.outbound_min")!.rate, 0.006);
  assert.equal(aug.get("telocall.outbound_min")!.source, "DEFAULT");
  const sep = await loadRates({ ...db, carrierRate: { findMany: async (a: any) => rateRows.filter((r) => r.effectiveFrom <= a.where.effectiveFrom.lte), create: async () => ({}) } } as any, new Date("2026-09-30T00:00:00Z"));
  assert.equal(sep.get("telocall.outbound_min")!.rate, 0.009);
  assert.equal(sep.get("telocall.outbound_min")!.source, "TYPED");
});

test("the breakdown never reads a customer-facing module", async () => {
  const { buildCostBreakdown, billableMinutes6s, SHARED_OUTBOUND_TRUNK_LABEL, loadRates } = await load();
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = __dirname;
  for (const f of ["costBreakdown.ts", "costRoutes.ts", "voipmsFeed.ts", "carrierRates.ts", "costSyncBoot.ts"]) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/from\s+"[^"]*(pdf|emailTemplates|publicPay)[^"]*"/i.test(code), `${f} must not import invoice PDFs, emails or the public pay page`);
    assert.ok(!/["'`]getSubAccounts["'`]/.test(code), `${f} must never call getSubAccounts (it returns SIP passwords)`);
  }
});
