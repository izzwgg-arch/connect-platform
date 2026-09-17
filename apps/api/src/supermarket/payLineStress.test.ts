/**
 * PAY-LINE HEAVY STRESS TESTS — independent proof for the 2026-09-17 caller-ID
 * rule (payIvrCore.ts) and its runtime wiring (payIvrRuntime.ts), on top of the
 * existing STRESS 1/4/17/22 coverage in supermarketStress.test.ts.
 *
 * Every test drives the REAL modules (reducer, runtime, dialplan view, routes)
 * against the faithful fakes in supermarketTestKit — no mocks of our own code,
 * only FakeDb/FakePos standing in for Postgres/the register. Deterministic
 * PRNG (mulberry32) everywhere, so a failure's seed reproduces it exactly.
 *
 * Run: node --experimental-test-module-mocks --import tsx --test src/supermarket/payLineStress.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

process.env.CREDENTIALS_MASTER_KEY = process.env.CREDENTIALS_MASTER_KEY || "ab".repeat(32);
process.env.CDR_INGEST_SECRET = process.env.CDR_INGEST_SECRET || "stress-internal-secret-000111222333";

import { FakeDb, FakePos, makeSupermarketDb, mulberry32 } from "./supermarketTestKit";
import { classifyPinRefusal } from "./posWithLogic";
import { PAY_PROBE_PIN, initialPayIvrState, type PayIvrPhase, type PayIvrState } from "./payIvrCore";
import { runPayIvrStep } from "./payIvrRuntime";
import { registerSupermarketRoutes } from "./supermarketRoutes";
import { checkInternalSecret } from "../internalSecret";
import { storeIntegrationKey, posClientForTenant } from "./integrationCredentials";

// ─────────────────────────── shared builders (copied conventions from
// supermarketStress.test.ts: seedPosTenant / clientForFactory / mulberry32) ──

async function seedPosTenant(db: FakeDb, tenantId: string, pos: FakePos) {
  db.seed("tenant", { id: tenantId, name: `Store ${tenantId}`, crmMode: "supermarket" });
  db.seed("user", { id: `admin-${tenantId}`, tenantId, email: `admin-${tenantId}@x.com`, role: "SUPER_ADMIN" });
  await storeIntegrationKey(db, {
    tenantId,
    provider: "POS_TRACKING",
    apiKey: pos.apiKey,
    actorUserId: `admin-${tenantId}`,
  });
}

function clientForFactory(posByTenant: Map<string, FakePos>) {
  return async (db: any, tenantId: string, deps: any = {}) => {
    const pos = posByTenant.get(tenantId);
    if (!pos) return null;
    return posClientForTenant(db, tenantId, { ...deps, fetchImpl: pos.fetchImpl });
  };
}

/** Encrypts a PIN exactly the way payIvrRuntime's enroll_pin effect does, for
 *  pre-seeding vault rows (correct / stale) without going through a live call. */
async function encryptedPin(pin: string): Promise<string> {
  const sec = await import("@connect/security");
  return sec.encryptJson({ pin });
}

// ─────────────────────────── deterministic phone/pin pools ──────────────────
// Fixed-width prefixes so posCustomer.phonesText "contains" lookups (the fake
// db's substring match) can never accidentally cross-match a different
// account: every token is exactly 10 digits, so a match can only be exact.

function pad7(i: number): string {
  return String(i).padStart(7, "0");
}
function primaryPhone(i: number): string {
  return `900${pad7(i)}`;
}
function secondPhone(i: number): string {
  return `901${pad7(i)}`;
}
function foreignPhone(i: number): string {
  return `955${pad7(i)}`;
}
function realPinFor(i: number): string {
  return String(1000 + (i % 9000));
}

// ─────────────────────────── scripted caller ─────────────────────────────────
// Drives runPayIvrStep to completion the way a well-behaved caller would:
// keys whatever the current gather wants, picks balance/payment, confirms.
// Tracks how many times 02_pin was heard (the caller-ID rule's core signal).

type ScriptOpts = {
  targetPhone?: string;
  pin?: string;
  wantsPayment?: boolean;
  amount?: string;
};

async function scriptedCall(
  deps: { db: any; clientFor: any },
  tenantId: string,
  callId: string,
  callerNumber: string,
  opts: ScriptOpts,
): Promise<{ steps: any[]; pin02Count: number; pinStarCount: number; finalOut: any }> {
  const step = (digits?: string, hangup?: boolean) =>
    runPayIvrStep(deps as any, { tenantId, callId, callerNumber, digits, hangup });
  const steps: any[] = [];
  let pin02Count = 0;
  let pinStarCount = 0;
  const record = (o: any) => {
    steps.push(o);
    if (o.prompts.includes("02_pin")) pin02Count++;
    if (o.prompts.includes("23_pin_or_star")) pinStarCount++;
  };

  let out = await step();
  record(out);
  let actionTaken = false;
  let guard = 0;
  while (guard++ < 10 && out.gather && !out.transfer && !out.done) {
    const what = out.gather.what;
    if (what === "menu" && actionTaken) {
      out = await step(undefined, true);
      record(out);
      break;
    }
    let digits: string;
    if (what === "phone") digits = opts.targetPhone ?? "8456624417";
    else if (what === "pin") digits = opts.pin ?? "0000";
    else if (what === "menu") {
      digits = opts.wantsPayment ? "2" : "1";
      actionTaken = true;
    } else if (what === "amount") digits = opts.amount ?? "12*34";
    else if (what === "confirm") digits = "1";
    else digits = "0";
    out = await step(digits);
    record(out);
  }
  return { steps, pin02Count, pinStarCount, finalOut: out };
}

// ═══════════════════════════════ PAYLINE 1 ═══════════════════════════════════
// Run twice: once for the DEFAULT policy ('never' — a matched caller with
// nothing enrolled is blocked at once, never asked) and once for the operator
// switch ('ask_once' — the pre-09-17 behaviour, verbatim). A foreign number's
// PIN prompt is "23_pin_or_star", never "02_pin" — tracked separately.

async function runCallerIdMatrix(policy: "never" | "ask_once") {
  const ACCOUNTS = 2000;
  const seed = policy === "never" ? 5150 : 51501;
  const rnd = mulberry32(seed);
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = `t-callerid-${policy}`;
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any, matchedPinPolicy: policy };

  type Scenario = "own_primary" | "own_second" | "foreign";
  type Vault = "none" | "correct" | "stale";
  type Account = {
    i: number;
    id: string;
    pinSet: boolean;
    realPin: string | null;
    hasCard: boolean;
    scenario: Scenario;
    vault: Vault;
  };
  const accounts: Account[] = [];

  for (let i = 0; i < ACCOUNTS; i++) {
    const pinSet = rnd() < 0.16; // the live ratio noted in the task
    const realPin = pinSet ? realPinFor(i) : null;
    const hasCard = rnd() < 0.07;
    const sRoll = rnd();
    const scenario: Scenario = sRoll < 1 / 3 ? "own_primary" : sRoll < 2 / 3 ? "own_second" : "foreign";
    const vRoll = rnd();
    const vault: Vault =
      !pinSet || scenario === "foreign" ? "none" : vRoll < 1 / 3 ? "none" : vRoll < 2 / 3 ? "correct" : "stale";
    const id = `pl-${i}`;
    accounts.push({ i, id, pinSet, realPin, hasCard, scenario, vault });

    pos.addCustomer({
      id,
      phone10: primaryPhone(i),
      pin: realPin,
      balanceCents: 500_000,
      cards: hasCard ? [{ id: `card-${i}`, masked: `x${i}` }] : [],
    });
    db.seed("posCustomer", {
      tenantId,
      posCustomerId: id,
      name: `Acct ${i}`,
      phonesText: `${primaryPhone(i)} ${secondPhone(i)}`,
      primaryPhone: primaryPhone(i),
    });
    if (vault === "correct" && realPin) {
      db.seed("supermarketPhonePin", {
        tenantId,
        posCustomerId: id,
        phoneE164: `+1${primaryPhone(i)}`,
        pinEnc: await encryptedPin(realPin),
        lastUsedAt: new Date(),
      });
    } else if (vault === "stale" && realPin) {
      db.seed("supermarketPhonePin", {
        tenantId,
        posCustomerId: id,
        phoneE164: `+1${primaryPhone(i)}`,
        pinEnc: await encryptedPin(`${realPin}x`),
        lastUsedAt: new Date(),
      });
    }
  }

  let silentServed = 0;
  let askedOnce = 0; // ask_once policy only
  let blockedNotEnrolled = 0; // never policy only
  let noPinLandings = 0;
  let foreignAskedOnce = 0;
  let charges = 0;
  const foreignAccountIds = new Set<string>();
  const acctById = new Map(accounts.map((a) => [a.id, a]));

  for (const acct of accounts) {
    const callerNumber =
      acct.scenario === "own_primary"
        ? primaryPhone(acct.i)
        : acct.scenario === "own_second"
          ? secondPhone(acct.i)
          : foreignPhone(acct.i);
    if (acct.scenario === "foreign") foreignAccountIds.add(acct.id);

    // ---- call 1 ----
    const before1 = pos.requestLog.length;
    const call1 = await scriptedCall(deps, tenantId, `${acct.id}-c1`, callerNumber, {
      targetPhone: acct.scenario === "foreign" ? primaryPhone(acct.i) : undefined,
      pin: acct.realPin ?? "0000",
      wantsPayment: rnd() < 0.5,
    });
    const mine1 = pos.requestLog.slice(before1);
    const pinGated1 = mine1.filter((r) => r.pin !== null);
    assert.ok(mine1.length <= 6, `call1 request count too high for ${acct.id}: ${mine1.length}`);

    const row1 = await db.supermarketPayCall.findFirst({ where: { tenantId, callId: `${acct.id}-c1` } });
    assert.ok(row1, `no session row for ${acct.id}`);

    if (!acct.pinSet) {
      // No PIN anywhere in the POS: EVERY caller — matched or foreign — is
      // blocked at once by the silent probe, regardless of policy. Nobody is
      // ever asked, because nothing any caller keys can ever satisfy it.
      assert.equal(pinGated1.length, 1, `no-pin account cost != 1 pin-gated read: ${acct.id}`);
      assert.equal(call1.pin02Count, 0, `no-pin account heard the matched-caller PIN prompt: ${acct.id}`);
      assert.equal(call1.pinStarCount, 0, `no-pin account heard the foreign PIN-or-star prompt: ${acct.id}`);
      const last = call1.steps.at(-1);
      assert.equal(last.transfer, true, `no-pin account not transferred: ${acct.id}`);
      assert.equal(last.gather, null, `no-pin account had a gather before transfer: ${acct.id}`);
      assert.ok(last.prompts.includes("20_connect_person"));
      assert.equal(row1.status, "no_pin");
      assert.equal(row1.state.blockedReason, "pin_not_set");
      noPinLandings++;
      continue;
    }

    if (acct.scenario === "foreign") {
      // The account HAS a PIN in the POS: a foreign caller is probed first
      // (silent — not counted), then keys it via the star-aware prompt, every
      // single call, and is never enrolled.
      assert.equal(call1.pinStarCount, 1, `foreign caller not asked exactly once: ${acct.id}`);
      assert.equal(call1.pin02Count, 0, `foreign caller heard the matched-caller PIN prompt: ${acct.id}`);
      assert.ok(
        pinGated1.some((r) => r.pin === acct.realPin),
        `foreign caller's keyed PIN never reached the register: ${acct.id}`,
      );
      foreignAskedOnce++;
    } else if (acct.vault === "correct") {
      assert.equal(call1.pin02Count, 0, `matched caller with a correct vault was asked: ${acct.id}`);
      assert.ok(
        pinGated1.every((r) => r.pin === acct.realPin),
        `wrong pin sent for correct-vault ${acct.id}: ${JSON.stringify(pinGated1)}`,
      );
      silentServed++;
    } else if (policy === "ask_once") {
      assert.equal(call1.pin02Count, 1, `matched caller with '${acct.vault}' vault not asked exactly once: ${acct.id}`);
      assert.equal(
        pinGated1[0]?.pin,
        acct.vault === "none" ? PAY_PROBE_PIN : `${acct.realPin}x`,
        `unexpected first pin-gated value for ${acct.id}`,
      );
      askedOnce++;
    } else {
      // policy "never": nothing enrolled → blocked at once, never asked.
      assert.equal(call1.pin02Count, 0, `matched caller under 'never' was asked for a PIN: ${acct.id}`);
      assert.equal(pinGated1.length, 1, `'never' policy should cost exactly one pin-gated read: ${acct.id}`);
      assert.equal(
        pinGated1[0]?.pin,
        acct.vault === "none" ? PAY_PROBE_PIN : `${acct.realPin}x`,
        `unexpected probe/stale pin-gated value for ${acct.id}`,
      );
      const last = call1.steps.at(-1);
      assert.equal(last.transfer, true, `matched caller with nothing enrolled not blocked under 'never': ${acct.id}`);
      assert.ok(last.prompts.includes("20_connect_person"));
      assert.equal(row1.status, "pin_not_enrolled");
      assert.equal(row1.state.blockedReason, "pin_not_enrolled");
      blockedNotEnrolled++;
    }

    // ---- call 2, from the OTHER of the account's own numbers (matched only) ----
    if (acct.scenario !== "foreign") {
      const callerNumber2 = acct.scenario === "own_primary" ? secondPhone(acct.i) : primaryPhone(acct.i);
      const before2 = pos.requestLog.length;
      const call2 = await scriptedCall(deps, tenantId, `${acct.id}-c2`, callerNumber2, {
        pin: acct.realPin ?? "0000",
        wantsPayment: rnd() < 0.5,
      });
      const mine2 = pos.requestLog.slice(before2);
      const pinGated2 = mine2.filter((r) => r.pin !== null);
      if (acct.vault === "correct" || policy === "ask_once") {
        // an enrolled PIN exists by now (pre-seeded, or just enrolled by call1) — silent every time after.
        assert.equal(call2.pin02Count, 0, `second matched call (from the other own number) was asked for a PIN: ${acct.id}`);
        assert.ok(
          pinGated2.every((r) => r.pin === acct.realPin),
          `second call did not use the enrolled PIN for ${acct.id}: ${JSON.stringify(pinGated2)}`,
        );
      } else {
        // policy "never" and nothing was ever enrolled: blocked again, identically — never asked either.
        assert.equal(call2.pin02Count, 0, `second 'never'-policy call was asked for a PIN: ${acct.id}`);
        assert.equal(call2.steps.at(-1).transfer, true, `second 'never'-policy call was not blocked again: ${acct.id}`);
      }
      assert.ok(mine2.length <= 6);
    }

    for (const s of call1.steps) {
      if (s.prompts.includes("09_approved_intro")) charges++;
    }
  }

  // GLOBAL: a foreign/looked-up account is NEVER enrolled, across the whole run.
  for (const row of db.rows("supermarketPhonePin")) {
    assert.ok(!foreignAccountIds.has(row.posCustomerId), `foreign account ${row.posCustomerId} got a vault row`);
  }
  if (policy === "never") {
    // GLOBAL: under 'never' the only vault rows that can exist are the ones
    // pre-seeded as "correct" — nothing is ever enrolled by a live call.
    for (const row of db.rows("supermarketPhonePin")) {
      const acct = acctById.get(row.posCustomerId);
      assert.ok(acct && acct.vault === "correct", `a vault row was created live under 'never' policy: ${row.posCustomerId}`);
    }
  }
  // GLOBAL: session bookkeeping reconciles with the register ledger to the cent.
  const ledgerTotal = [...pos.charges.values()].reduce((s, c) => s + c.amount, 0);
  const sessionTotal = db
    .rows("supermarketPayCall")
    .filter((r: any) => r.tenantId === tenantId)
    .reduce((s: number, r: any) => s + r.chargedCents, 0);
  assert.equal(sessionTotal, ledgerTotal, "session books disagree with the register ledger");
  assert.equal(new Set(pos.charges.keys()).size, pos.charges.size, "duplicate externalId in the ledger");

  console.log(
    `[PAYLINE 1:${policy}] accounts=${ACCOUNTS} silentServed=${silentServed} askedOnce=${askedOnce} blockedNotEnrolled=${blockedNotEnrolled} ` +
      `noPinLandings=${noPinLandings} foreignAskedOnce=${foreignAskedOnce} charges=${charges} ledgerCents=${ledgerTotal} posRequests=${pos.requestLog.length}`,
  );
}

test(
  "PAYLINE 1a — caller-ID rule matrix at scale (DEFAULT policy 'never'): 2,000 accounts x {own primary, own second, foreign} caller x {no PIN, no vault, correct vault, stale vault} — nothing enrolled means blocked at once, never asked",
  () => runCallerIdMatrix("never"),
);

test(
  "PAYLINE 1b — caller-ID rule matrix at scale (operator switch matchedPinPolicy:'ask_once'): the pre-09-17 behaviour verbatim — asked once, enrolled, silent after",
  () => runCallerIdMatrix("ask_once"),
);

// ═══════════════════════════════ PAYLINE 2 ═══════════════════════════════════
// A dumb dialplan emulator: it only ever reads playback/action/maxDigits (like
// connect-supermarket-pay.conf), decides digits from the PROMPT NAMES it hears
// (the same way a human caller would), and always posts the h-extension hangup.

class DialplanDriver {
  constructor(
    private app: any,
    private secret: string,
  ) {}

  async postStep(body: any): Promise<{ statusCode: number; view: any }> {
    const res = await this.app.inject({
      method: "POST",
      url: "/internal/supermarket/pay-ivr/step",
      payload: body,
      headers: { "x-cdr-secret": this.secret },
    });
    let view: any = null;
    try {
      view = JSON.parse(res.body);
    } catch {
      /* leave null — caller asserts on it */
    }
    return { statusCode: res.statusCode, view };
  }

  promptNames(playback: string): string[] {
    if (!playback) return [];
    return playback.split("&").map((p) => p.split("/").pop() || "");
  }

  chooseDigits(
    names: string[],
    maxDigits: number,
    opts: { pin?: string; targetPhone?: string; amount?: string; wantsPayment?: boolean; confirmAccept?: boolean },
  ): string {
    if (names.includes("02_pin")) return (opts.pin ?? "0000").slice(0, maxDigits);
    if (names.includes("13_not_recognized")) return (opts.targetPhone ?? "8456624417").slice(0, maxDigits);
    if (names.includes("05_amount_prompt") || names.includes("14_invalid_amount")) return opts.amount ?? "12*34";
    if (names.includes("07_confirm_choice")) return opts.confirmAccept === false ? "2" : "1";
    if (names.includes("22_main_menu") || names.includes("21_menu_after_balance")) return opts.wantsPayment ? "2" : "1";
    return "0";
  }
}

async function buildDialplanApp(db: FakeDb, posByTenant: Map<string, FakePos>) {
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

test(
  "PAYLINE 2 — dialplan emulator end-to-end through the real HTTP door: 500 randomized calls, mid-call hangups, empty Read timeouts, duplicated POSTs",
  async () => {
    const db = makeSupermarketDb();
    const pos = new FakePos({ failEvery: 23, failStatus: 500 });
    const tenantId = "t-dial";
    await seedPosTenant(db, tenantId, pos);
    db.seed("supermarketSettings", { tenantId, payIvrEnabled: true });
    const posByTenant = new Map([[tenantId, pos]]);
    const app = await buildDialplanApp(db, posByTenant);
    const driver = new DialplanDriver(app, process.env.CDR_INGEST_SECRET!);

    const ACCOUNTS = 500;
    const rnd = mulberry32(909);
    const foreignAccounts = new Set<number>();
    for (let i = 0; i < ACCOUNTS; i++) {
      const hasPin = rnd() < 0.16;
      const pin = hasPin ? realPinFor(i) : null;
      pos.addCustomer({
        id: `dl-${i}`,
        phone10: primaryPhone(i),
        pin,
        balanceCents: 250_000,
        cards: rnd() < 0.07 ? [{ id: `c${i}`, masked: "x" }] : [],
      });
      if (rnd() < 0.2) foreignAccounts.add(i);
    }

    let calls = 0;
    let httpOk = 0;
    let chargesSeen = 0;
    let midCallHangups = 0;
    let emptyReads = 0;
    let dupPosts = 0;

    for (let i = 0; i < ACCOUNTS; i++) {
      calls++;
      const callId = `dl-call-${i}`;
      const isForeign = foreignAccounts.has(i);
      const callerNumber = isForeign ? foreignPhone(i) : primaryPhone(i);
      const opts = {
        pin: realPinFor(i),
        targetPhone: primaryPhone(i),
        amount: "12*34",
        wantsPayment: rnd() < 0.5,
        confirmAccept: rnd() < 0.85,
      };

      let body: any = { tenantId, callId, callerNumber };
      let loops = 0;
      while (loops++ < 25) {
        const { statusCode, view } = await driver.postStep(body);
        assert.ok(statusCode < 500, `dialplan door 500d: ${JSON.stringify(body)} -> status ${statusCode}`);
        assert.ok(
          view && typeof view.action === "string" && ["gather", "transfer", "hangup", "continue"].includes(view.action),
          `bad action word: ${JSON.stringify(view)}`,
        );
        httpOk++;
        if (view.playback && view.playback.includes("09_approved_intro")) chargesSeen++;

        // a duplicated POST — the same body sent twice in a row (Asterisk retry).
        if (rnd() < 0.05 && body.digits !== undefined) {
          dupPosts++;
          const dup = await driver.postStep(body);
          assert.ok(dup.statusCode < 500, "duplicated POST 500d");
        }

        if (view.action === "transfer" || view.action === "hangup") break;
        if (view.action === "gather") {
          if (rnd() < 0.08) {
            emptyReads++;
            body = { tenantId, callId, digits: "" };
            continue;
          }
          if (rnd() < 0.05) {
            midCallHangups++;
            await driver.postStep({ tenantId, callId, hangup: true });
            break;
          }
          const names = driver.promptNames(view.playback);
          const digits = driver.chooseDigits(names, view.maxDigits, opts);
          body = { tenantId, callId, digits };
          continue;
        }
        body = { tenantId, callId };
      }
      // every real dialplan run ends on the h-extension hangup POST.
      const finalHangup = await driver.postStep({ tenantId, callId, hangup: true });
      assert.ok(finalHangup.statusCode < 500);
    }

    const ledgerTotal = [...pos.charges.values()].reduce((s, c) => s + c.amount, 0);
    const sessionTotal = db
      .rows("supermarketPayCall")
      .filter((r: any) => r.tenantId === tenantId)
      .reduce((s: number, r: any) => s + r.chargedCents, 0);
    assert.equal(sessionTotal, ledgerTotal, "dialplan-driven session books disagree with the register ledger");
    assert.equal(new Set(pos.charges.keys()).size, pos.charges.size, "duplicate externalId from a duplicated POST");

    const pinRows = db.rows("supermarketPhonePin").filter((r: any) => r.tenantId === tenantId);
    const pinKeys = new Set(pinRows.map((r: any) => `${r.posCustomerId}|${r.phoneE164}`));
    assert.equal(pinKeys.size, pinRows.length, "duplicate (tenant,account,phone) vault rows — a double-enrollment");
    for (const row of pinRows) {
      const idx = Number(String(row.posCustomerId).replace("dl-", ""));
      assert.ok(!foreignAccounts.has(idx), `a foreign call enrolled account dl-${idx}`);
    }

    console.log(
      `[PAYLINE 2] calls=${calls} httpOk=${httpOk} chargesSeen=${chargesSeen} midCallHangups=${midCallHangups} ` +
        `emptyReads=${emptyReads} dupPosts=${dupPosts} vaultRows=${pinRows.length}`,
    );
  },
);

// ═══════════════════════════════ PAYLINE 3 ═══════════════════════════════════

test(
  "PAYLINE 3 — classifyPinRefusal fuzz: 5,000 mutations of the two real POS bodies never drift toward 'not_set' and never misclassify a clean refusal",
  () => {
    const BASE = ["Customer PIN required.", "Invalid customer PIN."];
    const rnd = mulberry32(31337);

    const mutate = (s: string): string => {
      const kind = Math.floor(rnd() * 9);
      switch (kind) {
        case 0:
          return s.toUpperCase();
        case 1:
          return s.toLowerCase();
        case 2:
          return `  ${s}  \n\t`;
        case 3:
          return JSON.stringify({ error: s });
        case 4:
          return s.slice(0, Math.floor(rnd() * s.length)); // prefix truncation only — never
        // separates "pin" from "required"/"invalid" while keeping the tail word.
        case 5:
          return `${s} — please contact the store.`;
        case 6:
          return "";
        case 7:
          return `unrelated failure: ${Math.floor(rnd() * 100000)}`;
        case 8:
          return s.split("").reverse().join("");
        default:
          return s;
      }
    };

    let requiredCount = 0;
    let invalidCount = 0;
    let unknownCount = 0;
    let checked = 0;

    for (let i = 0; i < 5000; i++) {
      const base = BASE[i % 2];
      let body = mutate(base);
      const wrap = Math.floor(rnd() * 4);
      if (wrap === 1) body = JSON.stringify({ error: body });
      else if (wrap === 2) body = JSON.stringify({ message: body, code: "PIN" });
      else if (wrap === 3) body = `<html>${body}</html>`;
      const status = [401, 403][Math.floor(rnd() * 2)];

      const result = classifyPinRefusal(status, body);
      checked++;
      const lower = body.toLowerCase();
      if (lower.includes("required")) {
        assert.equal(result, "not_set", `body containing 'required' misclassified: ${JSON.stringify(body)} -> ${result}`);
        requiredCount++;
      } else if (lower.includes("invalid")) {
        assert.equal(
          result,
          "invalid",
          `body containing 'invalid' (no 'required') misclassified: ${JSON.stringify(body)} -> ${result}`,
        );
        invalidCount++;
      } else {
        assert.notEqual(
          result,
          "not_set",
          `unrecognised body classified as not_set — fails toward giving up, not asking: ${JSON.stringify(body)}`,
        );
        unknownCount++;
      }
    }

    // non-401/403 statuses always return null, regardless of body.
    const otherStatuses = [200, 204, 301, 400, 404, 409, 422, 429, 500, 502, 503, -1, 999];
    let nullChecked = 0;
    for (let s = 0; s < 600; s++) {
      const status = otherStatuses[s % otherStatuses.length];
      const r = classifyPinRefusal(status, "Customer PIN required.");
      assert.equal(r, null, `status ${status} did not return null`);
      nullChecked++;
    }

    assert.ok(requiredCount > 0 && invalidCount > 0 && unknownCount > 0, "fuzz did not exercise all three branches");
    console.log(
      `[PAYLINE 3] mutations=${checked} required=${requiredCount} invalid=${invalidCount} unknown=${unknownCount} nonAuthStatuses=${nullChecked}`,
    );
  },
);

// ═══════════════════════════════ PAYLINE 4 ═══════════════════════════════════

test(
  "PAYLINE 4 — 200 concurrent full calls against ONE FakePos: ledger reconciles, one vault row per (tenant,account,phone), every session state is a valid phase",
  async () => {
    const db = makeSupermarketDb();
    const pos = new FakePos();
    const tenantId = "t-conc";
    await seedPosTenant(db, tenantId, pos);
    const clientFor = clientForFactory(new Map([[tenantId, pos]]));
    const deps = { db, clientFor: clientFor as any };
    const rnd = mulberry32(2020);

    const N = 200;
    const accounts: Array<{ i: number; pinSet: boolean; realPin: string | null }> = [];
    for (let i = 0; i < N; i++) {
      const pinSet = rnd() < 0.5;
      const realPin = pinSet ? realPinFor(i) : null;
      pos.addCustomer({
        id: `cc-${i}`,
        phone10: primaryPhone(i),
        pin: realPin,
        balanceCents: 300_000,
        cards: [{ id: `card-${i}`, masked: "x" }],
      });
      accounts.push({ i, pinSet, realPin });
    }

    const results = await Promise.all(
      accounts.map((acct) =>
        scriptedCall(deps, tenantId, `cc-call-${acct.i}`, primaryPhone(acct.i), {
          pin: acct.realPin ?? "0000",
          wantsPayment: true,
          amount: "9*99",
        }),
      ),
    );
    assert.equal(results.length, N);

    const validPhases = new Set<PayIvrPhase>([
      "start",
      "pin_entry",
      "lookup_entry",
      "main_menu",
      "after_balance_menu",
      "amount_entry",
      "confirm",
      "charging",
      "human",
      "done",
    ]);
    for (const row of db.rows("supermarketPayCall").filter((r: any) => r.tenantId === tenantId)) {
      assert.ok(row.state && typeof row.state === "object", `corrupted state on ${row.callId}`);
      assert.ok(validPhases.has(row.state.phase), `invalid phase '${row.state.phase}' on ${row.callId}`);
    }

    const ledgerTotal = [...pos.charges.values()].reduce((s, c) => s + c.amount, 0);
    const sessionTotal = db
      .rows("supermarketPayCall")
      .filter((r: any) => r.tenantId === tenantId)
      .reduce((s: number, r: any) => s + r.chargedCents, 0);
    assert.equal(sessionTotal, ledgerTotal, "concurrent-call ledger mismatch");
    assert.equal(new Set(pos.charges.keys()).size, pos.charges.size);

    const pinRows = db.rows("supermarketPhonePin").filter((r: any) => r.tenantId === tenantId);
    const pinKeys = new Set(pinRows.map((r: any) => `${r.posCustomerId}|${r.phoneE164}`));
    assert.equal(pinKeys.size, pinRows.length, "duplicate (tenant,account,phone) vault rows under concurrency");

    console.log(`[PAYLINE 4] concurrentCalls=${N} charges=${pos.charges.size} vaultRows=${pinRows.length} ledgerCents=${ledgerTotal}`);
  },
);

// ═══════════════════════════════ PAYLINE 5 ═══════════════════════════════════

test("PAYLINE 5 — the same call's step posted 10x concurrently never double-charges and never double-enrolls", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-dup10";
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  // ask_once: this test is about concurrency safety around enrollment and
  // charging, not the caller-ID default — it needs a live PIN ask to reach.
  const deps = { db, clientFor: clientFor as any, matchedPinPolicy: "ask_once" as const };

  const N = 60;
  for (let i = 0; i < N; i++) {
    pos.addCustomer({
      id: `d10-${i}`,
      phone10: primaryPhone(i),
      pin: realPinFor(i),
      balanceCents: 200_000,
      cards: [{ id: `card-${i}`, masked: "x" }],
    });
  }

  let chargeDoubles = 0;
  let enrollDoubles = 0;
  let confirmsReached = 0;

  for (let i = 0; i < N; i++) {
    const callId = `d10-call-${i}`;
    const callerNumber = primaryPhone(i);
    const step = (digits?: string, hangup?: boolean) =>
      runPayIvrStep(deps as any, { tenantId, callId, callerNumber, digits, hangup });

    // Sequential setup up to the pin ask: the silent probe fails (no vault yet).
    let out = await step();
    assert.equal(out.gather?.what, "pin", `expected a pin ask for ${callId}`);

    // 10 concurrent, IDENTICAL PIN posts — this is also the enrollment trigger.
    await Promise.all(Array.from({ length: 10 }, () => step(realPinFor(i))));

    const pinRowsForAcct = db.rows("supermarketPhonePin").filter((r: any) => r.tenantId === tenantId && r.posCustomerId === `d10-${i}`);
    if (pinRowsForAcct.length > 1) enrollDoubles++;
    assert.ok(pinRowsForAcct.length <= 1, `double-enrolled ${callId}: ${pinRowsForAcct.length} rows`);

    // Drive to the confirm gather, then fire the SAME confirm-accept digit 10x concurrently.
    out = await step("2"); // payment
    if (out.gather?.what !== "amount") continue; // caps/edge case reached — nothing more to race here
    out = await step("5*00");
    if (out.gather?.what !== "confirm") continue;
    confirmsReached++;

    const beforeCharges = pos.charges.size;
    await Promise.all(Array.from({ length: 10 }, () => step("1")));
    const afterCharges = pos.charges.size;
    if (afterCharges - beforeCharges > 1) chargeDoubles++;
    assert.ok(afterCharges - beforeCharges <= 1, `double-charged ${callId}: +${afterCharges - beforeCharges} charges`);
  }

  const ledgerTotal = [...pos.charges.values()].reduce((s, c) => s + c.amount, 0);
  const sessionTotal = db
    .rows("supermarketPayCall")
    .filter((r: any) => r.tenantId === tenantId)
    .reduce((s: number, r: any) => s + r.chargedCents, 0);
  assert.equal(sessionTotal, ledgerTotal, "10x-concurrent-post ledger mismatch");

  console.log(
    `[PAYLINE 5] accounts=${N} confirmsReached=${confirmsReached} chargeDoubles=${chargeDoubles} enrollDoubles=${enrollDoubles} finalCharges=${pos.charges.size}`,
  );
});

// ═══════════════════════════════ PAYLINE 6 ═══════════════════════════════════

function wrapFetchWithInjection(pos: FakePos, shouldFail: (path: string, callCount: number) => "timeout" | "500" | null) {
  let count = 0;
  const base = pos.fetchImpl;
  return async (url: string, init: any) => {
    const path = new URL(url).pathname;
    count++;
    const verdict = shouldFail(path, count);
    if (verdict === "timeout") {
      const err: any = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    if (verdict === "500") {
      return { status: 500, headers: { get: () => null }, text: async () => JSON.stringify({ error: "injected outage" }) };
    }
    return base(url, init);
  };
}

function clientForWithFetch(tenantId: string, fetchImpl: any) {
  return async (db: any, tid: string, deps: any = {}) => {
    if (tid !== tenantId) return null;
    return posClientForTenant(db, tid, { ...deps, fetchImpl });
  };
}

test("PAYLINE 6 — a register outage during PIN verification never counts as an attempt and never purges a stored PIN", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-outage";
  await seedPosTenant(db, tenantId, pos);

  const N = 400;
  for (let i = 0; i < N; i++) {
    const pin = realPinFor(i);
    pos.addCustomer({ id: `ot-${i}`, phone10: primaryPhone(i), pin, balanceCents: 100_000, cards: [{ id: `c${i}`, masked: "x" }] });
    db.seed("supermarketPhonePin", {
      tenantId,
      posCustomerId: `ot-${i}`,
      phoneE164: `+1${primaryPhone(i)}`,
      pinEnc: await encryptedPin(pin),
      lastUsedAt: new Date(),
    });
  }

  // every /balance call (the PIN-gated read) times out or 500s — a provider outage.
  const rnd = mulberry32(6001);
  const fetchImpl = wrapFetchWithInjection(pos, (path) => (/\/balance$/.test(path) ? (rnd() < 0.5 ? "timeout" : "500") : null));
  const clientFor = clientForWithFetch(tenantId, fetchImpl);
  const deps = { db, clientFor: clientFor as any };

  let humanLandings = 0;
  let attemptsWronglyBumped = 0;
  let wronglyPurged = 0;

  for (let i = 0; i < N; i++) {
    const callId = `ot-call-${i}`;
    const out = await runPayIvrStep(deps as any, { tenantId, callId, callerNumber: primaryPhone(i) });
    assert.equal(out.transfer, true, `outage did not transfer to a person for ${callId}`);
    assert.equal(out.gather, null, `outage left a gather open for ${callId}`);
    humanLandings++;

    const row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
    assert.equal(row.status, "failed", `outage session should be 'failed', got '${row.status}' for ${callId}`);
    assert.notEqual(row.state.blockedReason, "pin_not_set", `outage wrongly flagged as pin_not_set for ${callId}`);
    if (row.state.pinAttempts !== 0) attemptsWronglyBumped++;
    assert.equal(row.state.pinAttempts, 0, `outage counted as a PIN attempt for ${callId}`);

    const vaultRow = db.rows("supermarketPhonePin").find((r: any) => r.tenantId === tenantId && r.posCustomerId === `ot-${i}`);
    if (!vaultRow) wronglyPurged++;
    assert.ok(vaultRow, `outage purged the stored PIN for ${callId}`);
  }

  console.log(`[PAYLINE 6] calls=${N} humanLandings=${humanLandings} attemptsWronglyBumped=${attemptsWronglyBumped} wronglyPurged=${wronglyPurged}`);
});

// ═══════════════════════════════ PAYLINE 7 ═══════════════════════════════════

test("PAYLINE 7 — a real 'invalid'/'not_set' refusal on a stored PIN purges exactly that account's rows and nothing else", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-purge";
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  // ask_once: this test is about the purge (never bleeding into another
  // account's vault row), which is independent of the caller-ID policy — the
  // "invalid" branch needs ask_once to still offer a fresh keyed PIN.
  const deps = { db, clientFor: clientFor as any, matchedPinPolicy: "ask_once" as const };

  const N = 300;
  const kinds: Array<"invalid" | "not_set"> = [];
  for (let i = 0; i < N; i++) {
    const kind: "invalid" | "not_set" = i % 2 === 0 ? "invalid" : "not_set";
    kinds.push(kind);
    // "invalid": the store changed the PIN, so the register still has ONE, just
    // not the stale value in our vault. "not_set": the store removed the PIN
    // from the account entirely — nothing can ever satisfy it.
    const registerPin = kind === "invalid" ? realPinFor(i) : null;
    pos.addCustomer({ id: `pg-${i}`, phone10: primaryPhone(i), pin: registerPin, balanceCents: 100_000, cards: [] });
    db.seed("supermarketPhonePin", {
      tenantId,
      posCustomerId: `pg-${i}`,
      phoneE164: `+1${primaryPhone(i)}`,
      pinEnc: await encryptedPin(`stale${i}`),
      lastUsedAt: new Date(),
    });
  }

  for (let i = 0; i < N; i++) {
    const otherRowsBefore = db.rows("supermarketPhonePin").filter((r: any) => r.tenantId === tenantId && r.posCustomerId !== `pg-${i}`);

    const out = await runPayIvrStep(deps as any, { tenantId, callId: `pg-call-${i}`, callerNumber: primaryPhone(i) });

    const mineRow = db.rows("supermarketPhonePin").find((r: any) => r.tenantId === tenantId && r.posCustomerId === `pg-${i}`);
    assert.equal(mineRow, undefined, `stale vault row for pg-${i} was not purged (kind ${kinds[i]})`);

    const otherRowsAfter = db.rows("supermarketPhonePin").filter((r: any) => r.tenantId === tenantId && r.posCustomerId !== `pg-${i}`);
    assert.deepEqual(
      otherRowsAfter.map((r: any) => r.posCustomerId).sort(),
      otherRowsBefore.map((r: any) => r.posCustomerId).sort(),
      `purging pg-${i} bled into a different account's vault row`,
    );

    if (kinds[i] === "invalid") {
      assert.equal(out.gather?.what, "pin", `invalid-stored-pin call should ask once for pg-${i}`);
    } else {
      assert.equal(out.transfer, true, `not_set-stored-pin call should transfer for pg-${i}`);
      const row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId: `pg-call-${i}` } });
      assert.equal(row.status, "no_pin");
      assert.equal(row.state.blockedReason, "pin_not_set");
    }
  }

  console.log(
    `[PAYLINE 7] accounts=${N} invalidKind=${kinds.filter((k) => k === "invalid").length} notSetKind=${kinds.filter((k) => k === "not_set").length}`,
  );
});

// ═══════════════════════════════ PAYLINE 8 ═══════════════════════════════════

function legacyState(overrides: Partial<PayIvrState> & { phase: PayIvrPhase }): any {
  const full: any = { ...initialPayIvrState(), ...overrides };
  // Rows persisted before 2026-09-17 never had these two fields at all.
  delete full.pinProbe;
  delete full.blockedReason;
  return full;
}

test("PAYLINE 8 — pre-2026-09-17 session shapes (missing pinProbe/blockedReason) never throw, in every phase", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-legacy";
  await seedPosTenant(db, tenantId, pos);
  const legacyPhone = primaryPhone(9999);
  pos.addCustomer({ id: "leg-1", phone10: legacyPhone, pin: "1234", balanceCents: 5000, cards: [{ id: "c1", masked: "x" }] });
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any };

  const phaseScenarios: Array<{ phase: PayIvrPhase; state: any; digits?: string; hangup?: boolean }> = [
    { phase: "start", state: legacyState({ phase: "start" }) },
    { phase: "lookup_entry", state: legacyState({ phase: "lookup_entry" }), digits: legacyPhone },
    {
      phase: "pin_entry",
      state: legacyState({ phase: "pin_entry", posCustomerId: "leg-1", callerIdMatched: true }),
      digits: "1234",
    },
    {
      phase: "main_menu",
      state: legacyState({ phase: "main_menu", posCustomerId: "leg-1", pinVerified: true, activePin: "1234" }),
      digits: "1",
    },
    {
      phase: "after_balance_menu",
      state: legacyState({
        phase: "after_balance_menu",
        posCustomerId: "leg-1",
        pinVerified: true,
        activePin: "1234",
        lastBalanceCents: 500,
      }),
      digits: "2",
    },
    {
      phase: "amount_entry",
      state: legacyState({ phase: "amount_entry", posCustomerId: "leg-1", pinVerified: true, activePin: "1234" }),
      digits: "5*00",
    },
    {
      phase: "confirm",
      state: legacyState({ phase: "confirm", posCustomerId: "leg-1", pinVerified: true, activePin: "1234", pendingCents: 500 }),
      digits: "1",
    },
    {
      phase: "charging",
      state: legacyState({
        phase: "charging",
        posCustomerId: "leg-1",
        pinVerified: true,
        activePin: "1234",
        pendingCents: 500,
        chargeSeq: 1,
      }),
      hangup: true,
    },
    { phase: "human", state: legacyState({ phase: "human" }), digits: "1" },
    { phase: "done", state: legacyState({ phase: "done" }), digits: "1" },
  ];

  let ran = 0;
  for (const scenario of phaseScenarios) {
    const callId = `leg-${scenario.phase}`;
    db.seed("supermarketPayCall", {
      tenantId,
      callId,
      callerNumber: legacyPhone,
      state: scenario.state,
      posCustomerId: scenario.state.posCustomerId ?? null,
      chargeSeq: scenario.state.chargeSeq ?? 0,
      chargedCents: 0,
      status: "open",
    });

    let out: any;
    let threw: unknown = null;
    try {
      out = await runPayIvrStep(deps as any, {
        tenantId,
        callId,
        callerNumber: legacyPhone,
        digits: scenario.digits,
        hangup: scenario.hangup,
      });
    } catch (err) {
      threw = err;
    }
    assert.equal(threw, null, `legacy '${scenario.phase}' shape threw: ${threw}`);
    assert.ok(out && Array.isArray(out.prompts), `bad output shape for legacy '${scenario.phase}'`);
    assert.equal(typeof out.transfer, "boolean");
    assert.equal(typeof out.done, "boolean");
    assert.ok(out.gather === null || typeof out.gather === "object", `bad gather shape for legacy '${scenario.phase}'`);

    const row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
    assert.ok(row, `no row persisted for legacy '${scenario.phase}'`);
    assert.equal(typeof row.state.pinProbe, "boolean", `pinProbe not normalized to boolean for '${scenario.phase}'`);
    assert.ok(
      row.state.blockedReason === null || row.state.blockedReason === "pin_not_set" || row.state.blockedReason === "pin_not_enrolled",
      `blockedReason not normalized for '${scenario.phase}'`,
    );
    ran++;
  }

  assert.equal(ran, phaseScenarios.length);
  console.log(`[PAYLINE 8] legacyPhasesExercised=${ran}`);
});
