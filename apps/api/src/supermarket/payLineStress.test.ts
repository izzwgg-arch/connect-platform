/**
 * PAY-LINE HEAVY STRESS TESTS — independent proof for the 2026-09-17 evening
 * flow (payIvrCore.ts: choose-account/lookup, THEN every caller keys the PIN
 * — nothing enrolled, nothing remembered) and its runtime wiring
 * (payIvrRuntime.ts), on top of the existing STRESS 1/4/17/22/25 coverage in
 * supermarketStress.test.ts.
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
import { PAY_MAX_PIN_ATTEMPTS, PAY_PROBE_PIN, initialPayIvrState, type PayIvrPhase, type PayIvrState } from "./payIvrCore";
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
// Drives runPayIvrStep to completion the way a well-behaved (or a
// three-wrong-tries) caller would: keys whatever the current gather wants,
// picks the account offered ("choice"), balance/payment, confirms. Tracks how
// many times 02_pin was heard — the flow's core "did anyone get to skip the
// PIN?" signal, which must always be either 0 (blocked) or exactly 1 (asked
// once, then keyed).

type ScriptOpts = {
  /** Answer to "your account, or a different one?" (choose_account gather). */
  choice?: "1" | "2";
  /** The account phone number keyed at a "phone" gather. */
  targetPhone?: string;
  /** The PIN keyed once the register has answered the silent probe. */
  pin?: string;
  /** Key a wrong PIN this many times BEFORE ever keying `pin` (0 = never). */
  wrongPinTimes?: number;
  wantsPayment?: boolean;
  amount?: string;
};

async function scriptedCall(
  deps: { db: any; clientFor: any },
  tenantId: string,
  callId: string,
  callerNumber: string,
  opts: ScriptOpts,
): Promise<{ steps: any[]; pin02Count: number; finalOut: any }> {
  const step = (digits?: string, hangup?: boolean) =>
    runPayIvrStep(deps as any, { tenantId, callId, callerNumber, digits, hangup });
  const steps: any[] = [];
  let pin02Count = 0;
  const record = (o: any) => {
    steps.push(o);
    if (o.prompts.includes("02_pin")) pin02Count++;
  };

  let out = await step();
  record(out);
  let wrongKeyed = 0;
  let actionTaken = false;
  let guard = 0;
  while (guard++ < 12 && out.gather && !out.transfer && !out.done) {
    const what = out.gather.what;
    if (what === "menu" && actionTaken) {
      out = await step(undefined, true);
      record(out);
      break;
    }
    let digits: string;
    if (what === "choice") digits = opts.choice ?? "1";
    else if (what === "phone") digits = opts.targetPhone ?? "8456624417";
    else if (what === "pin") {
      if (opts.wrongPinTimes && wrongKeyed < opts.wrongPinTimes) {
        wrongKeyed++;
        digits = "0000";
      } else {
        digits = opts.pin ?? "0000";
      }
    } else if (what === "menu") {
      digits = opts.wantsPayment ? "2" : "1";
      actionTaken = true;
    } else if (what === "amount") digits = opts.amount ?? "12*34";
    else if (what === "confirm") digits = "1";
    else digits = "0";
    out = await step(digits);
    record(out);
  }
  return { steps, pin02Count, finalOut: out };
}

// ═══════════════════════════════ PAYLINE 1 ═══════════════════════════════════
// The full matrix Izzy asked for: 2,000 accounts x {own number pressing 1, own
// number pressing 2 and keying own number, foreign number keying an account}
// x {no POS PIN, PIN keyed right, PIN keyed wrong x3}.

test(
  "PAYLINE 1 — the 2026-09-17-evening flow at scale: 2,000 accounts x {own#1, own#2-self-lookup, foreign} x {no PIN, right PIN, wrong PIN x3} — every served caller keyed the PIN, a no-PIN account never hears 02_pin and always hears 36 then 20, the vault is never touched, every failure ends on 20_connect_person",
  async () => {
    const ACCOUNTS = 2000;
    const seed = 71017;
    const rnd = mulberry32(seed);
    const db = makeSupermarketDb();
    const pos = new FakePos();
    const tenantId = "t-payline-matrix";
    await seedPosTenant(db, tenantId, pos);
    const clientFor = clientForFactory(new Map([[tenantId, pos]]));
    const deps = { db, clientFor: clientFor as any };

    // ⛔ Instrument the vault table: runPayIvrStep must never read or write it.
    let vaultCalls = 0;
    const vaultMethods = ["findFirst", "findUnique", "findMany", "count", "create", "update", "updateMany", "upsert", "deleteMany"];
    const realVault = db.supermarketPhonePin;
    const proxyVault: any = {};
    for (const m of vaultMethods) {
      proxyVault[m] = async (...args: any[]) => {
        vaultCalls++;
        return (realVault as any)[m](...args);
      };
    }
    db.supermarketPhonePin = proxyVault;

    type Scenario = "own1" | "own2" | "foreign";
    type PinCase = "no_pin" | "right" | "wrong3";
    type Account = { i: number; id: string; pinSet: boolean; realPin: string | null; hasCard: boolean; scenario: Scenario; pinCase: PinCase };
    const accounts: Account[] = [];

    for (let i = 0; i < ACCOUNTS; i++) {
      const pinSet = rnd() < 0.5;
      const realPin = pinSet ? realPinFor(i) : null;
      const hasCard = rnd() < 0.6;
      const sRoll = rnd();
      const scenario: Scenario = sRoll < 1 / 3 ? "own1" : sRoll < 2 / 3 ? "own2" : "foreign";
      const pinCase: PinCase = !pinSet ? "no_pin" : rnd() < 0.7 ? "right" : "wrong3";
      const id = `pl-${i}`;
      accounts.push({ i, id, pinSet, realPin, hasCard, scenario, pinCase });
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
    }

    let noPinLandings = 0;
    let servedRight = 0;
    let wrong3Landings = 0;
    let charges = 0;

    for (const acct of accounts) {
      const callerNumber = acct.scenario === "foreign" ? foreignPhone(acct.i) : primaryPhone(acct.i);
      const before = pos.requestLog.length;
      const call = await scriptedCall(deps, tenantId, `${acct.id}-c1`, callerNumber, {
        choice: acct.scenario === "own2" ? "2" : "1",
        targetPhone: primaryPhone(acct.i),
        pin: acct.realPin ?? "0000",
        wrongPinTimes: acct.pinCase === "wrong3" ? PAY_MAX_PIN_ATTEMPTS : 0,
        wantsPayment: rnd() < 0.5,
      });
      const mine = pos.requestLog.slice(before);
      const pinGated = mine.filter((r) => r.pin !== null);
      assert.ok(mine.length <= 8, `too many POS requests for ${acct.id} (${acct.scenario}/${acct.pinCase}): ${mine.length}`);

      const row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId: `${acct.id}-c1` } });
      assert.ok(row, `no session row for ${acct.id}`);

      if (acct.pinCase === "no_pin") {
        assert.equal(call.pin02Count, 0, `no-pin account heard 02_pin: ${acct.id}`);
        const last = call.steps.at(-1);
        assert.deepEqual(last.prompts, ["36_no_pin_visit_store", "20_connect_person"], `no-pin account (${acct.id}) did not hear exactly 36 then 20`);
        assert.equal(last.transfer, true);
        assert.equal(last.gather, null);
        assert.equal(row.status, "no_pin");
        assert.equal(row.state.blockedReason, "pin_not_set");
        assert.equal(pinGated.length, 1, `no-pin account (${acct.id}) should cost exactly one pin-gated probe`);
        assert.equal(pinGated[0].pin, PAY_PROBE_PIN);
        noPinLandings++;
        continue;
      }

      // every failure ends on 20_connect_person.
      const last = call.steps.at(-1);
      if (last.transfer) assert.ok(last.prompts.includes("20_connect_person"), `a failed call (${acct.id}) did not end on 20_connect_person`);

      if (acct.pinCase === "wrong3") {
        assert.ok(last.prompts.includes("15_too_many_tries"), `wrong3 account (${acct.id}) never heard the cap prompt`);
        assert.equal(last.transfer, true);
        assert.equal(row.status, "failed");
        assert.equal(pinGated.length, 1 + PAY_MAX_PIN_ATTEMPTS, `wrong3 account (${acct.id}) should cost probe + ${PAY_MAX_PIN_ATTEMPTS} wrong attempts`);
        assert.equal(pinGated[0].pin, PAY_PROBE_PIN);
        for (const r of pinGated.slice(1)) assert.equal(r.pin, "0000");
        wrong3Landings++;
        continue;
      }

      // pinCase === "right": every served caller keyed the PIN exactly once —
      // never silently let through on the probe alone.
      assert.equal(call.pin02Count, 1, `served caller (${acct.id}) was not asked for the PIN exactly once`);
      assert.equal(pinGated[0].pin, PAY_PROBE_PIN, `the FIRST pin-gated request for ${acct.id} must be the silent probe`);
      assert.ok(pinGated.some((r) => r.pin === acct.realPin), `the real PIN never reached the register for ${acct.id}`);
      servedRight++;
      for (const s of call.steps) if (s.prompts.includes("09_approved_intro")) charges++;
    }

    // GLOBAL: the vault is never touched by the pay line, across all 2,000 calls.
    assert.equal(vaultCalls, 0, `the pay line touched the PIN vault table ${vaultCalls} times`);
    assert.equal(db.rows("supermarketPhonePin").length, 0, "a vault row appeared even though nothing on this line ever enrolls");

    // GLOBAL: session bookkeeping reconciles with the register ledger to the cent.
    const ledgerTotal = [...pos.charges.values()].reduce((s, c) => s + c.amount, 0);
    const sessionTotal = db
      .rows("supermarketPayCall")
      .filter((r: any) => r.tenantId === tenantId)
      .reduce((s: number, r: any) => s + r.chargedCents, 0);
    assert.equal(sessionTotal, ledgerTotal, "session books disagree with the register ledger");
    assert.equal(new Set(pos.charges.keys()).size, pos.charges.size, "duplicate externalId in the ledger");

    assert.ok(noPinLandings > 0 && servedRight > 0 && wrong3Landings > 0, "the matrix did not exercise all three PIN cases");
    console.log(
      `[PAYLINE 1] accounts=${ACCOUNTS} noPinLandings=${noPinLandings} servedRight=${servedRight} wrong3Landings=${wrong3Landings} ` +
        `charges=${charges} ledgerCents=${ledgerTotal} posRequests=${pos.requestLog.length} vaultCalls=${vaultCalls}`,
    );
  },
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
    opts: { choice?: string; pin?: string; targetPhone?: string; amount?: string; wantsPayment?: boolean; confirmAccept?: boolean },
  ): string {
    if (names.includes("37_which_account")) return opts.choice ?? "1";
    if (names.includes("02_pin")) return (opts.pin ?? "0000").slice(0, maxDigits);
    if (names.includes("13_not_recognized") || names.includes("38_enter_phone") || names.includes("19_lookup_not_found")) {
      return (opts.targetPhone ?? "8456624417").slice(0, maxDigits);
    }
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
      const hasPin = rnd() < 0.7;
      const pin = hasPin ? realPinFor(i) : null;
      pos.addCustomer({
        id: `dl-${i}`,
        phone10: primaryPhone(i),
        pin,
        balanceCents: 250_000,
        cards: rnd() < 0.6 ? [{ id: `c${i}`, masked: "x" }] : [],
      });
      db.seed("posCustomer", { tenantId, posCustomerId: `dl-${i}`, name: `D${i}`, phonesText: primaryPhone(i), primaryPhone: primaryPhone(i) });
      if (rnd() < 0.2) foreignAccounts.add(i);
    }

    let calls = 0;
    let httpOk = 0;
    let chargesSeen = 0;
    let midCallHangups = 0;
    let emptyReads = 0;
    let dupPosts = 0;
    let noPinSeen = 0;

    for (let i = 0; i < ACCOUNTS; i++) {
      calls++;
      const callId = `dl-call-${i}`;
      const isForeign = foreignAccounts.has(i);
      const callerNumber = isForeign ? foreignPhone(i) : primaryPhone(i);
      const opts = {
        choice: "1",
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
        if (view.playback && view.playback.includes("36_no_pin_visit_store")) noPinSeen++;

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
    assert.equal(db.rows("supermarketPhonePin").length, 0, "the dialplan-driven line created a vault row");

    console.log(
      `[PAYLINE 2] calls=${calls} httpOk=${httpOk} chargesSeen=${chargesSeen} noPinSeen=${noPinSeen} midCallHangups=${midCallHangups} ` +
        `emptyReads=${emptyReads} dupPosts=${dupPosts}`,
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
  "PAYLINE 4 — 200 concurrent full calls against ONE FakePos: ledger reconciles, every session state is a valid phase, no-pin accounts never keyed a PIN",
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
      db.seed("posCustomer", { tenantId, posCustomerId: `cc-${i}`, name: `C${i}`, phonesText: primaryPhone(i), primaryPhone: primaryPhone(i) });
      accounts.push({ i, pinSet, realPin });
    }

    const results = await Promise.all(
      accounts.map((acct) =>
        scriptedCall(deps, tenantId, `cc-call-${acct.i}`, primaryPhone(acct.i), {
          choice: "1",
          pin: acct.realPin ?? "0000",
          wantsPayment: true,
          amount: "9*99",
        }),
      ),
    );
    assert.equal(results.length, N);
    for (let i = 0; i < N; i++) {
      if (!accounts[i].pinSet) assert.equal(results[i].pin02Count, 0, `a no-pin account (${i}) was asked for a PIN`);
    }

    const validPhases = new Set<PayIvrPhase>([
      "start",
      "pin_entry",
      "choose_account",
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
    assert.equal(db.rows("supermarketPhonePin").length, 0);

    console.log(`[PAYLINE 4] concurrentCalls=${N} charges=${pos.charges.size} ledgerCents=${ledgerTotal}`);
  },
);

// ═══════════════════════════════ PAYLINE 5 ═══════════════════════════════════

test("PAYLINE 5 — the same call's step posted 10x concurrently never double-charges", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-dup10";
  await seedPosTenant(db, tenantId, pos);
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any };

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
  let confirmsReached = 0;

  for (let i = 0; i < N; i++) {
    const callId = `d10-call-${i}`;
    const callerNumber = primaryPhone(i);
    const step = (digits?: string, hangup?: boolean) =>
      runPayIvrStep(deps as any, { tenantId, callId, callerNumber, digits, hangup });

    // Sequential setup: choice, then the silent probe lands us on a pin ask.
    let out = await step();
    assert.equal(out.gather?.what, "choice", `expected the choice gather for ${callId}`);
    out = await step("1");
    assert.equal(out.gather?.what, "pin", `expected a pin ask for ${callId}`);

    // 10 concurrent, IDENTICAL PIN posts.
    await Promise.all(Array.from({ length: 10 }, () => step(realPinFor(i))));

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

  console.log(`[PAYLINE 5] accounts=${N} confirmsReached=${confirmsReached} chargeDoubles=${chargeDoubles} finalCharges=${pos.charges.size}`);
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

test("PAYLINE 6 — a register outage during PIN verification (the silent probe OR a keyed attempt) never counts as an attempt and never falsely reports 'pin_not_set'", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-outage";
  await seedPosTenant(db, tenantId, pos);

  const N = 400;
  for (let i = 0; i < N; i++) {
    const pin = realPinFor(i);
    pos.addCustomer({ id: `ot-${i}`, phone10: primaryPhone(i), pin, balanceCents: 100_000, cards: [{ id: `c${i}`, masked: "x" }] });
  }

  // every /balance call (the PIN-gated read, used by BOTH the probe and a
  // keyed attempt) times out or 500s — a provider outage.
  const rnd = mulberry32(6001);
  const fetchImpl = wrapFetchWithInjection(pos, (path) => (/\/balance$/.test(path) ? (rnd() < 0.5 ? "timeout" : "500") : null));
  const clientFor = clientForWithFetch(tenantId, fetchImpl);
  const deps = { db, clientFor: clientFor as any };

  let humanLandings = 0;
  let attemptsWronglyBumped = 0;

  for (let i = 0; i < N; i++) {
    const callId = `ot-call-${i}`;
    // call_start is unaffected (a different endpoint) — the choice gather lands normally.
    const start = await runPayIvrStep(deps as any, { tenantId, callId, callerNumber: primaryPhone(i) });
    assert.equal(start.gather?.what, "choice", `outage affected call_start unexpectedly for ${callId}`);

    // pressing 1 fires the silent probe, which hits the outage.
    const out = await runPayIvrStep(deps as any, { tenantId, callId, callerNumber: primaryPhone(i), digits: "1" });
    assert.equal(out.transfer, true, `outage did not transfer to a person for ${callId}`);
    assert.equal(out.gather, null, `outage left a gather open for ${callId}`);
    humanLandings++;

    const row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId } });
    assert.equal(row.status, "failed", `outage session should be 'failed', got '${row.status}' for ${callId}`);
    assert.notEqual(row.state.blockedReason, "pin_not_set", `outage wrongly flagged as pin_not_set for ${callId}`);
    if (row.state.pinAttempts !== 0) attemptsWronglyBumped++;
    assert.equal(row.state.pinAttempts, 0, `outage counted as a PIN attempt for ${callId}`);
  }

  assert.equal(db.rows("supermarketPhonePin").length, 0);
  console.log(`[PAYLINE 6] calls=${N} humanLandings=${humanLandings} attemptsWronglyBumped=${attemptsWronglyBumped}`);
});

// ═══════════════════════════════ PAYLINE 7 ═══════════════════════════════════

test(
  "PAYLINE 7 — a register account with NO PIN is blocked identically no matter how it's reached: press 1 (own account), press 2 then key the same number, or a stranger's lookup — never a keyed PIN, always the same two prompts, always a person",
  async () => {
    const db = makeSupermarketDb();
    const pos = new FakePos();
    const tenantId = "t-nopin-uniform";
    await seedPosTenant(db, tenantId, pos);
    const clientFor = clientForFactory(new Map([[tenantId, pos]]));
    const deps = { db, clientFor: clientFor as any };

    const N = 300;
    for (let i = 0; i < N; i++) {
      pos.addCustomer({ id: `np-${i}`, phone10: primaryPhone(i), pin: null, balanceCents: 100_000, cards: [] });
      db.seed("posCustomer", { tenantId, posCustomerId: `np-${i}`, name: `NP ${i}`, phonesText: primaryPhone(i), primaryPhone: primaryPhone(i) });
    }

    const scenarios: Array<"own1" | "own2" | "foreign"> = ["own1", "own2", "foreign"];
    let checked = 0;
    for (let i = 0; i < N; i++) {
      const scenario = scenarios[i % 3];
      const callerNumber = scenario === "foreign" ? foreignPhone(i) : primaryPhone(i);
      const call = await scriptedCall(deps, tenantId, `np-call-${i}`, callerNumber, {
        choice: scenario === "own2" ? "2" : "1",
        targetPhone: primaryPhone(i),
      });
      const last = call.steps.at(-1);
      assert.deepEqual(last.prompts, ["36_no_pin_visit_store", "20_connect_person"], `${scenario} account ${i} did not hear the exact two-prompt block`);
      assert.equal(last.transfer, true);
      assert.equal(last.gather, null);
      assert.equal(call.pin02Count, 0, `${scenario} account ${i} was asked for a PIN despite having none in the POS`);
      const row = await db.supermarketPayCall.findFirst({ where: { tenantId, callId: `np-call-${i}` } });
      assert.equal(row.status, "no_pin");
      assert.equal(row.state.blockedReason, "pin_not_set");
      checked++;
    }
    assert.equal(checked, N);
    console.log(`[PAYLINE 7] accounts=${N} scenariosPerType=${Math.floor(N / 3)}`);
  },
);

// ═══════════════════════════════ PAYLINE 8 ═══════════════════════════════════

function legacyState(overrides: Partial<PayIvrState> & { phase: PayIvrPhase }): any {
  const full: any = { ...initialPayIvrState(), ...overrides };
  // Rows persisted before the 2026-09-17 evening flow never had these fields
  // at all, and some carried fields this shape has since deleted entirely
  // (the code/vault flow's ownAccountBlocked/matchedPinPolicy bookkeeping).
  delete full.pinProbe;
  delete full.blockedReason;
  delete full.callerIdMatched;
  delete full.accountPinState;
  full.ownAccountBlocked = "pin_not_enrolled";
  full.matchedPinPolicy = "ask_once";
  return full;
}

test("PAYLINE 8 — pre-2026-09-17-evening session shapes (missing pinProbe/blockedReason, carrying since-deleted fields, or a since-retired phase) never throw, in every phase", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  const tenantId = "t-legacy";
  await seedPosTenant(db, tenantId, pos);
  const legacyPhone = primaryPhone(9999);
  pos.addCustomer({ id: "leg-1", phone10: legacyPhone, pin: "1234", balanceCents: 5000, cards: [{ id: "c1", masked: "x" }] });
  const clientFor = clientForFactory(new Map([[tenantId, pos]]));
  const deps = { db, clientFor: clientFor as any };

  const phaseScenarios: Array<{ phase: string; state: any; digits?: string; hangup?: boolean }> = [
    { phase: "start", state: legacyState({ phase: "start" }) },
    { phase: "choose_account", state: legacyState({ phase: "choose_account", callerAccountId: "leg-1" }), digits: "1" },
    { phase: "lookup_entry", state: legacyState({ phase: "lookup_entry" }), digits: legacyPhone },
    { phase: "pin_entry", state: legacyState({ phase: "pin_entry", posCustomerId: "leg-1" }), digits: "1234" },
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
    { phase: "retired-code_entry", state: legacyState({ phase: "code_entry" as any }), digits: "1" },
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
      row.state.blockedReason === null || row.state.blockedReason === "pin_not_set",
      `blockedReason not normalized for '${scenario.phase}'`,
    );
    ran++;
  }

  assert.equal(ran, phaseScenarios.length);
  assert.equal(db.rows("supermarketPhonePin").length, 0);
  console.log(`[PAYLINE 8] legacyPhasesExercised=${ran}`);
});
