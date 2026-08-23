import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ALARM_KEY,
  decideVoicemailMailboxAlert,
  keyOf,
  parseAllowlist,
  raiseMailboxEscalation,
  runVoicemailMailboxSweep,
  type DisabledMailbox,
} from "./voicemailMailboxGuardrail";

const FIXUP: DisabledMailbox = { tenant: "fixup_group", extension: "103", extensionName: "Office" };
const MCNAMARA: DisabledMailbox = { tenant: "mcnamara_lion", extension: "101", extensionName: "Juda Poisner" };
const GESHEFT: DisabledMailbox = { tenant: "gesheft", extension: "898", extensionName: "Order Tracking" };

// ── the decision ────────────────────────────────────────────────────────────

test("a non-allowlisted disabled mailbox is an offender", () => {
  const v = decideVoicemailMailboxAlert({ disabled: [FIXUP], allowlist: parseAllowlist("gesheft:898") });
  assert.equal(v.shouldAlert, true);
  assert.deepEqual(v.offenders.map(keyOf), ["fixup_group:103"]);
  assert.match(v.summary, /^A customer cannot receive voicemail/);
  assert.match(v.sms, /cannot leave a message/);
});

test("an allowlisted one is recorded but never alerts", () => {
  const v = decideVoicemailMailboxAlert({ disabled: [GESHEFT], allowlist: parseAllowlist("gesheft:898") });
  assert.equal(v.shouldAlert, false);
  assert.deepEqual(v.allowlisted.map(keyOf), ["gesheft:898"]);
  assert.equal(v.sms, "");
});

test("the real incident: both casualties alert, the deliberate one does not", () => {
  const v = decideVoicemailMailboxAlert({
    disabled: [GESHEFT, MCNAMARA, FIXUP],
    allowlist: parseAllowlist("gesheft:898"),
  });
  assert.equal(v.shouldAlert, true);
  assert.deepEqual(v.offenders.map(keyOf), ["fixup_group:103", "mcnamara_lion:101"]);
  assert.deepEqual(v.allowlisted.map(keyOf), ["gesheft:898"]);
  for (const name of ["Office", "Juda Poisner"]) assert.ok(v.report.includes(name), name);
});

test("nothing disabled means no alarm", () => {
  const v = decideVoicemailMailboxAlert({ disabled: [], allowlist: parseAllowlist(null) });
  assert.equal(v.shouldAlert, false);
  assert.equal(v.offenders.length, 0);
});

test("the allowlist is case- and space-insensitive, and an empty entry is ignored", () => {
  const a = parseAllowlist(" GESHEFT:898 , , ");
  assert.equal(a.has("gesheft:898"), true);
  assert.equal(a.size, 1);
  const v = decideVoicemailMailboxAlert({
    disabled: [{ tenant: "Gesheft", extension: " 898 ", extensionName: "x" }],
    allowlist: a,
  });
  assert.equal(v.shouldAlert, false);
});

// ⛔ THE TEST THAT MATTERS MOST — it pins why this guardrail is shaped this way.
test("⛔ the obvious 'intended vs loaded' check would NOT have caught the incident", () => {
  // Live numbers immediately before the 2026-08-23 repair.
  const intendedEnabled = 122; // ombu_extensions_vm.enabled = 'yes'
  const loadedInAsterisk = 122; // asterisk: "voicemail show users"
  assert.equal(
    intendedEnabled,
    loadedInAsterisk,
    "the two casualties matched perfectly BY BEING EXCLUDED FROM BOTH SIDES — a guardrail " +
      "built on this comparison alone reports OK while customers cannot receive voicemail",
  );
  // The signal that DOES catch it is the disabled row itself.
  const v = decideVoicemailMailboxAlert({
    disabled: [FIXUP, MCNAMARA],
    allowlist: parseAllowlist("gesheft:898"),
  });
  assert.equal(v.shouldAlert, true, "the enabled='no' signal must fire where the count comparison is silent");
});

// ── the runner ──────────────────────────────────────────────────────────────

function fakeDb(overrides: any = {}) {
  const state: any = { escalations: [], audits: [], recentEscalation: null };
  return {
    state,
    agentEscalation: {
      findFirst: async () => state.recentEscalation,
      create: async ({ data }: any) => {
        state.escalations.push(data);
        return data;
      },
    },
    agentAuditLog: {
      create: async ({ data }: any) => {
        // Mirror Prisma: both columns are required. A monitor whose state write
        // silently fails is indistinguishable from a healthy one.
        assert.ok(data.actor, "AgentAuditLog requires actor");
        assert.ok(data.hash, "AgentAuditLog requires hash");
        state.audits.push(data);
        return data;
      },
    },
    ...overrides,
  };
}

test("a clean sweep still writes its audit row, and raises nothing", async () => {
  const database = fakeDb();
  const r = await runVoicemailMailboxSweep({
    database,
    allowlistRaw: "gesheft:898",
    fetch: async () => [GESHEFT],
  });
  assert.deepEqual(r, { ran: true, offenders: 0, alerted: false });
  assert.equal(database.state.escalations.length, 0);
  assert.equal(database.state.audits.length, 1, "a clean run must still prove it ran");
  assert.deepEqual(database.state.audits[0].payload.allowlisted, ["gesheft:898"]);
});

test("offenders raise exactly one escalation, and it carries an SMS body", async () => {
  const database = fakeDb();
  const r = await runVoicemailMailboxSweep({
    database,
    allowlistRaw: "gesheft:898",
    fetch: async () => [FIXUP, MCNAMARA, GESHEFT],
  });
  assert.equal(r.alerted, true);
  assert.equal(r.offenders, 2);
  assert.equal(database.state.escalations.length, 1);
  const esc = database.state.escalations[0];
  assert.equal(esc.status, "QUEUED", "QUEUED is what the dispatcher picks up");
  assert.ok(esc.smsBody.length > 0, "an escalation with no SMS body reaches nobody by phone");
  assert.match(esc.requestSummary, new RegExp("^" + ALARM_KEY));
});

test("a second sweep inside the window does not re-alert", async () => {
  const database = fakeDb();
  database.state.recentEscalation = { id: "esc-1" };
  const r = await runVoicemailMailboxSweep({
    database,
    allowlistRaw: "gesheft:898",
    fetch: async () => [FIXUP],
  });
  assert.equal(r.alerted, false, "de-duped inside the window");
  assert.equal(database.state.escalations.length, 0);
  assert.equal(database.state.audits.length, 1, "but it still records that it ran");
});

test("the de-dupe is bounded by time, so a standing problem keeps nagging", async () => {
  const database = fakeDb();
  let askedSince: any = null;
  database.agentEscalation.findFirst = async ({ where }: any) => {
    askedSince = where?.createdAt?.gte ?? null;
    return null;
  };
  await runVoicemailMailboxSweep({
    database,
    allowlistRaw: "gesheft:898",
    windowMs: 60_000,
    fetch: async () => [FIXUP],
  });
  assert.ok(askedSince instanceof Date, "the de-dupe must be time-bounded, not once-ever");
});

test("an unreachable PBX database reports honestly and alerts nobody", async () => {
  const database = fakeDb();
  const r = await runVoicemailMailboxSweep({ database, fetch: async () => null });
  assert.deepEqual(r, { ran: false, offenders: 0, alerted: false });
  assert.equal(database.state.escalations.length, 0, "not knowing is never the same as an all-clear");
});

test("a thrown query cannot crash the sweep", async () => {
  const database = fakeDb();
  const r = await runVoicemailMailboxSweep({
    database,
    fetch: async () => {
      throw new Error("mysql gone");
    },
  });
  assert.equal(r.ran, false);
});

test("raiseMailboxEscalation files under the platform tenant", async () => {
  const database = fakeDb();
  const v = decideVoicemailMailboxAlert({ disabled: [FIXUP], allowlist: parseAllowlist("") });
  const raised = await raiseMailboxEscalation(v, { windowMs: 1000, database });
  assert.equal(raised, true);
  assert.equal(database.state.escalations[0].tenantId, "connect-admin-tenant-v1");
});

// ── source guards ───────────────────────────────────────────────────────────

const SRC = readFileSync(join(__dirname, "voicemailMailboxGuardrail.ts"), "utf8").replace(/\r\n/g, "\n");
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("⛔ it does not use the once-ever shared escalation raiser", () => {
  assert.ok(
    !CODE.includes("raiseGuardrailEscalation"),
    "that helper de-dupes with no time bound, so this alarm could fire exactly once ever",
  );
});

test("⛔ the alert is an AgentEscalation, never an ADMIN_ALERT email", () => {
  assert.ok(CODE.includes("agentEscalation.create"), "escalations are the only channel that reaches a phone");
  // ⛔ Match the email TYPE, not the substring: ADMIN_ALERT_TENANT_ID is a
  // legitimate constant name here, and a blunt includes("ADMIN_ALERT") fails
  // against correct code — the recurring false-negative-guard trap in this repo.
  assert.ok(
    !/type:\s*["']ADMIN_ALERT["']/.test(CODE),
    "ADMIN_ALERT is muted platform-wide — such an alert would build clean, log clean and reach nobody",
  );
  assert.ok(!CODE.includes("emailJob.create"), "this guardrail must not grow its own email path");
});

test("⛔ every sweep writes an audit row with actor and hash", () => {
  assert.ok(CODE.includes("agentAuditLog.create"), "an ARMED log line is not proof a monitor works");
  assert.ok(CODE.includes("actor:"), "Prisma rejects the write without actor");
  assert.ok(CODE.includes("hash:"), "Prisma rejects the write without hash");
});
