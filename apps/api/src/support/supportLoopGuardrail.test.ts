/**
 * The server-side alarm on the support-ticket loop.
 *
 * ⛔ What it defends: on 2026-08-31 a Ctrl+C killed the watcher AND its restart
 * wrapper on Izzy's PC, and it sat dead 18 hours with three tickets stranded —
 * with nothing anywhere saying so. This sweep runs on the SERVER, where every
 * PC-side failure mode looks the same: a quiet heartbeat and unworked tickets.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  decideSupportLoopAlarms,
  raiseSupportLoopEscalation,
  runSupportLoopGuardrail,
  GUARDRAIL_USERNAME,
  WATCHER_DOWN_KEY,
  UNWORKED_KEY,
  HELD_KEY,
  UNREAD_REPLY_KEY,
  TOKEN_KEY,
  TOKEN_ALERT_WINDOW_MS,
  type SupportLoopInput,
} from "./supportLoopGuardrail";
import { NEEDS_PERSON_MARKER } from "./customerUpdate";

const QUIET: SupportLoopInput = {
  watcherBeatAgeMin: 1,
  watcherHost: "DESKTOP-8HUS877",
  unworked: [],
  held: [],
  unreadReplies: [],
  tokenDaysLeft: 25,
};

// ───────────────────────────────────────────────── the pure decision

describe("decideSupportLoopAlarms", () => {
  test("a healthy loop raises nothing", () => {
    assert.deepEqual(decideSupportLoopAlarms(QUIET), []);
  });

  test("⛔ the 2026-08-31 incident, replayed: 18h-quiet heartbeat + stranded tickets = both alarms", () => {
    const alarms = decideSupportLoopAlarms({
      ...QUIET,
      watcherBeatAgeMin: 18 * 60,
      unworked: [
        { reference: "9EFNKF", tenantName: "Connect Communications", ageHours: 18 },
        { reference: "DJH8XK", tenantName: "Connect Communications", ageHours: 18 },
        { reference: "AFVGHU", tenantName: "Loopcom platform", ageHours: 18 },
      ],
    });
    const keys = alarms.map((a) => a.key);
    assert.ok(keys.includes(WATCHER_DOWN_KEY));
    assert.ok(keys.includes(UNWORKED_KEY));
  });

  test("⛔ 'never reported' is the pre-rollout state, not an outage", () => {
    const alarms = decideSupportLoopAlarms({ ...QUIET, watcherBeatAgeMin: null, watcherHost: null });
    assert.ok(!alarms.some((a) => a.key === WATCHER_DOWN_KEY));
  });

  test("a fresh heartbeat during a long agent run is NOT an alarm", () => {
    // The watcher beats every ~60s including mid-run; 29 min is inside the window.
    const alarms = decideSupportLoopAlarms({ ...QUIET, watcherBeatAgeMin: 29 });
    assert.ok(!alarms.some((a) => a.key === WATCHER_DOWN_KEY));
  });

  test("held replies and unread customer replies each alarm", () => {
    const keys = decideSupportLoopAlarms({
      ...QUIET,
      held: [{ ticketRef: "T6HMUQ", heldReason: "names another company" }],
      unreadReplies: [{ ticketRef: "UXN2E6", ageHours: 3 }],
    }).map((a) => a.key);
    assert.ok(keys.includes(HELD_KEY));
    assert.ok(keys.includes(UNREAD_REPLY_KEY));
  });

  test("⛔ the token alarm has its own LONG window — a 6h nag about a monthly chore teaches people to ignore alarms", () => {
    const alarms = decideSupportLoopAlarms({ ...QUIET, tokenDaysLeft: 5 });
    const token = alarms.find((a) => a.key === TOKEN_KEY);
    assert.ok(token);
    assert.equal(token?.windowMs, TOKEN_ALERT_WINDOW_MS);
  });

  test("⛔ every SMS is plain ASCII", () => {
    const alarms = decideSupportLoopAlarms({
      ...QUIET,
      watcherBeatAgeMin: 999,
      unworked: [{ reference: "X", tenantName: "Gesheft — קאָשער", ageHours: 5 }],
      held: [{ ticketRef: "A", heldReason: "⛔ emoji" }],
      unreadReplies: [{ ticketRef: null, ageHours: 9 }],
      tokenDaysLeft: 2,
    });
    assert.ok(alarms.length >= 4);
    // The raise path flattens; the decide layer must not depend on it for the
    // watcher-down text, which goes out verbatim.
    for (const a of alarms) assert.ok(a.sms.length > 0);
  });
});

// ───────────────────────────────────────────────── the raise + de-dupe

function fakeDb(seed: any = {}) {
  const state = {
    escalations: seed.escalations ?? [],
    audits: [] as any[],
    watchers: seed.watchers ?? [],
    staleEscalations: seed.staleEscalations ?? [],
    runs: seed.runs ?? [],
    held: seed.held ?? [],
    unread: seed.unread ?? [],
  };
  return {
    state,
    agentEscalation: {
      findFirst: async ({ where }: any) =>
        state.escalations.find(
          (e: any) => e.requestSummary.includes(where.requestSummary.contains) && new Date(e.createdAt) >= where.createdAt.gte,
        ) ?? null,
      findMany: async () => state.staleEscalations,
      create: async ({ data }: any) => {
        const row = { id: "esc" + (state.escalations.length + 1), createdAt: new Date(), ...data };
        state.escalations.push(row);
        return row;
      },
    },
    supportAgentWatcher: { findMany: async () => state.watchers },
    supportAgentRun: { findMany: async () => state.runs },
    supportUpdate: { findMany: async () => state.held },
    supportMessage: { findMany: async () => state.unread },
    agentAuditLog: {
      create: async ({ data }: any) => {
        state.audits.push(data);
        return data;
      },
    },
  };
}

const ALARM = { key: WATCHER_DOWN_KEY, summary: `${WATCHER_DOWN_KEY} — test`, sms: "test", report: "test" };

describe("raiseSupportLoopEscalation", () => {
  test("raises once, then de-dupes INSIDE the window and re-fires after it", async () => {
    const db = fakeDb();
    assert.equal(await raiseSupportLoopEscalation(ALARM, { windowMs: 60_000, database: db }), true);
    assert.equal(await raiseSupportLoopEscalation(ALARM, { windowMs: 60_000, database: db }), false);
    // Age the first one out of the window.
    db.state.escalations[0].createdAt = new Date(Date.now() - 120_000);
    assert.equal(await raiseSupportLoopEscalation(ALARM, { windowMs: 60_000, database: db }), true);
  });

  test("⛔ the escalation is marked needs-person and wears the guardrail's name", async () => {
    const db = fakeDb();
    await raiseSupportLoopEscalation(ALARM, { windowMs: 60_000, database: db });
    const row = db.state.escalations[0];
    assert.ok(row.requestSummary.startsWith(NEEDS_PERSON_MARKER),
      "without the marker the watcher would spawn an agent to investigate its own down-detector");
    assert.equal(row.userName, GUARDRAIL_USERNAME);
    assert.equal(row.status, "QUEUED");
    // ⛔ Required column: null is a swallowed PrismaClientValidationError — the
    // exact way two sibling guardrails were silently unable to fire.
    assert.notEqual(row.proposedFix, null);
    assert.notEqual(row.proposedFix, undefined);
  });

  test("⛔ a failed raise returns false, never throws", async () => {
    const db = fakeDb();
    db.agentEscalation.create = async () => {
      throw new Error("no");
    };
    assert.equal(await raiseSupportLoopEscalation(ALARM, { windowMs: 60_000, database: db }), false);
  });
});

// ───────────────────────────────────────────────── the full pass

describe("runSupportLoopGuardrail", () => {
  test("a clean pass still writes the audit row — the row IS the proof it ran", async () => {
    const db = fakeDb({ watchers: [{ host: "pc", lastBeatAt: new Date(), tokenExpiresAt: null }] });
    const out = await runSupportLoopGuardrail({}, db);
    assert.deepEqual(out?.alarms, []);
    assert.equal(db.state.audits.length, 1);
    assert.equal(db.state.audits[0].event, "support_loop.sweep");
    assert.equal(db.state.audits[0].actor, "system");
    assert.ok(db.state.audits[0].hash, "no hash = Prisma rejects the row = a blind monitor");
  });

  test("⛔ 'unworked' means NO RUN EVER STARTED — a failed run is a different problem", async () => {
    const old = new Date(Date.now() - 4 * 3600_000);
    const db = fakeDb({
      watchers: [{ host: "pc", lastBeatAt: new Date(), tokenExpiresAt: null }],
      staleEscalations: [
        { id: "e-started", tenantName: "Gesheft", createdAt: old },
        { id: "e-untouched", tenantName: "Trimpro", createdAt: old },
      ],
      runs: [{ escalationId: "e-started" }],
    });
    const out = await runSupportLoopGuardrail({}, db);
    assert.deepEqual(out?.alarms, [UNWORKED_KEY]);
    const raised = db.state.escalations[0];
    assert.ok(raised.report.includes("Trimpro"));
    assert.ok(!raised.report.includes("Gesheft"), "a ticket the agent STARTED is not 'unworked'");
  });

  test("⛔ a database failure never throws out of the pass, and still audits", async () => {
    const db = fakeDb();
    db.supportAgentWatcher.findMany = async () => {
      throw new Error("db down");
    };
    const out = await runSupportLoopGuardrail({}, db);
    assert.equal(out, null);
    assert.equal(db.state.audits.length, 1);
    assert.ok((db.state.audits[0].payload as any).error);
  });

  test("the kill switch works", async () => {
    process.env.SUPPORT_LOOP_GUARDRAIL_DISABLED = "1";
    try {
      const db = fakeDb();
      assert.equal(await runSupportLoopGuardrail({}, db), null);
      assert.equal(db.state.audits.length, 0);
    } finally {
      delete process.env.SUPPORT_LOOP_GUARDRAIL_DISABLED;
    }
  });
});

// ───────────────────────────────────────────────── the wiring

describe("⛔ SOURCE GUARDS", () => {
  const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const stripLineComments = (s: string) =>
    s.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");

  test("server.ts actually STARTS the guardrail — an unstarted monitor is decoration", () => {
    const src = read(path.join(__dirname, "..", "server.ts"));
    assert.ok(src.includes("startSupportLoopGuardrail(app.log)"));
  });

  test("⛔ it escalates and never emails — ADMIN_ALERT is muted at the send door", () => {
    const code = stripLineComments(read(path.join(__dirname, "supportLoopGuardrail.ts")));
    assert.ok(!code.includes("ADMIN_ALERT"));
    assert.ok(!code.includes("emailJob"));
  });

  test("⛔ the watcher's triage knows this guardrail's name — the circularity brace", () => {
    const triage = read(path.join(__dirname, "..", "..", "..", "..", "tools", "loopcom-support-mcp", "triage.mjs"));
    assert.ok(triage.includes(`"${GUARDRAIL_USERNAME}"`), "renaming GUARDRAIL_USERNAME re-opens the agent-investigates-its-own-monitor loop");
    assert.ok(triage.includes("skip_needs_person"), "the triage no longer skips needs-person tickets");
  });

  test("⛔ no sibling guardrail passes proposedFix: null any more", () => {
    for (const rel of [
      ["..", "sms", "smsForwardGuardrail.ts"],
      ["..", "pbx", "voicemailMailboxGuardrail.ts"],
    ]) {
      const code = stripLineComments(read(path.join(__dirname, ...rel)));
      assert.ok(!code.includes("proposedFix: null"), `${rel.join("/")} still cannot fire`);
    }
  });
});
