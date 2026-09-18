import assert from "node:assert/strict";
import test, { mock } from "node:test";

// The feed module imports the real db + credential helpers at module scope;
// the parsers and the sync take everything they need as arguments.
mock.module("@connect/db", { namedExports: { db: {} } });
mock.module("../../voipMsAccounts", {
  namedExports: { loadVoipMsAccountCreds: async () => null, VOIPMS_PRIMARY_ACCOUNT_ID: "default" },
});

let feedP: Promise<typeof import("./voipmsFeed")> | null = null;
const load = () => (feedP ??= import("./voipmsFeed"));

// Real rows, as the live account answered on 2026-09-17 (names/other numbers changed).
const CDR_IN = {
  date: "2026-09-17 23:56:59",
  callerid: '"SOME CALLER" <8455550101>',
  destination: "8452449666",
  description: "Inbound DID",
  account: "344022",
  disposition: "ANSWERED",
  duration: "00:00:49",
  seconds: "49",
  rate: "0.00900000",
  total: "0.00810000",
  uniqueid: "4836113777",
  useragent: "",
  ip: "",
  destination_type: "IN:USA",
  call_logs: "Call logs for UniqueID: 4836113777\nDoing a CNAM lookup\nRouting to sub-account: 344022_gesheft\nStatus is 'Answered'",
};
const CDR_OUT = {
  date: "2026-09-17 16:35:36",
  callerid: '"Create A Box" <8457826722>',
  destination: "972527621115",
  description: "Israel - Mob",
  account: "344022_cabnew",
  disposition: "NO ANSWER",
  duration: "00:00:00",
  seconds: "0",
  rate: "0.11333300",
  total: "0.00000000",
  uniqueid: "4835717420",
  destination_type: "OUT:INTL",
  call_logs: "Call logs for UniqueID: 4835717420\nLog file is empty",
};

test("CDR inbound row → the call priced by the carrier + a CNAM lookup record, tenant sub-account kept, name dropped", async () => {
  const feed = await load();
  const recs = feed.parseVoipmsCdrRow(CDR_IN, "default");
  assert.equal(recs.length, 2);
  const [call, cnam] = recs;
  assert.equal(call.kind, "CALL_IN");
  assert.equal(call.externalId, "4836113777");
  assert.equal(call.numberE164, "+18452449666");
  assert.equal(call.quantity, 49);
  assert.equal(call.cost, 0.0081);
  assert.equal(call.subAccount, "344022_gesheft");
  assert.equal(call.occurredAt.toISOString(), "2026-09-17T23:56:59.000Z");
  assert.equal(cnam.kind, "CNAM_LOOKUP");
  assert.equal(cnam.externalId, "4836113777");
  assert.equal(cnam.quantity, 1);
  assert.equal(cnam.cost, null, "the CDR carries no CNAM cost — the breakdown prices it at the rate");
  assert.ok(!JSON.stringify(call.raw).includes("SOME CALLER"), "the caller's name must never be stored");
});

test("CDR outbound row → CALL_OUT keyed on the caller-ID number, sub-account from `account`, no CNAM record", async () => {
  const feed = await load();
  const recs = feed.parseVoipmsCdrRow(CDR_OUT, "default");
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, "CALL_OUT");
  assert.equal(recs[0].numberE164, "+18457826722");
  assert.equal(recs[0].subAccount, "344022_cabnew");
  assert.equal(recs[0].cost, 0);
});

test("SMS / MMS rows → direction from `type`, body never kept", async () => {
  const feed = await load();
  const sms = feed.parseVoipmsMessageRow({ id: "111562829", date: "2026-09-17 22:34:45", type: "1", did: "8457231213", contact: "8455577768", message: "secret body" }, "default", false)!;
  assert.equal(sms.kind, "SMS_IN");
  assert.equal(sms.externalId, "sms:111562829");
  assert.equal(sms.numberE164, "+18457231213");
  assert.ok(!JSON.stringify(sms).includes("secret body"));
  const out = feed.parseVoipmsMessageRow({ id: "1", date: "2026-09-17 10:00:00", type: "0", did: "8457231213", contact: "5622096644", message: "x" }, "default", false)!;
  assert.equal(out.kind, "SMS_OUT");
  const mms = feed.parseVoipmsMessageRow({ id: "10331397", date: "2026-09-17 17:59:41", type: "1", did: "8452449666", contact: "8453253091", message: "x", media: ["https://…"] }, "default", true)!;
  assert.equal(mms.kind, "MMS_IN");
  assert.equal(mms.externalId, "mms:10331397");
});

test("transactions → DID monthly, E911 monthly, the daily CNAM aggregate, sign flipped to a cost", async () => {
  const feed = await load();
  const did = feed.parseVoipmsTransactionRow({ date: "2026-09-17 01:05:04", uniqueid: "62144618xe0c36dd1", type: "DID8452136776", description: "Frais mensuel de DID: 8452136776", ammount: "-1.10" }, "default")!;
  assert.equal(did.kind, "DID_MONTHLY");
  assert.equal(did.numberE164, "+18452136776");
  assert.equal(did.cost, 1.1);
  assert.equal(did.externalId, "tx:62144618xe0c36dd1");
  const e911 = feed.parseVoipmsTransactionRow({ date: "2026-09-17 01:05:04", uniqueid: "62144619x9a0ca622", type: "E911 8452136776", description: "Frais de r&eacute;cup&eacute;ration e911: 8452136776", ammount: "-1.50" }, "default")!;
  assert.equal(e911.kind, "E911_MONTHLY");
  assert.equal(e911.cost, 1.5);
  assert.ok(!e911.description!.includes("&eacute;"));
  const cnam = feed.parseVoipmsTransactionRow({ date: "2026-09-17 to 2026-09-17", uniqueid: "n/a", type: "CNAM Queries", description: "CNAM Queries", ammount: "-4.1520" }, "default")!;
  assert.equal(cnam.kind, "CNAM_DAILY");
  assert.equal(cnam.numberE164, null);
  assert.equal(cnam.cost, 4.152);
  assert.equal(cnam.externalId, "tx:cnam_daily:2026-09-17:CNAM Queries");
  assert.equal(cnam.occurredAt.toISOString(), "2026-09-17T00:00:00.000Z");
  assert.equal(did.description, "Number monthly fee");
  assert.equal(e911.description, "911 registration monthly fee");
  const setup = feed.parseVoipmsTransactionRow({ date: "2026-08-19 00:05:18", uniqueid: "6001x1", type: "E911SETUP-8452449666", description: "Frais de r&eacute;cup&eacute;ration e911: SETUP-8452449666", ammount: "-1.50" }, "default")!;
  assert.equal(setup.kind, "E911_MONTHLY", "the E911SETUP row recurs monthly too");
  assert.equal(setup.numberE164, "+18452449666");
  assert.equal(setup.description, "911 registration fee");
  const paypal = feed.parseVoipmsTransactionRow({ date: "2026-08-19 00:05:18", uniqueid: "6001x2", type: "PAYPAL", description: "Paiement Paypal", ammount: "100.00" }, "default");
  assert.equal(paypal, null, "an account top-up is nobody's cost");
});

test("the daily CNAM charge reconciles with the per-call lookups at $0.008", async () => {
  const feed = await load();
  // 519 CDR rows carried "Doing a CNAM lookup" on 2026-09-17; the transaction was −4.1520.
  assert.equal(Math.round(519 * 0.008 * 10000) / 10000, 4.152);
});

function fakeDb() {
  const inserted: any[] = [];
  const cursors = new Map<string, any>();
  return {
    inserted,
    cursors,
    tenantSmsNumber: { findMany: async () => [{ phoneE164: "+18452449666", tenantId: "t-gesheft" }] },
    pbxTenantInboundDid: { findMany: async () => [{ e164: "+18457826722", connectTenantId: "t-cab", active: true, lastSeenAt: new Date() }] },
    carrierUsageRecord: {
      createMany: async (args: any) => {
        let n = 0;
        for (const r of args.data) {
          const key = `${r.carrier}|${r.kind}|${r.externalId}`;
          if (inserted.some((x) => `${x.carrier}|${x.kind}|${x.externalId}` === key)) continue;
          inserted.push(r);
          n += 1;
        }
        return { count: n };
      },
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    carrierSyncCursor: {
      findUnique: async (a: any) => cursors.get(a.where.id) ?? null,
      upsert: async (a: any) => {
        const cur = cursors.get(a.where.id);
        cursors.set(a.where.id, cur ? { ...cur, ...a.update } : { ...a.create });
        return cursors.get(a.where.id);
      },
    },
  };
}

test("sync pulls one day, resolves tenants by number, is idempotent on a re-pull, and moves the cursor", async () => {
  const feed = await load();
  const db = fakeDb();
  const calls: string[] = [];
  const api: any = async (method: string, params: Record<string, string>) => {
    calls.push(`${method}:${params.date_from || params.from}`);
    if (method === "getCDR") return { status: "success", cdr: [CDR_IN, CDR_OUT] };
    if (method === "getSMS") return { status: "success", sms: [{ id: "1", date: "2026-09-17 10:00:00", type: "1", did: "8452449666", contact: "8455550102", message: "hi" }] };
    if (method === "getMMS") return { status: "no_sms" };
    if (method === "getTransactionHistory") return { status: "success", transactions: [{ date: "2026-09-17 to 2026-09-17", uniqueid: "n/a", type: "CNAM Queries", description: "CNAM Queries", ammount: "-4.1520" }] };
    return { status: "success" };
  };
  const from = new Date("2026-09-17T12:00:00Z");
  const res = await feed.runVoipmsCostSync(db as any, api, { from, to: from });
  assert.equal(res.error, null);
  assert.equal(res.days.length, 1);
  assert.deepEqual(res.days[0], { day: "2026-09-17", calls: 2, cnam: 1, messages: 1, fees: 1, inserted: 5 });
  const byKind = Object.fromEntries(db.inserted.map((r) => [`${r.kind}:${r.externalId}`, r.tenantId]));
  assert.equal(byKind["CALL_IN:4836113777"], "t-gesheft");
  assert.equal(byKind["CNAM_LOOKUP:4836113777"], "t-gesheft");
  assert.equal(byKind["CALL_OUT:4835717420"], "t-cab", "outbound resolves by the caller-ID number through the PBX-synced DID");
  assert.equal(byKind["SMS_IN:sms:1"], "t-gesheft");
  assert.equal(byKind["CNAM_DAILY:tx:cnam_daily:2026-09-17:CNAM Queries"], null);
  assert.equal(db.cursors.get("voipms:default").lastDate.toISOString(), "2026-09-17T00:00:00.000Z");
  assert.ok(calls.every((c) => c.endsWith(":2026-09-17")), calls.join(","));

  const again = await feed.runVoipmsCostSync(db as any, api, { from, to: from });
  assert.equal(again.days[0].inserted, 0, "a re-pull inserts nothing");
  assert.equal(db.inserted.length, 5);
});

test("a failing day stops the sync, records the error on the cursor and keeps the last good day", async () => {
  const feed = await load();
  const db = fakeDb();
  const api: any = async (method: string, params: Record<string, string>) => {
    const day = params.date_from || params.from;
    if (day === "2026-09-18") return { status: "invalid_credentials" };
    if (method === "getCDR") return { status: "no_cdr" };
    return { status: "success" };
  };
  const res = await feed.runVoipmsCostSync(db as any, api, { from: new Date("2026-09-17T00:00:00Z"), to: new Date("2026-09-19T00:00:00Z") });
  assert.equal(res.days.length, 1);
  assert.match(res.error!, /2026-09-18: getCDR invalid_credentials/);
  const cur = db.cursors.get("voipms:default");
  assert.equal(cur.lastDate.toISOString(), "2026-09-17T00:00:00.000Z");
  assert.match(cur.lastError, /invalid_credentials/);
});

test("toE164 accepts 10 and 11 digits and refuses anything else", async () => {
  const feed = await load();
  assert.equal(feed.toE164("8452449666"), "+18452449666");
  assert.equal(feed.toE164("18452449666"), "+18452449666");
  assert.equal(feed.toE164("972527621115"), null);
  assert.equal(feed.toE164(""), null);
});
