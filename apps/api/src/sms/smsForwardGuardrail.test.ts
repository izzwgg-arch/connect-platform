/**
 * The SMS-forward guardrail: the alarm for texts that were never emailed.
 *
 * The decision rules are pure and tested directly. The rest are SOURCE guards,
 * because every defect of this shape in this codebase has been in the WIRING —
 * an alarm on the muted ADMIN_ALERT type, a monitor nothing ever calls, or a
 * bare setInterval starved to nothing on a deploy day. A unit test of the
 * decision function passes straight through all three.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideSmsForwardAlarms,
  runSmsForwardGuardrail,
  raiseSmsForwardEscalation,
  ALARM_KEY,
  SEND_FAILURE_ALARM_KEY,
  SWEEP_EVENT,
  AGED_OUT_THRESHOLD,
  SEND_FAILURE_THRESHOLD,
  STAMP_FAILURE_THRESHOLD,
  DEFAULT_CUTOVER_AT,
  AGED_OUT_GRACE_MS,
} from "./smsForwardGuardrail";

/** CRLF-normalised: the working tree is CRLF under core.autocrlf. */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const GUARDRAIL_SRC = join(__dirname, "smsForwardGuardrail.ts");
const SERVER_SRC = join(__dirname, "..", "server.ts");

const clean = { agedOut: 0, agedOutSample: [], sendFailurePasses: 0, stampFailures: 0 };

describe("decideSmsForwardAlarms", () => {
  it("a healthy platform raises nothing", () => {
    assert.deepStrictEqual(decideSmsForwardAlarms(clean), []);
  });

  it("ONE text that aged out unsent is enough — the measured baseline is zero", () => {
    const alarms = decideSmsForwardAlarms({ ...clean, agedOut: AGED_OUT_THRESHOLD });
    assert.strictEqual(alarms.length, 1);
    assert.strictEqual(alarms[0].key, ALARM_KEY);
    assert.match(alarms[0].summary, /never emailed/);
  });

  it("names the company and time so the alarm is actionable", () => {
    const alarms = decideSmsForwardAlarms({
      ...clean,
      agedOut: 3,
      agedOutSample: [{ company: "Trust Bookkeepings", at: "2026-08-24T15:00:00.000Z" }],
    });
    assert.match(alarms[0].report, /Trust Bookkeepings/);
    assert.match(alarms[0].report, /2026-08-24T15:00:00/);
  });

  it("a send outage is a SEPARATE, earlier alarm — the texts are still recoverable", () => {
    const below = decideSmsForwardAlarms({ ...clean, sendFailurePasses: SEND_FAILURE_THRESHOLD - 1 });
    assert.deepStrictEqual(below, [], "a single blip must not alarm");
    const at = decideSmsForwardAlarms({ ...clean, sendFailurePasses: SEND_FAILURE_THRESHOLD });
    assert.strictEqual(at.length, 1);
    assert.strictEqual(at[0].key, SEND_FAILURE_ALARM_KEY);
    assert.match(at[0].report, /RECOVERABLE/, "the early alarm must say the texts are not lost yet");
    // and the two are genuinely distinct keys, so one can never de-dupe the other
    assert.notStrictEqual(SEND_FAILURE_ALARM_KEY, ALARM_KEY);
  });

  it("stamp failures alarm only when persistent", () => {
    assert.deepStrictEqual(decideSmsForwardAlarms({ ...clean, stampFailures: STAMP_FAILURE_THRESHOLD - 1 }), []);
    const at = decideSmsForwardAlarms({ ...clean, stampFailures: STAMP_FAILURE_THRESHOLD });
    assert.strictEqual(at.length, 1);
    assert.match(at[0].report, /duplicate/i);
  });

  it("all three can fire together and stay distinct", () => {
    const alarms = decideSmsForwardAlarms({
      agedOut: 5,
      agedOutSample: [],
      sendFailurePasses: 10,
      stampFailures: 10,
    });
    assert.strictEqual(alarms.length, 3);
    assert.strictEqual(new Set(alarms.map((a) => a.key)).size, 3);
  });

  it("every SMS body is plain ASCII and bounded — one emoji halves an SMS segment", () => {
    const alarms = decideSmsForwardAlarms({
      agedOut: 9, agedOutSample: [{ company: "Café Ñandú 😀", at: "2026-08-24T15:00:00.000Z" }],
      sendFailurePasses: 9, stampFailures: 9,
    });
    for (const a of alarms) {
      assert.ok(/^[\x20-\x7e]*$/.test(a.sms), "non-ASCII reached the SMS: " + a.sms);
      assert.ok(a.sms.length <= 300, "SMS too long: " + a.sms.length);
      assert.ok(!/[\r\n]/.test(a.sms), "a newline in an SMS body");
    }
  });
});

// ─── the runner, against a fake database ─────────────────────────────────────

function makeDb(over: any = {}) {
  const created: any[] = [];
  const audits: any[] = [];
  const counts = { message: 0, sendFail: 0, stampFail: 0, ...(over.counts ?? {}) };
  const wheres: any[] = [];
  return {
    created,
    audits,
    wheres,
    connectChatMessage: {
      count: async ({ where }: any) => { wheres.push(where); return counts.message; },
      findMany: async () => (counts.message > 0 ? [{ createdAt: new Date("2026-08-24T15:00:00Z"), tenantId: "t1" }] : []),
    },
    agentAuditLog: {
      count: async ({ where }: any) => (where.event === "sms.email_send_failed" ? counts.sendFail : counts.stampFail),
      create: async ({ data }: any) => { audits.push(data); return data; },
    },
    agentEscalation: {
      findFirst: async () => over.existingEscalation ?? null,
      create: async ({ data }: any) => { created.push(data); return data; },
    },
    tenant: { findUnique: async () => ({ name: "Trust Bookkeepings" }) },
    ...over.overrides,
  };
}

const log = { info: () => {}, warn: () => {} };

describe("runSmsForwardGuardrail", () => {
  it("a clean run STILL writes an audit row — the row is the only proof it ran", async () => {
    const database = makeDb();
    const res = await runSmsForwardGuardrail(log, database);
    assert.deepStrictEqual(res, { agedOut: 0, alarms: [] });
    assert.strictEqual(database.created.length, 0, "a clean platform must not be escalated");
    assert.strictEqual(database.audits.length, 1, "no audit row on a clean run - the monitor is unprovable");
    assert.strictEqual(database.audits[0].event, SWEEP_EVENT);
  });

  it("the audit row carries actor AND hash — Prisma rejects it without them", async () => {
    const database = makeDb();
    await runSmsForwardGuardrail(log, database);
    const row = database.audits[0];
    assert.strictEqual(row.actor, "system");
    assert.ok(typeof row.hash === "string" && row.hash.length === 64, "hash must be a sha256 hex digest");
  });

  it("the query mirrors the forward job's own filters and honours the cutover", async () => {
    const database = makeDb();
    const now = new Date("2026-08-24T16:00:00Z");
    await runSmsForwardGuardrail(log, database, now);
    const where = database.wheres[0];
    assert.strictEqual(where.direction, "INBOUND");
    assert.deepStrictEqual(where.type, { in: ["TEXT", "IMAGE"] }, "must mirror the job or a row it ignores reads as lost");
    assert.strictEqual(where.deletedForEveryoneAt, null);
    assert.strictEqual(where.emailForwardedAt, null);
    // cutover: 1,374 pre-bridge texts are permanently unstamped and must never alarm
    assert.strictEqual(where.createdAt.gt.toISOString(), DEFAULT_CUTOVER_AT);
    // and nothing still inside the fresh window (+ grace) may be counted
    const youngest = where.createdAt.lt.getTime();
    assert.ok(youngest <= now.getTime() - AGED_OUT_GRACE_MS, "grace missing - would alarm on a text the job may still send");
    assert.ok(youngest < now.getTime() - 30 * 60_000, "the fresh window is not being honoured");
  });

  it("a lost text escalates, and the escalation is never an ADMIN_ALERT email", async () => {
    const database = makeDb({ counts: { message: 4 } });
    const res = await runSmsForwardGuardrail(log, database);
    assert.strictEqual(res!.agedOut, 4);
    assert.strictEqual(database.created.length, 1);
    assert.strictEqual(database.created[0].status, "QUEUED");
    assert.match(database.created[0].requestSummary, new RegExp("^" + ALARM_KEY));
    assert.match(database.created[0].report, /Trust Bookkeepings/, "the company must be named");
  });

  it("never throws, and still audits, when the database fails", async () => {
    const database = makeDb({
      overrides: { connectChatMessage: { count: async () => { throw new Error("db down"); }, findMany: async () => [] } },
    });
    const res = await runSmsForwardGuardrail(log, database);
    assert.strictEqual(res, null);
    assert.strictEqual(database.audits.length, 1, "a failed pass must still leave a trace");
    assert.match(String(database.audits[0].payload.error), /db down/);
  });

  it("the kill switch stops it dead", async () => {
    const prev = process.env.SMS_FORWARD_GUARDRAIL_DISABLED;
    process.env.SMS_FORWARD_GUARDRAIL_DISABLED = "1";
    try {
      const database = makeDb({ counts: { message: 99 } });
      assert.strictEqual(await runSmsForwardGuardrail(log, database), null);
      assert.strictEqual(database.created.length, 0);
      assert.strictEqual(database.audits.length, 0);
    } finally {
      if (prev === undefined) delete process.env.SMS_FORWARD_GUARDRAIL_DISABLED;
      else process.env.SMS_FORWARD_GUARDRAIL_DISABLED = prev;
    }
  });
});

describe("escalation de-dupe", () => {
  const alarm = { key: ALARM_KEY, summary: ALARM_KEY + " — 1", sms: "x", report: "y" };

  it("does not re-alert inside the window", async () => {
    const database = makeDb({ existingEscalation: { id: "e1" } });
    assert.strictEqual(await raiseSmsForwardEscalation(alarm, { windowMs: 6 * 3600_000, database }), false);
    assert.strictEqual(database.created.length, 0);
  });

  it("DOES alert again once the window has passed — it must nag, not fire once ever", async () => {
    const database = makeDb({ existingEscalation: null });
    assert.strictEqual(await raiseSmsForwardEscalation(alarm, { windowMs: 6 * 3600_000, database }), true);
    assert.strictEqual(database.created.length, 1);
  });

  it("the de-dupe is bounded by TIME, not by an open row", () => {
    const src = stripComments(read(GUARDRAIL_SRC));
    assert.ok(src.includes("createdAt: { gte: since }"), "the de-dupe must be time-bounded");
    assert.ok(
      !/status:\s*\{\s*in:\s*\["QUEUED",\s*"SENT"\]\s*\}/.test(src),
      "de-duping on an OPEN escalation makes this fire exactly once, ever - AgentEscalationStatus has no RESOLVED value",
    );
  });
});

describe("wiring guards — every defect of this shape has been in the caller", () => {
  it("never uses ADMIN_ALERT, and grows no email path of its own", () => {
    const src = stripComments(read(GUARDRAIL_SRC));
    assert.ok(!src.includes("ADMIN_ALERT"), "ADMIN_ALERT is SKIPPED at the send door - the alarm would reach nobody");
    assert.ok(!src.includes("emailJob"), "an alarm must not grow its own email path");
    assert.ok(!/resolve\w*SmsSender|sendMail|nodemailer/i.test(src), "no direct sender in a guardrail");
  });

  it("server.ts actually STARTS it", () => {
    const src = stripComments(read(SERVER_SRC));
    assert.ok(src.includes('from "./sms/smsForwardGuardrail"'), "not imported - the guard would never run");
    assert.ok(src.includes("startSmsForwardGuardrail(app.log)"), "imported but never called");
  });

  it("has BOTH a boot kick and an interval", () => {
    const src = stripComments(read(GUARDRAIL_SRC));
    assert.ok(src.includes("setTimeout("), "no boot kick - a bare interval is starved to nothing on a busy deploy day");
    assert.ok(src.includes("setInterval("), "no interval - it would run once and never again");
  });

  it("the audit event and the models it writes are real Prisma names", () => {
    const schema = read(join(__dirname, "../../../../packages/db/prisma/schema.prisma"));
    for (const model of ["AgentAuditLog", "AgentEscalation", "ConnectChatMessage"]) {
      assert.ok(new RegExp("model\\s+" + model + "\\s*\\{").test(schema), "no such model: " + model);
    }
    const block = /model\s+AgentAuditLog\s*\{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
    for (const col of ["actor", "event", "payload", "hash", "ts"]) {
      assert.ok(new RegExp("^\\s*" + col + "\\s", "m").test(block), "AgentAuditLog has no column " + col);
    }
    // the guardrail orders/filters AgentAuditLog by `ts` — `createdAt` does not exist here
    const src = read(GUARDRAIL_SRC);
    assert.ok(src.includes("ts: { gte:"), "must filter AgentAuditLog on ts");
    assert.ok(!/agentAuditLog[\s\S]{0,200}createdAt/.test(src), "AgentAuditLog has no createdAt - that typo silently zeroed a cap once already");
  });
});
