// Tests for the regulatory compliance calendar (2026-08-23).
//
// The cadence tests pin Izzy's exact ask ("a month and then once a week after
// that, before things are due" — and weekly past due until completed). The
// source guards pin the wiring, because every defect of this shape in this
// repo has been a missed caller: an unwired sweep, a missing permission-rule
// prefix, or an email type that the send door silently drops.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  COMPLIANCE_REMINDER_EMAIL_TYPE,
  COMPLIANCE_SEED_ITEMS,
  REMINDER_LEAD_DAYS,
  buildComplianceReminderSms,
  complianceDate,
  daysUntil,
  decideComplianceReminder,
  ensureComplianceSeed,
  rollDueDateForwardOneYear,
  runComplianceReminderSweep,
} from "./complianceCalendar";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const DAY = 24 * 60 * 60 * 1000;
const due = new Date("2027-03-01T12:00:00Z");
const at = (daysBefore: number) => new Date(due.getTime() - daysBefore * DAY);

// ── The cadence ──────────────────────────────────────────────────────────────

test("no reminder more than 30 days out", () => {
  assert.equal(decideComplianceReminder({ dueDate: due, completedAt: null, lastReminderAt: null }, at(31)), false);
  assert.equal(decideComplianceReminder({ dueDate: due, completedAt: null, lastReminderAt: null }, at(45)), false);
});

test("the first reminder fires at 30 days", () => {
  assert.equal(decideComplianceReminder({ dueDate: due, completedAt: null, lastReminderAt: null }, at(30)), true);
});

test("after a reminder, nothing for ~a week, then it fires again", () => {
  const first = at(30);
  assert.equal(decideComplianceReminder({ dueDate: due, completedAt: null, lastReminderAt: first }, at(26)), false, "4 days later is too soon");
  assert.equal(decideComplianceReminder({ dueDate: due, completedAt: null, lastReminderAt: first }, at(23)), true, "7 days later fires");
});

test("an OVERDUE item keeps reminding weekly until completed", () => {
  const lastWeek = new Date(due.getTime() + 3 * DAY);
  const now = new Date(due.getTime() + 10 * DAY);
  assert.equal(decideComplianceReminder({ dueDate: due, completedAt: null, lastReminderAt: lastWeek }, now), true);
});

test("a completed item never reminds, even overdue", () => {
  const now = new Date(due.getTime() + 10 * DAY);
  assert.equal(decideComplianceReminder({ dueDate: due, completedAt: new Date(), lastReminderAt: null }, now), false);
});

// ── Dates ────────────────────────────────────────────────────────────────────

test("complianceDate refuses garbage and impossible days", () => {
  assert.equal(complianceDate("2027-02-30"), null);
  assert.equal(complianceDate("not-a-date"), null);
  assert.equal(complianceDate("2027-3-1"), null);
  assert.equal(complianceDate("2027-03-01")?.toISOString(), "2027-03-01T12:00:00.000Z");
});

test("yearly roll-forward keeps the month/day; Feb 29 lands on Feb 28", () => {
  assert.equal(rollDueDateForwardOneYear(new Date("2027-03-01T12:00:00Z")).toISOString().slice(0, 10), "2028-03-01");
  assert.equal(rollDueDateForwardOneYear(new Date("2028-02-29T12:00:00Z")).toISOString().slice(0, 10), "2029-02-28");
});

test("daysUntil counts calendar distance", () => {
  assert.equal(daysUntil(due, at(30)), 30);
  assert.equal(daysUntil(due, new Date(due.getTime() + 2 * DAY)), -2);
});

// ── The SMS body ─────────────────────────────────────────────────────────────

test("every SMS shape is plain ASCII — one curly quote flips the message to UCS-2", () => {
  for (const now of [at(30), at(1), at(0), new Date(due.getTime() + 5 * DAY)]) {
    const body = buildComplianceReminderSms("FCC Form 499-A annual revenue filing (USAC)", due, now);
    assert.ok(/^[\x20-\x7E]+$/.test(body), `non-ASCII in: ${body}`);
    assert.ok(body.length <= 300, "keep it to two segments at most");
  }
});

// ── Seed ─────────────────────────────────────────────────────────────────────

function fakeDb() {
  const rows: any[] = [];
  let n = 0;
  return {
    rows,
    complianceItem: {
      findUnique: async ({ where }: any) => rows.find((r) => (where.key ? r.key === where.key : r.id === where.id)) || null,
      findMany: async ({ where }: any) => rows.filter((r) => (where?.completedAt === null ? !r.completedAt : true)),
      create: async ({ data }: any) => {
        const row = { id: `c${++n}`, completedAt: null, lastReminderAt: null, reminderCount: 0, details: null, recurrence: null, key: null, ...data };
        rows.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const hits = rows.filter(
          (r) =>
            r.id === where.id &&
            (where.completedAt === null ? !r.completedAt : true) &&
            (where.lastReminderAt === null ? r.lastReminderAt === null : String(r.lastReminderAt) === String(where.lastReminderAt)),
        );
        for (const r of hits) {
          if (data.lastReminderAt) r.lastReminderAt = data.lastReminderAt;
          if (data.reminderCount?.increment) r.reminderCount += data.reminderCount.increment;
        }
        return { count: hits.length };
      },
    },
    emailJobs: [] as any[],
    emailJob: {
      create: async function ({ data }: any) {
        (this as any)._sink.push(data);
        return { id: `e${(this as any)._sink.length}` };
      },
      _sink: [] as any[],
    },
  };
}

test("the seed creates every standing item once and never twice", async () => {
  const dbc: any = fakeDb();
  dbc.emailJob._sink = dbc.emailJobs;
  const first = await ensureComplianceSeed(dbc);
  const second = await ensureComplianceSeed(dbc);
  assert.equal(first, COMPLIANCE_SEED_ITEMS.length);
  assert.equal(second, 0);
  assert.ok(dbc.rows.every((r: any) => r.key && r.title && r.dueDate instanceof Date));
});

test("seed dates are all real calendar days", () => {
  for (const s of COMPLIANCE_SEED_ITEMS) assert.ok(complianceDate(s.dueDate), `${s.key} has a bad date ${s.dueDate}`);
});

// ── The sweep ────────────────────────────────────────────────────────────────

test("the sweep claims the slot, texts, emails, and does not double-send", async () => {
  const dbc: any = fakeDb();
  dbc.emailJob._sink = dbc.emailJobs;
  const now = new Date("2027-02-10T15:00:00Z"); // 19 days before due
  await dbc.complianceItem.create({ data: { key: "t1", title: "Test filing", dueDate: due } });

  const sent: any[] = [];
  const sender = async () =>
    ({ ok: true, fromNumber: "+18457231213", testMode: false, send: async (i: any) => void sent.push(i) }) as any;

  const r1 = await runComplianceReminderSweep(dbc, undefined, now, sender as any);
  assert.equal(r1.reminded, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /Test filing/);
  assert.equal(dbc.emailJobs.length, 1);
  assert.equal(dbc.emailJobs[0].type, COMPLIANCE_REMINDER_EMAIL_TYPE);
  assert.notEqual(dbc.emailJobs[0].type, "ADMIN_ALERT");

  // An hour later: nothing new (the weekly gap governs).
  const r2 = await runComplianceReminderSweep(dbc, undefined, new Date(now.getTime() + 60 * 60 * 1000), sender as any);
  assert.equal(r2.reminded, 0);
  assert.equal(sent.length, 1);

  // A week later: fires again.
  const r3 = await runComplianceReminderSweep(dbc, undefined, new Date(now.getTime() + 7 * DAY), sender as any);
  assert.equal(r3.reminded, 1);
  assert.equal(sent.length, 2);
});

test("an SMS failure never blocks the email (and vice versa the sweep records the error)", async () => {
  const dbc: any = fakeDb();
  dbc.emailJob._sink = dbc.emailJobs;
  await dbc.complianceItem.create({ data: { key: "t2", title: "Test filing 2", dueDate: due } });
  const sender = async () => ({ ok: false, error: "no_credentials", message: "x" }) as any;
  const r = await runComplianceReminderSweep(dbc, undefined, at(10), sender as any);
  assert.equal(r.reminded, 1, "email alone still counts as reminded");
  assert.equal(dbc.emailJobs.length, 1);
  assert.ok(r.errors.some((e) => e.includes("no_credentials")));
});

// ── Source guards ────────────────────────────────────────────────────────────

test("server.ts wires the routes, the sweep, and the permission prefix", () => {
  const server = read(join(__dirname, "server.ts"));
  assert.match(server, /registerComplianceRoutes\(\{ app, db, requireSuper/, "routes must be registered");
  assert.match(server, /startComplianceReminders\(app\.log\)/, "an unwired sweep is a sweep that never runs");
  assert.match(server, /\{ prefix: "\/admin\/compliance", permission: "can_manage_global_settings" \}/, "a prefix with no rule has NO global permission gate");
});

test("the module never queues an ADMIN_ALERT (muted at the send door) and has a boot kick", () => {
  const code = stripComments(read(join(__dirname, "complianceCalendar.ts")));
  assert.doesNotMatch(code, /type:\s*["']ADMIN_ALERT["']/);
  assert.match(code, /setTimeout\(/, "a bare interval with no boot run is starved by deploy churn");
  assert.match(code, /setInterval\(/);
});

test("the model really exists in the schema (the (db as any) transposition trap)", () => {
  const schema = read(join(__dirname, "..", "..", "..", "packages", "db", "prisma", "schema.prisma"));
  assert.match(schema, /model ComplianceItem \{/);
  assert.match(schema, /lastReminderAt DateTime\?/);
});

test("the lead window is the one Izzy asked for", () => {
  assert.equal(REMINDER_LEAD_DAYS, 30);
});
