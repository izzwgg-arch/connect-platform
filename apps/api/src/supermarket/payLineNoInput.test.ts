/**
 * NO INPUT IS NOT A WRONG ANSWER (2026-09-18).
 *
 * Every prompt on the pay line says "followed by the pound key", but a
 * fixed-length gather (the 10-digit phone number, a 1-digit menu) closes the
 * PBX's Read() on its last digit. The pound the caller then keys arrives a
 * second or two later — on the NEXT prompt — and is that Read()'s terminator:
 * it returns EMPTY at once. Until today the reducer scored that empty answer
 * as a wrong PIN, so a caller who did exactly what the prompt said heard
 * "that PIN is not correct" before keying anything. Proven on 3 of the last 4
 * real calls (PBX log, call C-00000024: `User entered '8457826775'` → 02_pin
 * → `DTMF end '#'` → `User entered nothing.` → 03_pin_wrong).
 *
 * The rule now: an empty answer replays the prompt it was asked at, counts
 * only against its own cap (three in a row → a person), and never touches
 * pinAttempts / lookupAttempts / amountAttempts / choiceAttempts.
 *
 * The dialplan also re-asks an early empty answer locally (see
 * connect-supermarket-pay.conf, `stray`) — guarded in payIvrDialplan.test.ts —
 * so most stray pounds never reach the api at all. This file proves the api
 * side alone is safe even when they do.
 *
 * Run: node --experimental-test-module-mocks --import tsx --test src/supermarket/payLineNoInput.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.CREDENTIALS_MASTER_KEY = process.env.CREDENTIALS_MASTER_KEY || "ab".repeat(32);
process.env.CDR_INGEST_SECRET = process.env.CDR_INGEST_SECRET || "noinput-internal-secret-000111222333";

import { FakeDb, FakePos, makeSupermarketDb } from "./supermarketTestKit";
import {
  PAY_MAX_NO_INPUT_ATTEMPTS,
  PAY_MAX_PIN_ATTEMPTS,
  initialPayIvrState,
  normalizePayIvrState,
  reducePayIvr,
  type PayIvrPhase,
  type PayIvrState,
} from "./payIvrCore";
import { runPayIvrStep } from "./payIvrRuntime";
import { storeIntegrationKey, posClientForTenant } from "./integrationCredentials";

async function seedPosTenant(db: FakeDb, tenantId: string, pos: FakePos) {
  db.seed("tenant", { id: tenantId, name: `Store ${tenantId}`, crmMode: "supermarket" });
  db.seed("user", { id: `admin-${tenantId}`, tenantId, email: `admin-${tenantId}@x.com`, role: "SUPER_ADMIN" });
  await storeIntegrationKey(db, { tenantId, provider: "POS_TRACKING", apiKey: pos.apiKey, actorUserId: `admin-${tenantId}` });
}

function clientForFactory(posByTenant: Map<string, FakePos>) {
  return async (db: any, tenantId: string, deps: any = {}) => {
    const pos = posByTenant.get(tenantId);
    if (!pos) return null;
    return posClientForTenant(db, tenantId, { ...deps, fetchImpl: pos.fetchImpl });
  };
}

async function setup(tenantId: string) {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  await seedPosTenant(db, tenantId, pos);
  // Izzy's cell (no POS PIN, no card) and the 3064 line (PIN 3064, one Visa)
  pos.addCustomer({ id: "1001021", phone10: "5622096644", pin: null, balanceCents: 0, cards: [] });
  pos.addCustomer({ id: "3762", phone10: "8457823064", pin: "3064", balanceCents: 63092, cards: [{ id: "395", masked: "************9603" }] });
  db.seed("posCustomer", { tenantId, posCustomerId: "1001021", name: "IZZY WEIN", phonesText: "5622096644", primaryPhone: "5622096644" });
  db.seed("posCustomer", { tenantId, posCustomerId: "3762", name: "JACOB WEINSTOCK", phonesText: "8457823064", primaryPhone: "8457823064" });
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  return { db, pos, deps: { db, clientFor: clientFor as any } };
}

// ═════════════════════════════════════════════════════════════════════════════
test("NOINPUT 1 — the real 2026-09-18 06:49 ET call, replayed: 2 → 10 digits → (stray pound = empty) → hears ONLY 02_pin, no wrong-PIN attempt; the PIN then serves", async () => {
  const tenantId = "t-noinput-real";
  const { deps, db } = await setup(tenantId);
  const callId = "1789728565.62";
  const step = (digits?: string) => runPayIvrStep(deps as any, { tenantId, callId, callerNumber: "5622096644", digits });

  let out = await step();
  assert.deepEqual(out.prompts, ["01_welcome", "37_which_account"]);
  out = await step("2");
  assert.deepEqual(out.prompts, ["38_enter_phone"]);
  assert.equal(out.gather?.maxDigits, 10, "the phone gather closes on the 10th digit — that is what makes the pound land late");
  out = await step("8457823064");
  assert.deepEqual(out.prompts, ["02_pin"]);

  // The pound keyed after the 10th digit hits the PIN prompt's Read() and it returns empty.
  out = await step("");
  assert.deepEqual(out.prompts, ["02_pin"], "an empty answer must replay the PIN prompt, not say it was wrong");
  assert.ok(!out.prompts.includes("03_pin_wrong"));
  assert.equal(out.gather?.what, "pin");
  let row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
  assert.equal(row.state.pinAttempts, 0, "a stray pound must not spend a PIN attempt");
  assert.equal(row.state.noInputAttempts, 1);

  // Then the PIN as keyed on the real call.
  out = await step("3064");
  assert.deepEqual(out.prompts, ["22_main_menu"]);
  row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
  assert.equal(row.state.pinVerified, true);
  assert.equal(row.state.noInputAttempts, 0, "a keyed answer resets the silence count");
  assert.equal(row.state.pinAttempts, 0, "pinAttempts counts WRONG PINs only — the stray pound spent none");
});

// ═════════════════════════════════════════════════════════════════════════════
test("NOINPUT 2 — three silences in a row at the PIN prompt end at a person WITHOUT 'too many tries' and without a single PIN attempt spent; a wrong PIN still costs one", async () => {
  const tenantId = "t-noinput-cap";
  const { deps, db } = await setup(tenantId);
  const callId = "cap-1";
  const step = (digits?: string) => runPayIvrStep(deps as any, { tenantId, callId, callerNumber: "8457823064", digits });

  await step();
  let out = await step("1");
  assert.deepEqual(out.prompts, ["02_pin"]);
  for (let i = 1; i < PAY_MAX_NO_INPUT_ATTEMPTS; i++) {
    out = await step("");
    assert.deepEqual(out.prompts, ["02_pin"], `silence #${i} replays the prompt`);
    assert.equal(out.transfer, false);
  }
  out = await step("");
  assert.deepEqual(out.prompts, ["20_connect_person"], "the third silence hands over, with no 'too many tries' (nothing was tried)");
  assert.equal(out.transfer, true);
  const row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
  assert.equal(row.state.pinAttempts, 0);
  assert.equal(row.state.noInputAttempts, PAY_MAX_NO_INPUT_ATTEMPTS);

  // Control: wrong PINs still count as before (unchanged behaviour).
  const callId2 = "cap-2";
  const step2 = (digits?: string) => runPayIvrStep(deps as any, { tenantId, callId: callId2, callerNumber: "8457823064", digits });
  await step2();
  await step2("1");
  let last: any = null;
  for (let i = 0; i < PAY_MAX_PIN_ATTEMPTS; i++) last = await step2("9999");
  assert.deepEqual(last.prompts, ["15_too_many_tries", "20_connect_person"]);
});

// ═════════════════════════════════════════════════════════════════════════════
test("NOINPUT 3 — a silence interleaved with real answers never changes the outcome: (silence, wrong, silence, wrong, silence, right) still serves — silences and wrong answers are counted apart", async () => {
  const tenantId = "t-noinput-mix";
  const { deps, db } = await setup(tenantId);
  const callId = "mix-1";
  const step = (digits?: string) => runPayIvrStep(deps as any, { tenantId, callId, callerNumber: "8457823064", digits });
  await step();
  await step("1");
  let out = await step("");
  assert.deepEqual(out.prompts, ["02_pin"]);
  out = await step("1111");
  assert.deepEqual(out.prompts, ["03_pin_wrong", "02_pin"]);
  out = await step("");
  assert.deepEqual(out.prompts, ["02_pin"]);
  out = await step("2222");
  assert.deepEqual(out.prompts, ["03_pin_wrong", "02_pin"]);
  out = await step("");
  assert.deepEqual(out.prompts, ["02_pin"]);
  out = await step("3064");
  assert.deepEqual(out.prompts, ["22_main_menu"], "two wrong PINs plus three separate silences is still under both caps");
  const row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
  assert.equal(row.state.pinAttempts, 2, "exactly the two wrong PINs — none of the three silences");
  assert.equal(row.state.pinVerified, true);
});

// ═════════════════════════════════════════════════════════════════════════════
test("NOINPUT 4 — at EVERY gathering phase an empty answer replays exactly that phase's own prompt, with no 'wrong' prefix and no phase-specific attempt spent (pure reducer)", () => {
  const base = initialPayIvrState();
  const cases: Array<{ state: Partial<PayIvrState> & { phase: PayIvrPhase }; prompts: string[]; untouched: (keyof PayIvrState)[] }> = [
    { state: { phase: "choose_account", callerAccountId: "3762" }, prompts: ["37_which_account"], untouched: ["choiceAttempts"] },
    { state: { phase: "lookup_entry" }, prompts: ["38_enter_phone"], untouched: ["lookupAttempts"] },
    { state: { phase: "pin_entry", posCustomerId: "3762", accountPinState: "set" }, prompts: ["02_pin"], untouched: ["pinAttempts"] },
    { state: { phase: "main_menu", posCustomerId: "3762", pinVerified: true, activePin: "3064" }, prompts: ["22_main_menu"], untouched: [] },
    { state: { phase: "after_balance_menu", posCustomerId: "3762", pinVerified: true, activePin: "3064" }, prompts: ["21_menu_after_balance"], untouched: [] },
    { state: { phase: "amount_entry", posCustomerId: "3762", pinVerified: true, activePin: "3064" }, prompts: ["05_amount_prompt"], untouched: ["amountAttempts"] },
    { state: { phase: "confirm", posCustomerId: "3762", pinVerified: true, activePin: "3064", pendingCents: 100 }, prompts: ["07_confirm_choice"], untouched: ["confirmRounds"] },
    {
      state: { phase: "card_choice", posCustomerId: "3762", pinVerified: true, activePin: "3064", pendingCents: 100, cards: [{ id: "395", last4: "9603" }] },
      prompts: ["48_to_use_card_ending", "num_9", "num_6", "num_0", "num_3", "49_press", "num_1", "50_new_card_press_9"],
      untouched: ["cardChoiceAttempts"],
    },
    { state: { phase: "card_save_choice", posCustomerId: "3762", pinVerified: true, activePin: "3064", pendingCents: 100, cardLast4: "1111" }, prompts: ["46_card_save_choice"], untouched: [] },
  ];
  for (const c of cases) {
    const state: PayIvrState = { ...base, ...c.state };
    const out = reducePayIvr(state, { type: "digits", value: "" });
    const phase = c.state.phase;
    assert.deepEqual(out.prompts, c.prompts, `${phase}: wrong replay`);
    assert.equal(out.state.phase, phase, `${phase}: the phase must not move`);
    assert.equal(out.state.noInputAttempts, 1, `${phase}: the silence must be counted`);
    assert.equal(out.effects.length, 0, `${phase}: a silence must never reach the register`);
    for (const k of c.untouched) assert.equal(out.state[k], state[k], `${phase}: ${String(k)} was spent by a silence`);
    // whitespace-only is the same as empty (the dialplan never sends it, but the schema allows it)
    const ws = reducePayIvr(state, { type: "digits", value: "  " });
    assert.deepEqual(ws.prompts, c.prompts);
    // the cap: the Nth consecutive silence ends at a person, from any of these phases
    const nearCap: PayIvrState = { ...state, noInputAttempts: PAY_MAX_NO_INPUT_ATTEMPTS - 1 };
    const capped = reducePayIvr(nearCap, { type: "digits", value: "" });
    assert.deepEqual(capped.prompts, ["20_connect_person"], `${phase}: the cap did not hand over`);
    assert.equal(capped.state.phase, "human");
    assert.ok(capped.effects.some((e) => e.kind === "transfer_to_person"));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
test("NOINPUT 5 — phases that are NOT waiting for keyed digits keep their own handling of an empty step: a probe in flight ignores it, the card collector re-runs, a person stays a person, done stays done", () => {
  const base = initialPayIvrState();
  // probe in flight: digits (empty or not) are ignored, nothing is counted
  const probing: PayIvrState = { ...base, phase: "pin_entry", posCustomerId: "3762", pinProbe: true, activePin: "0" };
  const p = reducePayIvr(probing, { type: "digits", value: "" });
  assert.deepEqual(p.prompts, []);
  assert.equal(p.state.noInputAttempts, 0);
  // the dialplan came back from the AGI early / the door was never reached: the collector runs again (bounded), as before
  const entering: PayIvrState = { ...base, phase: "card_entry", posCustomerId: "3762", pinVerified: true, activePin: "3064", pendingCents: 100 };
  const e = reducePayIvr(entering, { type: "digits", value: "" });
  assert.equal(e.gather?.what, "card");
  assert.equal(e.state.cardEntryAttempts, 1);
  // the AGI's outcome word rides the post-collector step (the dialplan posts PAY_CARD): in card_save_choice it just replays the question
  const saving: PayIvrState = { ...base, phase: "card_save_choice", posCustomerId: "3762", pinVerified: true, activePin: "3064", pendingCents: 100, cardLast4: "1111" };
  const s = reducePayIvr(saving, { type: "digits", value: "ok" });
  assert.deepEqual(s.prompts, ["46_card_save_choice"]);
  assert.equal(s.state.noInputAttempts, 0, "the collector's outcome word is not a silence");
  // a person / done never re-enter a gather
  const human = reducePayIvr({ ...base, phase: "human" }, { type: "digits", value: "" });
  assert.ok(human.effects.some((x) => x.kind === "transfer_to_person"));
  const done = reducePayIvr({ ...base, phase: "done" }, { type: "digits", value: "" });
  assert.deepEqual(done, { state: { ...base, phase: "done" }, prompts: [], gather: null, effects: [] });
  // card_choice with no cards listed is the reducer's own branch (pre-existing: a bad key
  // replays "to enter a new card, press nine", bounded by cardChoiceAttempts) — untouched
  const noCards: PayIvrState = { ...base, phase: "card_choice", cards: [], pendingCents: 100 };
  const nc = reducePayIvr(noCards, { type: "digits", value: "" });
  assert.deepEqual(nc.prompts, ["50_new_card_press_9"]);
  assert.equal(nc.state.noInputAttempts, 0);
  assert.equal(nc.state.cardChoiceAttempts, 1);
});

// ═════════════════════════════════════════════════════════════════════════════
test("NOINPUT 6 — session rows persisted before this field existed normalise to zero silences and behave exactly like fresh ones", () => {
  const legacy: any = { ...initialPayIvrState(), phase: "pin_entry", posCustomerId: "3762", accountPinState: "set" };
  delete legacy.noInputAttempts;
  const state = normalizePayIvrState(legacy);
  assert.equal(state.noInputAttempts, 0);
  const out = reducePayIvr(state, { type: "digits", value: "" });
  assert.deepEqual(out.prompts, ["02_pin"]);
  assert.equal(out.state.noInputAttempts, 1);
  // garbage never becomes a negative or fractional count
  assert.equal(normalizePayIvrState({ ...legacy, noInputAttempts: "3" }).noInputAttempts, 0);
  assert.equal(normalizePayIvrState({ ...legacy, noInputAttempts: 2.5 }).noInputAttempts, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
test("NOINPUT 7 — stress: 400 callers × a random sprinkle of silences (never 3 in a row) between every real answer all reach the main menu; 400 more with 3 in a row somewhere all reach a person; no PIN/lookup/amount attempt is ever charged for a silence", async () => {
  const tenantId = "t-noinput-stress";
  const db = makeSupermarketDb();
  const pos = new FakePos();
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any };
  const N = 400;
  for (let i = 0; i < N; i++) {
    const phone = `900${String(i).padStart(7, "0")}`;
    pos.addCustomer({ id: `st-${i}`, phone10: phone, pin: String(1000 + i), balanceCents: 1000, cards: [] });
    db.seed("posCustomer", { tenantId, posCustomerId: `st-${i}`, name: `S${i}`, phonesText: phone, primaryPhone: phone });
  }
  let seed = 20260918;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const silences = () => (rnd() < 0.5 ? 0 : rnd() < 0.6 ? 1 : 2); // 0, 1 or 2 — never 3 in a row

  let served = 0;
  for (let i = 0; i < N; i++) {
    const phone = `900${String(i).padStart(7, "0")}`;
    const own = rnd() < 0.5;
    const callId = `st-call-${i}`;
    const step = (digits?: string) => runPayIvrStep(deps as any, { tenantId, callId, callerNumber: own ? phone : `955${String(i).padStart(7, "0")}`, digits });
    const quiet = async () => {
      for (let k = silences(); k > 0; k--) {
        const o = await step("");
        assert.equal(o.transfer, false, `call ${i}: a silence under the cap handed over`);
      }
    };
    let out = await step();
    if (own) {
      await quiet();
      out = await step("1");
    } else {
      assert.deepEqual(out.prompts, ["01_welcome", "13_not_recognized"]);
      await quiet();
      out = await step(phone);
    }
    assert.deepEqual(out.prompts, ["02_pin"], `call ${i}: expected the PIN prompt`);
    await quiet();
    out = await step(String(1000 + i));
    assert.deepEqual(out.prompts, ["22_main_menu"], `call ${i}: the PIN did not serve after silences`);
    const row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
    assert.equal(row.state.pinAttempts, 0, `call ${i}: a silence was charged as a wrong PIN`);
    assert.equal(row.state.lookupAttempts, 0);
    assert.equal(row.state.choiceAttempts, 0);
    served++;
  }
  assert.equal(served, N);

  let handed = 0;
  for (let i = 0; i < N; i++) {
    const phone = `900${String(i).padStart(7, "0")}`;
    const callId = `st-cap-${i}`;
    const step = (digits?: string) => runPayIvrStep(deps as any, { tenantId, callId, callerNumber: phone, digits });
    await step();
    const where = i % 2; // silence out at the choice, or at the PIN
    if (where === 1) await step("1");
    let out: any = null;
    for (let k = 0; k < PAY_MAX_NO_INPUT_ATTEMPTS; k++) out = await step("");
    assert.equal(out.transfer, true, `call ${i}: three silences did not hand over`);
    assert.deepEqual(out.prompts, ["20_connect_person"]);
    const row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
    assert.equal(row.state.pinAttempts, 0);
    assert.equal(row.state.choiceAttempts, 0);
    handed++;
  }
  assert.equal(handed, N);
  console.log(`[NOINPUT 7] served=${served} handedOver=${handed}`);
});
