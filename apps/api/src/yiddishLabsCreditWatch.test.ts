/**
 * Guards for the Yiddish Labs credit watch.
 *
 * The defects this feature exists to prevent are all "it looked like it worked":
 * a negative balance read as positive, an alert that fires every hour for a week,
 * an alert that never re-arms, a transient blip waking the owner at 3am, and a
 * second delivery path quietly growing next to the one that already works. Each
 * has a test below, and the source-reading ones are here because a unit test of
 * a helper passes straight through a caller-side mistake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildCreditAlertSms,
  isCreditRefusal,
  parseCreditFailure,
  probeYiddishLabs,
  resolveYiddishLabsKey,
  runYiddishLabsCreditCheck,
  shouldAlert,
} from "./yiddishLabsCreditWatch";

const REFUSAL = JSON.stringify({
  error: {
    code: "insufficient_credits",
    message: "This action requires 16 credits but you only have -3 available. Please purchase more credits to continue.",
  },
});

// ── reading the refusal ──────────────────────────────────────────────────────

test("the balance is parsed WITH its sign — an empty account is negative here", () => {
  const { balance, required } = parseCreditFailure(REFUSAL);
  assert.equal(balance, -3, "a pattern of (\\d+) reads -3 as 3 and makes an empty account look healthy");
  assert.equal(required, 16);
});

test("a body with no numbers yields nulls rather than guesses", () => {
  assert.deepEqual(parseCreditFailure("insufficient_credits"), { balance: null, required: null });
});

test("only a 402 that names insufficient_credits counts as out of money", () => {
  assert.equal(isCreditRefusal(402, REFUSAL), true);
  assert.equal(isCreditRefusal(401, REFUSAL), false, "401 is a dead key, a different problem");
  assert.equal(isCreditRefusal(402, '{"error":{"code":"quota_exceeded"}}'), false);
  assert.equal(isCreditRefusal(500, "server error"), false);
});

// ── when it is allowed to text him ───────────────────────────────────────────

test("it texts on the crossing into out, and never again while it stays out", () => {
  assert.equal(shouldAlert("ok", "out"), true);
  assert.equal(shouldAlert(null, "out"), true, "first ever check finding it broken must speak up");
  assert.equal(shouldAlert("out", "out"), false, "an hourly re-text for a week is worse than silence");
});

test("it re-arms only after a healthy check", () => {
  assert.equal(shouldAlert("out", "ok"), false);
  assert.equal(shouldAlert("ok", "out"), true);
});

test("a blip neither texts nor clears the latch", () => {
  assert.equal(shouldAlert("ok", "unknown"), false, "a timeout is not an empty wallet");
  assert.equal(shouldAlert("out", "unknown"), false);
  assert.equal(
    shouldAlert("unknown", "out"),
    true,
    "after an inconclusive check, a real refusal must still get through",
  );
});

test("an unconfigured account is silent — there is nothing to alert about", () => {
  assert.equal(shouldAlert("ok", "unconfigured"), false);
  assert.equal(shouldAlert("unconfigured", "unconfigured"), false);
});

// ── the message itself ───────────────────────────────────────────────────────

test("the text is plain ASCII — one emoji would quadruple the segment count", () => {
  const sms = buildCreditAlertSms({ balance: -3 });
  assert.match(sms, /^[\x20-\x7E\n]*$/, "non-ASCII forces UCS-2: 70 chars per segment, not 160");
});

test("the text says what broke, what still works, and what to do", () => {
  const sms = buildCreditAlertSms({ balance: -3 });
  assert.match(sms, /Yiddish Labs is out of credits/i);
  assert.match(sms, /Balance -3/, "the number is the whole point of the alert");
  assert.match(sms, /voicemail still works/i, "or he will think the phones are affected");
  assert.match(sms, /top up/i);
  assert.doesNotMatch(sms, /rotate|re-?paste|new key/i, "the key is never the problem in this failure");
});

test("a missing balance degrades to a sentence that still reads", () => {
  const sms = buildCreditAlertSms({ balance: null });
  assert.doesNotMatch(sms, /Balance null|Balance undefined|NaN/);
});

// ── the key ──────────────────────────────────────────────────────────────────

test("the (paste...) placeholder in the environment is NOT treated as a key", async () => {
  const key = await resolveYiddishLabsKey({
    db: { agentSecret: { findUnique: async () => null } },
    decryptJson: () => null,
    hasMasterKey: () => false,
    env: { YIDDISHLABS_API_KEY: "(paste your key here)" },
  });
  assert.equal(key, null, "every container carries that placeholder; treating it as a key probes with nonsense");
});

test("the stored key wins over the environment", async () => {
  const key = await resolveYiddishLabsKey({
    db: { agentSecret: { findUnique: async () => ({ valueEnc: "enc" }) } },
    decryptJson: () => "real-key-from-store",
    hasMasterKey: () => true,
    env: { YIDDISHLABS_API_KEY: "env-key" },
  });
  assert.equal(key, "real-key-from-store");
});

// ── the probe ────────────────────────────────────────────────────────────────

test("a 402 probe reports out, with the balance", async () => {
  const out = await probeYiddishLabs("k", (async () =>
    new Response(REFUSAL, { status: 402 })) as unknown as typeof fetch);
  assert.equal(out.state, "out");
  assert.equal(out.balance, -3);
});

test("a dead key and a server error are unknown, never out", async () => {
  for (const status of [401, 500, 503]) {
    const out = await probeYiddishLabs("k", (async () =>
      new Response("nope", { status })) as unknown as typeof fetch);
    assert.equal(out.state, "unknown", `HTTP ${status} must not be reported as out of credits`);
  }
});

test("a network failure is unknown, not out", async () => {
  const out = await probeYiddishLabs("k", (async () => {
    throw new Error("fetch failed");
  }) as unknown as typeof fetch);
  assert.equal(out.state, "unknown");
});

// ── the whole pass, against a fake database ──────────────────────────────────

function fakeDb(opts: {
  lastState?: string | null;
  bridgeFailures?: any[];
  translations?: any[];
} = {}) {
  const escalations: any[] = [];
  const audits: any[] = [];
  return {
    escalations,
    audits,
    agentAuditLog: {
      findFirst: async () =>
        opts.lastState === undefined || opts.lastState === null
          ? null
          : { ts: new Date(Date.now() - 3600_000), payload: { state: opts.lastState } },
      findMany: async () => opts.bridgeFailures ?? [],
      create: async ({ data }: any) => {
        audits.push(data);
        return data;
      },
    },
    agentTranslation: {
      findFirst: async () => (opts.translations && opts.translations.length ? opts.translations[0] : null),
    },
    agentEscalation: {
      create: async ({ data }: any) => {
        escalations.push(data);
        return { id: "esc1", ...data };
      },
    },
  };
}

test("a customer's failed Yiddish chat raises the alert WITHOUT spending a credit", async () => {
  const database = fakeDb({ lastState: "ok", bridgeFailures: [{ payload: { error: REFUSAL } }] });
  let probed = false;
  const out = await runYiddishLabsCreditCheck({
    db: database,
    resolveKey: async () => "k",
    fetchImpl: (async () => {
      probed = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.equal(out.state, "out");
  assert.equal(out.via, "audit");
  assert.equal(probed, false, "the answer was already in the audit trail; probing would waste a credit");
  assert.equal(database.escalations.length, 1);
  assert.match(database.escalations[0].smsBody, /out of credits/i);
});

test("a recent successful translation proves the wire works and costs nothing", async () => {
  const database = fakeDb({ lastState: "ok", translations: [{ id: "t1" }] });
  let probed = false;
  const out = await runYiddishLabsCreditCheck({
    db: database,
    resolveKey: async () => "k",
    fetchImpl: (async () => {
      probed = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.equal(out.state, "ok");
  assert.equal(out.via, "translation");
  assert.equal(probed, false, "an account in daily use must cost nothing to monitor");
  assert.equal(database.escalations.length, 0);
});

test("a quiet period falls through to the probe", async () => {
  const database = fakeDb({ lastState: "ok" });
  const out = await runYiddishLabsCreditCheck({
    db: database,
    resolveKey: async () => "k",
    fetchImpl: (async () => new Response(REFUSAL, { status: 402 })) as unknown as typeof fetch,
  });
  assert.equal(out.via, "probe");
  assert.equal(out.state, "out");
  assert.equal(database.escalations.length, 1);
});

test("it does NOT text again while it is still out", async () => {
  const database = fakeDb({ lastState: "out" });
  await runYiddishLabsCreditCheck({
    db: database,
    resolveKey: async () => "k",
    fetchImpl: (async () => new Response(REFUSAL, { status: 402 })) as unknown as typeof fetch,
  });
  assert.equal(database.escalations.length, 0, "one outage, one text");
  assert.equal(database.audits.length, 1, "but every check is still recorded");
});

test("with no key configured it stays silent and never probes", async () => {
  const database = fakeDb({ lastState: null });
  let probed = false;
  const out = await runYiddishLabsCreditCheck({
    db: database,
    resolveKey: async () => null,
    fetchImpl: (async () => {
      probed = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.equal(out.state, "unconfigured");
  assert.equal(probed, false);
  assert.equal(database.escalations.length, 0);
});

test("a database failure can never throw into the sweep timer", async () => {
  const out = await runYiddishLabsCreditCheck({
    db: {
      agentAuditLog: {
        findFirst: async () => {
          throw new Error("db down");
        },
      },
    },
    resolveKey: async () => "k",
  });
  assert.equal(out.state, "unknown");
});

test("every check is written to the audit trail with a hash", async () => {
  const database = fakeDb({ lastState: "ok", translations: [{ id: "t1" }] });
  await runYiddishLabsCreditCheck({ db: database, resolveKey: async () => "k" });
  assert.equal(database.audits.length, 1);
  assert.equal(database.audits[0].event, "yiddishlabs.credit_check");
  assert.match(database.audits[0].hash, /^[a-f0-9]{64}$/, "the column has no default; an unhashed row fails to insert");
});

// ── the fence: no second delivery path ───────────────────────────────────────

const SOURCE = readFileSync(join(__dirname, "yiddishLabsCreditWatch.ts"), "utf8");

/**
 * ⛔ Strip comments first. The file's header DESCRIBES the things these guards
 * forbid ("do NOT give this its own resolvePlatformSmsSender", "must not be an
 * ADMIN_ALERT"), so a naive grep fails on the documentation that exists to
 * prevent the very mistake. Assert against code.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("it never grows its own SMS sender or email — everything ends at the escalation row", () => {
  assert.doesNotMatch(CODE, /resolvePlatformSmsSender\s*\(/, "the dispatcher owns delivery; a second path is one to rot");
  assert.doesNotMatch(CODE, /emailJob\s*\.\s*create/);
  assert.match(CODE, /agentEscalation\s*\.\s*create/, "the escalation row IS the delivery mechanism");
});

test("it never queues an ADMIN_ALERT, which is muted at the send door", () => {
  assert.doesNotMatch(
    CODE,
    /type:\s*["']ADMIN_ALERT["']/,
    "that category reaches nobody — it would build clean, log clean and never arrive",
  );
});

test("the escalation is QUEUED and carries no fix code", () => {
  assert.match(SOURCE, /status:\s*"QUEUED"/, "the dispatcher only sweeps QUEUED rows");
  assert.doesNotMatch(SOURCE, /fixActionId:\s*["'][^"']/, "this is information, not something to approve by text");
});

test("the boot wiring is registered in the api's sweep block", () => {
  const server = readFileSync(join(__dirname, "server.ts"), "utf8");
  assert.match(server, /startYiddishLabsCreditWatch/, "an unwired watcher is a watcher that never runs");
});
