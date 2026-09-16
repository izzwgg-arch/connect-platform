/**
 * The texting switcher (2026-09-16). Proves: detection is a read of the Telnyx
 * account; only VOIPMS rows with a tenant flip; not-active numbers wait; a flip
 * happens exactly once under concurrency; a chosen messaging profile is never
 * overwritten; an approved registration is kicked so the engine attaches the
 * number; and the two traced facts the design rests on stay true in source.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createFakeDb } from "./fakeDb.testutil";
import { sweepTextingSwitcher, type OwnedTelnyxNumber, type SwitcherDeps } from "./switcher";
import { telnyxNumbersFor } from "./engine";

const T1 = "tenant-relax";
const T2 = "tenant-other";

function setup(opts: { owned?: Record<string, OwnedTelnyxNumber | null>; regStatus?: string | null; findDelayMs?: number; throwFor?: string } = {}) {
  const { db } = createFakeDb() as any;
  const calls = { profileSet: [] as Array<[string, string]>, kicked: [] as string[], audits: [] as any[], finds: 0 };
  const deps: SwitcherDeps = {
    db,
    now: () => new Date("2026-09-18T11:00:00Z"),
    resolveCreds: async () => ({ apiKey: "k" }),
    findOwnedNumber: async (_c, e164) => {
      calls.finds++;
      if (opts.findDelayMs) await new Promise((r) => setTimeout(r, opts.findDelayMs));
      if (opts.throwFor === e164) throw new Error("telnyx 500");
      return opts.owned?.[e164] ?? null;
    },
    resolveMessagingProfileId: async () => "profile-loopcom",
    setMessagingProfile: async (_c, id, p) => {
      calls.profileSet.push([id, p]);
    },
    advanceRegistration: async (id) => {
      calls.kicked.push(id);
    },
    audit: async (event, payload) => {
      calls.audits.push({ event, payload });
    },
  };
  return { db, deps, calls };
}

async function seedNumber(db: any, e164: string, tenantId: string | null, provider = "VOIPMS", active = true) {
  return db.tenantSmsNumber.create({ data: { phoneE164: e164, tenantId, provider, active, smsCapable: true } });
}

async function seedReg(db: any, tenantId: string, status: string) {
  return db.textingRegistration.create({ data: { tenantId, status, publicSlug: `s-${tenantId}`, referenceKey: `r-${tenantId}`, displayName: "Relax Tires", content: {} } });
}

const active = (e164: string, profile: string | null = null): OwnedTelnyxNumber => ({ id: `tx-${e164}`, phoneNumber: e164, status: "active", messagingProfileId: profile });

test("a number still at VoIP.ms is left alone", async () => {
  const { db, deps, calls } = setup();
  await seedNumber(db, "+18457761765", T1);
  const r = await sweepTextingSwitcher(deps);
  assert.equal(r.switched.length, 0);
  assert.equal(r.notOnTelnyx, 1);
  const row = await db.tenantSmsNumber.findFirst({ where: { phoneE164: "+18457761765" } });
  assert.equal(row.provider, "VOIPMS");
  assert.equal(calls.profileSet.length, 0);
});

test("a number on Telnyx but not ACTIVE (port in flight) waits", async () => {
  const { db, deps } = setup({ owned: { "+18457761765": { ...active("+18457761765"), status: "port_pending" } } });
  await seedNumber(db, "+18457761765", T1);
  const r = await sweepTextingSwitcher(deps);
  assert.deepEqual(r.notActive, ["+18457761765"]);
  assert.equal((await db.tenantSmsNumber.findFirst({ where: { phoneE164: "+18457761765" } })).provider, "VOIPMS");
});

test("landed + approved registration: profile set, flipped, recorded, registration kicked, engine now sees it", async () => {
  const { db, deps, calls } = setup({ owned: { "+18457761765": active("+18457761765") } });
  await seedNumber(db, "+18457761765", T1);
  const reg = await seedReg(db, T1, "live");
  const r = await sweepTextingSwitcher(deps);
  assert.deepEqual(r.switched, ["+18457761765"]);
  assert.equal((await db.tenantSmsNumber.findFirst({ where: { phoneE164: "+18457761765" } })).provider, "TELNYX");
  assert.deepEqual(calls.profileSet, [["tx-+18457761765", "profile-loopcom"]]);
  assert.deepEqual(calls.kicked, [reg.id]);
  const ev = await db.textingRegistrationEvent.findMany({ where: { registrationId: reg.id } });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, "number_switched");
  assert.match(ev[0].message, /Attaching it to the approved registration now/);
  assert.doesNotMatch(ev[0].message, /telnyx|voip\.?ms/i, "registration history never names a carrier");
  assert.equal(calls.audits[0].event, "texting_switched");
  // The engine's attach list is exactly what the switcher just produced.
  assert.deepEqual(await telnyxNumbersFor({ db } as any, T1), ["+18457761765"]);
});

test("a messaging profile a person already chose is never overwritten", async () => {
  const { db, deps, calls } = setup({ owned: { "+18457761765": active("+18457761765", "profile-chosen") } });
  await seedNumber(db, "+18457761765", T1);
  await seedReg(db, T1, "assigning");
  await sweepTextingSwitcher(deps);
  assert.equal(calls.profileSet.length, 0);
  assert.equal((await db.tenantSmsNumber.findFirst({ where: { phoneE164: "+18457761765" } })).provider, "TELNYX");
});

test("only VOIPMS rows with a tenant are ever touched", async () => {
  const e = "+18452380478";
  const { db, deps, calls } = setup({ owned: { [e]: active(e), "+18450000001": active("+18450000001"), "+18450000002": active("+18450000002"), "+18450000003": active("+18450000003") } });
  await seedNumber(db, e, T1, "SIGNALWIRE");
  await seedNumber(db, "+18450000001", null, "VOIPMS");
  await seedNumber(db, "+18450000002", T2, "TELNYX");
  await seedNumber(db, "+18450000003", T2, "VOIPMS", false);
  const r = await sweepTextingSwitcher(deps);
  assert.equal(r.checked, 0);
  assert.equal(calls.finds, 0, "no Telnyx read is spent on rows the switcher may not flip");
  assert.equal((await db.tenantSmsNumber.findFirst({ where: { phoneE164: e } })).provider, "SIGNALWIRE");
  assert.equal((await db.tenantSmsNumber.findFirst({ where: { phoneE164: "+18450000001" } })).provider, "VOIPMS");
});

test("two sweeps at the same moment flip once, record once, kick once", async () => {
  const { db, deps, calls } = setup({ owned: { "+18457761765": active("+18457761765") }, findDelayMs: 5 });
  await seedNumber(db, "+18457761765", T1);
  const reg = await seedReg(db, T1, "live");
  const [a, b] = await Promise.all([sweepTextingSwitcher(deps), sweepTextingSwitcher(deps)]);
  assert.equal(a.switched.length + b.switched.length, 1);
  assert.equal((await db.textingRegistrationEvent.findMany({ where: { registrationId: reg.id } })).length, 1);
  assert.equal(calls.kicked.length, 1);
  assert.equal(calls.audits.length, 1);
});

test("a registration that is not approved yet: switched, not kicked, history says texts wait", async () => {
  const { db, deps, calls } = setup({ owned: { "+18457761765": active("+18457761765") } });
  await seedNumber(db, "+18457761765", T1);
  const reg = await seedReg(db, T1, "draft");
  await sweepTextingSwitcher(deps);
  assert.equal(calls.kicked.length, 0);
  const ev = await db.textingRegistrationEvent.findMany({ where: { registrationId: reg.id } });
  assert.match(ev[0].message, /not approved yet/);
});

test("no registration at all still switches (VoIP.ms can no longer send) and is logged", async () => {
  const { db, deps, calls } = setup({ owned: { "+18457761765": active("+18457761765") } });
  await seedNumber(db, "+18457761765", T1);
  const r = await sweepTextingSwitcher(deps);
  assert.deepEqual(r.switched, ["+18457761765"]);
  assert.equal(calls.kicked.length, 0);
  assert.equal(calls.audits[0].payload.registrationId, null);
});

test("one number's Telnyx error never stops the others", async () => {
  const { db, deps } = setup({ owned: { "+18452441708": active("+18452441708") }, throwFor: "+18457761765" });
  await seedNumber(db, "+18457761765", T1);
  await seedNumber(db, "+18452441708", T2);
  const r = await sweepTextingSwitcher(deps);
  assert.equal(r.errors.length, 1);
  assert.deepEqual(r.switched, ["+18452441708"]);
  assert.equal((await db.tenantSmsNumber.findFirst({ where: { phoneE164: "+18457761765" } })).provider, "VOIPMS");
});

test("no Telnyx credentials: nothing is read or flipped", async () => {
  const { db, deps, calls } = setup({ owned: { "+18457761765": active("+18457761765") } });
  deps.resolveCreds = async () => null;
  await seedNumber(db, "+18457761765", T1);
  await sweepTextingSwitcher(deps);
  assert.equal(calls.finds, 0);
  assert.equal((await db.tenantSmsNumber.findFirst({ where: { phoneE164: "+18457761765" } })).provider, "VOIPMS");
});

// ── The traced facts the design rests on, kept true in source ────────────────
const API = process.env.API_GUARD_ROOT || path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(API, rel), "utf8").replace(/\r\n/g, "\n");

test("guard: the VoIP.ms DID sync never writes provider, so it cannot flip a switched number back", () => {
  const src = read("connectChatRoutes.ts");
  const i = src.indexOf("[VOIPMS_SYNC] (${accountTag}) Raw DID count");
  assert.ok(i > 0, "sync block found");
  const block = src.slice(i, src.indexOf("[VOIPMS_SYNC] (${accountTag}) Complete", i));
  assert.match(block, /tenantSmsNumber\.upsert/);
  assert.doesNotMatch(block, /provider\s*:/, "a provider write in the sync would revert every switched number");
});

test("guard: the VoIP.ms inbox poll only selects VOIPMS rows", () => {
  const src = read("../../worker/src/voipMsInboundSyncJob.ts");
  assert.match(src, /smsCapable: true, provider: "VOIPMS" \}/);
});

test("guard: the switcher only ever writes TELNYX, only over VOIPMS", () => {
  const src = read("textingRegistration/switcher.ts");
  const writes = src.match(/tenantSmsNumber\.(update|updateMany|upsert|create)\(/g) || [];
  assert.deepEqual(writes, ["tenantSmsNumber.updateMany("]);
  assert.match(src, /where: \{ id: row\.id, provider: "VOIPMS" \},\s*data: \{ provider: "TELNYX"/);
});
