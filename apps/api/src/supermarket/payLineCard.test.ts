/**
 * payLineCard.test.ts — round 5 (2026-09-17 late night): "choose the card
 * BEFORE charging" layered onto the Gesheft pay line. Confirm's "1" is back
 * to plain accept (no "press 3") and silently lists the cards on file
 * (`list_cards` / `cards_result`); the caller picks one by last four (or
 * presses 9 for a new one) at the card_choice menu; a decline silently
 * re-lists and replays the SAME menu, never re-asking the amount; the AGI
 * card door, the process-memory vault, and card_save_choice (once/save) are
 * unchanged from the 2026-09-17 night build.
 *
 * Drives the REAL modules (reducer, runtime, dialplan view, routes, vault)
 * against the faithful fakes in supermarketTestKit — no mocks of our own code,
 * only FakeDb/FakePos standing in for Postgres/the register. Deterministic
 * PRNG (mulberry32) for the stress section, so a failure's seed reproduces it.
 *
 * Run: node --experimental-test-module-mocks --import tsx --test src/supermarket/payLineCard.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

process.env.CREDENTIALS_MASTER_KEY = process.env.CREDENTIALS_MASTER_KEY || "ab".repeat(32);
process.env.CDR_INGEST_SECRET = process.env.CDR_INGEST_SECRET || "card-door-secret-000111222333444";

import { FakeDb, FakePos, makeSupermarketDb, maskedCard, mulberry32 } from "./supermarketTestKit";
import {
  PAY_MAX_AMOUNT_ATTEMPTS,
  PAY_MAX_CARD_ENTRY_ATTEMPTS,
  PAY_MAX_CHARGES_PER_CALL,
  initialPayIvrState,
  reducePayIvr,
} from "./payIvrCore";
import { runPayIvrStep, runPayIvrCardEntry, validateKeyedCard } from "./payIvrRuntime";
import { payIvrDialplanView } from "./payIvrDialplan";
import { vaultGet, vaultSize, CARD_VAULT_TTL_MS } from "./payCardVault";
import { registerSupermarketRoutes } from "./supermarketRoutes";
import { checkInternalSecret } from "../internalSecret";
import { storeIntegrationKey, posClientForTenant } from "./integrationCredentials";
import { luhnValid } from "./posWithLogic";

// ─── shared builders (same conventions as payLineStress.test.ts) ────────────

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

function goodCard(overrides: Partial<{ number: string; expMonth: number; expYear: number; cvv: string; zipCode: string }> = {}) {
  return { number: "4111111111111111", expMonth: 12, expYear: 30, cvv: "123", zipCode: "10001", ...overrides };
}

/** Scans a value for any 13–19 digit run that Luhn-validates — the rule-5 leak detector. */
function findLuhnDigitRuns(value: unknown): string[] {
  let str: string;
  try {
    str = JSON.stringify(value);
  } catch {
    str = String(value);
  }
  const matches = str.match(/\d{13,19}/g) ?? [];
  return matches.filter((m) => luhnValid(m));
}

/** Drives a call up to the confirm gather with a card on file's account known. */
async function toConfirm(
  deps: { db: any; clientFor: any; log?: any },
  tenantId: string,
  callId: string,
  callerNumber: string,
  pin: string,
  amount = "10*00",
) {
  const step = (digits?: string, hangup?: boolean) => runPayIvrStep(deps as any, { tenantId, callId, callerNumber, digits, hangup });
  let out = await step();
  assert.equal(out.gather?.what, "choice", `${callId}: expected the choice gather`);
  out = await step("1");
  assert.equal(out.gather?.what, "pin", `${callId}: expected the pin gather`);
  out = await step(pin);
  assert.equal(out.gather?.what, "menu", `${callId}: expected the main menu`);
  out = await step("2");
  assert.equal(out.gather?.what, "amount", `${callId}: expected the amount gather`);
  out = await step(amount);
  assert.equal(out.gather?.what, "confirm", `${callId}: expected the confirm gather`);
  return { out, step };
}

// ═══════════════════════ RULE 1 — confirm is back to plain accept ═══════════

test("confirm's prompt is 06_confirm_intro … 07_confirm_choice, with NO third 'press 3' option; pressing 1 silently lists the cards on file (list_cards, no prompts of our own)", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-card-r1";
  pos.addCustomer({ id: "c1", phone10: "8456624417", pin: "4321", balanceCents: 10_000, cards: [{ id: "cdA", masked: maskedCard("1234") }] });
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any };

  const { out, step } = await toConfirm(deps, tenantId, "call-r1", "+18456624417", "4321");
  assert.ok(out.prompts.includes("06_confirm_intro"), "06_confirm_intro missing from the confirm lead");
  assert.equal(out.prompts.at(-1), "07_confirm_choice", "confirm must be back to the plain two-option prompt, no 'press 3'");
  assert.ok(!out.prompts.includes("39_confirm_choice_card"), "the retired three-option confirm prompt must never be named again");

  const next = await step("1");
  // With a card on file, "1" silently lists the cards and lands on the
  // card_choice menu — the menu prompts are real (they name the cards), but
  // nothing plays BEFORE the register answers list_cards.
  assert.equal(next.gather?.what, "menu");
  assert.ok(next.prompts.includes("48_to_use_card_ending"));
});

test("with NO cards on file, confirm's '1' still emits list_cards silently first, then goes straight to keying one (12_no_card, action card)", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-card-r1b";
  pos.addCustomer({ id: "c1", phone10: "8456624417", pin: "4321", balanceCents: 10_000, cards: [] });
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any };

  const { step } = await toConfirm(deps, tenantId, "call-r1b", "+18456624417", "4321");
  const next = await step("1");
  assert.deepEqual(next.prompts, ["12_no_card"]);
  assert.equal(next.gather?.what, "card");

  const view = payIvrDialplanView(next);
  assert.equal(view.action, "card");
  assert.equal(view.maxDigits, 0);
});

test("pressing 9 at the card_choice menu (cards ARE on file) hands off to the AGI with no prompts of our own", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-card-r1c";
  pos.addCustomer({ id: "c1", phone10: "8456624417", pin: "4321", balanceCents: 10_000, cards: [{ id: "cdA", masked: maskedCard("1234") }] });
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any };

  const { step } = await toConfirm(deps, tenantId, "call-r1c", "+18456624417", "4321");
  const menuOut = await step("1");
  assert.equal(menuOut.gather?.what, "menu");

  const next = await step("9");
  assert.equal(next.gather?.what, "card");
  assert.deepEqual(next.prompts, [], "explicitly asking for a new card must play nothing of ours before the AGI");

  const view = payIvrDialplanView(next);
  assert.equal(view.action, "card");
  assert.equal(view.maxDigits, 0);
});

// ═══════════════════════ RULE 2 — the card door + vault ═════════════════════

test("a valid keyed card lands in the vault under the session ROW id and advances to card_save_choice", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-card-r2a";
  pos.addCustomer({ id: "c1", phone10: "8456624417", pin: "4321", balanceCents: 10_000, cards: [] });
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any };
  const callId = "call-r2a";

  const { step } = await toConfirm(deps, tenantId, callId, "+18456624417", "4321");
  await step("1"); // confirm -> silent list_cards -> 0 cards on file -> straight to the collector

  const session = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
  const sessionId = String(session.id);
  const before = vaultSize();

  const doorOut = await runPayIvrCardEntry(deps, { tenantId, callId, callerNumber: "+18456624417", card: goodCard() });
  assert.deepEqual(doorOut, { ok: true });
  assert.equal(Object.keys(doorOut).some((k) => /\d{4,}/.test(String((doorOut as any)[k]))), false, "digits leaked into the door response");
  assert.equal(vaultSize(), before + 1, "exactly one vault entry should have appeared");
  const vaulted = vaultGet(sessionId);
  assert.ok(vaulted, "the card is not in the vault under the session row id");
  assert.equal(vaulted!.number, "4111111111111111");

  const row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
  assert.equal(row.state.phase, "card_save_choice");
  assert.equal(row.state.cardLast4, "1111");

  // clean up so this test does not leave a vault entry for later tests.
  await runPayIvrStep(deps as any, { tenantId, callId, callerNumber: "+18456624417", hangup: true });
  assert.equal(vaultGet(sessionId), null);
});

test("cardFailed:true clears the vault and lands on a person via 45_card_invalid then 20_connect_person", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-card-r2b";
  pos.addCustomer({ id: "c1", phone10: "8456624417", pin: "4321", balanceCents: 10_000, cards: [] });
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any };
  const callId = "call-r2b";

  await toConfirm(deps, tenantId, callId, "+18456624417", "4321");
  await runPayIvrStep(deps as any, { tenantId, callId, callerNumber: "+18456624417", digits: "1" });

  const session = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
  const sessionId = String(session.id);

  // Drive the exact event the door hands the reducer (bypassing the HTTP
  // wrapper here so we can see the prompts it produces on THIS step).
  const out = await runPayIvrStep(deps as any, { tenantId, callId, callerNumber: "+18456624417", cardEntered: { ok: false } });
  assert.deepEqual(out.prompts, ["45_card_invalid", "20_connect_person"]);
  assert.equal(out.transfer, true);
  assert.equal(out.gather, null);
  assert.equal(vaultGet(sessionId), null);

  // And through the actual door with cardFailed:true — same outcome.
  const callId2 = "call-r2b-2";
  await toConfirm(deps, tenantId, callId2, "+18456624417", "4321");
  await runPayIvrStep(deps as any, { tenantId, callId: callId2, callerNumber: "+18456624417", digits: "1" });
  const doorOut = await runPayIvrCardEntry(deps, { tenantId, callId: callId2, callerNumber: "+18456624417", cardFailed: true });
  assert.equal(doorOut.ok, false);
  assert.equal(doorOut.reason, "gave_up");
  const row2 = await db.supermarketPayCall.findFirst({ where: { tenantId, callId: callId2 } });
  assert.equal(row2.state.phase, "human");
  assert.equal(row2.status, "failed");
});

test("an invalid card shape (bad Luhn, month 13, cvv 2 digits) is refused by the door — {ok:false, reason:\"invalid\"} — and the machine never advances", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-card-r2c";
  pos.addCustomer({ id: "c1", phone10: "8456624417", pin: "4321", balanceCents: 10_000, cards: [] });
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any };
  const callId = "call-r2c";

  await toConfirm(deps, tenantId, callId, "+18456624417", "4321");
  await runPayIvrStep(deps as any, { tenantId, callId, callerNumber: "+18456624417", digits: "1" });
  const before = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
  const sessionId = String(before.id);

  const badCards = [
    goodCard({ number: "4111111111111112" }), // fails Luhn
    goodCard({ expMonth: 13 }),
    goodCard({ cvv: "12" }),
  ];
  for (const card of badCards) {
    assert.equal(validateKeyedCard(card), null, `expected ${JSON.stringify(card)} to be rejected`);
    const doorOut = await runPayIvrCardEntry(deps, { tenantId, callId, callerNumber: "+18456624417", card });
    assert.deepEqual(doorOut, { ok: false, reason: "invalid" });
  }
  assert.equal(vaultGet(sessionId), null, "an invalid card must never reach the vault");
  const after = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
  assert.deepEqual(after.state, before.state, "the machine advanced on an invalid card shape");
});

test("empty digits while in card_entry re-enters the collector (action \"card\") once more, then a person at PAY_MAX_CARD_ENTRY_ATTEMPTS", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-card-r2d";
  pos.addCustomer({ id: "c1", phone10: "8456624417", pin: "4321", balanceCents: 10_000, cards: [] });
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any };
  const callId = "call-r2d";
  assert.equal(PAY_MAX_CARD_ENTRY_ATTEMPTS, 2, "this test is written against a cap of 2 — update it if the cap changes");

  const { step } = await toConfirm(deps, tenantId, callId, "+18456624417", "4321");
  let out = await step("1"); // attempt 1 (confirm -> silent list_cards -> 0 cards -> the collector)
  assert.equal(out.gather?.what, "card");
  out = await step(""); // attempt 2 — still the collector
  assert.equal(out.gather?.what, "card");
  assert.equal(out.transfer, false);
  out = await step(""); // attempt 3 — over the cap
  assert.equal(out.transfer, true);
  assert.equal(out.gather, null);
  assert.ok(out.prompts.includes("20_connect_person"));
});

// ═══════════════════════ RULE 3 — charge dispatch (once / save) ═════════════

test("card_save_choice \"1\" charges once with an inline card body and NO cardId, and the vault is empty after", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-card-r3a";
  pos.addCustomer({ id: "c1", phone10: "8456624417", pin: "4321", balanceCents: 10_000, cards: [] });
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any };
  const callId = "call-r3a";

  const { step } = await toConfirm(deps, tenantId, callId, "+18456624417", "4321");
  await step("1"); // confirm -> silent list_cards -> 0 cards on file -> straight to the collector
  const session = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
  const sessionId = String(session.id);
  const doorOut = await runPayIvrCardEntry(deps, { tenantId, callId, callerNumber: "+18456624417", card: goodCard() });
  assert.equal(doorOut.ok, true);

  const beforeCharges = pos.requestLog.filter((r) => r.method === "POST" && r.path.endsWith("/charges")).length;
  const out = await step("1"); // once
  assert.ok(out.prompts.includes("09_approved_intro"), `expected an approval: ${JSON.stringify(out.prompts)}`);
  const chargeCall = pos.requestLog.filter((r) => r.method === "POST" && r.path.endsWith("/charges"));
  assert.equal(chargeCall.length, beforeCharges + 1);
  const lastCharge = [...pos.charges.values()].at(-1)!;
  assert.equal(lastCharge.cardId, null, "an inline-card charge must never also carry a cardId");
  assert.equal(lastCharge.keyed, true);
  assert.equal(vaultGet(sessionId), null, "the vault must be empty after the charge attempt");

  const cardAddPosts = pos.requestLog.filter((r) => r.method === "POST" && r.path.endsWith("/cards")).length;
  assert.equal(cardAddPosts, 0, "\"once\" must never call the add-card door");
});

test("card_save_choice \"2\" stores the card first (POST /cards), then charges by the returned cardId, and the card appears in GET /cards", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-card-r3b";
  pos.addCustomer({ id: "c1", phone10: "8456624417", pin: "4321", balanceCents: 10_000, cards: [] });
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any };
  const callId = "call-r3b";

  const { step } = await toConfirm(deps, tenantId, callId, "+18456624417", "4321");
  await step("1"); // confirm -> silent list_cards -> 0 cards on file -> straight to the collector
  const session = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
  const sessionId = String(session.id);
  await runPayIvrCardEntry(deps, { tenantId, callId, callerNumber: "+18456624417", card: goodCard() });

  const out = await step("2"); // save
  assert.ok(out.prompts.includes("09_approved_intro"), `expected an approval: ${JSON.stringify(out.prompts)}`);

  const addCardPost = pos.requestLog.find((r) => r.method === "POST" && r.path.endsWith("/cards"));
  assert.ok(addCardPost, "\"save\" must POST /cards before charging");
  const chargeBodyKeyed = [...pos.charges.values()].at(-1)!;
  assert.equal(chargeBodyKeyed.keyed, false, "a saved-then-charged card must charge by cardId, not inline");
  assert.ok(chargeBodyKeyed.cardId, "the charge must carry the cardId the register returned");
  assert.equal(vaultGet(sessionId), null);

  const stored = pos.customers.get("c1")!.cards;
  assert.equal(stored.length, 1, "the register's card list must now contain the saved card");
  assert.equal(stored[0].id, chargeBodyKeyed.cardId);
});

test("exactly one charge per confirmation still holds when paying with a keyed card (round 5: confirm '1' lists cards first; 0 on file goes straight to the collector)", () => {
  const events: Parameters<typeof reducePayIvr>[1][] = [
    { type: "call_start", callerKnown: true, callerAccountId: "c1" },
    { type: "digits", value: "1" },
    { type: "pin_result", ok: false, reason: "invalid" },
    { type: "digits", value: "4321" },
    { type: "pin_result", ok: true, balanceCents: 10000 },
    { type: "digits", value: "2" },
    { type: "digits", value: "25*37" },
    { type: "digits", value: "1" }, // confirm -> silent list_cards
    { type: "cards_result", ok: true, cards: [] }, // nothing on file -> straight to the collector
    { type: "card_entered", ok: true, last4: "1111" },
    { type: "digits", value: "1" }, // once
  ];
  let state = initialPayIvrState();
  const outputs: ReturnType<typeof reducePayIvr>[] = [];
  for (const e of events) {
    const out = reducePayIvr(state, e);
    outputs.push(out);
    state = out.state;
  }
  const chargeEffects = outputs.flatMap((o) => o.effects).filter((e) => e.kind === "charge");
  assert.equal(chargeEffects.length, 1);
  assert.deepEqual(chargeEffects[0], { kind: "charge", amountCents: 2537, chargeSeq: 1, cardMode: "once", cardId: null });
  // a stray repeat of the same digit while charging must never charge again.
  const replay = reducePayIvr(state, { type: "digits", value: "1" });
  assert.equal(replay.effects.filter((e) => e.kind === "charge").length, 0);
});

// ═══════════════════════ RULE 4 — no_card / declined branching ═════════════

test("(round 5) 0 cards on file: confirm goes straight to keying one (12_no_card, phase card_entry, gather card) — the old card_offer menu step is gone", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-card-r4a";
  pos.addCustomer({ id: "c1", phone10: "8456624417", pin: "4321", balanceCents: 10_000, cards: [] });
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any };
  const callId = "call-r4a";

  const { step } = await toConfirm(deps, tenantId, callId, "+18456624417", "4321");
  const out = await step("1"); // confirm -> silent list_cards -> 0 on file
  assert.deepEqual(out.prompts, ["12_no_card"]);
  assert.equal(out.gather?.what, "card");
  assert.equal(out.gather?.maxDigits, 0);
  const row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
  assert.equal(row.state.phase, "card_entry");
});

test("(legacy) a resumed card_offer row from before round 5 (no longer reachable live) still obeys its old rules on replay: '1' keys a card, anything else is a person", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-card-legacy-offer";
  pos.addCustomer({ id: "c1", phone10: "8456624417", pin: "4321", balanceCents: 10_000, cards: [] });
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any };

  db.seed("supermarketPayCall", {
    tenantId,
    callId: "call-legacy-offer-1",
    callerNumber: "+18456624417",
    state: { ...initialPayIvrState(), phase: "card_offer", posCustomerId: "c1", pinVerified: true, activePin: "4321", pendingCents: 500 },
    posCustomerId: "c1",
    chargeSeq: 0,
    chargedCents: 0,
    status: "open",
  });
  const keyOne = await runPayIvrStep(deps as any, { tenantId, callId: "call-legacy-offer-1", callerNumber: "+18456624417", digits: "1" });
  assert.equal(keyOne.gather?.what, "card");

  db.seed("supermarketPayCall", {
    tenantId,
    callId: "call-legacy-offer-2",
    callerNumber: "+18456624417",
    state: { ...initialPayIvrState(), phase: "card_offer", posCustomerId: "c1", pinVerified: true, activePin: "4321", pendingCents: 500 },
    posCustomerId: "c1",
    chargeSeq: 0,
    chargedCents: 0,
    status: "open",
  });
  const anythingElse = await runPayIvrStep(deps as any, { tenantId, callId: "call-legacy-offer-2", callerNumber: "+18456624417", digits: "2" });
  assert.equal(anythingElse.transfer, true);
  assert.ok(anythingElse.prompts.includes("20_connect_person"));
});

test("(round 5) a declined KEYED card, with NO cards on file, silently re-lists (finds none) and goes straight back to keying a card — amount kept", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-card-r4b";
  pos.addCustomer({ id: "c1", phone10: "8456624417", pin: "4321", balanceCents: 10_000, cards: [] });
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any };
  const callId = "call-r4b";

  const { step } = await toConfirm(deps, tenantId, callId, "+18456624417", "4321", "10*00");
  const listed = await step("1"); // confirm -> silent list_cards -> 0 on file -> the collector
  assert.deepEqual(listed.prompts, ["12_no_card"]);
  const session = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
  const sessionId = String(session.id);
  await runPayIvrCardEntry(deps, { tenantId, callId, callerNumber: "+18456624417", card: goodCard() });

  pos.opts.declineCards = true;
  const out = await step("1"); // once — declined
  pos.opts.declineCards = false;
  assert.deepEqual(out.prompts, ["08_processing", "11_declined", "12_no_card"]);
  assert.equal(out.gather?.what, "card");
  assert.equal(vaultGet(sessionId), null, "the vault must be empty after the declined attempt");

  const row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
  assert.equal(row.state.phase, "card_entry");
  assert.equal(row.state.pendingCents, 1000, "the amount must be kept after a declined keyed card");
});

test("(round 5) a declined CARD-ON-FILE charge silently re-lists and replays the SAME menu — a different card can be picked next; the amount is never re-asked", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-card-r4c";
  pos.addCustomer({
    id: "c1",
    phone10: "8456624417",
    pin: "4321",
    balanceCents: 10_000,
    cards: [
      { id: "cdA", masked: maskedCard("1111") },
      { id: "cdB", masked: maskedCard("2222") },
    ],
  });
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any };
  const callId = "call-r4c";

  const { step } = await toConfirm(deps, tenantId, callId, "+18456624417", "4321");
  const menuOut = await step("1"); // confirm -> silent list_cards -> 2 on file -> the menu
  assert.equal(menuOut.gather?.what, "menu");
  assert.ok(menuOut.prompts.includes("48_to_use_card_ending"));

  pos.opts.declineCards = true;
  const out = await step("1"); // pick card A — declined
  pos.opts.declineCards = false;
  assert.deepEqual(out.prompts.slice(0, 2), ["08_processing", "11_declined"], "a decline must lead with 08_processing, 11_declined");
  assert.ok(out.prompts.includes("48_to_use_card_ending"), "the SAME menu must be replayed after a silent re-list");
  assert.equal(out.gather?.what, "menu");
  const row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
  assert.equal(row.state.phase, "card_choice");
  assert.equal(row.state.pendingCents, 1000, "the old card-on-file path used to clear the amount on decline — round 5 keeps it");

  // a FRESH pick (the other card) now approves.
  const approved = await step("2");
  assert.ok(approved.prompts.includes("09_approved_intro"));
  const lastCharge = [...pos.charges.values()].at(-1)!;
  assert.equal(lastCharge.cardId, "cdB", "the second pick must charge the SECOND card, not silently retry the first");
});

test("(round 5) 3 consecutive declines hit PAY_MAX_AMOUNT_ATTEMPTS and land on a person: 11_declined then 20_connect_person, never a further re-list", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos({ declineCards: true });
  const tenantId = "t-card-r4d";
  pos.addCustomer({ id: "c1", phone10: "8456624417", pin: "4321", balanceCents: 10_000, cards: [{ id: "cdA", masked: maskedCard("1111") }] });
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any };
  const callId = "call-r4d";

  const { step } = await toConfirm(deps, tenantId, callId, "+18456624417", "4321");
  let out = await step("1"); // menu
  for (let i = 0; i < PAY_MAX_AMOUNT_ATTEMPTS - 1; i++) {
    out = await step("1"); // pick the only card — declined, silently re-listed
    assert.equal(out.gather?.what, "menu", `attempt ${i + 1} must still replay the menu`);
  }
  out = await step("1"); // final attempt — over the cap
  assert.deepEqual(out.prompts, ["08_processing", "11_declined", "20_connect_person"]);
  assert.equal(out.transfer, true);
  assert.equal(out.gather, null);
  const row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
  assert.equal(row.state.phase, "human");
  assert.equal(row.state.pendingCents, null, "the amount is finally cleared once capped to a person");
});

// ═══════════════════════ RULE 5 — the card number never leaks ══════════════

test("⛔ the card number never appears in the persisted session, any logged object, the card door's response, or the register's error text", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-card-r5";
  pos.addCustomer({ id: "c1", phone10: "8456624417", pin: "4321", balanceCents: 10_000, cards: [] });
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const logCalls: any[] = [];
  const log = {
    info: (o: any, m?: string) => logCalls.push({ o, m }),
    warn: (o: any, m?: string) => logCalls.push({ o, m }),
  };
  const deps = { db, clientFor: clientFor as any, log };
  const callId = "call-r5";

  const { step } = await toConfirm(deps, tenantId, callId, "+18456624417", "4321");
  await step("1"); // confirm -> silent list_cards -> 0 cards on file -> straight to the collector
  const card = goodCard();

  // 1) the door's own response carries no digits.
  const doorOut = await runPayIvrCardEntry(deps, { tenantId, callId, callerNumber: "+18456624417", card });
  assert.equal(findLuhnDigitRuns(doorOut).length, 0, "the card door's response leaked the card number");

  // 2) once-mode charge (inline card body) — still no leak anywhere.
  const out = await step("1");
  assert.ok(out.prompts.includes("09_approved_intro"));
  assert.equal(findLuhnDigitRuns(out).length, 0, "the step result leaked the card number");

  // 3) the persisted session rows never carry it.
  for (const row of db.rows("supermarketPayCall")) {
    assert.equal(findLuhnDigitRuns(row).length, 0, `a persisted supermarketPayCall row leaked the card number: ${row.callId}`);
  }

  // 4) every log call this whole run produced is clean.
  for (const call of logCalls) {
    assert.equal(findLuhnDigitRuns(call).length, 0, `a log call leaked the card number: ${JSON.stringify(call).slice(0, 200)}`);
  }

  // 5) the register's OWN 400 response for a bad card shape names only the
  // field it refused, never the digits — proven directly against the fake's
  // wire behavior (the shape our client forwards verbatim into bodyPreview).
  const pos2 = new FakePos();
  pos2.addCustomer({ id: "c2", phone10: "8456624499", pin: "1234", balanceCents: 5_000, cards: [] });
  const badBody = JSON.stringify({
    externalId: "test123",
    amount: 10,
    card: { CardNumber: "4111111111111112", ExpMonth: 12, ExpYear: 30, CVV: "123" }, // bad Luhn
  });
  const res: any = await pos2.fetchImpl(`https://api.poswithlogic.dev/customers/id/c2/charges`, {
    method: "POST",
    headers: { "x-api-key": pos2.apiKey, "X-Customer-Pin": "1234" },
    body: badBody,
  });
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { errors: [{ field: "CardNumber", message: "CardNumber is invalid" }] });
  assert.equal(findLuhnDigitRuns(text).length, 0, "the register's own 400 body leaked a card number");
  assert.ok(!text.includes("4111"), "the register's own 400 body must never echo any part of the card number");
});

// ═══════════════════════ RULE 6 — vault hygiene ═════════════════════════════

test("a hangup step deletes the vault entry", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-card-r6a";
  pos.addCustomer({ id: "c1", phone10: "8456624417", pin: "4321", balanceCents: 10_000, cards: [] });
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any };
  const callId = "call-r6a";

  const { step } = await toConfirm(deps, tenantId, callId, "+18456624417", "4321");
  await step("1"); // confirm -> silent list_cards -> 0 cards on file -> straight to the collector
  const session = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
  const sessionId = String(session.id);
  await runPayIvrCardEntry(deps, { tenantId, callId, callerNumber: "+18456624417", card: goodCard() });
  assert.ok(vaultGet(sessionId), "setup: the card must be vaulted before the hangup");

  await runPayIvrStep(deps as any, { tenantId, callId, callerNumber: "+18456624417", hangup: true });
  assert.equal(vaultGet(sessionId), null, "hangup must delete the vault entry");
});

test("vaultGet after TTL (injected `now`) returns null", async () => {
  const { vaultPut, vaultGet: get } = await import("./payCardVault");
  const id = "vault-ttl-test-session";
  const t0 = 1_700_000_000_000;
  vaultPut(id, goodCard(), t0);
  assert.ok(get(id, t0), "the card should still be there immediately");
  assert.ok(get(id, t0 + CARD_VAULT_TTL_MS - 1), "the card should still be there just before the TTL");
  assert.equal(get(id, t0 + CARD_VAULT_TTL_MS + 1), null, "the card must be gone just after the TTL");
});

test("(round 5) a charge attempted with an empty vault is declined and re-lists to 0 cards — straight back to keying one, never a charge on a card we don't hold", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-card-r6c";
  pos.addCustomer({ id: "c1", phone10: "8456624417", pin: "4321", balanceCents: 10_000, cards: [] });
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any };
  const callId = "call-r6c";

  const { step } = await toConfirm(deps, tenantId, callId, "+18456624417", "4321");
  await step("1"); // confirm -> silent list_cards -> 0 cards on file -> straight to the collector
  // Simulate the AGI's outcome WITHOUT ever putting a card in the vault (the
  // real trigger is an api restart / TTL between the two requests) by driving
  // the reducer event directly, bypassing runPayIvrCardEntry.
  const advanced = await runPayIvrStep(deps as any, { tenantId, callId, callerNumber: "+18456624417", cardEntered: { ok: true, last4: "9999" } });
  assert.equal(advanced.gather?.what, "menu");

  const chargesBefore = pos.charges.size;
  const out = await step("1"); // once
  assert.equal(pos.charges.size, chargesBefore, "a charge reached the register with no card in the vault");
  assert.deepEqual(out.prompts, ["08_processing", "11_declined", "12_no_card"]);
  assert.equal(out.gather?.what, "card");
  const row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
  assert.equal(row.state.phase, "card_entry");
});

// ═══════════════════════ ROUTE-LEVEL: the real HTTP door ════════════════════

async function buildCardDoorApp(db: FakeDb, posByTenant: Map<string, FakePos>) {
  const app = Fastify();
  await registerSupermarketRoutes({
    app,
    db,
    requireOwner: async () => null,
    audit: async () => {},
    internalGuard: (req: any, reply: any, _endpoint: string) => {
      const verdict = checkInternalSecret(process.env.CDR_INGEST_SECRET, req.headers?.["x-cdr-secret"]);
      if (verdict.ok) return true;
      reply.code(verdict.status).send({ error: verdict.error });
      return false;
    },
    renderShell: (opts: any) => `<html><body>${opts.body}</body></html>`,
    publicOrigin: () => "https://pay.example.test",
    ingestDeliveryOrder: async () => ({ ok: true }),
    driverInvite: {
      createInviteToken: async () => ({ token: "tok" }),
      portalPublicUrl: (p: string) => `https://pay.example.test${p}`,
      queueEmailJob: async () => {},
    },
    hasActionPermission: (async () => false) as any,
    clientFor: clientForFactory(posByTenant) as any,
  });
  return app;
}

test("POST /internal/supermarket/pay-ivr/card with the secret validates and vaults a card through the real route", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-card-route";
  pos.addCustomer({ id: "c1", phone10: "8456624417", pin: "4321", balanceCents: 10_000, cards: [] });
  await seedPosTenant(db, tenantId, pos);
  db.seed("supermarketSettings", { tenantId, payIvrEnabled: true });
  const app = await buildCardDoorApp(db, new Map([[tenantId, pos]]));
  const secret = process.env.CDR_INGEST_SECRET!;

  // drive the call up to card_entry through the real /step door first.
  const stepUrl = "/internal/supermarket/pay-ivr/step";
  const stepHeaders = { "x-cdr-secret": secret };
  const callId = "call-route-1";
  await app.inject({ method: "POST", url: stepUrl, payload: { tenantId, callId, callerNumber: "+18456624417" }, headers: stepHeaders });
  await app.inject({ method: "POST", url: stepUrl, payload: { tenantId, callId, digits: "1" }, headers: stepHeaders });
  await app.inject({ method: "POST", url: stepUrl, payload: { tenantId, callId, digits: "4321" }, headers: stepHeaders });
  await app.inject({ method: "POST", url: stepUrl, payload: { tenantId, callId, digits: "2" }, headers: stepHeaders });
  await app.inject({ method: "POST", url: stepUrl, payload: { tenantId, callId, digits: "10*00" }, headers: stepHeaders });
  // confirm's "1" (0 cards on file) silently lists the cards and lands straight on the collector.
  const confirmRes = await app.inject({ method: "POST", url: stepUrl, payload: { tenantId, callId, digits: "1" }, headers: stepHeaders });
  assert.equal(JSON.parse(confirmRes.body).action, "card");

  const cardRes = await app.inject({
    method: "POST",
    url: "/internal/supermarket/pay-ivr/card",
    payload: { tenantId, callId, callerNumber: "+18456624417", card: goodCard() },
    headers: { "x-cdr-secret": secret },
  });
  assert.equal(cardRes.statusCode, 200);
  assert.deepEqual(JSON.parse(cardRes.body), { ok: true });
  assert.equal(findLuhnDigitRuns(cardRes.body).length, 0, "the raw HTTP response body leaked the card number");

  const row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
  assert.equal(row.state.phase, "card_save_choice");
});

test("POST /internal/supermarket/pay-ivr/card without the secret is refused (401/403, as the guard answers)", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-card-route-2";
  pos.addCustomer({ id: "c1", phone10: "8456624417", pin: "4321", balanceCents: 10_000, cards: [] });
  await seedPosTenant(db, tenantId, pos);
  db.seed("supermarketSettings", { tenantId, payIvrEnabled: true });
  const app = await buildCardDoorApp(db, new Map([[tenantId, pos]]));

  const noHeader = await app.inject({
    method: "POST",
    url: "/internal/supermarket/pay-ivr/card",
    payload: { tenantId, callId: "x", callerNumber: "+18456624417", card: goodCard() },
  });
  assert.equal(noHeader.statusCode, 401, "a missing secret must answer exactly like the internalGuard says for a missing header");

  const wrongSecret = await app.inject({
    method: "POST",
    url: "/internal/supermarket/pay-ivr/card",
    payload: { tenantId, callId: "x", callerNumber: "+18456624417", card: goodCard() },
    headers: { "x-cdr-secret": "wrong" },
  });
  assert.equal(wrongSecret.statusCode, 403, "a wrong secret must answer exactly like the internalGuard says for a bad header");
});

// ═══════════════════════ STRESS (round 5) — rules 1–6 at volume ═════════════

function cardPhone(i: number): string {
  return `932${String(i).padStart(7, "0")}`;
}
function cardPin(i: number): string {
  return String(2000 + (i % 7000));
}

test(
  "CARD STRESS (round 5) — 500 sessions x {0,1,2,4 cards on file} x {pick ok / pick declined then pick other / 9 new card once / 9 new card save}: " +
    "the charged cardId is always the one PICKED (never assumed first), a decline never charges again without a fresh pick, the amount survives " +
    "every decline unchanged, and no call ever exceeds PAY_MAX_CHARGES_PER_CALL charges",
  async () => {
    const db = makeSupermarketDb();
    const pos = new FakePos();
    const tenantId = "t-card-stress2";
    await seedPosTenant(db, tenantId, pos);
    const clientFor = clientForFactory(new Map([[tenantId, pos]]));
    const deps = { db, clientFor: clientFor as any };
    const rnd = mulberry32(20260918);

    const N = 500;
    const COF_OPTIONS = [0, 1, 2, 4] as const;
    type Mode = "pick_ok" | "pick_declined_then_other" | "new_once" | "new_save";
    const MODES: Mode[] = ["pick_ok", "pick_declined_then_other", "new_once", "new_save"];
    const cofCounts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 4: 0 };
    const modeCounts: Record<Mode, number> = { pick_ok: 0, pick_declined_then_other: 0, new_once: 0, new_save: 0 };

    for (let i = 0; i < N; i++) {
      const cof = COF_OPTIONS[Math.floor(rnd() * COF_OPTIONS.length)];
      let mode = MODES[Math.floor(rnd() * MODES.length)];
      // 0 cards on file can only ever key a new one — there is nothing to pick.
      if (cof === 0 && (mode === "pick_ok" || mode === "pick_declined_then_other")) mode = rnd() < 0.5 ? "new_once" : "new_save";
      cofCounts[cof]++;
      modeCounts[mode]++;

      const callId = `cs2-${i}`;
      const callerNumber = cardPhone(i);
      const pin = cardPin(i);
      const cards = Array.from({ length: cof }, (_, k) => ({
        id: `cs2-${i}-card-${k}`,
        masked: maskedCard(String(1000 + i * 10 + k).slice(-4)),
      }));
      pos.addCustomer({ id: `cs2-${i}`, phone10: callerNumber, pin, balanceCents: 500_000, cards });

      const step = (digits?: string, hangup?: boolean) => runPayIvrStep(deps as any, { tenantId, callId, callerNumber, digits, hangup });
      let out = await step();
      assert.equal(out.gather?.what, "choice", `${callId}: choice`);
      out = await step("1");
      assert.equal(out.gather?.what, "pin", `${callId}: pin`);
      out = await step(pin);
      assert.equal(out.gather?.what, "menu", `${callId}: menu`);
      out = await step("2");
      assert.equal(out.gather?.what, "amount", `${callId}: amount`);
      out = await step("10*00");
      assert.equal(out.gather?.what, "confirm", `${callId}: confirm`);

      out = await step("1"); // confirm -> silent list_cards

      if (cof === 0) {
        assert.deepEqual(out.prompts, ["12_no_card"], `${callId}: 0-card lead-in`);
        assert.equal(out.gather?.what, "card", `${callId}: 0-card goes straight to the collector`);
      } else {
        assert.equal(out.gather?.what, "menu", `${callId}: card_choice menu`);
        assert.ok(out.prompts.includes("50_new_card_press_9"), `${callId}: menu missing the new-card option`);
      }

      const sessionRow = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
      const sessionId = String(sessionRow.id);
      const chargesBefore = pos.charges.size;

      if (mode === "new_once" || mode === "new_save") {
        if (cof > 0) {
          out = await step("9"); // explicitly key a new card
          assert.equal(out.gather?.what, "card", `${callId}: 9 must hand off to the collector`);
        }
        const doorOut = await runPayIvrCardEntry(deps, { tenantId, callId, callerNumber, card: goodCard() });
        assert.equal(doorOut.ok, true, `${callId}: a well-formed keyed card must be accepted`);
        assert.ok(vaultGet(sessionId), `${callId}: the card must be vaulted`);
        out = await step(mode === "new_once" ? "1" : "2");
        assert.ok(out.prompts.includes("09_approved_intro"), `${callId}: expected an approval for the keyed card`);
        assert.equal(pos.charges.size, chargesBefore + 1, `${callId}: expected exactly one new charge`);
        assert.equal(vaultGet(sessionId), null, `${callId}: the vault must be empty after ANY charge attempt`);
        const lastCharge = [...pos.charges.values()].at(-1)!;
        assert.equal(lastCharge.keyed, mode === "new_once", `${callId}: once/save charge shape mismatch`);
        if (mode === "new_save") assert.ok(lastCharge.cardId, `${callId}: a saved card must charge by cardId`);
      } else {
        // a card-on-file scenario (cof > 0) — pick a RANDOM index, never assume the first.
        const idx = Math.floor(rnd() * cof);
        const pickedCardId = cards[idx].id;

        if (mode === "pick_ok") {
          out = await step(String(idx + 1));
          assert.ok(out.prompts.includes("09_approved_intro"), `${callId}: expected an approval`);
          assert.equal(pos.charges.size, chargesBefore + 1, `${callId}: exactly one charge`);
          const lastCharge = [...pos.charges.values()].at(-1)!;
          assert.equal(lastCharge.cardId, pickedCardId, `${callId}: charged the wrong card — must be the one picked, never assumed first`);
        } else {
          // pick_declined_then_other
          pos.opts.declineCards = true;
          out = await step(String(idx + 1));
          pos.opts.declineCards = false;
          assert.deepEqual(out.prompts.slice(0, 2), ["08_processing", "11_declined"], `${callId}: declined lead-in`);
          assert.equal(pos.charges.size, chargesBefore, `${callId}: a declined attempt must never charge`);
          assert.equal(out.gather?.what, "menu", `${callId}: a decline must silently re-list and replay the menu`);
          const rowAfterDecline = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
          assert.equal(rowAfterDecline.state.pendingCents, 1000, `${callId}: the amount must survive a decline unchanged`);

          const otherIdx = (idx + 1) % cof;
          const otherCardId = cards[otherIdx].id;
          out = await step(String(otherIdx + 1)); // a FRESH pick — a different card.
          assert.ok(out.prompts.includes("09_approved_intro"), `${callId}: expected an approval on the second pick`);
          assert.equal(pos.charges.size, chargesBefore + 1, `${callId}: exactly one charge landed, after the fresh pick`);
          const lastCharge = [...pos.charges.values()].at(-1)!;
          assert.equal(lastCharge.cardId, otherCardId, `${callId}: charged the wrong card on the second pick`);
        }
      }

      const finalRow = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
      assert.ok(finalRow.chargeSeq <= PAY_MAX_CHARGES_PER_CALL, `${callId}: exceeded PAY_MAX_CHARGES_PER_CALL`);
    }

    // GLOBAL: the ledger reconciles to the cent, no duplicate externalIds.
    const ledgerTotal = [...pos.charges.values()].reduce((s, c) => s + c.amount, 0);
    const sessionTotal = db
      .rows("supermarketPayCall")
      .filter((r: any) => r.tenantId === tenantId)
      .reduce((s: number, r: any) => s + r.chargedCents, 0);
    assert.equal(sessionTotal, ledgerTotal, "CARD STRESS: session books disagree with the register ledger");
    assert.equal(new Set(pos.charges.keys()).size, pos.charges.size, "CARD STRESS: duplicate externalId in the ledger");

    // GLOBAL: no card number anywhere in any persisted row.
    for (const row of db.rows("supermarketPayCall")) {
      assert.equal(findLuhnDigitRuns(row).length, 0, `CARD STRESS: a persisted row leaked a card number: ${row.callId}`);
    }

    assert.ok(Object.values(cofCounts).every((c) => c > 0), "the card-on-file matrix did not exercise all four buckets (0/1/2/4)");
    assert.ok(Object.values(modeCounts).every((c) => c > 0), "the mode matrix did not exercise all four buckets");
    console.log(
      `[CARD STRESS round5] n=${N} cof=${JSON.stringify(cofCounts)} mode=${JSON.stringify(modeCounts)} ledgerCents=${ledgerTotal}`,
    );
  },
);
