import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The guardrails added after voicemail email died for ~20 hours on 2026-08-18.
 * Each pure decision is pinned at its thresholds; each runner is driven against
 * a faked db; and SOURCE guards make sure the runtime, the sync and server.ts
 * actually CALL them — a guard that exists but is not wired is the failure shape
 * this whole file is about (the old watchdog existed and had never run).
 */

const state: { audit: any[]; escalations: any[]; jobs: any[]; recipients: any[]; extensions: any[] } = {
  audit: [], escalations: [], jobs: [], recipients: [], extensions: [],
};
const calls: { emailJobWhere: any[] } = { emailJobWhere: [] };

const fakeDb: any = {
  agentAuditLog: {
    create: async ({ data }: any) => { state.audit.push({ ...data, ts: new Date() }); return data; },
    findFirst: async ({ where }: any) => {
      const rows = state.audit.filter((a) => a.event === where.event).sort((a, b) => +b.ts - +a.ts);
      return rows[0] || null;
    },
    findMany: async ({ where }: any) => state.audit.filter((a) => a.event === where.event),
  },
  agentEscalation: {
    findFirst: async ({ where }: any) =>
      state.escalations.find((e) => e.requestSummary.startsWith(where.requestSummary.startsWith) && ["QUEUED", "SENT"].includes(e.status)) || null,
    create: async ({ data }: any) => { state.escalations.push(data); return data; },
  },
  emailJob: {
    findFirst: async ({ where, orderBy }: any) => {
      calls.emailJobWhere.push(where);
      let rows = state.jobs.filter((j) => j.type !== "ADMIN_ALERT");
      if (where?.status?.in) rows = rows.filter((j) => where.status.in.includes(j.status));
      if (where?.status === "SENT") rows = rows.filter((j) => j.status === "SENT");
      if (where?.attempts?.lt != null) rows = rows.filter((j) => j.attempts < where.attempts.lt);
      if (where?.nextRunAt?.lte) rows = rows.filter((j) => +j.nextRunAt <= +where.nextRunAt.lte);
      if (orderBy?.sentAt === "desc") rows.sort((a, b) => +b.sentAt - +a.sentAt);
      if (orderBy?.nextRunAt === "asc") rows.sort((a, b) => +a.nextRunAt - +b.nextRunAt);
      return rows[0] || null;
    },
    count: async () => state.jobs.filter((j) => j.type !== "ADMIN_ALERT" && j.status !== "SENT").length,
    findMany: async ({ where }: any) => {
      calls.emailJobWhere.push(where);
      let rows = state.jobs.filter((j) => j.type !== "ADMIN_ALERT");
      if (where?.type && typeof where.type === "string") rows = rows.filter((j) => j.type === where.type);
      if (where?.status === "FAILED") rows = rows.filter((j) => j.status === "FAILED");
      if (where?.attempts?.gte != null) rows = rows.filter((j) => j.attempts >= where.attempts.gte);
      if (where?.updatedAt?.gte) rows = rows.filter((j) => +j.updatedAt >= +where.updatedAt.gte);
      return rows;
    },
    update: async ({ where, data }: any) => { const j = state.jobs.find((x) => x.id === where.id); Object.assign(j, data); return j; },
  },
  extension: {
    findUnique: async ({ where }: any) =>
      state.extensions.find((e) => e.tenantId === where.tenantId_extNumber.tenantId && e.extNumber === where.tenantId_extNumber.extNumber) || null,
    findMany: async () => state.extensions,
  },
  voicemailEmailRecipient: {
    upsert: async ({ where, create }: any) => {
      const exists = state.recipients.find((r) => r.extensionId === where.extensionId_email.extensionId && r.email === where.extensionId_email.email);
      if (exists) return exists;
      state.recipients.push(create); return create;
    },
  },
};

mock.module("@connect/db", { namedExports: { db: fakeDb } });

const log = { info: () => {}, warn: () => {} };
function reset() {
  for (const k of Object.keys(state)) (state as any)[k].length = 0;
  calls.emailJobWhere.length = 0;
  process.env.VOICEMAIL_EMAIL_ENABLED = "1";
  process.env.VOICEMAIL_EMAIL_EXCLUDED_TENANT_IDS = "gesheft";
}
const min = (n: number) => n * 60_000;
const NOW = new Date("2026-08-18T18:00:00Z");

// ── pure decisions ────────────────────────────────────────────────────────────

test("heartbeat staleness: a fresh process is not judged, an old heartbeat is, a mature process with none is dead", async () => {
  const { decideHeartbeatStale, LIVENESS_BOOT_GRACE_MS, HEARTBEAT_STALE_MS } = await import("./voicemailEmailGuardrails");
  const fresh = LIVENESS_BOOT_GRACE_MS / 2, mature = LIVENESS_BOOT_GRACE_MS * 2;
  assert.equal(decideHeartbeatStale({ kind: "sweep", lastAt: null, now: NOW, processUptimeMs: fresh }).stale, false, "fresh + never: wait");
  assert.equal(decideHeartbeatStale({ kind: "sweep", lastAt: new Date(+NOW - HEARTBEAT_STALE_MS.sweep - LIVENESS_BOOT_GRACE_MS - 1000), now: NOW, processUptimeMs: fresh }).stale, true, "fresh + very old: still a finding");
  assert.equal(decideHeartbeatStale({ kind: "sweep", lastAt: null, now: NOW, processUptimeMs: mature }).stale, true, "mature + never: dead");
  assert.equal(decideHeartbeatStale({ kind: "sweep", lastAt: new Date(+NOW - min(3)), now: NOW, processUptimeMs: mature }).stale, false);
  assert.equal(decideHeartbeatStale({ kind: "sweep", lastAt: new Date(+NOW - min(11)), now: NOW, processUptimeMs: mature }).stale, true);
  assert.equal(decideHeartbeatStale({ kind: "watchdog", lastAt: new Date(+NOW - min(30)), now: NOW, processUptimeMs: mature }).stale, false, "watchdog every 15 min: 30 is fine");
  assert.equal(decideHeartbeatStale({ kind: "watchdog", lastAt: new Date(+NOW - min(46)), now: NOW, processUptimeMs: mature }).stale, true);
});

test("recipient coverage: the cutover shape (55 -> 0) trips it; one customer removing one address does not", async () => {
  const { decideRecipientCoverageDrop } = await import("./voicemailEmailGuardrails");
  assert.equal(decideRecipientCoverageDrop({ previous: null, current: 0 }).dropped, false, "first run: nothing to compare");
  assert.equal(decideRecipientCoverageDrop({ previous: 55, current: 0 }).dropped, true);
  assert.equal(decideRecipientCoverageDrop({ previous: 55, current: 53 }).dropped, false, "2 lost: churn");
  assert.equal(decideRecipientCoverageDrop({ previous: 10, current: 7 }).dropped, true, "3 lost of 10 = 30%");
  assert.equal(decideRecipientCoverageDrop({ previous: 100, current: 97 }).dropped, false, "3 lost of 100 = 3%");
  assert.equal(decideRecipientCoverageDrop({ previous: 50, current: 60 }).dropped, false, "growth is fine");
});

test("preserve a blanked PBX address: value->blank is kept (lowercased); a change or nothing->nothing is not", async () => {
  const { decidePreservePbxEmail } = await import("./voicemailEmailGuardrails");
  assert.equal(decidePreservePbxEmail({ previous: " Sales@BVisible.us ", next: null }), "sales@bvisible.us");
  assert.equal(decidePreservePbxEmail({ previous: "a@x.com", next: "" }), "a@x.com");
  assert.equal(decidePreservePbxEmail({ previous: "a@x.com", next: "b@x.com" }), null, "a change is the mirror's business");
  assert.equal(decidePreservePbxEmail({ previous: null, next: null }), null);
  assert.equal(decidePreservePbxEmail({ previous: "not-an-email", next: null }), null);
});

test("outbox health thresholds", async () => {
  const { decideOutboxHealth, OUTBOX_STALL_MS, OUTBOX_FAILURES_BEFORE_ALARM } = await import("./voicemailEmailGuardrails");
  assert.deepEqual(decideOutboxHealth({ oldestOverdueQueuedAgeMs: null, failuresLastHour: 0 }), { stalled: false, failing: false });
  assert.equal(decideOutboxHealth({ oldestOverdueQueuedAgeMs: OUTBOX_STALL_MS - 1, failuresLastHour: 0 }).stalled, false);
  assert.equal(decideOutboxHealth({ oldestOverdueQueuedAgeMs: OUTBOX_STALL_MS, failuresLastHour: 0 }).stalled, true);
  assert.equal(decideOutboxHealth({ oldestOverdueQueuedAgeMs: null, failuresLastHour: OUTBOX_FAILURES_BEFORE_ALARM - 1 }).failing, false);
  assert.equal(decideOutboxHealth({ oldestOverdueQueuedAgeMs: null, failuresLastHour: OUTBOX_FAILURES_BEFORE_ALARM }).failing, true);
});

test("requeue: bounded, not before an hour, and only once the outbox has sent something SINCE the failure", async () => {
  const { decideRequeue, MAX_REQUEUES_PER_JOB } = await import("./voicemailEmailGuardrails");
  const failedAt = new Date(+NOW - min(90));
  assert.equal(decideRequeue({ failedAt, lastSentAnywhereAt: new Date(+NOW - min(5)), priorRequeues: 0, now: NOW }), true);
  assert.equal(decideRequeue({ failedAt, lastSentAnywhereAt: new Date(+NOW - min(5)), priorRequeues: MAX_REQUEUES_PER_JOB, now: NOW }), false, "cap");
  assert.equal(decideRequeue({ failedAt: new Date(+NOW - min(10)), lastSentAnywhereAt: new Date(+NOW - min(5)), priorRequeues: 0, now: NOW }), false, "too soon");
  assert.equal(decideRequeue({ failedAt, lastSentAnywhereAt: new Date(+NOW - min(120)), priorRequeues: 0, now: NOW }), false, "last success predates the failure — cause not shown cleared");
  assert.equal(decideRequeue({ failedAt, lastSentAnywhereAt: null, priorRequeues: 0, now: NOW }), false);
});

// ── runners against the fake db ───────────────────────────────────────────────

test("an escalation is raised once and de-duplicated while open", async () => {
  reset();
  const { raiseGuardrailEscalation } = await import("./voicemailEmailGuardrails");
  const alarm = { key: "Test alarm", summary: "Test alarm — x", sms: "s", report: "r", fix: "f" };
  assert.equal(await raiseGuardrailEscalation(alarm, log, fakeDb), true);
  assert.equal(await raiseGuardrailEscalation(alarm, log, fakeDb), false);
  assert.equal(state.escalations.length, 1);
  assert.equal(state.escalations[0].status, "QUEUED");
  assert.equal(state.escalations[0].tenantId, "connect-admin-tenant-v1");
});

test("the watchdog's own failure escalates on the third consecutive run and resets on success", async () => {
  reset();
  const { noteWatchdogFailure, noteWatchdogSuccess, _resetWatchdogFailureCounter, ALARM_PREFIX } = await import("./voicemailEmailGuardrails");
  _resetWatchdogFailureCounter();
  await noteWatchdogFailure(new Error("Unknown field `tenant`"), log, fakeDb);
  await noteWatchdogFailure(new Error("Unknown field `tenant`"), log, fakeDb);
  assert.equal(state.escalations.length, 0, "two failures: not yet");
  await noteWatchdogFailure(new Error("Unknown field `tenant`"), log, fakeDb);
  assert.equal(state.escalations.length, 1);
  assert.ok(state.escalations[0].requestSummary.startsWith(ALARM_PREFIX.watchdogFailing));
  assert.match(state.escalations[0].report, /Unknown field `tenant`/);
  noteWatchdogSuccess();
  state.escalations.length = 0;
  await noteWatchdogFailure(new Error("x"), log, fakeDb);
  await noteWatchdogFailure(new Error("x"), log, fakeDb);
  assert.equal(state.escalations.length, 0, "counter reset by success");
  _resetWatchdogFailureCounter();
});

test("preserveBlankedPbxEmail writes the old address into VoicemailEmailRecipient before the mirror is nulled", async () => {
  reset();
  const { preserveBlankedPbxEmail } = await import("./voicemailEmailGuardrails");
  state.extensions.push({ id: "e1", tenantId: "t1", extNumber: "105", pbxUserEmail: "fhalpert@trustbookkeepingny.com" });
  assert.equal(await preserveBlankedPbxEmail(fakeDb, { tenantId: "t1", extNumber: "105", nextPbxUserEmail: null }, log), true);
  assert.deepEqual(state.recipients, [{ tenantId: "t1", extensionId: "e1", email: "fhalpert@trustbookkeepingny.com" }]);
  // Same value again: nothing to preserve. A change: nothing to preserve. Unknown extension: nothing.
  assert.equal(await preserveBlankedPbxEmail(fakeDb, { tenantId: "t1", extNumber: "105", nextPbxUserEmail: "fhalpert@trustbookkeepingny.com" }, log), false);
  assert.equal(await preserveBlankedPbxEmail(fakeDb, { tenantId: "t1", extNumber: "999", nextPbxUserEmail: null }, log), false);
  assert.equal(state.recipients.length, 1);
});

test("outbox health: an old due job escalates 'not sending'; a burst of failures escalates 'failing'; ADMIN_ALERT is never counted", async () => {
  reset();
  const { runOutboxHealthCheck, ALARM_PREFIX } = await import("./voicemailEmailGuardrails");
  state.jobs.push({ id: "j1", type: "USER_INVITE", status: "QUEUED", attempts: 0, nextRunAt: new Date(+NOW - min(30)), createdAt: new Date(+NOW - min(30)), updatedAt: new Date(+NOW - min(30)), toEmail: "a@x.com" });
  await runOutboxHealthCheck(log, fakeDb, NOW);
  assert.ok(state.escalations.some((e) => e.requestSummary.startsWith(ALARM_PREFIX.outboxStalled)), "stalled outbox escalated");
  for (const w of calls.emailJobWhere) assert.deepEqual(w.type, { not: "ADMIN_ALERT" }, "every outbox query excludes the muted type");
  state.escalations.length = 0; state.jobs.length = 0; calls.emailJobWhere.length = 0;
  for (let i = 0; i < 5; i++) state.jobs.push({ id: `f${i}`, type: "BILLING_INVOICE_READY", status: "FAILED", attempts: 5, nextRunAt: NOW, createdAt: NOW, updatedAt: new Date(+NOW - min(10)), lastErrorCode: "550", lastErrorMessage: "quota", toEmail: "b@x.com" });
  await runOutboxHealthCheck(log, fakeDb, NOW);
  assert.ok(state.escalations.some((e) => e.requestSummary.startsWith(ALARM_PREFIX.outboxFailing)), "failing outbox escalated");
  assert.match(state.escalations[0].report, /5 x BILLING_INVOICE_READY: 550 quota/);
});

test("dead voicemail emails are re-queued once the outbox sends again — at most twice each", async () => {
  reset();
  const { requeueDeadVoicemailEmails, REQUEUE_EVENT } = await import("./voicemailEmailGuardrails");
  state.jobs.push({ id: "dead1", type: "VOICEMAIL_NOTIFICATION", status: "FAILED", attempts: 5, nextRunAt: NOW, createdAt: new Date(+NOW - min(200)), updatedAt: new Date(+NOW - min(120)), toEmail: "v@x.com" });
  state.jobs.push({ id: "ok1", type: "USER_INVITE", status: "SENT", attempts: 1, nextRunAt: NOW, createdAt: NOW, updatedAt: NOW, sentAt: new Date(+NOW - min(5)), toEmail: "i@x.com" });
  assert.equal(await requeueDeadVoicemailEmails(log, fakeDb, NOW), 1);
  const j = state.jobs.find((x) => x.id === "dead1");
  assert.equal(j.status, "QUEUED"); assert.equal(j.attempts, 0); assert.equal(j.lastErrorCode, "REQUEUED_BY_WATCHDOG");
  assert.equal(state.audit.filter((a) => a.event === REQUEUE_EVENT).length, 1);
  // It fails again twice more; only ONE more requeue is allowed.
  j.status = "FAILED"; j.attempts = 5; j.updatedAt = new Date(+NOW - min(120));
  assert.equal(await requeueDeadVoicemailEmails(log, fakeDb, NOW), 1);
  j.status = "FAILED"; j.attempts = 5; j.updatedAt = new Date(+NOW - min(120));
  assert.equal(await requeueDeadVoicemailEmails(log, fakeDb, NOW), 0, "cap reached");
});

test("liveness: a mature process with a stale sweep heartbeat escalates; a fresh one waits", async () => {
  reset();
  const { runVoicemailEmailLivenessCheck, ALARM_PREFIX, LIVENESS_BOOT_GRACE_MS } = await import("./voicemailEmailGuardrails");
  const realUptime = process.uptime;
  try {
    (process as any).uptime = () => (LIVENESS_BOOT_GRACE_MS * 2) / 1000;
    state.audit.push({ event: "voicemail_email.sweep_heartbeat", ts: new Date(+NOW - min(30)) });
    state.audit.push({ event: "voicemail_email.watchdog_heartbeat", ts: new Date(+NOW - min(5)) });
    await runVoicemailEmailLivenessCheck(log, fakeDb, NOW);
    assert.equal(state.escalations.length, 1);
    assert.ok(state.escalations[0].requestSummary.startsWith(ALARM_PREFIX.sweepDead));
    assert.match(state.escalations[0].requestSummary, /30 min ago/);
    state.escalations.length = 0;
    (process as any).uptime = () => 30; // 30 s old process, heartbeats from before the restart are fine
    await runVoicemailEmailLivenessCheck(log, fakeDb, NOW);
    assert.equal(state.escalations.length, 0);
  } finally {
    (process as any).uptime = realUptime;
  }
});

// ── SOURCE guards: a guard that exists but is not wired is the bug this file is about ──
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
const runtimeSrc = read("voicemailEmailRuntime.ts");
const syncSrc = read("../pbxExtensionSync.ts");
const serverSrc = read("../server.ts");

test("SOURCE: the sweep and the watchdog both record heartbeats, and the watchdog's catch escalates", () => {
  const sweep = runtimeSrc.slice(runtimeSrc.indexOf("export async function runVoicemailEmailSweep"), runtimeSrc.indexOf("export async function runVoicemailEmailWatchdog"));
  const wd = runtimeSrc.slice(runtimeSrc.indexOf("export async function runVoicemailEmailWatchdog"), runtimeSrc.indexOf("function countBy"));
  assert.match(sweep, /recordHeartbeat\("sweep"/);
  assert.match(wd, /recordHeartbeat\("watchdog"/);
  assert.match(wd, /catch \(err\) \{[\s\S]*?noteWatchdogFailure\(err, log\)/);
  assert.match(wd, /noteWatchdogSuccess\(\)/);
});

test("SOURCE: the watchdog self-heals — it processes stranded voicemails and re-queues dead jobs", () => {
  const wd = runtimeSrc.slice(runtimeSrc.indexOf("export async function runVoicemailEmailWatchdog"), runtimeSrc.indexOf("function countBy"));
  assert.match(wd, /problem === "never_processed"[\s\S]*?processVoicemails\(rows, log\)/);
  assert.match(wd, /await requeueDeadVoicemailEmails\(log\)/);
});

test("SOURCE: the extension sync calls preserveBlankedPbxEmail BEFORE the extension upsert", () => {
  const i = syncSrc.indexOf("await preserveBlankedPbxEmail(db, { tenantId: resolvedTenantId, extNumber, nextPbxUserEmail: pbxUserEmail })");
  const j = syncSrc.indexOf("const connectExt = await db.extension.upsert(");
  assert.ok(i > 0, "sync must call the guard");
  assert.ok(j > i, "the guard must run before the mirror is overwritten");
});

test("SOURCE: server.ts starts the guardrail timers", () => {
  assert.match(serverSrc, /startEmailGuardrails\(app\.log\)/);
});

// ⛔⛔ 2026-08-21: the watchdog was armed with a bare setInterval(15 min) and no
// boot run, so every api restart reset its clock. Five rollouts inside 50 minutes
// (ten container boots, longest quiet stretch ~12 min) starved it for 67 minutes
// and paged the owner while the pipeline was healthy. The sweep survived the exact
// same churn because it has a 45 s boot kick. This guard keeps the watchdog’s.
test("SOURCE: the watchdog is kicked at boot as well as on its interval", async () => {
  const { VOICEMAIL_EMAIL_WATCHDOG_BOOT_DELAY_MS, VOICEMAIL_EMAIL_WATCHDOG_INTERVAL_MS } = await import("./voicemailEmailRuntime");
  assert.match(
    serverSrc,
    /setTimeout\(\(\) => \{ void runVoicemailEmailWatchdog\(app\.log\); \}, VOICEMAIL_EMAIL_WATCHDOG_BOOT_DELAY_MS\)/,
    "the watchdog must run once shortly after boot, or a restart cadence under its interval starves it forever",
  );
  assert.match(
    serverSrc,
    /setInterval\(\(\) => \{ void runVoicemailEmailWatchdog\(app\.log\); \}, VOICEMAIL_EMAIL_WATCHDOG_INTERVAL_MS\)/,
    "the interval must remain — the boot kick is an addition, never a replacement",
  );
  // The boot kick must land AFTER the sweep’s, so the sweep gets first refusal
  // on fresh voicemail and the watchdog’s rescue path stays the exception.
  assert.ok(
    VOICEMAIL_EMAIL_WATCHDOG_BOOT_DELAY_MS > 45_000,
    "the watchdog boot kick must come after the sweep’s 45 s kick",
  );
  assert.ok(
    VOICEMAIL_EMAIL_WATCHDOG_BOOT_DELAY_MS < VOICEMAIL_EMAIL_WATCHDOG_INTERVAL_MS,
    "a boot kick no earlier than the interval is not a boot kick",
  );
});
