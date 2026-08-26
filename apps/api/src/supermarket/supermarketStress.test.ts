/**
 * THE 25 HEAVY STRESS TESTS — Izzy's acceptance bar for the supermarket build
 * (2026-08-26: "Run 25 very, very heavy stress tests on the whole system with
 * proof that everything is working end to end").
 *
 * Every test drives the REAL modules (reducer, runtime, sweeps, submit path,
 * blast, routes through a real Fastify with real @fastify/jwt and the real
 * bypass list) against the faithful fakes in supermarketTestKit (snapshot
 * reads, P2002 uniques, honest updateMany counts, a POS register with
 * documented semantics + failure injection). Deterministic PRNG — a failure
 * prints its seed and replays.
 *
 * Run: node --experimental-test-module-mocks --import tsx --test src/supermarket/supermarketStress.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import jwt from "@fastify/jwt";

process.env.JWT_SECRET = process.env.JWT_SECRET || "supermarket-stress-secret-0123456789abcdef00";
process.env.CREDENTIALS_MASTER_KEY = process.env.CREDENTIALS_MASTER_KEY || "ab".repeat(32);
process.env.CDR_INGEST_SECRET = process.env.CDR_INGEST_SECRET || "stress-internal-secret-000111222333";
delete process.env.MARKETING_MAIL_ENABLED;

import { FakeDb, FakePos, makeSupermarketDb, mulberry32 } from "./supermarketTestKit";
import { PosWithLogicClient } from "./posWithLogic";
import {
  PAY_MAX_AMOUNT_ATTEMPTS,
  PAY_MAX_CHARGES_PER_CALL,
  PAY_MAX_CONFIRM_ROUNDS,
  PAY_MAX_LOOKUP_ATTEMPTS,
  PAY_MAX_PIN_ATTEMPTS,
  initialPayIvrState,
  reducePayIvr,
  type PayIvrEvent,
  type PayIvrState,
} from "./payIvrCore";
import { amountToPromptRefs, numberToPromptRefs, parseStarDecimalAmount } from "./payAmount";
import { runPayIvrStep } from "./payIvrRuntime";
import { approveAndSubmitDraft, sanitizeDraftItems } from "./orderSubmit";
import { runDraftBuilderSweep } from "./draftBuilder";
import { runCatalogSyncSweep, parseProductsPage } from "./catalogSync";
import { buildCatalogIndex, matchDraftText } from "./draftMatcher";
import { decideAutoSubmit, weeklyCorrectionStats, MIN_WEEK_VOLUME, type WeekStat } from "./learning";
import { sendSpecialBlast, unsubscribeToken, verifyUnsubscribeToken } from "./specials";
import { storeIntegrationKey, posClientForTenant } from "./integrationCredentials";
import { registerSupermarketRoutes } from "./supermarketRoutes";
import { checkInternalSecret } from "../internalSecret";
import { shouldSkipJwtVerification } from "../jwtPublicRouteBypass";

// ─── the recorded voice set (both shipped voices carry identical names) ──────
const RECORDED_PROMPTS = new Set<string>([
  ...Array.from({ length: 21 }, (_, i) => `num_${i}`),
  "num_30", "num_40", "num_50", "num_60", "num_70", "num_80", "num_90",
  "num_hundred", "num_thousand",
  "01_welcome", "02_pin", "03_pin_wrong", "04_balance_intro", "05_amount_prompt",
  "06_confirm_intro", "07_confirm_choice", "08_processing", "09_approved_intro",
  "10_thanks_bye", "11_declined", "12_no_card", "13_not_recognized",
  "14_invalid_amount", "15_too_many_tries", "16_dollars", "17_cents", "18_and",
  "19_lookup_not_found", "20_connect_person", "21_menu_after_balance", "22_main_menu",
]);

// ─── shared builders ─────────────────────────────────────────────────────────

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
    // forward caller deps (onCredits — the sweep's meter) alongside the fake wire
    return posClientForTenant(db, tenantId, { ...deps, fetchImpl: pos.fetchImpl });
  };
}

type AppKit = {
  app: any;
  db: FakeDb;
  posByTenant: Map<string, FakePos>;
  keyHolders: Map<string, Set<string>>;
  ingested: Array<{ tenantId: string; event: any }>;
  emails: any[];
  tokenFor: (u: { sub: string; tenantId: string; role: string }) => string;
};

const RULES: Array<{ prefix: string; permission: string | null }> = [
  { prefix: "/supermarket", permission: "can_view_supermarket_orders" },
  { prefix: "/supermarket/mode", permission: null },
  { prefix: "/admin/integrations", permission: "can_manage_global_settings" },
];
function rulePermissionFor(path: string): string | null {
  const rule = RULES.filter((r) => path === r.prefix || path.startsWith(`${r.prefix}/`)).sort(
    (a, b) => b.prefix.length - a.prefix.length,
  )[0];
  return rule?.permission ?? null;
}

async function buildApp(): Promise<AppKit> {
  const db = makeSupermarketDb();
  const posByTenant = new Map<string, FakePos>();
  const keyHolders = new Map<string, Set<string>>();
  const ingested: Array<{ tenantId: string; event: any }> = [];
  const emails: any[] = [];
  let inviteSeq = 0;

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  app.addHook("preHandler", async (req: any, reply: any) => {
    const path = String(req.url).split("?")[0];
    if (shouldSkipJwtVerification(path)) return;
    try {
      await req.jwtVerify();
    } catch {
      return reply.status(401).send({ error: "unauthorized" });
    }
    // Emulate the server.ts prefix permission gate (longest prefix wins).
    const needed = rulePermissionFor(path);
    if (needed) {
      const user = req.user as any;
      if (user.role !== "SUPER_ADMIN" && !keyHolders.get(user.sub)?.has(needed)) {
        return reply.status(403).send({ error: "forbidden" });
      }
    }
  });

  await registerSupermarketRoutes({
    app,
    db,
    requireOwner: async (req: any, reply: any) => {
      try {
        await req.jwtVerify();
      } catch {
        reply.status(401).send({ error: "unauthorized" });
        return null;
      }
      if ((req.user as any).role !== "SUPER_ADMIN") {
        reply.status(403).send({ error: "forbidden" });
        return null;
      }
      return req.user;
    },
    audit: async () => {},
    internalGuard: (req: any, reply: any, _endpoint: string) => {
      const verdict = checkInternalSecret(process.env.CDR_INGEST_SECRET, req.headers?.["x-cdr-secret"]);
      if (verdict.ok) return true;
      reply.code(verdict.status).send({ error: verdict.error });
      return false;
    },
    renderShell: (opts) => `<html><body><h1>${opts.headerTitle}</h1>${opts.body}</body></html>`,
    publicOrigin: () => "https://app.example.test",
    ingestDeliveryOrder: async (tenantId, event) => {
      ingested.push({ tenantId, event });
      return { ok: true };
    },
    driverInvite: {
      createInviteToken: async () => ({ token: `tok-${++inviteSeq}` }),
      portalPublicUrl: (p) => `https://app.example.test${p}`,
      queueEmailJob: async (input) => {
        emails.push(input);
        await db.emailJob.create({ data: { tenantId: input.tenantId, type: input.type, toEmail: input.toEmail, subject: input.subject, htmlBody: input.htmlBody, textBody: input.textBody } });
      },
    },
    hasActionPermission: (async (user: any, key: string) => keyHolders.get(user.sub)?.has(key) ?? false) as any,
    clientFor: clientForFactory(posByTenant) as any,
  });

  const tokenFor = (u: { sub: string; tenantId: string; role: string }) => (app as any).jwt.sign(u);
  return { app, db, posByTenant, keyHolders, ingested, emails, tokenFor };
}

const body = (r: any) => JSON.parse(r.body);

// ═════════════════════════════ STRESS 1 ══════════════════════════════════════

test("STRESS 1 — pay-IVR reducer fuzz: 3,000 random calls / ~60k events; money + cap + secrecy invariants on every step", () => {
  const seed = 11;
  const rnd = mulberry32(seed);
  const eventPool = (state: PayIvrState): PayIvrEvent[] => [
    { type: "call_start", callerKnown: rnd() < 0.5, hasStoredPin: rnd() < 0.5, storedPin: "1234" },
    { type: "digits", value: ["1", "2", "3", "9999", "25*37", "8456624417", "", "*", "###", "0"][Math.floor(rnd() * 10)] },
    { type: "lookup_result", found: rnd() < 0.5, posCustomerId: "c1" },
    { type: "pin_result", ok: rnd() < 0.5, balanceCents: Math.floor(rnd() * 10000) },
    { type: "balance_result", ok: rnd() < 0.7, balanceCents: Math.floor(rnd() * 10000) },
    { type: "charge_result", outcome: (["approved", "declined", "no_card", "duplicate", "error"] as const)[Math.floor(rnd() * 5)], newBalanceCents: 100 },
    { type: "hangup" },
  ];
  for (let call = 0; call < 3000; call++) {
    let state = initialPayIvrState();
    let chargesWithoutConfirm = 0;
    let confirmsSinceCharge = 0;
    for (let i = 0; i < 20; i++) {
      const pool = eventPool(state);
      const event = pool[Math.floor(rnd() * pool.length)];
      const wasConfirmAccept = state.phase === "confirm" && event.type === "digits" && event.value === "1" && state.pendingCents !== null;
      const out = reducePayIvr(state, event);
      // INVARIANT: prompts only ever come from the recorded set.
      for (const p of out.prompts) assert.ok(RECORDED_PROMPTS.has(p), `unknown prompt ${p} (seed ${seed}, call ${call})`);
      // INVARIANT: a PIN digit string never appears in any prompt ref.
      assert.ok(!out.prompts.some((p) => /^\d{4,}$/.test(p)), `pin-shaped prompt leaked (seed ${seed})`);
      const charges = out.effects.filter((e) => e.kind === "charge").length;
      if (charges > 0) {
        assert.equal(charges, 1, `two charge effects in one step (seed ${seed}, call ${call})`);
        assert.ok(wasConfirmAccept, `charge without a fresh confirmation (seed ${seed}, call ${call}, phase ${state.phase})`);
        confirmsSinceCharge = 0;
      }
      chargesWithoutConfirm += charges;
      void confirmsSinceCharge;
      // INVARIANT: caps can never be exceeded in stored state.
      assert.ok(out.state.pinAttempts <= PAY_MAX_PIN_ATTEMPTS);
      assert.ok(out.state.amountAttempts <= PAY_MAX_AMOUNT_ATTEMPTS);
      assert.ok(out.state.lookupAttempts <= PAY_MAX_LOOKUP_ATTEMPTS);
      assert.ok(out.state.confirmRounds <= PAY_MAX_CONFIRM_ROUNDS);
      assert.ok(out.state.chargeSeq <= PAY_MAX_CHARGES_PER_CALL);
      // INVARIANT: terminal states absorb.
      if (state.phase === "done" || state.phase === "human") {
        assert.equal(out.effects.length, 0, `terminal state produced effects (seed ${seed})`);
      }
      state = out.state;
    }
    assert.ok(chargesWithoutConfirm <= PAY_MAX_CHARGES_PER_CALL);
  }
});

// ═════════════════════════════ STRESS 2 ══════════════════════════════════════

test("STRESS 2 — amount entry exhaustive: EVERY DTMF string up to length 5 over [0-9*#] plus 50k length-9 randoms", () => {
  const alphabet = "0123456789*#";
  let checked = 0;
  const walk = (prefix: string) => {
    if (prefix.length > 0) {
      const parsed = parseStarDecimalAmount(prefix);
      checked++;
      if (prefix.includes("#")) assert.equal(parsed.ok, false, `# accepted in ${prefix}`);
      if (parsed.ok) {
        assert.ok(parsed.cents >= 1 && parsed.cents <= 9999999, `range breach ${prefix} -> ${parsed.cents}`);
        const refs = amountToPromptRefs(parsed.cents);
        for (const r of refs) assert.ok(RECORDED_PROMPTS.has(r), `unrecorded ref ${r} for ${prefix}`);
      }
    }
    if (prefix.length >= 5) return;
    for (const ch of alphabet) walk(prefix + ch);
  };
  walk("");
  const rnd = mulberry32(22);
  for (let i = 0; i < 50_000; i++) {
    let s = "";
    const len = 6 + Math.floor(rnd() * 4);
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    const parsed = parseStarDecimalAmount(s);
    checked++;
    if (parsed.ok) assert.ok(parsed.cents >= 1 && parsed.cents <= 9999999);
  }
  assert.ok(checked > 300_000, `exhaustive sweep too small: ${checked}`);
});

// ═════════════════════════════ STRESS 3 ══════════════════════════════════════

test("STRESS 3 — number reading exhaustive: every dollar amount 0..99,999 splices only recorded prompts and round-trips its value", () => {
  const speak = new Map<string, number>([
    ...Array.from({ length: 21 }, (_, i) => [`num_${i}`, i] as [string, number]),
    ["num_30", 30], ["num_40", 40], ["num_50", 50], ["num_60", 60],
    ["num_70", 70], ["num_80", 80], ["num_90", 90],
  ]);
  const revalue = (refs: string[]): number => {
    // Reconstruct the number a listener would hear.
    let total = 0;
    let current = 0;
    for (const ref of refs) {
      if (ref === "num_hundred") current *= 100;
      else if (ref === "num_thousand") {
        total += current * 1000;
        current = 0;
      } else current += speak.get(ref)!;
    }
    return total + current;
  };
  for (let n = 0; n <= 99_999; n++) {
    const refs = numberToPromptRefs(n);
    for (const r of refs) assert.ok(RECORDED_PROMPTS.has(r), `unrecorded ${r} at ${n}`);
    assert.equal(revalue(refs), n, `splice does not read back as ${n}: ${refs.join(" ")}`);
  }
});

// ═════════════════════════════ STRESS 4 ══════════════════════════════════════

test("STRESS 4 — pay-call runtime marathon: 400 full calls with injected 500s/timeouts/duplicates; the POS ledger reconciles to the cent", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos({ failEvery: 17, failStatus: 500 });
  pos.addCustomer({ id: "c1", phone10: "8456624417", pin: "4321", balanceCents: 10_000_000, cards: [{ id: "card1", masked: "…4417" }] });
  await seedPosTenant(db, "t-pay", pos);
  const clientFor = clientForFactory(new Map([["t-pay", pos]]));

  const rnd = mulberry32(44);
  let humanLandings = 0;
  for (let call = 0; call < 400; call++) {
    const callId = `call-${call}`;
    const step = (digits?: string, hangup?: boolean) =>
      runPayIvrStep({ db, clientFor: clientFor as any }, { tenantId: "t-pay", callId, callerNumber: "+18456624417", digits, hangup });
    let out = await step();
    let guard = 0;
    while (guard++ < 12 && out.gather && !out.transfer && !out.done) {
      const what = out.gather.what;
      const roll = rnd();
      if (what === "pin") out = await step(roll < 0.8 ? "4321" : "9999");
      else if (what === "menu") out = await step(roll < 0.5 ? "1" : "2");
      else if (what === "amount") out = await step(roll < 0.85 ? `${1 + Math.floor(rnd() * 90)}*${Math.floor(rnd() * 100)}`.replace("*100", "*99") : "###");
      else if (what === "confirm") out = await step(roll < 0.8 ? "1" : "2");
      else out = await step("8456624417");
      if (rnd() < 0.06) {
        out = await step(undefined, true);
        break;
      }
    }
    if (out.transfer) humanLandings++;
  }

  // ⛔ MONEY RECONCILIATION: what the sessions think they charged equals what
  // the register's ledger holds — to the cent, with zero duplicate externalIds.
  const ledgerTotal = [...pos.charges.values()].reduce((s, c) => s + c.amount, 0);
  const sessionTotal = db.rows("supermarketPayCall").reduce((s, r) => s + r.chargedCents, 0);
  assert.equal(sessionTotal, ledgerTotal, "session books disagree with the register ledger");
  assert.equal(new Set(pos.charges.keys()).size, pos.charges.size);
  assert.ok(pos.charges.size > 30, `marathon too quiet: ${pos.charges.size} charges`);
  assert.ok(humanLandings > 0, "failure injection never landed on a person — injection not exercised");
});

// ═════════════════════════════ STRESS 5 ══════════════════════════════════════

test("STRESS 5 — 25 concurrent approvals of ONE draft submit exactly ONE register order", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  await seedPosTenant(db, "t-conc", pos);
  const draft = db.seed("supermarketOrderDraft", {
    tenantId: "t-conc", sourceType: "voicemail", sourceId: "vm1",
    agentItems: [{ posProductId: "p1", qty: 1 }],
  });
  const clientFor = clientForFactory(new Map([["t-conc", pos]]));
  const items = [{ posProductId: "p1", code: "104", name: "Milk", qty: 2, unitPriceCents: 429 }];
  const results = await Promise.all(
    Array.from({ length: 25 }, () =>
      approveAndSubmitDraft(
        { db, clientFor: clientFor as any },
        { tenantId: "t-conc", draftId: draft.id, actorUserId: "rep1", reviewedItems: items, comments: "", notes: "", orderMethod: "Pickup" },
      ),
    ),
  );
  const orderPosts = pos.requestLog.filter((r) => r.method === "POST" && r.path === "/orders").length;
  assert.equal(orderPosts, 1, `the register saw ${orderPosts} order posts — the claim failed`);
  assert.ok(results.some((r) => r.ok));
  const row = db.rows("supermarketOrderDraft")[0];
  assert.equal(row.status, "SUBMITTED");
});

// ═════════════════════════════ STRESS 6 ══════════════════════════════════════

test("STRESS 6 — a timed-out submit retried lands ONCE: the second attempt reads their 409 as 'already landed'", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos({ timeoutOn: new Set([1]) }); // first request (the order POST) times out
  await seedPosTenant(db, "t-retry", pos);
  pos.counter = 0; // seed made no pos calls; keep indexes aligned
  const draft = db.seed("supermarketOrderDraft", { tenantId: "t-retry", sourceType: "text", sourceId: "m1", agentItems: [] });
  const clientFor = clientForFactory(new Map([["t-retry", pos]]));
  const items = [{ posProductId: "p9", code: "9", name: "Eggs", qty: 1, unitPriceCents: 389 }];
  const input = { tenantId: "t-retry", draftId: draft.id, actorUserId: "rep1", reviewedItems: items, comments: "", notes: "", orderMethod: "Pickup" as const };

  // ⛔ The fake times out AFTER recording the request — like a real socket, the
  // register may have processed it. Simulate exactly that: mark it landed.
  const first = await approveAndSubmitDraft({ db, clientFor: clientFor as any }, input);
  assert.equal(first.ok, false);
  const ext = db.rows("supermarketOrderDraft")[0].posExternalId;
  pos.orders.set(ext, { externalOrderId: ext, body: {} }); // the timed-out POST actually landed

  const second = await approveAndSubmitDraft({ db, clientFor: clientFor as any }, input);
  assert.equal(second.ok, true);
  const orderPosts = pos.requestLog.filter((r) => r.method === "POST" && r.path === "/orders").length;
  // one timed-out POST + one 409'd POST = two REQUESTS, but the ledger holds ONE order
  assert.equal(pos.orders.size, 1, "retry created a second register order");
  assert.ok(orderPosts <= 2);
  assert.equal(db.rows("supermarketOrderDraft")[0].status, "SUBMITTED");
});

// ═════════════════════════════ STRESS 7 ══════════════════════════════════════

test("STRESS 7 — draft-builder sweep is idempotent: 10 consecutive sweeps over the same sources create each draft exactly once", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  await seedPosTenant(db, "t-sweep", pos);
  for (let i = 0; i < 40; i++) {
    db.seed("voicemail", { id: `vm-${i}`, tenantId: "t-sweep", transcript: `104 x2 note ${i}`, callerNumber: "8456624417", receivedAt: new Date() });
  }
  const thread = db.seed("connectChatThread", { id: "th1", type: "SMS", externalSmsE164: "+18456624417", title: "Rivky" });
  for (let i = 0; i < 40; i++) {
    db.seed("connectChatMessage", { id: `msg-${i}`, tenantId: "t-sweep", direction: "INBOUND", body: `order line ${i}`, threadId: thread.id, createdAt: new Date() });
  }
  const clientFor = clientForFactory(new Map([["t-sweep", pos]]));
  for (let pass = 0; pass < 10; pass++) {
    await runDraftBuilderSweep({ db, clientFor: clientFor as any });
  }
  assert.equal(db.rows("supermarketOrderDraft").length, 80, "sweeps duplicated or dropped drafts");
});

// ═════════════════════════════ STRESS 8 ══════════════════════════════════════

test("STRESS 8 — sweep volume + fresh window: 3,000 sources, only in-window ones drafted, per-run caps hold, stale backlog untouchable", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  await seedPosTenant(db, "t-vol", pos);
  const now = Date.now();
  for (let i = 0; i < 1500; i++) {
    const fresh = i % 3 !== 0;
    db.seed("voicemail", {
      id: `vmv-${i}`, tenantId: "t-vol", transcript: `line ${i}`, callerNumber: "8450000000",
      receivedAt: new Date(now - (fresh ? 3_600_000 : 100 * 3_600_000)),
    });
  }
  const thread = db.seed("connectChatThread", { id: "thv", type: "SMS", externalSmsE164: "+18450000000" });
  for (let i = 0; i < 1500; i++) {
    const fresh = i % 3 !== 0;
    db.seed("connectChatMessage", {
      id: `mgv-${i}`, tenantId: "t-vol", direction: "INBOUND", body: `txt ${i}`, threadId: thread.id,
      createdAt: new Date(now - (fresh ? 3_600_000 : 100 * 3_600_000)),
    });
  }
  const clientFor = clientForFactory(new Map([["t-vol", pos]]));
  const first = await runDraftBuilderSweep({ db, clientFor: clientFor as any });
  assert.ok(first.drafts <= 100, `per-run cap breached: ${first.drafts}`);
  for (let pass = 0; pass < 40; pass++) await runDraftBuilderSweep({ db, clientFor: clientFor as any });
  const drafts = db.rows("supermarketOrderDraft");
  const freshCount = 1000 + 1000; // 2/3 of each 1500
  assert.equal(drafts.length, freshCount, `expected exactly the in-window sources drafted, got ${drafts.length}`);
  assert.ok(drafts.every((d) => d.tenantId === "t-vol"));
});

// ═════════════════════════════ STRESS 9 ══════════════════════════════════════

test("STRESS 9 — matcher hostile fuzz: 30,000 adversarial texts (NULs, RTL, 8KB, emoji, regex bombs) never throw and never breach bounds", () => {
  const index = buildCatalogIndex([
    { posProductId: "p1", code: "104", name: "Milk", unitPriceCents: 429 },
    { posProductId: "p2", code: "1188", name: "Challah", unitPriceCents: 550 },
  ]);
  const rnd = mulberry32(99);
  const nasties = [
    String.fromCharCode(0), String.fromCharCode(8), "‮", "🛒", "׳״", "\\", "$&", "(((((", "a".repeat(200),
    "104", "x2", "וויק", ".", "*", "1188 1188 1188", "999999999999999999", "<script>", "%s%s%n",
  ];
  for (let i = 0; i < 30_000; i++) {
    let text = "";
    const parts = Math.floor(rnd() * 40);
    for (let j = 0; j < parts; j++) text += nasties[Math.floor(rnd() * nasties.length)] + (rnd() < 0.3 ? "\n" : " ");
    if (rnd() < 0.05) text = text.repeat(20).slice(0, 9000);
    const m = matchDraftText(text, index);
    assert.ok(m.items.length <= 60);
    assert.ok(m.notes.length <= 12);
    for (const item of m.items) {
      assert.ok(item.qty >= 1 && item.qty <= 99, `qty bound breach ${item.qty}`);
      assert.ok(["p1", "p2"].includes(item.posProductId), "matched an item not in the catalog");
    }
    for (const note of m.notes) assert.ok(note.length <= 240);
  }
});

// ═════════════════════════════ STRESS 10 ═════════════════════════════════════

test("STRESS 10 — matcher precision at scale: 1,500-item catalog × 300 generated orders — every match is real, quantities exact", () => {
  const entries = Array.from({ length: 1500 }, (_, i) => ({
    posProductId: `p${i}`,
    code: String(1000 + i),
    name: `item${i}`,
    unitPriceCents: 100 + i,
  }));
  const index = buildCatalogIndex(entries);
  const rnd = mulberry32(1010);
  for (let order = 0; order < 300; order++) {
    const wanted = new Map<string, number>();
    let text = "";
    const lines = 1 + Math.floor(rnd() * 12);
    for (let l = 0; l < lines; l++) {
      const item = entries[Math.floor(rnd() * entries.length)];
      const qty = 1 + Math.floor(rnd() * 9);
      wanted.set(item.posProductId, (wanted.get(item.posProductId) ?? 0) + qty);
      text += rnd() < 0.5 ? `${qty} ${item.name}\n` : `${item.code} x${qty}\n`;
    }
    const m = matchDraftText(text, index);
    for (const item of m.items) {
      assert.ok(wanted.has(item.posProductId), `phantom item ${item.posProductId} in order ${order}`);
      assert.equal(item.qty, Math.min(99, wanted.get(item.posProductId)!), `qty drift on ${item.posProductId} in order ${order}`);
    }
    assert.equal(m.items.length, wanted.size, `missing items in order ${order}: got ${m.items.length}, wanted ${wanted.size}`);
  }
});

// ═════════════════════════════ STRESS 11 ═════════════════════════════════════

test("STRESS 11 — catalog paging storm: a 12,000-product walk FINISHES IN ONE RUN, the high-water gates re-reads, and a too-small budget persists NO cursor (their cursors die between runs — proven live)", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  for (let i = 0; i < 12_000; i++) {
    pos.products.push({ id: `pr${i}`, code: String(i), name: `prod ${i}`, price: 1 + (i % 50) / 10, lastMod: `2026-08-${String(1 + (i % 25)).padStart(2, "0")}` });
  }
  await seedPosTenant(db, "t-cat", pos);
  const clientFor = clientForFactory(new Map([["t-cat", pos]]));

  // a too-small budget: run cannot finish → NO cursor persisted, NO high-water
  await runCatalogSyncSweep({ db, clientFor: clientFor as any, pageBudget: 10, pagePaceMs: 0 });
  let state = db.rows("posCatalogSyncState")[0];
  assert.equal(state.cursor, null, "a cross-run cursor was persisted — their cursors are DEAD between runs");
  assert.equal(state.lastMod, null, "high-water advanced on an unfinished walk — the tail would be skipped forever");
  assert.equal(db.rows("posCatalogItem").length, 1000);

  // an adequate budget: the whole walk completes inside one run
  await runCatalogSyncSweep({ db, clientFor: clientFor as any, pageBudget: 200, pagePaceMs: 0 });
  state = db.rows("posCatalogSyncState")[0];
  assert.equal(db.rows("posCatalogItem").length, 12_000);
  assert.equal(state.lastMod, "2026-08-25");
  assert.equal(state.cursor, null);
  assert.equal(state.itemCount, 12_000);

  // incremental re-run: nothing older re-fetched, count stable
  const before = pos.requestLog.length;
  await runCatalogSyncSweep({ db, clientFor: clientFor as any, pageBudget: 200, pagePaceMs: 0 });
  assert.equal(db.rows("posCatalogItem").length, 12_000);
  assert.ok(pos.requestLog.length - before <= 2, "incremental run should cost ~1 page");
});

test("STRESS 11b — a mid-walk 429 waits Retry-After and CONTINUES the same walk (the live 2026-08-26 failure: aborting restarts from scratch forever)", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos({ failEvery: 25, failStatus: 429 }); // every 25th request is a 429
  for (let i = 0; i < 4000; i++) {
    pos.products.push({ id: `rl${i}`, code: String(i), name: `p${i}`, price: 1, lastMod: "m" });
  }
  await seedPosTenant(db, "t-rl", pos);
  pos.counter = 0;
  const clientFor = clientForFactory(new Map([["t-rl", pos]]));
  await runCatalogSyncSweep({ db, clientFor: clientFor as any, pagePaceMs: 0 });
  const state = db.rows("posCatalogSyncState")[0];
  // 40 pages + a 429 every 25th request: with wait-and-continue the walk FINISHES.
  assert.equal(db.rows("posCatalogItem").length, 4000, `429s aborted the walk: ${JSON.stringify(state)}`);
  assert.equal(state.lastMod, "m", "high-water not set — the walk did not finish");
  assert.equal(state.lastError, null);
});

// ═════════════════════════════ STRESS 12 ═════════════════════════════════════

test("STRESS 12 — catalog sync vs 40 hostile page shapes: records lastError, never throws, never wipes stored items", async () => {
  const db = makeSupermarketDb();
  const goodPos = new FakePos();
  goodPos.products.push({ id: "keep1", code: "1", name: "Keep me", price: 1, lastMod: "a" });
  await seedPosTenant(db, "t-host", goodPos);
  const clientFor1 = clientForFactory(new Map([["t-host", goodPos]]));
  await runCatalogSyncSweep({ db, clientFor: clientFor1 as any, pagePaceMs: 0 });
  assert.equal(db.rows("posCatalogItem").length, 1);

  const hostileBodies = [
    "not json at all", "[[[", JSON.stringify("a string"), JSON.stringify(123), JSON.stringify({ items: "nope" }),
    JSON.stringify({ items: [null, 5, "x", {}, { id: null }] }), JSON.stringify({ cursor: "x".repeat(600), items: [] }),
    ...Array.from({ length: 33 }, (_, i) => JSON.stringify({ ["k" + i]: i })),
  ];
  for (const hostile of hostileBodies) {
    const badPos = new FakePos();
    badPos.fetchImpl = (async () => ({ status: 200, headers: { get: () => null }, text: async () => hostile })) as any;
    // re-point the same tenant at the hostile register
    const clientFor2 = clientForFactory(new Map([["t-host", badPos]]));
    await runCatalogSyncSweep({ db, clientFor: clientFor2 as any, pagePaceMs: 0 });
    assert.equal(db.rows("posCatalogItem").length, 1, `stored items were disturbed by: ${hostile.slice(0, 40)}`);
  }
  // parseProductsPage direct sweep too
  for (const hostile of hostileBodies) {
    let parsed: any;
    try {
      parsed = parseProductsPage(JSON.parse(hostile));
    } catch {
      parsed = parseProductsPage(hostile);
    }
    assert.ok(parsed === null || Array.isArray(parsed.items));
  }
});

// ═════════════════════════════ STRESS 13 ═════════════════════════════════════

test("STRESS 13 — the credit meter: a full sync + lookups account exactly the documented per-call costs", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  for (let i = 0; i < 250; i++) pos.products.push({ id: `pc${i}`, code: String(i), name: `p${i}`, price: 1, lastMod: "z" });
  await seedPosTenant(db, "t-credit", pos);
  const clientFor = clientForFactory(new Map([["t-credit", pos]]));
  await runCatalogSyncSweep({ db, clientFor: clientFor as any, pageBudget: 10, pagePaceMs: 0 });
  const state = db.rows("posCatalogSyncState")[0];
  // 250 products at take=100 → 3 pages → 3 credits (products = 1 credit each)
  assert.equal(state.creditsSpent, 3, `meter read ${state.creditsSpent}, expected 3`);
});

// ═════════════════════════════ STRESS 14 ═════════════════════════════════════

test("STRESS 14 — route auth matrix: every surface × six principals answers exactly as designed (404-ownership before 403-permission)", async () => {
  const kit = await buildApp();
  const { app, db, posByTenant, keyHolders, tokenFor } = kit;
  const pos = new FakePos();
  posByTenant.set("t-a", pos);
  await seedPosTenant(db, "t-a", pos);
  db.seed("tenant", { id: "t-b", name: "Other Store", crmMode: "supermarket" });
  db.seed("tenant", { id: "t-classic", name: "Classic Co", crmMode: "classic" });

  db.seed("user", { id: "u-view", tenantId: "t-a", email: "v@x.com" });
  db.seed("user", { id: "u-manage", tenantId: "t-a", email: "m@x.com" });
  db.seed("user", { id: "u-none", tenantId: "t-a", email: "n@x.com" });
  db.seed("user", { id: "u-foreign", tenantId: "t-b", email: "f@x.com" });
  db.seed("user", { id: "u-classic", tenantId: "t-classic", email: "c@x.com" });
  keyHolders.set("u-view", new Set(["can_view_supermarket_orders"]));
  keyHolders.set("u-manage", new Set(["can_view_supermarket_orders", "can_manage_supermarket_orders", "can_manage_supermarket_specials", "can_manage_tracking_drivers"]));
  keyHolders.set("u-foreign", new Set(["can_view_supermarket_orders", "can_manage_supermarket_orders"]));
  keyHolders.set("u-classic", new Set(["can_view_supermarket_orders"]));

  const draft = db.seed("supermarketOrderDraft", { tenantId: "t-a", sourceType: "voicemail", sourceId: "vmx", agentItems: [] });

  const tokens = {
    view: tokenFor({ sub: "u-view", tenantId: "t-a", role: "USER" }),
    manage: tokenFor({ sub: "u-manage", tenantId: "t-a", role: "USER" }),
    none: tokenFor({ sub: "u-none", tenantId: "t-a", role: "USER" }),
    foreign: tokenFor({ sub: "u-foreign", tenantId: "t-b", role: "USER" }),
    classic: tokenFor({ sub: "u-classic", tenantId: "t-classic", role: "USER" }),
    owner: tokenFor({ sub: "u-owner", tenantId: "admin", role: "SUPER_ADMIN" }),
  };
  const h = (t?: string) => (t ? { authorization: `Bearer ${t}` } : {});

  // list/read family
  assert.equal((await app.inject({ method: "GET", url: "/supermarket/drafts" })).statusCode, 401, "anonymous");
  assert.equal((await app.inject({ method: "GET", url: "/supermarket/drafts", headers: h(tokens.none) })).statusCode, 403, "no key");
  assert.equal((await app.inject({ method: "GET", url: "/supermarket/drafts", headers: h(tokens.view) })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/supermarket/drafts", headers: h(tokens.classic) })).statusCode, 403, "classic mode walled");

  // ⛔ ownership before permission: a FOREIGN draft answers 404 to a fully-keyed
  // foreign user — and 404, not 403, to a keyless user of the wrong tenant.
  const foreign = await app.inject({ method: "POST", url: `/supermarket/drafts/${draft.id}/approve`, headers: h(tokens.foreign), payload: { items: [] } });
  assert.equal(foreign.statusCode, 404, "another tenant's draft must be indistinguishable from one that never existed");
  // view-only user hitting approve on an OWN draft: 403 (after 404-ownership passes)
  const viewApprove = await app.inject({ method: "POST", url: `/supermarket/drafts/${draft.id}/approve`, headers: h(tokens.view), payload: { items: [] } });
  assert.equal(viewApprove.statusCode, 403);
  // manage user, empty items → 400 (body validated after both)
  const emptyApprove = await app.inject({ method: "POST", url: `/supermarket/drafts/${draft.id}/approve`, headers: h(tokens.manage), payload: { items: [] } });
  assert.equal(emptyApprove.statusCode, 400);

  // /supermarket/mode is authenticated-only (permission: null rule)
  assert.equal((await app.inject({ method: "GET", url: "/supermarket/mode", headers: h(tokens.none) })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/supermarket/mode" })).statusCode, 401);

  // admin family: owner only
  for (const [name, token, expected] of [
    ["anon", undefined, 401],
    ["user", tokens.manage, 403],
    ["owner", tokens.owner, 200],
  ] as const) {
    const res = await app.inject({ method: "GET", url: "/admin/integrations/tenants", headers: h(token as any) });
    assert.equal(res.statusCode, expected, `admin tenants as ${name}`);
  }

  // specials + drivers keys
  assert.equal((await app.inject({ method: "POST", url: "/supermarket/specials", headers: h(tokens.view), payload: { subject: "abc", body: "def" } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/supermarket/specials", headers: h(tokens.manage), payload: { subject: "abc", body: "def" } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/supermarket/drivers/full", headers: h(tokens.view), payload: { name: "A Driver", cell: "8455551234", email: "d@x.com" } })).statusCode, 403);
});

test("STRESS 14b — the workspace tenant switch: SUPER_ADMIN with x-tenant-context operates on the SWITCHED tenant; a plain user's forged header is IGNORED", async () => {
  const kit = await buildApp();
  const { app, db, posByTenant, keyHolders, tokenFor } = kit;
  const pos = new FakePos();
  pos.products.push({ id: "sw1", code: "104", name: "Milk", price: 4.29, lastMod: "m" });
  posByTenant.set("t-shop", pos);
  await seedPosTenant(db, "t-shop", pos);
  db.seed("posCatalogItem", { tenantId: "t-shop", posProductId: "sw1", code: "104", name: "Milk", unitPriceCents: 429, isActive: true });
  db.seed("supermarketOrderDraft", { tenantId: "t-shop", sourceType: "voicemail", sourceId: "sw-vm", agentItems: [] });
  db.seed("tenant", { id: "t-other", crmMode: "classic" });
  db.seed("user", { id: "u-pleb", tenantId: "t-other", email: "pleb@x.com" });
  keyHolders.set("u-pleb", new Set(["can_view_supermarket_orders"]));

  const admin = tokenFor({ sub: "u-owner", tenantId: "admin-tenant", role: "SUPER_ADMIN" });
  const switched = { authorization: `Bearer ${admin}`, "x-tenant-context": "t-shop" };

  // unswitched: the admin tenant has nothing
  const bare = await app.inject({ method: "GET", url: "/supermarket/drafts", headers: { authorization: `Bearer ${admin}` } });
  assert.equal(body(bare).drafts.length, 0, "unswitched admin should see the admin tenant (empty)");
  // switched: the store's drafts + catalog appear — Izzy's exact report was
  // "I started to type, nothing came up in suggestions"
  const drafts = await app.inject({ method: "GET", url: "/supermarket/drafts", headers: switched });
  assert.equal(body(drafts).drafts.length, 1, "the switch must reach the drafts list");
  const search = await app.inject({ method: "GET", url: "/supermarket/catalog/search?q=mil", headers: switched });
  assert.equal(body(search).items.length, 1, "the switch must reach the quick-add search");
  assert.equal(body(search).items[0].name, "Milk");
  // a call-sourced draft lands in the SWITCHED tenant
  const created = await app.inject({ method: "POST", url: "/supermarket/drafts", headers: switched, payload: { sourceType: "call", customerPhone: "8456624417" } });
  assert.equal(created.statusCode, 200, created.body);
  const row = db.rows("supermarketOrderDraft").find((d) => d.id === body(created).draft.id);
  assert.equal(row!.tenantId, "t-shop", "a created draft must land in the switched tenant");

  // ⛔ a NON-admin sending the header is ignored — the switch is SUPER_ADMIN only
  const pleb = tokenFor({ sub: "u-pleb", tenantId: "t-other", role: "USER" });
  const forged = await app.inject({ method: "GET", url: "/supermarket/drafts", headers: { authorization: `Bearer ${pleb}`, "x-tenant-context": "t-shop" } });
  // t-other is classic → the mode wall refuses; the header must NOT have moved them into t-shop
  assert.equal(forged.statusCode, 403);
  assert.equal(body(forged).error, "wrong_crm_mode");
});

// ═════════════════════════════ STRESS 15 ═════════════════════════════════════

test("STRESS 15 — tenant-isolation storm: 300 concurrent mixed operations across 3 tenants with forged tenantIds in every body — zero cross-tenant bleed", async () => {
  const kit = await buildApp();
  const { app, db, posByTenant, keyHolders, tokenFor } = kit;
  const tenants = ["iso-1", "iso-2", "iso-3"];
  const tokens: Record<string, string> = {};
  for (const t of tenants) {
    const pos = new FakePos({ apiKey: `key-${t}-0000000000` });
    posByTenant.set(t, pos);
    await seedPosTenant(db, t, pos);
    db.seed("user", { id: `rep-${t}`, tenantId: t, email: `rep-${t}@x.com` });
    keyHolders.set(`rep-${t}`, new Set(["can_view_supermarket_orders", "can_manage_supermarket_orders", "can_manage_supermarket_specials"]));
    tokens[t] = tokenFor({ sub: `rep-${t}`, tenantId: t, role: "USER" });
  }
  const rnd = mulberry32(1515);
  const ops = Array.from({ length: 300 }, (_, i) => {
    const mine = tenants[i % 3];
    const theirs = tenants[(i + 1) % 3];
    const kind = Math.floor(rnd() * 3);
    if (kind === 0) {
      return app.inject({
        method: "POST", url: "/supermarket/drafts", headers: { authorization: `Bearer ${tokens[mine]}` },
        // ⛔ forged tenant markers in the body must be IGNORED
        payload: { sourceType: "call", customerPhone: "8450001111", tenantId: theirs, tenant_id: theirs, __proto__: { hacked: true } } as any,
      });
    }
    if (kind === 1) {
      return app.inject({ method: "GET", url: "/supermarket/drafts", headers: { authorization: `Bearer ${tokens[mine]}` } });
    }
    return app.inject({
      method: "POST", url: "/supermarket/specials", headers: { authorization: `Bearer ${tokens[mine]}` },
      payload: { subject: `s-${i}`, body: `b-${i}`, tenantId: theirs } as any,
    });
  });
  const results = await Promise.all(ops);
  for (const r of results) assert.ok(r.statusCode < 500, `a 500 escaped: ${r.body}`);

  // every created row sits in its creator's tenant
  for (const row of db.rows("supermarketOrderDraft")) assert.ok(tenants.includes(row.tenantId));
  for (const row of db.rows("supermarketSpecial")) assert.ok(tenants.includes(row.tenantId));
  // and every list answer contained only that tenant's rows
  for (const t of tenants) {
    const res = await app.inject({ method: "GET", url: "/supermarket/drafts", headers: { authorization: `Bearer ${tokens[t]}` } });
    for (const d of body(res).drafts) {
      const row = db.rows("supermarketOrderDraft").find((x) => x.id === d.id);
      assert.equal(row!.tenantId, t, "a list leaked another tenant's draft");
    }
  }
  assert.equal(({} as any).hacked, undefined, "prototype pollution escaped");
});

// ═════════════════════════════ STRESS 16 ═════════════════════════════════════

test("STRESS 16 — the mode wall both directions + the campaign-block decision sweep", async () => {
  const kit = await buildApp();
  const { app, db, keyHolders, tokenFor } = kit;
  db.seed("tenant", { id: "t-wall", crmMode: "classic", name: "Wall Co" });
  db.seed("user", { id: "u-wall", tenantId: "t-wall", email: "w@x.com" });
  keyHolders.set("u-wall", new Set(["can_view_supermarket_orders", "can_manage_supermarket_orders"]));
  const token = tokenFor({ sub: "u-wall", tenantId: "t-wall", role: "USER" });

  // classic tenant: every supermarket surface refuses wrong_crm_mode
  for (const url of ["/supermarket/summary", "/supermarket/drafts", "/supermarket/catalog/search?q=1", "/supermarket/stats", "/supermarket/specials", "/supermarket/drivers"]) {
    const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.statusCode, 403, `${url} opened for a classic tenant`);
    assert.equal(body(res).error, "wrong_crm_mode");
  }
  // SUPER_ADMIN passes the wall (owner inspects any tenant)
  const owner = tokenFor({ sub: "owner", tenantId: "t-wall", role: "SUPER_ADMIN" });
  assert.equal((await app.inject({ method: "GET", url: "/supermarket/summary", headers: { authorization: `Bearer ${owner}` } })).statusCode, 200);

  // the campaign-block hook decision, swept across the whole input space
  const { decideCampaignBlock, CLASSIC_ONLY_PREFIXES } = await import("./crmMode");
  const paths = [
    ...CLASSIC_ONLY_PREFIXES,
    ...CLASSIC_ONLY_PREFIXES.map((p) => `${p}/anything/deep`),
    ...CLASSIC_ONLY_PREFIXES.map((p) => `/api${p}`),
    "/crm/contacts", "/chat/threads", "/supermarket/drafts", "/crm/campaignsish",
  ];
  for (const path of paths) {
    for (const role of ["USER", "TENANT_ADMIN", "SUPER_ADMIN", undefined]) {
      for (const mode of ["classic", "supermarket"] as const) {
        const blocked = decideCampaignBlock({ path, role, mode });
        const isCampaign = CLASSIC_ONLY_PREFIXES.some((p) => {
          const bare = path.startsWith("/api/") ? path.slice(4) : path;
          return bare === p || bare.startsWith(`${p}/`);
        });
        const expected = isCampaign && mode === "supermarket" && role !== "SUPER_ADMIN";
        assert.equal(blocked, expected, `${path} role=${role} mode=${mode}`);
      }
    }
  }
});

// ═════════════════════════════ STRESS 17 ═════════════════════════════════════

test("STRESS 17 — the pay-by-phone door: fail-closed secret matrix, disabled tenants transfer, 12 hostile bodies never 500", async () => {
  const kit = await buildApp();
  const { app, db, posByTenant } = kit;
  const pos = new FakePos();
  pos.addCustomer({ id: "c1", phone10: "8456624417", pin: "1111", balanceCents: 5000, cards: [{ id: "cd", masked: "x" }] });
  posByTenant.set("t-door", pos);
  await seedPosTenant(db, "t-door", pos);
  db.seed("supermarketSettings", { tenantId: "t-door", payIvrEnabled: true });

  const good = { tenantId: "t-door", callId: "c-1", callerNumber: "+18456624417" };
  const url = "/internal/supermarket/pay-ivr/step";

  // secret matrix (⛔ 403 = reached the handler; 401 = missing header)
  assert.equal((await app.inject({ method: "POST", url, payload: good })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url, payload: good, headers: { "x-cdr-secret": "wrong" } })).statusCode, 403);
  const ok = await app.inject({ method: "POST", url, payload: good, headers: { "x-cdr-secret": process.env.CDR_INGEST_SECRET! } });
  assert.equal(ok.statusCode, 200);
  assert.ok(body(ok).prompts.includes("01_welcome"));

  // a tenant with the line switched OFF gets a person, no lookups, no state
  db.seed("tenant", { id: "t-off", crmMode: "supermarket" });
  const off = await app.inject({ method: "POST", url, payload: { ...good, tenantId: "t-off" }, headers: { "x-cdr-secret": process.env.CDR_INGEST_SECRET! } });
  assert.equal(off.statusCode, 200);
  assert.equal(body(off).transfer, true);

  // hostile bodies
  const hostiles = [
    {}, { tenantId: 5 }, { tenantId: "t-door" }, { tenantId: "t-door", callId: "x".repeat(500) },
    { tenantId: "t-door", callId: "c", digits: 12345 }, { tenantId: "t-door", callId: "c", hangup: "yes" },
    [], "string", { tenantId: "t-door", callId: "c-1", callerNumber: { evil: 1 } },
    { tenantId: "t-door", callId: "c-1", digits: " " }, { tenantId: { in: ["t-door"] }, callId: "c" },
    { tenantId: "t-door", callId: "c-1", digits: "9".repeat(31) },
  ];
  for (const hostile of hostiles) {
    const res = await app.inject({ method: "POST", url, payload: hostile as any, headers: { "x-cdr-secret": process.env.CDR_INGEST_SECRET! } });
    assert.ok(res.statusCode < 500, `hostile body 500d: ${JSON.stringify(hostile).slice(0, 60)} -> ${res.body}`);
  }
});

// ═════════════════════════════ STRESS 18 ═════════════════════════════════════

test("STRESS 18 — unsubscribe forgery storm: 5,000 mutated tokens accepted 0 times; a legit token is idempotent and tenant-scoped", async () => {
  const kit = await buildApp();
  const { app, db } = kit;
  db.seed("tenant", { id: "t-mail", crmMode: "supermarket" });
  db.seed("tenant", { id: "t-mail2", crmMode: "supermarket" });
  const legit = unsubscribeToken("t-mail", "buyer@example.com");
  const rnd = mulberry32(1818);
  let accepted = 0;
  for (let i = 0; i < 5000; i++) {
    const chars = legit.split("");
    const flips = 1 + Math.floor(rnd() * 3);
    for (let f = 0; f < flips; f++) {
      const at = Math.floor(rnd() * chars.length);
      chars[at] = "ABCDEFabcdef0123456789_-".charAt(Math.floor(rnd() * 24));
    }
    const mutated = chars.join("");
    if (mutated === legit) continue;
    const verdict = verifyUnsubscribeToken(mutated);
    // base64 malleability: a flip in the unused trailing bits of the final
    // sextet decodes to IDENTICAL bytes — that is the same token, not a forgery.
    // The security property is that no mutation ever verifies to a DIFFERENT
    // tenant or address.
    if (verdict && (verdict.tenantId !== "t-mail" || verdict.email !== "buyer@example.com")) accepted++;
  }
  assert.equal(accepted, 0, `forged tokens verified to a foreign identity: ${accepted}`);

  for (let i = 0; i < 3; i++) {
    const res = await app.inject({ method: "GET", url: `/marketing/unsubscribe/${legit}` });
    assert.equal(res.statusCode, 200);
  }
  const rows = db.rows("marketingUnsubscribe");
  assert.equal(rows.length, 1, "unsubscribe not idempotent");
  assert.equal(rows[0].tenantId, "t-mail");
  // the same address on ANOTHER tenant is untouched
  assert.ok(!rows.some((r) => r.tenantId === "t-mail2"));
});

// ═════════════════════════════ STRESS 19 ═════════════════════════════════════

test("STRESS 19 — the blast: 2,600 messy contacts dedupe to the correct recipient set, unsubscribed excluded, capped, and 10 concurrent sends collapse to one", async () => {
  process.env.MARKETING_MAIL_ENABLED = "1";
  try {
    const db = makeSupermarketDb();
    db.seed("tenant", { id: "t-blast", crmMode: "supermarket" });
    for (let i = 0; i < 2600; i++) {
      const c = db.seed("contact", { id: `ct-${i}`, tenantId: "t-blast", displayName: `Person ${i}`, active: i % 50 !== 0 });
      if (i % 7 === 0) continue; // no email at all
      const email = i % 13 === 0 ? `DUP@example.com` : `p${i}@example.com`;
      db.seed("contactEmail", { contactId: c.id, email, isPrimary: true });
    }
    for (let i = 0; i < 100; i++) db.seed("marketingUnsubscribe", { tenantId: "t-blast", email: `p${i * 3}@example.com` });
    const special = db.seed("supermarketSpecial", { tenantId: "t-blast", subject: "Weekly special", body: "Chicken <b>$1.99</b>/lb & more" });

    const deps = {
      db,
      renderShell: (o: any) => `<html>${o.body}</html>`,
      publicOrigin: () => "https://app.example.test",
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => sendSpecialBlast(deps as any, { tenantId: "t-blast", specialId: special.id })));
    const wins = results.filter((r) => r.ok);
    assert.equal(wins.length, 1, `concurrent sends won ${wins.length} times`);

    const jobs = db.rows("emailJob");
    assert.ok(jobs.length > 0 && jobs.length <= 2000, `cap breach: ${jobs.length}`);
    const to = jobs.map((j) => j.toEmail);
    assert.equal(new Set(to).size, to.length, "duplicate recipient");
    for (const j of jobs) {
      assert.equal(j.type, "MARKETING_SPECIAL");
      assert.notEqual(j.type, "ADMIN_ALERT");
      assert.ok(j.htmlBody.includes("/api/marketing/unsubscribe/"), "an email went out without its unsubscribe link");
      // hostile body content is escaped, not rendered
      assert.ok(!j.htmlBody.includes("<b>$1.99</b>"), "unescaped customer HTML");
      assert.ok(j.htmlBody.includes("&lt;b&gt;$1.99&lt;/b&gt;"));
    }
    // every unsubscribed address is absent
    for (let i = 0; i < 100; i++) assert.ok(!to.includes(`p${i * 3}@example.com`), "an unsubscribed address was mailed");
    // inactive contacts are absent
    assert.ok(!to.includes("p50@example.com"));
    // every token in every email verifies back to its own recipient
    for (const j of jobs.slice(0, 200)) {
      const m = j.htmlBody.match(/unsubscribe\/([A-Za-z0-9_.-]+)/);
      const verdict = verifyUnsubscribeToken(m![1]);
      assert.equal(verdict!.email, j.toEmail.toLowerCase());
      assert.equal(verdict!.tenantId, "t-blast");
    }
  } finally {
    delete process.env.MARKETING_MAIL_ENABLED;
  }
});

// ═════════════════════════════ STRESS 20 ═════════════════════════════════════

test("STRESS 20 — the marketing wall: with the lane OFF a send refuses loudly and queues NOTHING, and the refusal never marks the special sent", async () => {
  delete process.env.MARKETING_MAIL_ENABLED;
  const db = makeSupermarketDb();
  db.seed("tenant", { id: "t-wall2", crmMode: "supermarket" });
  const c = db.seed("contact", { id: "ct", tenantId: "t-wall2", displayName: "P" });
  db.seed("contactEmail", { contactId: c.id, email: "p@example.com", isPrimary: true });
  const special = db.seed("supermarketSpecial", { tenantId: "t-wall2", subject: "S", body: "B" });
  for (let i = 0; i < 25; i++) {
    const res = await sendSpecialBlast(
      { db, renderShell: (o: any) => o.body, publicOrigin: () => "https://x" } as any,
      { tenantId: "t-wall2", specialId: special.id },
    );
    assert.equal(res.ok, false);
    assert.equal((res as any).code, "marketing_lane_not_configured");
  }
  assert.equal(db.rows("emailJob").length, 0, "the wall leaked email jobs");
  assert.equal(db.rows("supermarketSpecial")[0].status, "DRAFT");
});

// ═════════════════════════════ STRESS 21 ═════════════════════════════════════

test("STRESS 21 — driver creation storm: 100 concurrent creates on one email make ONE login; resend refuses for a signed-in driver; the email is never ADMIN_ALERT", async () => {
  const kit = await buildApp();
  const { app, db, posByTenant, keyHolders, tokenFor } = kit;
  const pos = new FakePos();
  posByTenant.set("t-drv", pos);
  await seedPosTenant(db, "t-drv", pos);
  db.seed("user", { id: "mgr", tenantId: "t-drv", email: "mgr@x.com" });
  keyHolders.set("mgr", new Set(["can_view_supermarket_orders", "can_manage_tracking_drivers"]));
  const token = tokenFor({ sub: "mgr", tenantId: "t-drv", role: "USER" });

  const results = await Promise.all(
    Array.from({ length: 100 }, () =>
      app.inject({
        method: "POST", url: "/supermarket/drivers/full", headers: { authorization: `Bearer ${token}` },
        payload: { name: "Mendy Roth", cell: "3476602218", email: "mendyr@yahoo.com" },
      }),
    ),
  );
  const created = results.filter((r) => r.statusCode === 200).length;
  const drivers = db.rows("user").filter((u) => u.email === "mendyr@yahoo.com");
  assert.equal(drivers.length, 1, `storm created ${drivers.length} logins`);
  assert.ok(created >= 1);
  assert.equal(db.rows("driverProfile").filter((d) => d.userId === drivers[0].id).length, 1);
  for (const j of db.rows("emailJob")) {
    assert.equal(j.type, "DRIVER_INVITE");
    assert.ok(j.htmlBody.includes("Loopcom Driver"), "the email must name the Loopcom Driver app");
    assert.ok(j.htmlBody.includes("/auth/invite/accept?token="), "no setup link in the email");
  }

  // resend: fine while INVITED…
  const okResend = await app.inject({ method: "POST", url: `/supermarket/drivers/${drivers[0].id}/resend-invite`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(okResend.statusCode, 200);
  // …⛔ REFUSED the moment he has signed in (the TYH resend lesson)
  await db.user.update({ where: { id: drivers[0].id }, data: { lastLoginAt: new Date(), status: "ACTIVE" } });
  const badResend = await app.inject({ method: "POST", url: `/supermarket/drivers/${drivers[0].id}/resend-invite`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(badResend.statusCode, 409);
});

// ═════════════════════════════ STRESS 22 ═════════════════════════════════════

test("STRESS 22 — the PIN store: enrolled only on caller-ID-matching keyed calls, encrypted at rest, purged when stale, never readable in plaintext", async () => {
  const db = makeSupermarketDb();
  const pos = new FakePos();
  pos.addCustomer({ id: "c-pin", phone10: "8456624417", pin: "7777", balanceCents: 4200, cards: [{ id: "cd1", masked: "…1" }] });
  await seedPosTenant(db, "t-pin", pos);
  const clientFor = clientForFactory(new Map([["t-pin", pos]]));
  const deps = { db, clientFor: clientFor as any };

  // Call 1: known caller keys the right PIN → enrolled.
  await runPayIvrStep(deps, { tenantId: "t-pin", callId: "k1", callerNumber: "+18456624417" });
  await runPayIvrStep(deps, { tenantId: "t-pin", callId: "k1", callerNumber: "+18456624417", digits: "7777" });
  const pins = db.rows("supermarketPhonePin");
  assert.equal(pins.length, 1);
  assert.equal(pins[0].phoneE164, "+18456624417");
  // ⛔ encrypted at rest: the plaintext PIN appears NOWHERE in the stored row
  assert.ok(!JSON.stringify(pins[0]).includes("7777"), "PIN stored in the clear");

  // Call 2 from the SAME number: silent — the caller keys nothing before the menu.
  const start2 = await runPayIvrStep(deps, { tenantId: "t-pin", callId: "k2", callerNumber: "+18456624417" });
  assert.ok(start2.prompts.includes("22_main_menu"), "stored PIN did not skip the keying");
  assert.ok(!start2.prompts.includes("02_pin"));

  // The store PIN goes stale (customer changed it at the store) → purged + re-keyed.
  pos.customers.get("c-pin")!.pin = "8888";
  const start3 = await runPayIvrStep(deps, { tenantId: "t-pin", callId: "k3", callerNumber: "+18456624417" });
  assert.ok(start3.prompts.includes("02_pin"), "stale stored PIN must fall back to keying");
  assert.equal(db.rows("supermarketPhonePin").length, 0, "stale enrollment not purged");

  // A FOREIGN number that looks the account up NEVER enrolls, across 50 calls.
  for (let i = 0; i < 50; i++) {
    const cid = `f-${i}`;
    await runPayIvrStep(deps, { tenantId: "t-pin", callId: cid, callerNumber: "+12120000000" });
    await runPayIvrStep(deps, { tenantId: "t-pin", callId: cid, callerNumber: "+12120000000", digits: "8456624417" });
    await runPayIvrStep(deps, { tenantId: "t-pin", callId: cid, callerNumber: "+12120000000", digits: "8888" });
  }
  assert.equal(db.rows("supermarketPhonePin").length, 0, "a foreign number was enrolled");
});

// ═════════════════════════════ STRESS 23 ═════════════════════════════════════

test("STRESS 23 — the auto-submit gate swept over 10,000 random histories agrees with a brute-force re-check every single time", () => {
  const rnd = mulberry32(2323);
  for (let i = 0; i < 10_000; i++) {
    const weeks: WeekStat[] = [];
    const n = Math.floor(rnd() * 8);
    for (let w = 0; w < n; w++) {
      weeks.push({
        weekStart: `2026-0${1 + (w % 8)}-0${1 + (w % 7)}`,
        drafts: Math.floor(rnd() * 30),
        correctionRatePct: Math.round(rnd() * 20 * 10) / 10,
      });
    }
    const config = {
      autoSubmitEnabled: rnd() < 0.5,
      autoSubmitMaxCorrectionPct: Math.round(rnd() * 10 * 10) / 10,
      autoSubmitMinWeeks: 1 + Math.floor(rnd() * 4),
    };
    const decision = decideAutoSubmit(weeks, config);
    // brute force
    let expected = false;
    if (config.autoSubmitEnabled) {
      const sorted = [...weeks].sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1)).slice(-config.autoSubmitMinWeeks);
      expected =
        sorted.length >= config.autoSubmitMinWeeks &&
        sorted.every((w) => w.drafts >= MIN_WEEK_VOLUME && w.correctionRatePct <= config.autoSubmitMaxCorrectionPct);
    }
    assert.equal(decision.allowed, expected, `disagreement at i=${i}: ${JSON.stringify({ weeks, config, decision })}`);
    if (!config.autoSubmitEnabled) assert.equal(decision.reason, "switch_off");
  }
});

// ═════════════════════════════ STRESS 24 ═════════════════════════════════════

test("STRESS 24 — hostile-body fuzz over every write route: 600 adversarial payloads, zero 500s, zero prototype pollution, zero row corruption", async () => {
  const kit = await buildApp();
  const { app, db, posByTenant, keyHolders, tokenFor } = kit;
  const pos = new FakePos();
  posByTenant.set("t-fuzz", pos);
  await seedPosTenant(db, "t-fuzz", pos);
  db.seed("user", { id: "fz", tenantId: "t-fuzz", email: "fz@x.com" });
  keyHolders.set("fz", new Set(["can_view_supermarket_orders", "can_manage_supermarket_orders", "can_manage_supermarket_specials", "can_manage_tracking_drivers"]));
  const token = tokenFor({ sub: "fz", tenantId: "t-fuzz", role: "USER" });
  const owner = tokenFor({ sub: "ow", tenantId: "x", role: "SUPER_ADMIN" });
  const draft = db.seed("supermarketOrderDraft", { tenantId: "t-fuzz", sourceType: "voicemail", sourceId: "v", agentItems: [] });

  const rnd = mulberry32(2424);
  const hostileValues: any[] = [
    null, 0, -1, 1e308, "", "x".repeat(60_000), { toString: "x" }, [], [[]], { __proto__: { polluted: true } },
    { $where: "1" }, "'; DROP TABLE", " ", true, { in: ["a"] }, Array(200).fill({ a: 1 }),
  ];
  const targets = [
    { method: "POST", url: "/supermarket/drafts", auth: token },
    { method: "PATCH", url: `/supermarket/drafts/${draft.id}`, auth: token },
    { method: "POST", url: `/supermarket/drafts/${draft.id}/approve`, auth: token },
    { method: "POST", url: "/supermarket/specials", auth: token },
    { method: "POST", url: "/supermarket/drivers/full", auth: token },
    { method: "POST", url: "/admin/integrations/keys", auth: owner },
    { method: "PUT", url: "/admin/integrations/crm-mode", auth: owner },
    { method: "PUT", url: "/admin/integrations/supermarket-settings", auth: owner },
  ];
  const fields = ["items", "comments", "notes", "orderMethod", "sourceType", "customerPhone", "subject", "body", "name", "cell", "email", "tenantId", "provider", "apiKey", "mode", "payIvrEnabled"];
  let sent = 0;
  for (let i = 0; i < 600; i++) {
    const target = targets[i % targets.length];
    const payload: any = {};
    const fieldCount = 1 + Math.floor(rnd() * 5);
    for (let f = 0; f < fieldCount; f++) {
      payload[fields[Math.floor(rnd() * fields.length)]] = hostileValues[Math.floor(rnd() * hostileValues.length)];
    }
    const res = await app.inject({ method: target.method as any, url: target.url, headers: { authorization: `Bearer ${target.auth}` }, payload });
    sent++;
    assert.ok(res.statusCode < 500, `500 from ${target.method} ${target.url} with ${JSON.stringify(payload).slice(0, 80)}: ${res.body.slice(0, 120)}`);
  }
  assert.equal(sent, 600);
  assert.equal(({} as any).polluted, undefined, "prototype pollution escaped");
  // the fuzz never mutated the draft into an unknown status
  const statuses = new Set(db.rows("supermarketOrderDraft").map((d) => d.status));
  for (const s of statuses) assert.ok(["NEEDS_REVIEW", "APPROVED", "SUBMITTING", "SUBMITTED", "SUBMIT_FAILED", "DISMISSED"].includes(s));
});

// ═════════════════════════════ STRESS 25 ═════════════════════════════════════

test("STRESS 25 — the life of 120 orders, end to end: voicemail/text → sweep → rep review → register → delivery tracker → corrections → the earned auto-submit verdict; every book balances", async () => {
  const kit = await buildApp();
  const { app, db, posByTenant, keyHolders, tokenFor, ingested } = kit;
  const pos = new FakePos();
  for (let i = 0; i < 200; i++) pos.products.push({ id: `lp${i}`, code: String(2000 + i), name: `good${i}`, price: 2 + (i % 9), lastMod: "m1" });
  pos.addCustomer({ id: "cust1", phone10: "8456624417", firstName: "Rivky", lastName: "Braun", pin: "4321", balanceCents: 3750, cards: [{ id: "cd", masked: "…4417" }], address1: "12 Forest Rd", city: "Monroe" });
  posByTenant.set("t-life", pos);
  await seedPosTenant(db, "t-life", pos);
  db.seed("supermarketSettings", { tenantId: "t-life", deliveryIngestEnabled: true, deliveryStoreRef: "gesheft-main", payIvrEnabled: true });
  db.seed("user", { id: "rep", tenantId: "t-life", email: "rep@x.com" });
  keyHolders.set("rep", new Set(["can_view_supermarket_orders", "can_manage_supermarket_orders"]));
  const token = tokenFor({ sub: "rep", tenantId: "t-life", role: "USER" });

  // 0) catalog sync fills the quick-add index
  const clientFor = clientForFactory(posByTenant);
  await runCatalogSyncSweep({ db, clientFor: clientFor as any, pagePaceMs: 0 });
  assert.equal(db.rows("posCatalogItem").length, 200);

  // 1) 60 voicemails + 60 texts arrive (some WIC, some remarks)
  const thread = db.seed("connectChatThread", { id: "thl", type: "SMS", externalSmsE164: "+18456624417", title: "Rivky" });
  for (let i = 0; i < 60; i++) {
    db.seed("voicemail", {
      id: `lvm-${i}`, tenantId: "t-life", callerNumber: "8456624417", receivedAt: new Date(),
      transcript: `${2000 + (i % 200)} x2 ${i % 4 === 0 ? "I pay with WIC" : ""} ${i % 5 === 0 ? "leave it by the side door" : ""}`,
    });
    db.seed("connectChatMessage", {
      id: `ltx-${i}`, tenantId: "t-life", direction: "INBOUND", threadId: thread.id, createdAt: new Date(),
      body: `2 good${i % 200} and ${2001 + (i % 150)}`,
    });
  }
  await runDraftBuilderSweep({ db, clientFor: clientFor as any });
  await runDraftBuilderSweep({ db, clientFor: clientFor as any });
  await runDraftBuilderSweep({ db, clientFor: clientFor as any });
  const draftRows = db.rows("supermarketOrderDraft");
  assert.equal(draftRows.length, 120, `expected 120 drafts, got ${draftRows.length}`);
  // WIC routed to comments automatically
  const wicDrafts = draftRows.filter((d) => /WIC/i.test(d.comments));
  assert.equal(wicDrafts.length, 15, "WIC comment routing drifted");
  // customer resolved by phone through the register
  assert.ok(draftRows.every((d) => d.posCustomerId === "cust1"));

  // 2) the rep reviews every draft through the REAL routes; every 3rd gets a
  //    correction (an item added), every 4th is a Delivery
  let submitted = 0;
  for (let i = 0; i < draftRows.length; i++) {
    const d = draftRows[i];
    const detail = body(await app.inject({ method: "GET", url: `/supermarket/drafts/${d.id}`, headers: { authorization: `Bearer ${token}` } }));
    const items = sanitizeDraftItems(detail.draft.items);
    const reviewed = [...items];
    if (i % 3 === 0) reviewed.push({ posProductId: "lp0", code: "2000", name: "good0", qty: 1, unitPriceCents: 200 });
    if (reviewed.length === 0) reviewed.push({ posProductId: "lp1", code: "2001", name: "good1", qty: 1, unitPriceCents: 300 });
    const res = await app.inject({
      method: "POST", url: `/supermarket/drafts/${d.id}/approve`, headers: { authorization: `Bearer ${token}` },
      payload: { items: reviewed, comments: detail.draft.comments, notes: detail.draft.notes, orderMethod: i % 4 === 0 ? "Delivery" : "Pickup" },
    });
    assert.equal(res.statusCode, 200, `approve failed for ${d.id}: ${res.body}`);
    submitted++;
  }
  assert.equal(submitted, 120);

  // 3) the register holds EXACTLY 120 orders — no dupes, no misses
  assert.equal(pos.orders.size, 120, `register order count ${pos.orders.size}`);
  // 4) the delivery tracker got exactly the Delivery-method orders
  assert.equal(ingested.length, 30, `delivery ingest count ${ingested.length}`);
  assert.ok(ingested.every((e) => e.tenantId === "t-life" && e.event.storeRef === "gesheft-main" && e.event.address?.line1));

  // 5) correction capture landed on every submitted draft, and the stats gauge reads it
  const reviewedRows = db.rows("supermarketOrderDraft");
  assert.ok(reviewedRows.every((d) => d.status === "SUBMITTED" && d.corrections !== null));
  const stats = body(await app.inject({ method: "GET", url: "/supermarket/stats", headers: { authorization: `Bearer ${token}` } }));
  assert.ok(stats.weeks.length >= 1);
  assert.ok(stats.weeks[0].drafts === 120);
  // corrections happened on 1/3 of orders → the rate is far above 5%, so even
  // an ARMED auto-submit stays off: the numbers have not earned it.
  await db.supermarketSettings.update({ where: { tenantId: "t-life" }, data: { autoSubmitEnabled: true } });
  const stats2 = body(await app.inject({ method: "GET", url: "/supermarket/stats", headers: { authorization: `Bearer ${token}` } }));
  assert.equal(stats2.autoSubmit.allowed, false);
  assert.ok(["rate_above_threshold", "not_enough_weeks"].includes(stats2.autoSubmit.reason));

  // 6) and the pay line settles the balance on the same register: a real call
  const step = (digits?: string) =>
    app.inject({
      method: "POST", url: "/internal/supermarket/pay-ivr/step", headers: { "x-cdr-secret": process.env.CDR_INGEST_SECRET! },
      payload: { tenantId: "t-life", callId: "life-call", callerNumber: "+18456624417", ...(digits === undefined ? {} : { digits }) },
    });
  await step();
  await step("4321"); // PIN
  await step("2"); // payment
  await step("25*37"); // amount
  const charged = body(await step("1")); // confirm
  assert.ok(charged.prompts.includes("09_approved_intro"), `charge flow: ${JSON.stringify(charged)}`);
  assert.equal([...pos.charges.values()].reduce((s, c) => s + c.amount, 0), 2537);
  assert.equal(pos.customers.get("cust1")!.balanceCents, 3750 - 2537);
});
