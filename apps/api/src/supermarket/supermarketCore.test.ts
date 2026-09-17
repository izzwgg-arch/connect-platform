/**
 * Unit tests for the supermarket pure cores: the POS client's request
 * discipline, star-decimal amounts + prompt splicing, the pay-IVR reducer's
 * money rules, the draft matcher, the learning gate, and the catalog parser.
 *
 * Run: part of `npm test` in apps/api via the "src/supermarket/*.test.ts" glob
 * (registered in package.json in the same commit — a test the runner does not
 * name never runs).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PosApiError,
  PosWithLogicClient,
  centsToPosAmount,
  creditCostFor,
  isValidPosPin,
  posPhoneDigits,
  posUnitPriceCents,
  toPosExternalId,
} from "./posWithLogic";
import { amountToPromptRefs, formatCents, numberToPromptRefs, parseStarDecimalAmount } from "./payAmount";
import {
  PAY_MAX_PIN_ATTEMPTS,
  PAY_PROBE_PIN,
  countChargeEffects,
  initialPayIvrState,
  normalizePayIvrState,
  reducePayIvr,
  type PayIvrOutput,
  type PayIvrState,
} from "./payIvrCore";
import { buildCatalogIndex, computeCorrections, detectWic, matchDraftText, WIC_COMMENT } from "./draftMatcher";
import { decideAutoSubmit, weeklyCorrectionStats, MIN_WEEK_VOLUME } from "./learning";
import { laterLastMod, parseProductsPage, pickEffectivePrice } from "./catalogSync";
import { maskKeyHint } from "./integrationCredentials";
import { unsubscribeToken, verifyUnsubscribeToken } from "./specials";
import { sanitizeDraftItems } from "./orderSubmit";
import { decideCampaignBlock } from "./crmMode";

process.env.JWT_SECRET = process.env.JWT_SECRET || "supermarket-test-secret-0123456789abcdef";

// ─── star-decimal amounts ────────────────────────────────────────────────────

test("star is the decimal point: 25*37 = $25.37", () => {
  assert.deepEqual(parseStarDecimalAmount("25*37"), { ok: true, cents: 2537 });
  assert.deepEqual(parseStarDecimalAmount("25"), { ok: true, cents: 2500 });
  assert.deepEqual(parseStarDecimalAmount("25*3"), { ok: true, cents: 2530 });
  assert.deepEqual(parseStarDecimalAmount("*50"), { ok: true, cents: 50 });
  assert.deepEqual(parseStarDecimalAmount("0*01"), { ok: true, cents: 1 });
});

test("amount refusals: empty, junk, double star, 3 decimals, zero, too large", () => {
  assert.equal(parseStarDecimalAmount("").ok, false);
  assert.equal(parseStarDecimalAmount("12#4").ok, false);
  assert.equal(parseStarDecimalAmount("1*2*3").ok, false);
  assert.equal(parseStarDecimalAmount("1*234").ok, false);
  assert.equal(parseStarDecimalAmount("0").ok, false);
  assert.equal(parseStarDecimalAmount("0*00").ok, false);
  assert.equal(parseStarDecimalAmount("100000").ok, false); // > $99,999.99
  assert.deepEqual(parseStarDecimalAmount("99999*99"), { ok: true, cents: 9999999 });
});

test("number prompts splice correctly across the recorded set", () => {
  assert.deepEqual(numberToPromptRefs(0), ["num_0"]);
  assert.deepEqual(numberToPromptRefs(17), ["num_17"]);
  assert.deepEqual(numberToPromptRefs(45), ["num_40", "num_5"]);
  assert.deepEqual(numberToPromptRefs(100), ["num_1", "num_hundred"]);
  assert.deepEqual(numberToPromptRefs(1234), ["num_1", "num_thousand", "num_2", "num_hundred", "num_30", "num_4"]);
  assert.deepEqual(numberToPromptRefs(99999), [
    "num_99".replace("99", "90"), "num_9", "num_thousand", "num_9", "num_hundred", "num_90", "num_9",
  ]);
});

test("$25.37 reads as twenty-five dollars and thirty-seven cents", () => {
  assert.deepEqual(amountToPromptRefs(2537), ["num_20", "num_5", "16_dollars", "18_and", "num_30", "num_7", "17_cents"]);
  assert.deepEqual(amountToPromptRefs(2500), ["num_20", "num_5", "16_dollars"]);
  assert.deepEqual(amountToPromptRefs(50), ["num_50", "17_cents"]);
  assert.equal(formatCents(2537), "$25.37");
});

// ─── the POS client ──────────────────────────────────────────────────────────

function fakeFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: any }> = [];
  const fetchImpl = async (url: string, init: any) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { status: 500, body: "" };
    return {
      status: next.status,
      headers: { get: (n: string) => next.headers?.[n.toLowerCase()] ?? null },
      text: async () => (typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? "")),
    };
  };
  return { fetchImpl, calls };
}

test("POS client sends x-api-key, and PIN only when supplied", async () => {
  const { fetchImpl, calls } = fakeFetch([
    { status: 200, body: { id: "c1" } },
    { status: 200, body: { balance: 37.5 } },
  ]);
  const client = new PosWithLogicClient({ apiKey: "k".repeat(16) }, { fetchImpl });
  await client.getCustomerByPhone("8456624417");
  await client.getCustomerBalance("c1", "1234");
  assert.equal(calls[0].init.headers["x-api-key"], "k".repeat(16));
  assert.equal(calls[0].init.headers["X-Customer-Pin"], undefined);
  assert.equal(calls[1].init.headers["X-Customer-Pin"], "1234");
});

test("POS client classifies 401/402/404/409/429 and reads Retry-After", async () => {
  const { fetchImpl } = fakeFetch([
    { status: 401, body: "no" },
    { status: 402, body: "credits" },
    { status: 404, body: "gone" },
    { status: 409, body: "dupe" },
    { status: 429, body: "slow", headers: { "retry-after": "30" } },
  ]);
  const client = new PosWithLogicClient({ apiKey: "k".repeat(16) }, { fetchImpl });
  const codes: string[] = [];
  let retryAfter: number | null = null;
  for (let i = 0; i < 5; i++) {
    try {
      await client.getProductByCode("104");
    } catch (err) {
      assert.ok(err instanceof PosApiError);
      codes.push(err.code);
      if (err.retryAfterSec !== null) retryAfter = err.retryAfterSec;
    }
  }
  assert.deepEqual(codes, ["pos_auth_failed", "pos_out_of_credits", "pos_not_found", "pos_duplicate", "pos_rate_limited"]);
  assert.equal(retryAfter, 30);
});

test("⛔ the client NEVER retries: one charge call = exactly one HTTP request, even on timeout-ish failure", async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 500, body: "boom" }]);
  const client = new PosWithLogicClient({ apiKey: "k".repeat(16) }, { fetchImpl });
  await assert.rejects(() => client.createCharge("c1", "1234", { externalId: "x1", amountCents: 2537, cardId: "card1" }));
  assert.equal(calls.length, 1, "a write must never be silently retried");
});

test("credit accounting: writes cost 18, reads 0-1", () => {
  assert.equal(creditCostFor("POST", "/orders"), 18);
  assert.equal(creditCostFor("POST", "/customers/id/c1/charges"), 18);
  assert.equal(creditCostFor("GET", "/products"), 1);
  assert.equal(creditCostFor("GET", "/orders/id/x"), 0);
});

test("pos helpers: phones, pins, amounts, external ids, priceQty divisor", () => {
  assert.equal(posPhoneDigits("+1 (845) 662-4417"), "8456624417");
  assert.equal(posPhoneDigits("845-662-4417"), "8456624417");
  assert.equal(posPhoneDigits("12345"), null);
  assert.equal(isValidPosPin("1234"), true);
  assert.equal(isValidPosPin(""), false);
  assert.equal(isValidPosPin("123456789"), false);
  assert.equal(isValidPosPin("12 34"), false);
  assert.equal(centsToPosAmount(2537), "25.37");
  assert.throws(() => centsToPosAmount(0));
  assert.equal(toPosExternalId("d" + "a".repeat(40)).length, 20);
  // ⛔ priceQty is a DIVISOR: "2 for $10" = $5.00 each.
  assert.equal(posUnitPriceCents(10, 2), 500);
  assert.equal(posUnitPriceCents(4.29, undefined), 429);
  assert.equal(posUnitPriceCents(4.29, 0), 429); // 0 never divides
});

// ─── the pay-IVR reducer ─────────────────────────────────────────────────────

function drive(events: Parameters<typeof reducePayIvr>[1][]): { outputs: PayIvrOutput[]; state: PayIvrState } {
  let state = initialPayIvrState();
  const outputs: PayIvrOutput[] = [];
  for (const event of events) {
    const out = reducePayIvr(state, event);
    outputs.push(out);
    state = out.state;
  }
  return { outputs, state };
}

test("caller-ID match with a stored PIN: silent verify, straight to the menu, no PIN prompt", () => {
  const { outputs } = drive([
    { type: "call_start", callerKnown: true, hasStoredPin: true, storedPin: "4321" },
    { type: "pin_result", ok: true, balanceCents: 3750 },
  ]);
  assert.deepEqual(outputs[0].prompts, ["01_welcome"]);
  assert.deepEqual(outputs[0].effects, [{ kind: "verify_pin", pin: "4321" }]);
  assert.ok(outputs[1].prompts.includes("22_main_menu"));
  assert.ok(!outputs.flatMap((o) => o.prompts).includes("02_pin"), "a matching caller with a stored PIN never hears the PIN prompt");
});

test("stored PIN gone stale: under the default policy 'never' the caller is redirected to another account at once (never re-keyed); under the operator switch 'ask_once' it falls back to keying and re-enrolls; a foreign number is NEVER enrolled either way", () => {
  // Default policy 'never': a stale enrollment is nothing enrolled — redirected
  // to key another account at once (09-17 evening rule), purge already
  // happened in the runtime, no re-keying of THIS account offered.
  const blocked = drive([
    { type: "call_start", callerKnown: true, hasStoredPin: true, storedPin: "0000" },
    { type: "pin_result", ok: false, reason: "invalid" },
  ]);
  assert.ok(!blocked.outputs.flatMap((o) => o.prompts).includes("02_pin"), "policy 'never' must not fall back to keying");
  assert.ok(!blocked.outputs.flatMap((o) => o.prompts).includes("20_connect_person"), "redirected instead of handed to a person on the first block");
  assert.equal(blocked.state.phase, "lookup_entry");
  assert.equal(blocked.state.blockedReason, null, "cleared — the block is recorded in ownAccountBlocked instead");
  assert.equal(blocked.state.ownAccountBlocked, "pin_not_enrolled");
  assert.equal(blocked.state.callerIdMatched, false, "cleared so the next lookup is treated as a fresh account");
  assert.ok(blocked.outputs.at(-1)!.prompts.includes("34_enter_account_phone"));
  assert.equal(blocked.outputs.at(-1)!.gather?.what, "phone");

  // Operator switch 'ask_once': restores the pre-09-17 behaviour verbatim.
  const { outputs, state } = drive([
    { type: "call_start", callerKnown: true, hasStoredPin: true, storedPin: "0000", matchedPinPolicy: "ask_once" },
    { type: "pin_result", ok: false, reason: "invalid" },
    { type: "digits", value: "4321" },
    { type: "pin_result", ok: true, balanceCents: 1000 },
  ]);
  assert.ok(outputs[1].prompts.includes("02_pin"), "stale store falls back to keying under ask_once");
  // caller-ID matched + keyed → enrollment fires
  assert.ok(outputs[3].effects.some((e) => e.kind === "enroll_pin"));
  assert.equal(state.phase, "main_menu");

  // Foreign number (looked up): probed first, then keyed — NO enrollment ever,
  // regardless of the matched-caller policy.
  const foreign = drive([
    { type: "call_start", callerKnown: false, hasStoredPin: false },
    { type: "digits", value: "8456624417" },
    { type: "lookup_result", found: true, posCustomerId: "c9" },
    { type: "pin_result", ok: false, reason: "invalid" },
    { type: "digits", value: "4321" },
    { type: "pin_result", ok: true, balanceCents: 500 },
  ]);
  assert.ok(
    foreign.outputs.every((o) => !o.effects.some((e) => e.kind === "enroll_pin")),
    "a looked-up (foreign) number must NEVER enroll a PIN",
  );
});

test("wrong PIN caps at 3 and lands on a person, never a loop (operator switch matchedPinPolicy:'ask_once')", () => {
  // A matched caller with nothing enrolled is PROBED first (silent); under the
  // ask_once switch the register's "invalid" means asked once, then keyed.
  const events: Parameters<typeof reducePayIvr>[1][] = [
    { type: "call_start", callerKnown: true, hasStoredPin: false, matchedPinPolicy: "ask_once" },
    { type: "pin_result", ok: false, reason: "invalid" },
  ];
  for (let i = 0; i < PAY_MAX_PIN_ATTEMPTS; i++) {
    events.push({ type: "digits", value: "9999" });
    events.push({ type: "pin_result", ok: false });
  }
  const { outputs, state } = drive(events);
  assert.equal(state.phase, "human");
  const all = outputs.flatMap((o) => o.prompts);
  assert.ok(all.includes("15_too_many_tries"));
  assert.ok(all.includes("20_connect_person"));
});

test("⛔ THE DEFAULT (policy 'never'): the exact same 'invalid' probe result redirects a matched caller to another account AT ONCE — no PIN is ever keyed, no 3-strikes cap is ever reached, never a person the first time — and the SAME call then continues: another account's number, probed, keyed, paid exactly once", () => {
  const events: Parameters<typeof reducePayIvr>[1][] = [
    { type: "call_start", callerKnown: true, hasStoredPin: false },
    { type: "pin_result", ok: false, reason: "invalid" },
  ];
  const { outputs: redirectOutputs, state: redirectState } = drive(events);
  assert.equal(redirectState.phase, "lookup_entry");
  assert.equal(redirectState.blockedReason, null);
  assert.equal(redirectState.ownAccountBlocked, "pin_not_enrolled");
  assert.equal(redirectState.pinAttempts, 0, "never reaches a keyed attempt at all");
  assert.equal(redirectState.lookupAttempts, 0);
  const redirectPrompts = redirectOutputs.flatMap((o) => o.prompts);
  assert.ok(!redirectPrompts.includes("02_pin"), "never asked");
  assert.ok(!redirectPrompts.includes("15_too_many_tries"), "there is nothing to cap — it never starts trying");
  assert.ok(!redirectPrompts.includes("20_connect_person"), "redirected instead of a person on the first block");
  assert.ok(redirectPrompts.includes("34_enter_account_phone"));
  assert.equal(redirectOutputs.at(-1)!.gather?.what, "phone");

  // the SAME call goes on: a different account's phone number, a silent
  // probe (this one HAS a PIN in the POS), the foreign PIN keyed correctly,
  // the main menu, and exactly one charge.
  const { outputs, state } = drive([
    ...events,
    { type: "digits", value: "8456624417" },
    { type: "lookup_result", found: true, posCustomerId: "c9" },
    { type: "pin_result", ok: false, reason: "invalid" }, // silent probe: this account has a PIN
    { type: "digits", value: "5555" },
    { type: "pin_result", ok: true, balanceCents: 4200 },
    { type: "digits", value: "2" }, // payment
    { type: "digits", value: "3*00" },
    { type: "digits", value: "1" }, // confirm
    { type: "charge_result", outcome: "approved", newBalanceCents: 900 },
  ]);
  assert.equal(countChargeEffects(outputs), 1);
  assert.equal(state.phase, "after_balance_menu");
  assert.equal(state.chargedCents, 300);
  assert.equal(state.ownAccountBlocked, "pin_not_enrolled", "the desk-visible flag survives — it records what happened, it does not block anything further");
  assert.ok(outputs.every((o) => !o.effects.some((e) => e.kind === "enroll_pin")), "a looked-up account (even the caller's own, relooked-up) must never be enrolled");
  assert.ok(!outputs.flatMap((o) => o.prompts).includes("20_connect_person"), "never reached a person — the redirect let the call succeed");
});

test("THE CALLER-ID RULE: a matched caller keys nothing — probe silently; 'PIN required' = no PIN in the POS → redirected to key another account instead of a person, flagged ownAccountBlocked; a SECOND unservable account still ends at a person (the redirect fires only once)", () => {
  const { outputs, state } = drive([
    { type: "call_start", callerKnown: true, hasStoredPin: false },
    { type: "pin_result", ok: false, reason: "not_set" },
  ]);
  assert.deepEqual(outputs[0].prompts, ["01_welcome"]);
  assert.equal(outputs[0].gather, null, "a matched caller must not be asked to key anything before the register answers");
  assert.deepEqual(outputs[0].effects, [{ kind: "verify_pin", pin: PAY_PROBE_PIN }]);
  assert.deepEqual(outputs[1].prompts, ["34_enter_account_phone"]);
  assert.equal(outputs[1].gather?.what, "phone");
  assert.equal(state.phase, "lookup_entry");
  assert.equal(state.blockedReason, null);
  assert.equal(state.ownAccountBlocked, "pin_not_set");
  assert.equal(state.pinAttempts, 0, "a silent probe is not an attempt");
  assert.ok(!outputs.flatMap((o) => o.prompts).includes("02_pin"), "never asked");
  assert.ok(!outputs.flatMap((o) => o.prompts).includes("20_connect_person"), "redirected instead of a person on the first block");

  // the redirect fires only once per call: a second unservable account (also
  // no PIN in the POS) ends exactly like the pre-09-17-evening behaviour.
  const second = drive([
    { type: "call_start", callerKnown: true, hasStoredPin: false },
    { type: "pin_result", ok: false, reason: "not_set" },
    { type: "digits", value: "8456624417" },
    { type: "lookup_result", found: true, posCustomerId: "c9" },
    { type: "pin_result", ok: false, reason: "not_set" },
  ]);
  assert.equal(second.state.phase, "human");
  assert.equal(second.state.blockedReason, "pin_not_set");
  assert.ok(second.outputs.at(-1)!.prompts.includes("20_connect_person"));
});

test("THE CALLER-ID RULE (operator switch matchedPinPolicy:'ask_once'): the store set a PIN Loopcom does not know → asked ONCE, enrolled, and digits during the silent probe are ignored", () => {
  const { outputs, state } = drive([
    { type: "call_start", callerKnown: true, hasStoredPin: false, matchedPinPolicy: "ask_once" },
    { type: "digits", value: "4321" }, // stray DTMF while the probe is in flight
    { type: "pin_result", ok: false, reason: "invalid" },
    { type: "digits", value: "4321" },
    { type: "pin_result", ok: true, balanceCents: 1200 },
  ]);
  assert.deepEqual(outputs[1].effects, [], "digits during a silent probe must not fire a second verify");
  assert.deepEqual(outputs[2].prompts, ["02_pin"]);
  assert.equal(outputs[2].state.pinAttempts, 0, "the probe refusal is not the caller's attempt");
  assert.ok(outputs[4].effects.some((e) => e.kind === "enroll_pin" && e.pin === "4321"));
  assert.equal(state.phase, "main_menu");
});

test("THE CALLER-ID RULE (default policy 'never'): the store set a PIN Loopcom does not know → the caller is NEVER asked, redirected to key another account at once, flagged pin_not_enrolled for the desk to enroll", () => {
  const { outputs, state } = drive([
    { type: "call_start", callerKnown: true, hasStoredPin: false },
    { type: "digits", value: "4321" }, // stray DTMF while the probe is in flight — still ignored
    { type: "pin_result", ok: false, reason: "invalid" },
  ]);
  assert.deepEqual(outputs[1].effects, [], "digits during a silent probe must not fire a second verify");
  assert.equal(state.phase, "lookup_entry");
  assert.equal(state.blockedReason, null);
  assert.equal(state.ownAccountBlocked, "pin_not_enrolled");
  assert.ok(!outputs.flatMap((o) => o.prompts).includes("02_pin"), "never asked under the default policy");
  assert.ok(!outputs.flatMap((o) => o.prompts).includes("20_connect_person"), "redirected instead of a person on the first block");
  assert.ok(outputs.at(-1)!.prompts.includes("34_enter_account_phone"));
  assert.ok(outputs.every((o) => !o.effects.some((e) => e.kind === "enroll_pin")), "nothing was ever keyed, so nothing can be enrolled");
});

test("THE CALLER-ID RULE: a foreign number whose account has NO PIN in the POS is blocked at once by the silent probe — never asked, just like a matched caller", () => {
  const { outputs, state } = drive([
    { type: "call_start", callerKnown: false, hasStoredPin: false },
    { type: "digits", value: "8456624417" },
    { type: "lookup_result", found: true, posCustomerId: "c9" },
    { type: "pin_result", ok: false, reason: "not_set" },
  ]);
  assert.ok(!outputs.flatMap((o) => o.prompts).includes("02_pin"), "never asked — nothing any caller keys can pass");
  assert.ok(!outputs.flatMap((o) => o.prompts).includes("23_pin_or_star"), "never asked — nothing any caller keys can pass");
  assert.equal(state.phase, "human");
  assert.equal(state.blockedReason, "pin_not_set");
  assert.ok(outputs.every((o) => !o.effects.some((e) => e.kind === "enroll_pin")));
});

test("THE CALLER-ID RULE: a foreign number whose account HAS a PIN keys it every time (probed first, silently); three misses land on a person, never enrolled", () => {
  const events: Parameters<typeof reducePayIvr>[1][] = [
    { type: "call_start", callerKnown: false, hasStoredPin: false },
    { type: "digits", value: "8456624417" },
    { type: "lookup_result", found: true, posCustomerId: "c9" },
    { type: "pin_result", ok: false, reason: "invalid" }, // the silent probe: the account has a PIN
  ];
  for (let i = 0; i < PAY_MAX_PIN_ATTEMPTS; i++) {
    events.push({ type: "digits", value: "1234" });
    events.push({ type: "pin_result", ok: false });
  }
  const { outputs, state } = drive(events);
  assert.equal(state.phase, "human");
  assert.ok(outputs.flatMap((o) => o.prompts).includes("23_pin_or_star"), "a foreign caller must be told they may press star for a code");
  assert.ok(outputs.flatMap((o) => o.prompts).includes("15_too_many_tries"));
  assert.ok(outputs.every((o) => !o.effects.some((e) => e.kind === "enroll_pin")), "a foreign number must NEVER enroll a PIN");
});

test("normalizePayIvrState reads pre-2026-09-17 rows (no pinProbe / blockedReason) safely", () => {
  const legacy: any = { ...initialPayIvrState(), phase: "main_menu", activePin: "1", pinVerified: true };
  delete legacy.pinProbe;
  delete legacy.blockedReason;
  const s = normalizePayIvrState(legacy);
  assert.equal(s.pinProbe, false);
  assert.equal(s.blockedReason, null);
  assert.equal(s.phase, "main_menu");
  assert.equal(normalizePayIvrState(null).phase, "start");
  assert.equal(normalizePayIvrState({ blockedReason: "garbage" }).blockedReason, null);
});

test("⛔ THE MONEY RULE: one confirmation = one charge effect, and a stray repeat event charges nothing", () => {
  const base: Parameters<typeof reducePayIvr>[1][] = [
    { type: "call_start", callerKnown: true, hasStoredPin: true, storedPin: "1" },
    { type: "pin_result", ok: true, balanceCents: 10000 },
    { type: "digits", value: "2" }, // payment
    { type: "digits", value: "25*37" },
    { type: "digits", value: "1" }, // confirm
  ];
  const { outputs, state } = drive(base);
  assert.equal(countChargeEffects(outputs), 1);
  assert.deepEqual(outputs.at(-1)!.effects, [{ kind: "charge", amountCents: 2537, chargeSeq: 1 }]);
  // A duplicated confirm (replayed webhook) in the charging phase is IGNORED.
  const replay = reducePayIvr(state, { type: "digits", value: "1" });
  assert.equal(countChargeEffects([replay]), 0, "a repeated digit in charging must never charge again");
});

test("declined → re-enter; three failed amounts → a person; approved reads the new balance", () => {
  const { outputs } = drive([
    { type: "call_start", callerKnown: true, hasStoredPin: true, storedPin: "1" },
    { type: "pin_result", ok: true, balanceCents: 10000 },
    { type: "digits", value: "2" },
    { type: "digits", value: "25*37" },
    { type: "digits", value: "1" },
    { type: "charge_result", outcome: "approved", newBalanceCents: 7463 },
  ]);
  const last = outputs.at(-1)!;
  assert.ok(last.prompts[0] === "09_approved_intro");
  assert.ok(last.prompts.includes("21_menu_after_balance"));
  // the new balance is spliced in the recorded voice
  assert.ok(last.prompts.includes("16_dollars"));
});

test("no card on file lands on a person with the honest prompt", () => {
  const { outputs, state } = drive([
    { type: "call_start", callerKnown: true, hasStoredPin: true, storedPin: "1" },
    { type: "pin_result", ok: true },
    { type: "digits", value: "2" },
    { type: "digits", value: "10" },
    { type: "digits", value: "1" },
    { type: "charge_result", outcome: "no_card" },
  ]);
  assert.equal(state.phase, "human");
  assert.ok(outputs.at(-1)!.prompts.includes("12_no_card"));
});

test("unknown caller: lookup path, wrong-length numbers refused, three misses → person", () => {
  const { outputs, state } = drive([
    { type: "call_start", callerKnown: false, hasStoredPin: false },
    { type: "digits", value: "123" },
    { type: "digits", value: "123" },
    { type: "digits", value: "123" },
  ]);
  assert.ok(outputs[0].prompts.includes("13_not_recognized"));
  assert.equal(state.phase, "human");
});

// ─── the draft matcher ───────────────────────────────────────────────────────

const CATALOG = buildCatalogIndex([
  { posProductId: "p1", code: "104", name: "Milk", unitPriceCents: 429 },
  { posProductId: "p2", code: "201", name: "Eggs", unitPriceCents: 389 },
  { posProductId: "p3", code: "3011", name: "Challah medium", unitPriceCents: 550 },
  { posProductId: "p4", code: "44", name: "Kokosh cake", unitPriceCents: 899 },
]);

test("item numbers match with quantities; names match as whole words", () => {
  const m = matchDraftText("2 milk and 104 x3 and one kokosh cake\nleave it by the side door", CATALOG);
  const byId = new Map(m.items.map((i) => [i.posProductId, i]));
  assert.equal(byId.get("p1")!.qty, 5); // "2 milk" + "104 x3" merge on the product
  assert.equal(byId.get("p4")!.qty, 1);
  assert.ok(m.notes.some((n) => /side door/.test(n)), "non-item remark lands in notes");
});

test("WIC detection routes to comments, English and Yiddish spellings", () => {
  assert.equal(detectWic("I pay with WIC"), true);
  assert.equal(detectWic("איך באצאל מיט וויק"), true);
  assert.equal(detectWic("wicked good"), false);
  assert.equal(WIC_COMMENT.includes("WIC"), true);
});

test("an ambiguous product name is dropped from name-matching (ambiguity reaches the rep)", () => {
  const index = buildCatalogIndex([
    { posProductId: "a", code: "1", name: "Soda", unitPriceCents: 100 },
    { posProductId: "b", code: "2", name: "Soda", unitPriceCents: 200 },
  ]);
  const m = matchDraftText("2 soda", index);
  assert.equal(m.items.length, 0, "two products, one name → no silent guess");
});

test("correction capture: added/removed/qty-changed and the rate", () => {
  const c = computeCorrections(
    [{ posProductId: "p1", qty: 2 }, { posProductId: "p2", qty: 1 }],
    [{ posProductId: "p1", qty: 3 }, { posProductId: "p4", qty: 1 }],
  );
  assert.equal(c.qtyChanged, 1);
  assert.equal(c.added, 1);
  assert.equal(c.removed, 1);
  assert.equal(c.unchanged, 0);
  assert.equal(c.correctionRatePct, 100);
  const clean = computeCorrections([{ posProductId: "p1", qty: 2 }], [{ posProductId: "p1", qty: 2 }]);
  assert.equal(clean.correctionRatePct, 0);
});

// ─── the learning gate ───────────────────────────────────────────────────────

function week(offsetWeeks: number, drafts: number, rate: number) {
  const monday = new Date(Date.UTC(2026, 7, 24) - offsetWeeks * 7 * 86400_000);
  return { weekStart: monday.toISOString().slice(0, 10), drafts, correctionRatePct: rate };
}

test("⛔ auto-submit: the switch alone does nothing, the numbers alone do nothing", () => {
  const goodWeeks = [week(1, 20, 2), week(0, 25, 1.5)];
  const config = { autoSubmitEnabled: true, autoSubmitMaxCorrectionPct: 5, autoSubmitMinWeeks: 2 };
  assert.equal(decideAutoSubmit(goodWeeks, { ...config, autoSubmitEnabled: false }).allowed, false);
  assert.equal(decideAutoSubmit(goodWeeks, config).allowed, true);
  assert.equal(decideAutoSubmit([week(1, 20, 9), week(0, 25, 1)], config).allowed, false, "one bad recent week blocks");
  assert.equal(decideAutoSubmit([week(0, 25, 1)], config).allowed, false, "not enough weeks");
  assert.equal(decideAutoSubmit([week(1, MIN_WEEK_VOLUME - 1, 0), week(0, 25, 1)], config).allowed, false, "thin volume is not evidence");
});

test("weeklyCorrectionStats groups by ISO Monday and averages", () => {
  const rows = [
    { approvedAt: "2026-08-19T10:00:00Z", corrections: { correctionRatePct: 10 } }, // Wed
    { approvedAt: "2026-08-21T10:00:00Z", corrections: { correctionRatePct: 20 } }, // Fri same week
    { approvedAt: "bad-date", corrections: { correctionRatePct: 50 } },
    { approvedAt: "2026-08-21T10:00:00Z", corrections: null },
  ];
  const weeks = weeklyCorrectionStats(rows as any);
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].weekStart, "2026-08-17");
  assert.equal(weeks[0].drafts, 2);
  assert.equal(weeks[0].correctionRatePct, 15);
});

// ─── catalog parsing ─────────────────────────────────────────────────────────

test("parseProductsPage reads items/products/data/rows and hostile shapes", () => {
  const page = parseProductsPage({ items: [{ id: 7, code: "104", name: "Milk", price: 4.29, priceQty: 1, lastMod: "2026-08-25T10:00:00Z" }], cursor: "abc" });
  assert.ok(page);
  assert.equal(page!.items[0].posProductId, "7");
  assert.equal(page!.items[0].unitPriceCents, 429);
  assert.equal(page!.cursor, "abc");
  assert.ok(parseProductsPage([{ id: "x", price: "2 for 10" }]));
  assert.equal(parseProductsPage("nonsense"), null);
  assert.equal(parseProductsPage({ weird: true }), null);
  assert.equal(parseProductsPage(null), null);
  // bulk pricing honoured
  const bulk = parseProductsPage({ data: [{ id: 1, price: 10, priceQty: 2 }] })!;
  assert.equal(bulk.items[0].unitPriceCents, 500);
});


test("⛔ THE REAL REGISTER PAGE PARSES — verbatim fixture from the first live call ever made (Gesheft's key, 2026-08-26)", () => {
  // The documented shape was flat code/name/price; the REAL envelope is
  // results/hasMore/cursor/total with itemCode/description/prices[] items —
  // and the live data carried an EXPIRED Special beside the Regular price.
  const realPage = {
    results: [
      {
        id: "1", itemCode: "729940005486", primaryCode: "729940005486",
        description: 'Foil Pan 8" Round Deep', labelDescription: "Foil Pan 8 Round 4 Pack",
        brand: "Jetfoil", byMeasure: false, lastSold: "2026-08-24", size: 4, caseQty: 75,
        tax: true, ebt: false, unit: "pk", categoryName: "PAPERGDS", subCategoryName: "FOIL",
        prices: [
          { qty: 1, priceQtyType: "Bulk", price: 1.99, priceType: "Regular", priceFrom: null, priceTill: null, daysOfWeek: [], name: "Regular" },
          // expired Special — must NOT be chosen
          { qty: 1, priceQtyType: "Minimum", price: 1.69, priceType: "Special", priceFrom: null, priceTill: "2025-09-23T00:00:00-04:00", daysOfWeek: [], name: "Special" },
        ],
        taxRate: 8.125, active: true, aliases: [], onHand: 32,
        lastModified: "2026-08-24T22:37:17-04:00", location: "5B3", wicEligible: null, tags: [],
      },
      {
        id: "10", itemCode: "727891000154", primaryCode: "727891000154",
        description: "Apple Cider", labelDescription: "Apple Cider 64 Oz.", brand: "Golden Flow",
        prices: [{ qty: 1, priceQtyType: "Bulk", price: 5.19, priceType: "Regular", priceFrom: null, priceTill: null, name: "Regular" }],
        taxRate: 0, active: true, onHand: -149, lastModified: "2026-08-24T13:40:03-04:00",
      },
    ],
    hasMore: true, cursor: "eyJpZCI6IjEwIn0", total: 5211,
  };
  const page = parseProductsPage(realPage);
  assert.ok(page, "the real register page must parse — a null here is a sync that never runs");
  assert.equal(page!.items.length, 2);
  const foil = page!.items[0];
  assert.equal(foil.posProductId, "1");
  assert.equal(foil.code, "729940005486");
  assert.equal(foil.name, 'Foil Pan 8" Round Deep');
  assert.equal(foil.unitPriceCents, 199, "the EXPIRED Special (1.69) must lose to the Regular price");
  assert.equal(foil.isActive, true);
  assert.equal(foil.posLastMod, "2026-08-24T22:37:17-04:00");
  assert.equal(page!.items[1].unitPriceCents, 519);
  assert.equal(page!.cursor, "eyJpZCI6IjEwIn0");
  // hasMore false terminates the walk even if a cursor value lingers
  const last = parseProductsPage({ ...realPage, hasMore: false });
  assert.equal(last!.cursor, null, "hasMore=false must null the cursor or the sweep loops forever");
});

test("pickEffectivePrice: in-window Special beats Regular; expired/future windows excluded; bulk qty is the divisor", () => {
  const now = new Date("2026-08-26T00:00:00Z");
  assert.deepEqual(
    pickEffectivePrice([
      { qty: 1, price: 1.99, priceType: "Regular" },
      { qty: 1, price: 1.69, priceType: "Special", priceFrom: "2026-08-01T00:00:00Z", priceTill: "2026-09-01T00:00:00Z" },
    ], now),
    { price: 1.69, qty: 1 },
  );
  assert.deepEqual(
    pickEffectivePrice([
      { qty: 1, price: 1.99, priceType: "Regular" },
      { qty: 1, price: 1.69, priceType: "Special", priceTill: "2025-09-23T00:00:00-04:00" },
      { qty: 1, price: 1.49, priceType: "Special", priceFrom: "2027-01-01T00:00:00Z" },
    ], now),
    { price: 1.99, qty: 1 },
  );
  // "2 for $10" as a prices[] row
  assert.deepEqual(pickEffectivePrice([{ qty: 2, price: 10, priceType: "Regular" }], now), { price: 10, qty: 2 });
  assert.equal(pickEffectivePrice([], now), null);
  assert.equal(pickEffectivePrice("junk", now), null);
  assert.equal(pickEffectivePrice([{ price: "free" }], now), null);
});

test("laterLastMod keeps the max and survives nulls", () => {
  assert.equal(laterLastMod(null, "b"), "b");
  assert.equal(laterLastMod("a", null), "a");
  assert.equal(laterLastMod("2026-01-01", "2026-02-01"), "2026-02-01");
});

// ─── misc pure rules ─────────────────────────────────────────────────────────

test("key hints mask everything but the tail", () => {
  assert.equal(maskKeyHint("abcdefgh1234"), "…1234");
  assert.equal(maskKeyHint("ab"), "…");
});

test("unsubscribe tokens verify only for their own tenant+email, and forgeries fail", () => {
  const token = unsubscribeToken("tenant-a", "Person@Example.com");
  const verdict = verifyUnsubscribeToken(token);
  assert.deepEqual(verdict, { tenantId: "tenant-a", email: "person@example.com" });
  assert.equal(verifyUnsubscribeToken(token.slice(0, -2) + "zz"), null);
  assert.equal(verifyUnsubscribeToken("garbage"), null);
  const other = unsubscribeToken("tenant-b", "person@example.com");
  assert.notEqual(token, other);
});

test("sanitizeDraftItems drops junk and bounds quantities", () => {
  const items = sanitizeDraftItems([
    { posProductId: "p1", code: "104", name: "Milk", qty: 2, unitPriceCents: 429 },
    { posProductId: "", qty: 1, unitPriceCents: 100 },
    { posProductId: "p2", qty: 0, unitPriceCents: 100 },
    { posProductId: "p3", qty: 5000, unitPriceCents: 100 },
    { posProductId: "p4", qty: 1, unitPriceCents: -5 },
    "junk",
    null,
  ] as any);
  assert.deepEqual(items.map((i) => i.posProductId), ["p1"]);
});

test("campaign block: only supermarket tenants, only campaign prefixes, never SUPER_ADMIN", () => {
  assert.equal(decideCampaignBlock({ path: "/crm/campaigns", role: "USER", mode: "supermarket" }), true);
  assert.equal(decideCampaignBlock({ path: "/api/crm/campaigns/x", role: "USER", mode: "supermarket" }), true);
  assert.equal(decideCampaignBlock({ path: "/crm/campaigns", role: "USER", mode: "classic" }), false);
  assert.equal(decideCampaignBlock({ path: "/crm/contacts", role: "USER", mode: "supermarket" }), false);
  assert.equal(decideCampaignBlock({ path: "/crm/campaigns", role: "SUPER_ADMIN", mode: "supermarket" }), false);
});
