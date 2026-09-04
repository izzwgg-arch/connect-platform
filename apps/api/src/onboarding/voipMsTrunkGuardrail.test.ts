// VoIP.ms trunk guardrail — proves the alarm that would have caught the
// 2026-09-02 → 09-04 inii mini outage (146 lost calls, nobody told).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DUPLICATE_ALARM_KEY,
  SWEEP_EVENT,
  UNREGISTERED_ALARM_KEY,
  decideTrunkVerdict,
  fetchTrunkState,
  raiseTrunkEscalation,
  runVoipmsTrunkSweep,
  type TrunkState,
} from "./voipMsTrunkGuardrail";

const state = (over: Partial<TrunkState> = {}): TrunkState => ({
  rowsByName: new Map([
    ["344022_iniimi92gh2m", 1],
    ["344022_Hannaeneh5c", 1],
  ]),
  didsByAccount: new Map([
    ["344022", ["8452605692", "7244198226"]],
    ["344022_iniimi92gh2m", ["6469846023"]],
    ["344022_Hannaeneh5c", ["8455577194"]],
  ]),
  registration: new Map([
    ["344022_iniimi92gh2m", "no"],
    ["344022_Hannaeneh5c", "yes"],
  ]),
  master: "344022",
  ...over,
});

// ── the decision ────────────────────────────────────────────────────────────

test("first sighting of an unregistered trunk is a candidate, not an alarm", () => {
  const v = decideTrunkVerdict({ state: state(), previousUnregistered: [] });
  assert.deepEqual(v.unregisteredNow, ["344022_iniimi92gh2m"]);
  assert.equal(v.offenders.length, 0);
  assert.equal(v.unregisteredSms, "");
});

test("the real incident: unregistered on two consecutive sweeps alarms, naming the number and the company", () => {
  const v = decideTrunkVerdict({
    state: state(),
    previousUnregistered: ["344022_iniimi92gh2m"],
    tenantNameByDid: new Map([["6469846023", "inii mini"]]),
  });
  assert.equal(v.offenders.length, 1);
  assert.equal(v.offenders[0].account, "344022_iniimi92gh2m");
  assert.match(v.unregisteredSummary, /^A phone number cannot receive calls/);
  assert.match(v.unregisteredSms, /646-984-6023 \(inii mini\)/);
  assert.match(v.unregisteredSms, /busy signal/);
  assert.match(v.unregisteredReport, /pjsip send register/);
});

test("the master account (spare pool) never counts, and a registered trunk never alarms", () => {
  const v = decideTrunkVerdict({
    state: state({ registration: new Map([["344022_iniimi92gh2m", "yes"], ["344022_Hannaeneh5c", "yes"]]) }),
    previousUnregistered: ["344022_iniimi92gh2m", "344022"],
  });
  assert.deepEqual(v.unregisteredNow, []);
  assert.equal(v.offenders.length, 0);
});

test("a provider error on one account is not 'no' — it neither alarms nor becomes a candidate", () => {
  const v = decideTrunkVerdict({
    state: state({ registration: new Map([["344022_iniimi92gh2m", "error:timeout"], ["344022_Hannaeneh5c", "yes"]]) }),
    previousUnregistered: ["344022_iniimi92gh2m"],
  });
  assert.deepEqual(v.unregisteredNow, []);
  assert.equal(v.offenders.length, 0);
});

test("a login name that exists twice alarms on its own, on the first sweep", () => {
  const v = decideTrunkVerdict({
    state: state({ rowsByName: new Map([["344022_Matamih8gmrh", 3], ["344022_iniimi92gh2m", 2]]) }),
    previousUnregistered: [],
  });
  assert.deepEqual(
    [...v.duplicates].sort((a, b) => b.rows - a.rows),
    [
      { account: "344022_Matamih8gmrh", rows: 3 },
      { account: "344022_iniimi92gh2m", rows: 2 },
    ],
  );
  assert.match(v.duplicateSms, /3 rows for 344022_Matamih8gmrh/);
  assert.match(v.duplicateReport, /LOWEST id/);
});

// ── fetching from VoIP.ms ───────────────────────────────────────────────────

test("fetchTrunkState asks registration only for subaccounts that hold a number, never the master", async () => {
  const asked: string[] = [];
  const fake = async (_c: any, method: string, params: Record<string, string> = {}) => {
    if (method === "getSubAccounts")
      return { accounts: [{ id: "1", account: "344022_a" }, { id: "2", account: "344022_b" }, { id: "3", account: "344022_b" }] };
    if (method === "getDIDsInfo")
      return { dids: [{ did: "1112223333", routing: "account:344022_a" }, { did: "2223334444", routing: "account:344022" }, { did: "3334445555", routing: "sys:hangup" }] };
    if (method === "getRegistrationStatus") {
      asked.push(params.account);
      return { registered: params.account === "344022_a" ? "no" : "yes" };
    }
    throw new Error("unexpected " + method);
  };
  const st = await fetchTrunkState({ username: "u", password: "p" }, fake as any);
  assert.deepEqual(asked, ["344022_a"]);
  assert.equal(st.master, "344022");
  assert.equal(st.rowsByName.get("344022_b"), 2);
  assert.equal(st.registration.get("344022_a"), "no");
});

// ── the runner against a fake db ────────────────────────────────────────────

function fakeDb(seedSweeps: any[] = []) {
  const escalations: any[] = [];
  const audits: any[] = [...seedSweeps];
  const database = {
    agentEscalation: {
      findFirst: async ({ where }: any) => {
        const key = where.requestSummary.startsWith;
        const since = where.createdAt.gte as Date;
        return escalations.find((e) => e.requestSummary.startsWith(key) && e.createdAt >= since) || null;
      },
      create: async ({ data }: any) => {
        assert.equal(data.status, "QUEUED");
        assert.notEqual(data.smsBody, "");
        const row = { id: "esc" + escalations.length, createdAt: new Date(), ...data };
        escalations.push(row);
        return row;
      },
    },
    agentAuditLog: {
      findFirst: async ({ where }: any) => {
        const rows = audits.filter((a) => a.event === where.event).sort((a, b) => b.ts - a.ts);
        return rows[0] || null;
      },
      create: async ({ data }: any) => {
        // Prisma refuses the write without actor + hash — the exact shape that
        // once left another guardrail blind while it logged ARMED.
        assert.ok(data.actor, "actor is required");
        assert.ok(data.hash, "hash is required");
        const row = { ts: Date.now() + audits.length, ...data };
        audits.push(row);
        return row;
      },
    },
    pbxTenantInboundDid: { findMany: async () => [{ e164: "6469846023", pbxTenantCode: "T105" }] },
    tenantPbxLink: { findMany: async () => [{ pbxTenantCode: "T105", tenant: { name: "inii mini", pbxRemovedAt: null } }] },
  };
  return { database, escalations, audits };
}

test("first sweep records state and alarms nothing; the second sweep with the same fault texts the owner once", async () => {
  const { database, escalations, audits } = fakeDb();
  const r1 = await runVoipmsTrunkSweep({ database, fetch: async () => state(), windowMs: 6 * 3600e3 });
  assert.equal(r1.ran, true);
  assert.equal(r1.alerted, false);
  assert.equal(audits.filter((a) => a.event === SWEEP_EVENT).length, 1);
  assert.deepEqual(audits[0].payload.unregisteredNow, ["344022_iniimi92gh2m"]);
  assert.equal(audits[0].payload.firstSweep, true);

  const r2 = await runVoipmsTrunkSweep({ database, fetch: async () => state(), windowMs: 6 * 3600e3 });
  assert.equal(r2.alerted, true);
  assert.equal(escalations.length, 1);
  assert.match(escalations[0].requestSummary, new RegExp("^" + UNREGISTERED_ALARM_KEY));
  assert.match(escalations[0].smsBody, /646-984-6023 \(inii mini\)/);
  assert.equal(escalations[0].tenantName, "Loopcom platform");

  const r3 = await runVoipmsTrunkSweep({ database, fetch: async () => state(), windowMs: 6 * 3600e3 });
  assert.equal(r3.offenders, 1);
  assert.equal(r3.alerted, false, "inside the window it must not text again");
  assert.equal(escalations.length, 1);
  assert.equal(audits.filter((a) => a.event === SWEEP_EVENT).length, 3, "every run writes its audit row");
});

test("a trunk that recovers between sweeps never alarms", async () => {
  const { database, escalations } = fakeDb();
  await runVoipmsTrunkSweep({ database, fetch: async () => state() });
  await runVoipmsTrunkSweep({
    database,
    fetch: async () => state({ registration: new Map([["344022_iniimi92gh2m", "yes"], ["344022_Hannaeneh5c", "yes"]]) }),
  });
  assert.equal(escalations.length, 0);
});

test("duplicate rows alarm on the very first sweep under their own key", async () => {
  const { database, escalations } = fakeDb();
  const r = await runVoipmsTrunkSweep({
    database,
    fetch: async () =>
      state({
        rowsByName: new Map([["344022_Matamih8gmrh", 3]]),
        registration: new Map([["344022_iniimi92gh2m", "yes"], ["344022_Hannaeneh5c", "yes"]]),
      }),
  });
  assert.equal(r.duplicates, 1);
  assert.equal(escalations.length, 1);
  assert.match(escalations[0].requestSummary, new RegExp("^" + DUPLICATE_ALARM_KEY));
});

test("the window re-arms: an escalation older than the window does not suppress a new one", async () => {
  const { database, escalations } = fakeDb();
  escalations.push({
    id: "old",
    requestSummary: UNREGISTERED_ALARM_KEY + " — old",
    createdAt: new Date(Date.now() - 7 * 3600e3),
  });
  const raised = await raiseTrunkEscalation(
    UNREGISTERED_ALARM_KEY,
    { summary: UNREGISTERED_ALARM_KEY + " — x", sms: "x", report: "x" },
    { windowMs: 6 * 3600e3, database },
  );
  assert.equal(raised, true);
});

test("a provider outage fails the sweep loudly and writes nothing", async () => {
  const { database, escalations, audits } = fakeDb();
  const warned: string[] = [];
  const r = await runVoipmsTrunkSweep({
    database,
    log: { warn: (_o, m) => warned.push(String(m)) },
    fetch: async () => {
      throw new Error("provider_unreachable");
    },
  });
  assert.equal(r.ran, false);
  assert.equal(escalations.length, 0);
  assert.equal(audits.length, 0);
  assert.ok(warned.some((m) => /sweep FAILED/.test(m)));
});

// ── the caller: server.ts must actually arm it ──────────────────────────────

test("server.ts arms the guardrail at boot (a guard nobody calls is decoration)", () => {
  const src = readFileSync(join(__dirname, "..", "server.ts"), "utf8").replace(/\r\n/g, "\n");
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.ok(/import \{ startVoipmsTrunkGuardrail \} from "\.\/onboarding\/voipMsTrunkGuardrail";/.test(code));
  assert.ok(/startVoipmsTrunkGuardrail\(app\.log\);/.test(code));
});

test("escalations never ride ADMIN_ALERT and the module never grows its own sender", () => {
  const src = readFileSync(join(__dirname, "voipMsTrunkGuardrail.ts"), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  assert.ok(!/["'`]ADMIN_ALERT["'`]/.test(code), "the muted email type must never be used as an alarm channel");
  assert.ok(!/emailJob\.create/.test(code));
  assert.ok(!/resolveBillingSmsSender|sendSms\(/.test(code));
});
