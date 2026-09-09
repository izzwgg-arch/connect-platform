import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AUTOPAY_BLOCK_ALARM_PREFIX,
  autopayBlockAlarmKey,
  buildAutopayBlockAlarmText,
  decideAutopayBlockAlarm,
  raiseAutopayBlockAlarm,
  sameCompany,
} from "./autopayBlockAlarm";

const base = {
  tenantId: "t-secro",
  tenantName: "Secro Selutions",
  phase: "charge" as const,
  linkId: "link-1",
  solaScheduleId: "c1_s1",
  linkCompanyName: "fix up usa",
  paymentDate: "2026-09-06",
};

test("decide: first alarm raises, inside the window holds, after the window raises again", () => {
  const now = new Date("2026-09-06T05:00:00Z");
  assert.equal(decideAutopayBlockAlarm({ now, recentCreatedAt: null }).raise, true);
  assert.equal(decideAutopayBlockAlarm({ now, recentCreatedAt: new Date("2026-09-06T04:00:00Z") }).raise, false);
  assert.equal(decideAutopayBlockAlarm({ now, recentCreatedAt: new Date("2026-09-04T04:00:00Z") }).raise, true);
  assert.equal(
    decideAutopayBlockAlarm({ now, recentCreatedAt: new Date("2026-09-07T04:00:00Z") }).raise,
    false,
    "a future-dated row must not suppress forever",
  );
});

test("text names the tenant, the link, the Sola label, and calls out a mis-map", () => {
  const t = buildAutopayBlockAlarmText(base);
  assert.ok(t.summary.startsWith(autopayBlockAlarmKey(base)));
  assert.ok(t.sms.includes("Secro Selutions"));
  assert.ok(t.sms.includes("NOT charged"));
  assert.ok(t.sms.includes("c1_s1"));
  assert.ok(t.sms.includes("fix up usa"));
  assert.ok(t.report.includes("wrong company"));
  const own = buildAutopayBlockAlarmText({ ...base, linkCompanyName: "Secro solutions" });
  assert.ok(!own.report.includes("wrong company"));
  const reminder = buildAutopayBlockAlarmText({ ...base, phase: "reminder" });
  assert.ok(reminder.sms.includes("NOT invoiced"));
  assert.ok(t.sms.length < 480);
});

test("raise: one escalation inside the window, keyed on tenant + link, QUEUED with a proposedFix column", async () => {
  const rows: any[] = [];
  const fake = {
    agentEscalation: {
      findFirst: async ({ where }: any) =>
        rows
          .filter((r) => r.requestSummary.startsWith(where.requestSummary.startsWith))
          .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
      create: async ({ data }: any) => {
        rows.push({ ...data, createdAt: new Date("2026-09-06T04:00:00Z") });
        return { id: String(rows.length) };
      },
    },
  };
  const a = await raiseAutopayBlockAlarm(fake, base, { now: new Date("2026-09-06T04:00:00Z") });
  const b = await raiseAutopayBlockAlarm(fake, base, { now: new Date("2026-09-06T09:00:00Z") });
  const c = await raiseAutopayBlockAlarm(fake, { ...base, linkId: "link-2" }, { now: new Date("2026-09-06T09:00:00Z") });
  assert.deepEqual([a.raised, b.raised, c.raised], [true, false, true]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, "QUEUED");
  assert.equal(rows[0].proposedFix, "");
  assert.equal(rows[0].tenantName, "Loopcom platform");
  assert.equal(rows[0].userName, "autopay block guardrail");
});

test("sameCompany tolerates a typo but not a different company", () => {
  assert.equal(sameCompany("Secro solutions", "Secro Selutions"), true);
  assert.equal(sameCompany("displaydex corp.", "Displaydex"), true);
  assert.equal(sameCompany("fix up usa", "Secro Selutions"), false);
  assert.equal(sameCompany("Nexus Realty", "Displaydex"), false);
});

test("raise never throws when the database fails", async () => {
  const fake = {
    agentEscalation: {
      findFirst: async () => {
        throw new Error("boom");
      },
      create: async () => {
        throw new Error("boom");
      },
    },
  };
  const r = await raiseAutopayBlockAlarm(fake, base, {});
  assert.deepEqual(r, { raised: false, reason: "error" });
});

test("source guard: BOTH worker phases alarm on the active-Sola block, and the reminder skip logs an event", () => {
  const src = readFileSync(path.join(__dirname, "main.ts"), "utf8").replace(/\r\n/g, "\n");
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const reminder = code.slice(
    code.indexOf("async function runAutopayReminderPhase("),
    code.indexOf("async function reportMissedChargeWindow("),
  );
  assert.ok(reminder.includes('type: "billing.autopay_reminder_skipped_active_sola_schedule"'), "reminder-phase skip must log an event");
  assert.ok(reminder.includes("raiseAutopayBlockAlarm(") && reminder.includes('phase: "reminder"'), "reminder-phase skip must escalate");
  const chargeIdx = code.indexOf('type: "billing.autopay_skipped_active_sola_schedule"');
  assert.ok(chargeIdx > 0, "charge-phase skip event must still exist");
  const charge = code.slice(chargeIdx, chargeIdx + 3000);
  assert.ok(charge.includes("raiseAutopayBlockAlarm(") && charge.includes('phase: "charge"'), "charge-phase skip must escalate");
  const alarmSrc = readFileSync(path.join(__dirname, "autopayBlockAlarm.ts"), "utf8");
  assert.ok(!alarmSrc.includes('"ADMIN_ALERT"'), "the alarm must never ride ADMIN_ALERT");
  assert.ok(AUTOPAY_BLOCK_ALARM_PREFIX.length > 10);
});
