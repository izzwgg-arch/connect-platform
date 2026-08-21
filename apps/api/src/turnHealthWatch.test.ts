/**
 * TURN health watch — the decision rules, the URL parsing, and the wiring.
 *
 * ⛔ The alarm's whole job is to text a human, so the tests that matter most
 * are the ones proving it texts through the ONE channel that reaches him
 * (AgentEscalation, never ADMIN_ALERT), texts ONCE for a persistent fault, and
 * does NOT text for a single dropped packet.
 */
import assert from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  TURN_ALARM_PREFIX,
  buildStunBindingRequest,
  buildTurnAlertSms,
  classifyTurnProbe,
  decideTurnAlert,
  parseTurnUrls,
  runTurnHealthCheck,
  turnUrlsFromEnv,
  type TurnProbe,
} from "./turnHealthWatch";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const R = (ok: boolean, target = "udp 1.2.3.4:3478") => ({ target, ok, detail: ok ? "ok" : "timeout" });
const probeOf = (udp: boolean[], tcp: boolean[] = [], tlsArr: boolean[] = [], certDaysLeft: number | null = null): TurnProbe => ({
  udp: udp.map((o) => R(o)),
  tcp: tcp.map((o) => R(o, "tcp 1.2.3.4:3478")),
  tls: tlsArr.map((o) => R(o, "tls h:5349")),
  certDaysLeft,
  certSubject: "turn.example",
});

test("STUN binding request has the right magic cookie and length", () => {
  const b = buildStunBindingRequest();
  assert.equal(b.length, 20);
  assert.equal(b.readUInt16BE(0), 0x0001, "binding request type");
  assert.equal(b.readUInt16BE(2), 0, "zero body length");
  assert.equal(b.readUInt32BE(4), 0x2112a442, "STUN magic cookie");
});

test("classifyTurnProbe: all good = ok, none = down, mixed = degraded", () => {
  assert.equal(classifyTurnProbe(probeOf([true], [true], [true])), "ok");
  assert.equal(classifyTurnProbe(probeOf([false], [false], [false])), "down");
  // ⛔ UDP dead while TCP answers is a REAL fault — most call media is UDP —
  // even though a naive "is the port open" check would call this healthy.
  assert.equal(classifyTurnProbe(probeOf([false], [true], [true])), "degraded");
  assert.equal(classifyTurnProbe({ udp: [], tcp: [], tls: [], certDaysLeft: null, certSubject: null }), "unknown");
});

test("decideTurnAlert: a single failure does NOT text; the streak does", () => {
  const base = { state: "down" as const, alreadyAlerted: false, downStreak: 3 };
  assert.equal(decideTurnAlert({ ...base, streak: 1 }).action, "none");
  assert.equal(decideTurnAlert({ ...base, streak: 2 }).action, "none");
  const fire = decideTurnAlert({ ...base, streak: 3 });
  assert.equal(fire.action, "alert");
  assert.equal((fire as any).key, TURN_ALARM_PREFIX.down);
});

test("decideTurnAlert: a persistent fault texts ONCE, and recovery texts once", () => {
  assert.equal(decideTurnAlert({ state: "down", streak: 9, alreadyAlerted: true, downStreak: 3 }).action, "none");
  assert.equal(decideTurnAlert({ state: "ok", streak: 0, alreadyAlerted: true }).action, "recovered");
  assert.equal(decideTurnAlert({ state: "ok", streak: 0, alreadyAlerted: false }).action, "none");
});

test("decideTurnAlert: an inconclusive probe never texts", () => {
  assert.equal(decideTurnAlert({ state: "unknown", streak: 99, alreadyAlerted: false }).action, "none");
});

test("parseTurnUrls: real urls become the right probe kinds, deduped", () => {
  const t = parseTurnUrls([
    "turn:45.14.194.179:3478?transport=udp",
    "turn:45.14.194.179:3478?transport=tcp",
    "turns:app.connectcomunications.com:5349?transport=tcp",
    "turn:45.14.194.179:3478?transport=udp", // dupe
    "stun:stun.l.google.com:19302",          // not TURN — ignored
    "garbage",
  ]);
  assert.deepEqual(t.map((x) => `${x.kind}:${x.host}:${x.port}`), [
    "udp:45.14.194.179:3478",
    "tcp:45.14.194.179:3478",
    "tls:app.connectcomunications.com:5349",
  ]);
});

test("turnUrlsFromEnv expands a bare host exactly like the ICE list clients receive", () => {
  assert.deepEqual(turnUrlsFromEnv({ TURN_SERVER: "45.14.194.179" } as any), [
    "turn:45.14.194.179:3478?transport=udp",
    "turn:45.14.194.179:3478?transport=tcp",
  ]);
  assert.equal(turnUrlsFromEnv({} as any).length, 0, "no target -> nothing invented");
});

test("the SMS is plain ASCII — one emoji would cut the segment from 160 to 70", () => {
  const sms = buildTurnAlertSms("down", probeOf([false], [false]), "45.14.194.179");
  // eslint-disable-next-line no-control-regex
  assert.ok(/^[\x00-\x7F]*$/.test(sms), `SMS must be ASCII: ${sms}`);
  assert.ok(sms.includes("45.14.194.179"));
  assert.ok(sms.length <= 300);
});

// ── Runner against a fake db ───────────────────────────────────────────────

function fakeDb(lastPayload: any = null) {
  const escalations: any[] = [];
  const audits: any[] = [];
  return {
    escalations,
    audits,
    agentAuditLog: {
      findFirst: async () => (lastPayload ? { payload: lastPayload } : null),
      // ⛔ Validates the REQUIRED columns exactly as Prisma does. A fake db that
      // accepts anything is why the real write failed silently in production
      // while every test stayed green.
      create: async ({ data }: any) => {
        for (const f of ["actor", "event", "hash"]) {
          if (!data?.[f]) throw new Error(`Argument \`${f}\` is missing (AgentAuditLog)`);
        }
        audits.push(data); return data;
      },
    },
    agentEscalation: {
      findFirst: async ({ where }: any) =>
        escalations.find((e) => String(e.requestSummary).startsWith(where.requestSummary.startsWith)) ?? null,
      create: async ({ data }: any) => { escalations.push(data); return data; },
    },
    turnConfig: { findMany: async () => [] },
  };
}

const ENV = { TURN_SERVER: "1.2.3.4" } as any;

test("runner: a down TURN at the streak raises an escalation (the only channel that texts)", async () => {
  const db = fakeDb({ state: "down", streak: 2, alerted: false });
  const res = await runTurnHealthCheck({
    db, env: ENV,
    probe: async () => probeOf([false], [false]),
  });
  assert.equal(res.state, "down");
  assert.equal(db.escalations.length, 1);
  const e = db.escalations[0];
  assert.ok(String(e.requestSummary).startsWith(TURN_ALARM_PREFIX.down));
  assert.equal(e.status, "QUEUED", "QUEUED is what the dispatcher picks up");
  assert.ok(e.smsBody && e.report, "must carry both the SMS and the report");
  assert.equal(db.audits.length, 1, "state recorded for the next run");
  assert.equal(db.audits[0].payload.alerted, true);
});

test("runner: the SAME fault next cycle does NOT text again", async () => {
  const db = fakeDb({ state: "down", streak: 5, alerted: true });
  await runTurnHealthCheck({ db, env: ENV, probe: async () => probeOf([false], [false]) });
  assert.equal(db.escalations.length, 0, "already alerted — must stay silent");
});

test("runner: one bad check alone never texts", async () => {
  const db = fakeDb(null);
  await runTurnHealthCheck({ db, env: ENV, probe: async () => probeOf([false], [false]) });
  assert.equal(db.escalations.length, 0, "streak 1 of 3");
  assert.equal(db.audits[0].payload.streak, 1);
});

test("runner: healthy records a heartbeat and texts nothing", async () => {
  const db = fakeDb(null);
  const res = await runTurnHealthCheck({ db, env: ENV, probe: async () => probeOf([true], [true]) });
  assert.equal(res.state, "ok");
  assert.equal(db.escalations.length, 0);
  assert.equal(db.audits.length, 1, "⛔ heartbeat on healthy runs too — it proves the monitor is alive");
});

test("runner: recovery sends the all-clear once", async () => {
  const db = fakeDb({ state: "down", streak: 4, alerted: true });
  await runTurnHealthCheck({ db, env: ENV, probe: async () => probeOf([true], [true]) });
  assert.equal(db.escalations.length, 1);
  assert.ok(String(db.escalations[0].requestSummary).startsWith("TURN server is back"));
  assert.equal(db.audits[0].payload.alerted, false, "re-armed for the next outage");
});

test("runner: an expiring certificate raises its own alarm", async () => {
  const db = fakeDb(null);
  await runTurnHealthCheck({ db, env: ENV, probe: async () => probeOf([true], [true], [true], 3) });
  assert.equal(db.escalations.length, 1);
  assert.ok(String(db.escalations[0].requestSummary).startsWith(TURN_ALARM_PREFIX.certExpiring));
});

test("runner: no configured target monitors nothing and says so", async () => {
  const db = fakeDb(null);
  const res = await runTurnHealthCheck({ db, env: {} as any, probe: async () => probeOf([true]) });
  assert.equal(res.skipped, "no_target");
  assert.equal(db.escalations.length, 0);
});

// ── Source guards ──────────────────────────────────────────────────────────

test("⛔ the state row carries the columns AgentAuditLog actually requires", async () => {
  const db = fakeDb(null);
  await runTurnHealthCheck({ db, env: ENV, probe: async () => probeOf([true], [true]) });
  assert.equal(db.audits.length, 1, "the heartbeat must actually be written");
  const row = db.audits[0];
  assert.equal(row.actor, "system");
  assert.equal(row.event, "turn_health.check");
  assert.ok(/^[0-9a-f]{64}$/.test(row.hash), "hash must be a sha256 hex digest");
});

test("⛔ the watcher NEVER uses ADMIN_ALERT (muted at the send door — would reach nobody)", () => {
  const src = read(path.join(__dirname, "turnHealthWatch.ts"));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/ADMIN_ALERT["'`]|type:\s*["'`]ADMIN_ALERT/.test(code), "must not queue an ADMIN_ALERT email");
  assert.ok(!/emailJob\.create/.test(code), "must not grow its own email path");
  assert.ok(/agentEscalation\.create/.test(code), "must raise an AgentEscalation — the channel that texts");
});

test("⛔ the watcher is actually STARTED in server.ts (a guard nobody calls is the bug itself)", () => {
  const src = read(path.join(__dirname, "server.ts"));
  assert.ok(src.includes('from "./turnHealthWatch"'), "server.ts must import it");
  assert.ok(/startTurnHealthWatch\(/.test(src), "server.ts must call startTurnHealthWatch(...)");
});
