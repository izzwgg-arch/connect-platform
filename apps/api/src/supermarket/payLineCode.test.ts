/**
 * The one-time-code delivery flow (2026-09-17 caller-ID rewrite, rules 2-5):
 * a foreign caller who cannot pass a keyed PIN proves ownership of a number
 * ON THE ACCOUNT instead — by phone call or by text, picking the number by
 * its last four digits, keying the six-digit code back. A correct code
 * serves the caller exactly like a matched caller (silent enrolled PIN, else
 * a person) and NEVER enrolls a PIN itself.
 *
 * Full coverage of payIvrCore's code_channel/code_number/code_entry phases,
 * end to end through the real runtime (runPayIvrStep) against the faithful
 * FakeDb/FakePos fakes — deps.sendSms/deps.generateCode/deps.now injected so
 * the test can read the code back and control the clock (production never
 * does either). Two source guards close the loop: the reducer stays pure,
 * and the runtime never logs the raw code.
 *
 * Run: node --experimental-test-module-mocks --import tsx --test src/supermarket/payLineCode.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

process.env.CREDENTIALS_MASTER_KEY = process.env.CREDENTIALS_MASTER_KEY || "ab".repeat(32);

import { FakeDb, FakePos, makeSupermarketDb, mulberry32 } from "./supermarketTestKit";
import { posClientForTenant, storeIntegrationKey } from "./integrationCredentials";
import {
  PAY_CODE_LENGTH,
  PAY_MAX_CODE_ATTEMPTS,
  PAY_MAX_CODE_SENDS,
  PAY_MAX_CODE_WAITS,
  codeCallPromptRefs,
} from "./payIvrCore";
import { runPayIvrStep, PAY_CODE_TTL_MS, type PayIvrRuntimeDeps } from "./payIvrRuntime";
import { payLineCodeSmsBody, resolvePayLineFromNumber } from "./payLineSms";

// ─────────────────────────── shared builders (conventions from
// payLineStress.test.ts / supermarketStress.test.ts) ──────────────────────────

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

async function encryptedPin(pin: string): Promise<string> {
  const sec = await import("@connect/security");
  return sec.encryptJson({ pin });
}

// Fixed-width 10-digit phone pools — see payLineStress.test.ts for why this
// matters to the fake db's substring "contains" matching.
function pad7(i: number): string {
  return String(i).padStart(7, "0");
}
function accountPhone(i: number): string {
  return `920${pad7(i)}`;
}
function secondPhone(i: number): string {
  return `921${pad7(i)}`;
}
function thirdPhone(i: number): string {
  return `922${pad7(i)}`;
}
function foreignCaller(i: number): string {
  return `933${pad7(i)}`;
}
function realPinFor(i: number): string {
  return String(2000 + (i % 7000));
}

type Sent = { tenantId: string; to10: string; body: string };

function makeDeps(
  db: any,
  clientFor: any,
  opts: { codes: string[]; sent: Sent[]; clock: { value: number } },
): PayIvrRuntimeDeps {
  let idx = 0;
  return {
    db,
    clientFor,
    sendSms: async (input: { tenantId: string; to10: string; body: string }) => {
      opts.sent.push(input);
      return { ok: true };
    },
    generateCode: () => {
      const c = opts.codes[idx++];
      if (!c) throw new Error("generateCode called more times than the test supplied codes for");
      return c;
    },
    now: () => opts.clock.value,
  };
}

/** Drives a foreign call from nothing to the "23_pin_or_star" prompt, then
 *  presses star — landing on 24_code_channel_menu. Returns the bound `step`. */
async function driveToCodeChannelMenu(
  deps: PayIvrRuntimeDeps,
  tenantId: string,
  callId: string,
  callerNumber: string,
  accountPhoneDigits: string,
) {
  const step = (digits?: string, hangup?: boolean) =>
    runPayIvrStep(deps, { tenantId, callId, callerNumber, digits, hangup });
  let out = await step();
  assert.equal(out.gather?.what, "phone", "expected the lookup prompt for an unknown caller");
  out = await step(accountPhoneDigits);
  assert.equal(out.gather?.what, "pin", `expected to be asked a PIN after lookup: ${JSON.stringify(out)}`);
  assert.ok(out.prompts.includes("23_pin_or_star"), "a foreign caller must hear the star-aware prompt");
  out = await step("*");
  assert.ok(out.prompts.includes("24_code_channel_menu"), `star did not reach the code channel menu: ${JSON.stringify(out)}`);
  return { step, out };
}

/** Longest run of consecutive single-digit prompt refs ("num_0".."num_9") —
 *  a full 10-digit account number spoken anywhere would show up as a run >= 10. */
function longestDigitRun(prompts: string[]): number {
  let max = 0;
  let cur = 0;
  for (const p of prompts) {
    if (/^num_\d$/.test(p)) {
      cur++;
      max = Math.max(max, cur);
    } else {
      cur = 0;
    }
  }
  return max;
}

// ═══════════════════════════ basic delivery + verification ═══════════════════

test("text delivery to the account's only number, correct code first try: enrolled PIN silently verifies and pays; never re-enrolled", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-code-a";
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const phone = accountPhone(1);
  const realPin = "4455";
  pos.addCustomer({ id: "acc-a", phone10: phone, pin: realPin, balanceCents: 10_000, cards: [{ id: "cd1", masked: "x" }] });
  db.seed("posCustomer", { tenantId, posCustomerId: "acc-a", phonesText: phone, primaryPhone: phone });
  // The desk already enrolled this account's PIN from a prior matched call.
  db.seed("supermarketPhonePin", {
    tenantId,
    posCustomerId: "acc-a",
    phoneE164: `+1${phone}`,
    pinEnc: await encryptedPin(realPin),
    lastUsedAt: new Date(),
  });

  const CODE = "482913";
  const sent: Sent[] = [];
  const deps = makeDeps(db, clientFor, { codes: [CODE], sent, clock: { value: 1_000_000 } });

  const { step } = await driveToCodeChannelMenu(deps, tenantId, "call-a", foreignCaller(1), phone);
  let out = await step("2"); // text
  assert.ok(out.prompts.includes("32_code_text_sent"));
  assert.equal(out.gather?.what, "code");
  assert.equal(out.gather?.maxDigits, PAY_CODE_LENGTH);
  assert.equal(sent.length, 1, "exactly one text sent");
  assert.equal(sent[0].to10, phone, "the code must go to an account number, not the foreign caller");
  assert.ok(sent[0].body.includes(CODE), "the SMS body must carry the code");
  assert.ok(sent[0].body.includes("10 minutes"));

  const row1 = await db.supermarketPayCall.findFirst({ where: { tenantId, callId: "call-a" } });
  assert.ok(row1.state.codeHash, "codeHash was not persisted");
  assert.equal(row1.state.codeExpiresAt, 1_000_000 + PAY_CODE_TTL_MS);
  assert.ok(!JSON.stringify(row1.state).includes(CODE), "the raw code must never be persisted");

  out = await step(CODE);
  assert.ok(out.prompts.includes("22_main_menu"), `expected the main menu: ${JSON.stringify(out)}`);
  assert.equal(out.transfer, false);

  const row2 = await db.supermarketPayCall.findFirst({ where: { tenantId, callId: "call-a" } });
  assert.ok(!JSON.stringify(row2.state).includes(CODE), "the raw code leaked into the post-verify state");
  assert.equal(row2.state.codeHash, null, "the spent code's hash must be cleared");

  // pays like a matched caller
  out = await step("2"); // payment
  out = await step("5*00");
  out = await step("1"); // confirm
  assert.ok(out.prompts.includes("09_approved_intro"), JSON.stringify(out));
  assert.equal(pos.charges.size, 1);

  // never re-enrolled by the code path — still exactly the one pre-seeded row.
  assert.equal(
    db.rows("supermarketPhonePin").filter((r: any) => r.tenantId === tenantId).length,
    1,
    "the code flow must never create a second enrollment",
  );
});

test("text delivery, NO enrolled PIN on the account: a correct code still never enrolls — the caller is blocked, flagged pin_not_enrolled, for the desk", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-code-b";
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const phone = accountPhone(2);
  const realPin = "6677";
  pos.addCustomer({ id: "acc-b", phone10: phone, pin: realPin, balanceCents: 2_000, cards: [] });
  db.seed("posCustomer", { tenantId, posCustomerId: "acc-b", phonesText: phone, primaryPhone: phone });

  const CODE = "119922";
  const sent: Sent[] = [];
  const deps = makeDeps(db, clientFor, { codes: [CODE], sent, clock: { value: 2_000_000 } });

  const { step } = await driveToCodeChannelMenu(deps, tenantId, "call-b", foreignCaller(2), phone);
  await step("2"); // text
  const out = await step(CODE);
  assert.equal(out.transfer, true, "an unenrolled account must still land on a person after a correct code");
  assert.ok(out.prompts.includes("20_connect_person"));
  assert.ok(!out.prompts.includes("22_main_menu"));

  const row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId: "call-b" } });
  assert.equal(row.status, "pin_not_enrolled");
  assert.equal(row.state.blockedReason, "pin_not_enrolled");
  assert.equal(row.state.ownerVerified, true, "ownership WAS proven — it just isn't enough without an enrolled PIN");
  assert.equal(db.rows("supermarketPhonePin").filter((r: any) => r.tenantId === tenantId).length, 0, "a verified owner must NEVER be enrolled");
});

test("phone-call delivery with 3 numbers on the account: the menu speaks only last-four digits, dial/dialPrompts carry the code, and a full number is never spoken", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-code-c";
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const p1 = accountPhone(3);
  const p2 = secondPhone(3);
  const p3 = thirdPhone(3);
  const realPin = "9081";
  pos.addCustomer({ id: "acc-c", phone10: p1, pin: realPin, balanceCents: 5_000, cards: [{ id: "cd", masked: "x" }], phones: [p2, p3] });
  db.seed("posCustomer", { tenantId, posCustomerId: "acc-c", phonesText: `${p1} ${p2} ${p3}`, primaryPhone: p1 });
  db.seed("supermarketPhonePin", {
    tenantId, posCustomerId: "acc-c", phoneE164: `+1${p1}`, pinEnc: await encryptedPin(realPin), lastUsedAt: new Date(),
  });

  const CODE = "610284";
  const sent: Sent[] = [];
  const deps = makeDeps(db, clientFor, { codes: [CODE], sent, clock: { value: 5_000_000 } });
  const { step } = await driveToCodeChannelMenu(deps, tenantId, "call-c", foreignCaller(3), p1);

  let out = await step("1"); // call
  assert.ok(out.prompts.includes("25_code_number_intro"));
  const numbers = [p1, p2, p3];
  let cursor = out.prompts.indexOf("25_code_number_intro") + 1;
  for (let i = 0; i < 3; i++) {
    assert.equal(out.prompts[cursor], "26_press");
    assert.equal(out.prompts[cursor + 1], `num_${i + 1}`);
    assert.equal(out.prompts[cursor + 2], "27_for_number_ending_in");
    const last4 = numbers[i].slice(-4);
    for (let d = 0; d < 4; d++) assert.equal(out.prompts[cursor + 3 + d], `num_${last4[d]}`);
    cursor += 7;
  }
  assert.equal(out.prompts.length, cursor, "no extra prompts beyond the three number entries");
  assert.ok(longestDigitRun(out.prompts) < 10, "a full account number must never be spoken");

  out = await step("2"); // pick the SECOND number
  assert.ok(out.prompts.includes("31_code_call_sent"));
  assert.equal(out.dial, p2, "the dial target must be the number the caller picked, not the primary");
  assert.deepEqual(out.dialPrompts, codeCallPromptRefs(CODE));
  assert.equal(sent.length, 0, "a phone-call delivery must never also text");

  const row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId: "call-c" } });
  assert.ok(!JSON.stringify(row.state).includes(CODE));

  out = await step(CODE);
  assert.ok(out.prompts.includes("22_main_menu"));
});

test("zero numbers on the account (register AND mirror both empty): straight to a person — no code channel possible", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-code-h";
  await seedPosTenant(db, tenantId, pos);
  const phone = accountPhone(4);
  pos.addCustomer({ id: "acc-h", phone10: phone, pin: "1212", balanceCents: 1_000, cards: [] });
  // ⛔ deliberately NO posCustomer mirror row — the fallback has nothing either.
  const base = pos.fetchImpl;
  const wrapped = async (url: string, init: any) => {
    const p = new URL(url).pathname;
    if (/^\/customers\/id\/[^/]+$/.test(p) && init.method === "GET") {
      return { status: 404, headers: { get: () => null }, text: async () => JSON.stringify({ error: "not found" }) };
    }
    return base(url, init);
  };
  const clientFor = async (db2: any, tid: string) => (tid === tenantId ? posClientForTenant(db2, tid, { fetchImpl: wrapped }) : null);
  const deps = makeDeps(db, clientFor as any, { codes: [], sent: [], clock: { value: 1 } });

  const { step } = await driveToCodeChannelMenu(deps, tenantId, "call-h", foreignCaller(4), phone);
  const out = await step("2"); // text
  assert.equal(out.transfer, true);
  assert.ok(out.prompts.includes("20_connect_person"));
});

// ═══════════════════════════ entry-phase edge cases ═══════════════════════════

test("empty digits (the caller never keys anything) replay 30_enter_code up to 8 times, then a person", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-code-d";
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const phone = accountPhone(5);
  pos.addCustomer({ id: "acc-d", phone10: phone, pin: "3344", balanceCents: 1_000, cards: [] });
  const CODE = "224466";
  const deps = makeDeps(db, clientFor, { codes: [CODE], sent: [], clock: { value: 1 } });
  const { step } = await driveToCodeChannelMenu(deps, tenantId, "call-d", foreignCaller(5), phone);
  await step("2");

  for (let i = 0; i < PAY_MAX_CODE_WAITS; i++) {
    const out = await step("");
    assert.equal(out.gather?.what, "code", `expected to still be gathering at empty read ${i + 1}`);
    assert.ok(out.prompts.includes("30_enter_code"));
  }
  const last = await step("");
  assert.equal(last.transfer, true, `the ${PAY_MAX_CODE_WAITS + 1}th empty read must transfer`);
  assert.ok(last.prompts.includes("20_connect_person"));
});

test("wrong code twice then correct succeeds; three wrong codes land on a person and never enroll", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-code-e";
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));

  // scenario 1: wrong, wrong, right — with an enrolled vault to prove through.
  const phone1 = accountPhone(6);
  pos.addCustomer({ id: "acc-e1", phone10: phone1, pin: "5566", balanceCents: 1_000, cards: [] });
  db.seed("supermarketPhonePin", { tenantId, posCustomerId: "acc-e1", phoneE164: `+1${phone1}`, pinEnc: await encryptedPin("5566"), lastUsedAt: new Date() });
  const CODE1 = "334455";
  const deps1 = makeDeps(db, clientFor, { codes: [CODE1], sent: [], clock: { value: 1 } });
  const { step: step1 } = await driveToCodeChannelMenu(deps1, tenantId, "call-e1", foreignCaller(6), phone1);
  await step1("2");
  let out = await step1("111111");
  assert.ok(out.prompts.includes("33_code_wrong"));
  assert.ok(out.prompts.includes("30_enter_code"));
  assert.equal(out.gather?.what, "code");
  out = await step1("222222");
  assert.ok(out.prompts.includes("33_code_wrong"));
  out = await step1(CODE1);
  assert.ok(out.prompts.includes("22_main_menu"), `two wrong codes should not burn the cap: ${JSON.stringify(out)}`);

  // scenario 2: three wrong codes in a row → a person, never enrolled.
  const phone2 = accountPhone(7);
  pos.addCustomer({ id: "acc-e2", phone10: phone2, pin: "7788", balanceCents: 1_000, cards: [] });
  const CODE2 = "667788";
  const deps2 = makeDeps(db, clientFor, { codes: [CODE2], sent: [], clock: { value: 1 } });
  const { step: step2 } = await driveToCodeChannelMenu(deps2, tenantId, "call-e2", foreignCaller(7), phone2);
  await step2("2");
  let out2: any = null;
  for (let i = 0; i < PAY_MAX_CODE_ATTEMPTS; i++) {
    out2 = await step2("000000"); // never the real code
  }
  assert.equal(out2.transfer, true, `${PAY_MAX_CODE_ATTEMPTS} wrong codes must transfer`);
  assert.ok(out2.prompts.includes("15_too_many_tries"));
  assert.equal(db.rows("supermarketPhonePin").filter((r: any) => r.tenantId === tenantId && r.posCustomerId === "acc-e2").length, 0);
});

test("an expired code re-offers the channel menu once (a send remains), and lands on a person once the resend cap is spent", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-code-f";
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const phone = accountPhone(8);
  pos.addCustomer({ id: "acc-f", phone10: phone, pin: "9900", balanceCents: 1_000, cards: [] });
  const CODE1 = "111222";
  const CODE2 = "333444";
  const clock = { value: 100_000 };
  const deps = makeDeps(db, clientFor, { codes: [CODE1, CODE2], sent: [], clock });
  const { step } = await driveToCodeChannelMenu(deps, tenantId, "call-f", foreignCaller(8), phone);
  await step("2"); // send #1

  clock.value += PAY_CODE_TTL_MS + 1; // expire it
  let out = await step(CODE1);
  assert.ok(out.prompts.includes("33_code_wrong"));
  assert.ok(out.prompts.includes("24_code_channel_menu"), `a send remains — must re-offer the channel menu: ${JSON.stringify(out)}`);
  assert.equal(out.gather?.what, "menu");

  out = await step("2"); // send #2 (the resend)
  assert.ok(out.prompts.includes("32_code_text_sent"));

  clock.value += PAY_CODE_TTL_MS + 1; // expire the resend too
  out = await step(CODE2);
  assert.equal(out.transfer, true, `no sends remain — must land on a person: ${JSON.stringify(out)}`);
  assert.ok(out.prompts.includes("33_code_wrong"));
  assert.ok(!out.prompts.includes("24_code_channel_menu"), "no sends remain — must not offer another resend");
});

test("pressing star resends once (two sends total); a third resend attempt is refused and lands on a person, never a third text", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-code-g";
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const phone = accountPhone(9);
  pos.addCustomer({ id: "acc-g", phone10: phone, pin: "1231", balanceCents: 1_000, cards: [] });
  const sent: Sent[] = [];
  const deps = makeDeps(db, clientFor, { codes: ["555111", "555222"], sent, clock: { value: 1 } });
  const { step } = await driveToCodeChannelMenu(deps, tenantId, "call-g", foreignCaller(9), phone);
  await step("2"); // send #1
  assert.equal(sent.length, 1);

  let out = await step("*");
  assert.ok(out.prompts.includes("24_code_channel_menu"));
  out = await step("2"); // send #2 (resend)
  assert.ok(out.prompts.includes("32_code_text_sent"));
  assert.equal(sent.length, 2, "expected exactly two sends");

  out = await step("*"); // third resend attempt: cap reached
  assert.equal(out.transfer, true, "PAY_MAX_CODE_SENDS is 2 — a third resend must be refused");
  assert.ok(out.prompts.includes("20_connect_person"));
  assert.equal(sent.length, 2, "must never exceed the send cap");
});

// ═══════════════════════════ payLineSms ═══════════════════════════════════════

test("payLineCodeSmsBody carries the code and the store name, expires in 10 minutes, ASCII only (an emoji doubles SMS segments)", () => {
  const body = payLineCodeSmsBody("482913", "Gesheft");
  assert.ok(body.includes("482913"));
  assert.ok(body.includes("Gesheft"));
  assert.ok(body.includes("10 minutes"));
  assert.ok(/^[\x00-\x7F]*$/.test(body), "ASCII only");
});

test("resolvePayLineFromNumber: a default VoIP.ms number is ok; anything else (non-VOIPMS, non-default account, or no number) is refused with a reason", async () => {
  const rowFor = (row: any) => ({ tenantSmsNumber: { findFirst: async () => row } });

  const ok = await resolvePayLineFromNumber(rowFor({ phoneE164: "+18452449666", provider: "VOIPMS", voipmsAccountId: "default" }), "t1");
  assert.deepEqual(ok, { e164: "+18452449666" });

  const noNumber = await resolvePayLineFromNumber(rowFor(null), "t1");
  assert.deepEqual(noNumber, { error: "tenant_has_no_texting_number" });

  const notVoipms = await resolvePayLineFromNumber(rowFor({ phoneE164: "+18450000000", provider: "TELNYX", voipmsAccountId: "default" }), "t1");
  assert.deepEqual(notVoipms, { error: "tenant_number_not_voipms" });

  const notDefaultAccount = await resolvePayLineFromNumber(
    rowFor({ phoneE164: "+18450000000", provider: "VOIPMS", voipmsAccountId: "second" }),
    "t1",
  );
  assert.deepEqual(notDefaultAccount, { error: "tenant_number_not_on_default_account" });

  // the lookup throwing is treated the same as "no number" — never surfaced as an exception
  const thrown = await resolvePayLineFromNumber({ tenantSmsNumber: { findFirst: async () => { throw new Error("db down"); } } }, "t1");
  assert.deepEqual(thrown, { error: "tenant_has_no_texting_number" });
});

// ═══════════════════════════ source guards ═══════════════════════════════════

test("⛔ payIvrCore.ts stays pure: no imports beyond ./payAmount (no IO, no Date, no other module)", () => {
  const src = readFileSync(path.join(__dirname, "payIvrCore.ts"), "utf8");
  const imports = [...src.matchAll(/^import[^\n]+from\s+["']([^"']+)["'];?/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0, "no imports found — this guard would pass vacuously");
  for (const spec of imports) {
    assert.equal(spec, "./payAmount", `payIvrCore.ts imports "${spec}" — the reducer must stay pure`);
  }
});

function firstArgObjectsOfLogCalls(src: string): string[] {
  const out: string[] = [];
  const re = /log\.(?:info|warn)\(\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const start = re.lastIndex - 1; // the '{'
    let depth = 0;
    let i = start;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    out.push(src.slice(start, i));
  }
  return out;
}

test("⛔ the runtime never logs the raw one-time code — only a masked tail (…XXXX) ever appears in a log call's metadata", () => {
  const src = readFileSync(path.join(__dirname, "payIvrRuntime.ts"), "utf8")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const objs = firstArgObjectsOfLogCalls(src);
  assert.ok(objs.length >= 4, `expected several log calls in the send_code/verify_code effects, found ${objs.length}`);
  for (const obj of objs) {
    // (?<!\.)\bcode\b matches only the bare identifier — "codeHash"/"codeChannel"/
    // "codeSentTo"/etc. are one word to a regex word boundary and never trip this,
    // and the exclusion lets a PosApiError's `.code`/`?.code` PROPERTY (an error
    // code like "pos_not_found", unrelated to the one-time code) through.
    assert.ok(!/(?<!\.)\bcode\b/.test(obj), `a log call's metadata references the raw code variable: ${obj}`);
  }
  assert.ok(
    objs.some((o) => /…\$\{effect\.phone10\.slice\(-4\)\}/.test(o)),
    "expected the masked 'to: …XXXX' shape in at least one log call",
  );
});

// ═══════════════════════════ PAY-LINE CODE STRESS ═════════════════════════════

test(
  "PAY-LINE CODE STRESS — 500 scripted foreign callers x {call,text} x {1,3 numbers} x {right, wrong-then-right, expired-then-resend, star-resend, timeout}: code never persisted, only account numbers ever texted/dialled, <=2 sends/call, every failure ends on a person, exactly one charge for the ones that pay",
  async () => {
    const db = makeSupermarketDb();
    const pos = new FakePos();
    const tenantId = "t-code-stress";
    await seedPosTenant(db, tenantId, pos);
    const clientFor = clientForFactory(new Map([[tenantId, pos]]));

    const N = 500;
    const BEHAVIORS = ["right", "wrong_then_right", "expired_then_resend", "star_resend", "timeout"] as const;
    type Behavior = (typeof BEHAVIORS)[number];
    const rnd = mulberry32(20260917);

    const codeFor = (i: number) => String(100_000 + i).padStart(6, "0");
    const resendCodeFor = (i: number) => String(500_000 + i).padStart(6, "0");
    const wrongCodeFor = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

    type Account = {
      i: number;
      id: string;
      phones: string[];
      realPin: string;
      channel: "call" | "text";
      numbersCount: 1 | 3;
      behavior: Behavior;
      hasVault: boolean;
      pickIndex: number;
    };
    const accounts: Account[] = [];
    for (let i = 0; i < N; i++) {
      const channel: "call" | "text" = rnd() < 0.5 ? "call" : "text";
      const numbersCount: 1 | 3 = rnd() < 0.5 ? 1 : 3;
      const behavior = BEHAVIORS[i % BEHAVIORS.length];
      const hasVault = rnd() < 0.5;
      const pickIndex = numbersCount === 3 ? 1 + Math.floor(rnd() * 3) : 1;
      const realPin = realPinFor(i);
      const p1 = accountPhone(i);
      const extra = numbersCount === 3 ? [secondPhone(i), thirdPhone(i)] : [];
      const id = `cs-${i}`;
      pos.addCustomer({ id, phone10: p1, pin: realPin, balanceCents: 900_000, cards: [{ id: `card-${i}`, masked: "x" }], phones: extra });
      db.seed("posCustomer", { tenantId, posCustomerId: id, phonesText: [p1, ...extra].join(" "), primaryPhone: p1 });
      if (hasVault) {
        db.seed("supermarketPhonePin", {
          tenantId, posCustomerId: id, phoneE164: `+1${p1}`, pinEnc: await encryptedPin(realPin), lastUsedAt: new Date(),
        });
      }
      accounts.push({ i, id, phones: [p1, ...extra], realPin, channel, numbersCount, behavior, hasVault, pickIndex });
    }

    let charges = 0;

    for (const acct of accounts) {
      const callId = `cs-call-${acct.i}`;
      const callerNumber = foreignCaller(acct.i);
      const CODE = codeFor(acct.i);
      const RESEND_CODE = resendCodeFor(acct.i);
      const needsResend = acct.behavior === "expired_then_resend" || acct.behavior === "star_resend";
      const sentThisCall: Sent[] = [];
      const clock = { value: 10_000_000 + acct.i };
      const deps = makeDeps(db, clientFor, {
        codes: needsResend ? [CODE, RESEND_CODE] : [CODE],
        sent: sentThisCall,
        clock,
      });
      const snapshots: string[] = [];
      const step = async (digits?: string) => {
        const o = await runPayIvrStep(deps, { tenantId, callId, callerNumber, digits });
        const row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
        snapshots.push(JSON.stringify(row?.state ?? null));
        return o;
      };

      let out = await step();
      out = await step(acct.phones[0]);
      assert.ok(out.prompts.includes("23_pin_or_star"), `acct ${acct.id} not asked the foreign PIN-or-star prompt`);
      out = await step("*");

      const chooseChannelAndNumber = async (expectedCode: string) => {
        let o = await step(acct.channel === "call" ? "1" : "2");
        if (acct.numbersCount === 3) o = await step(String(acct.pickIndex));
        const chosenPhone = acct.phones[acct.pickIndex - 1];
        if (acct.channel === "text") {
          assert.ok(sentThisCall.at(-1)?.to10 === chosenPhone, `acct ${acct.id}: code texted to a non-account number`);
        } else {
          assert.equal(o.dial, chosenPhone, `acct ${acct.id}: dial target must be an account number`);
          assert.deepEqual(o.dialPrompts, codeCallPromptRefs(expectedCode));
        }
        return o;
      };

      out = await chooseChannelAndNumber(CODE);
      assert.equal(out.gather?.what, "code", `acct ${acct.id} did not reach the code entry gather: ${JSON.stringify(out)}`);
      let sendsUsed = 1;

      switch (acct.behavior) {
        case "right":
          out = await step(CODE);
          break;
        case "wrong_then_right":
          out = await step(wrongCodeFor(CODE));
          assert.equal(out.gather?.what, "code", `acct ${acct.id}: one wrong code must not burn the cap`);
          out = await step(CODE);
          break;
        case "expired_then_resend":
          clock.value += PAY_CODE_TTL_MS + 1000;
          out = await step(CODE);
          assert.ok(out.prompts.includes("33_code_wrong"));
          assert.equal(out.gather?.what, "menu", `acct ${acct.id}: expiry with a send remaining must re-offer the channel menu`);
          out = await chooseChannelAndNumber(RESEND_CODE);
          sendsUsed = 2;
          out = await step(RESEND_CODE);
          break;
        case "star_resend":
          out = await step("*");
          assert.ok(out.prompts.includes("24_code_channel_menu"));
          out = await chooseChannelAndNumber(RESEND_CODE);
          sendsUsed = 2;
          out = await step(RESEND_CODE);
          break;
        case "timeout":
          for (let w = 0; w < PAY_MAX_CODE_WAITS + 1; w++) out = await step("");
          break;
      }

      assert.ok(sendsUsed <= PAY_MAX_CODE_SENDS, `acct ${acct.id} used ${sendsUsed} sends, more than the cap`);

      if (acct.behavior === "timeout") {
        assert.equal(out.transfer, true, `acct ${acct.id}: a timed-out code entry must transfer`);
        assert.ok(out.prompts.includes("20_connect_person"));
      } else if (acct.hasVault) {
        assert.ok(out.prompts.includes("22_main_menu"), `acct ${acct.id} had a vault but was not silently served: ${JSON.stringify(out)}`);
        out = await step("2"); // payment
        out = await step("3*33");
        out = await step("1"); // confirm
        assert.ok(out.prompts.includes("09_approved_intro"), `acct ${acct.id} charge failed: ${JSON.stringify(out)}`);
        charges++;
      } else {
        assert.equal(out.transfer, true, `acct ${acct.id} had no vault but was not blocked: ${JSON.stringify(out)}`);
        assert.ok(out.prompts.includes("20_connect_person"));
      }

      // the raw code(s) for THIS call must never appear in any of its own
      // persisted state snapshots.
      const codesUsed = needsResend ? [CODE, RESEND_CODE] : [CODE];
      for (const snap of snapshots) {
        for (const code of codesUsed) {
          assert.ok(!snap.includes(code), `acct ${acct.id} persisted the raw code ${code} in session state`);
        }
      }
    }

    assert.equal(pos.charges.size, charges, "charge count mismatch");
    assert.equal(new Set(pos.charges.keys()).size, pos.charges.size, "duplicate externalId in the ledger");

    // GLOBAL: a foreign code-verified call must NEVER enroll a PIN — the only
    // vault rows that can exist are the ones this test pre-seeded.
    const preSeededCount = accounts.filter((a) => a.hasVault).length;
    const finalVaultRows = db.rows("supermarketPhonePin").filter((r: any) => r.tenantId === tenantId);
    assert.equal(finalVaultRows.length, preSeededCount, "a foreign code call enrolled a NEW pin — must never happen");

    console.log(
      `[PAY-LINE CODE STRESS] accounts=${N} charges=${charges} vaultRows=${finalVaultRows.length} preSeeded=${preSeededCount}`,
    );
  },
);
