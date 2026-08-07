import test from "node:test";
import assert from "node:assert/strict";
import { buildBillingSchedule, buildUpcomingBillingSchedule, resolveBillingTimeZone } from "./billingSchedule";

test("worker restart before payment date local midnight is not due", () => {
  const schedule = buildBillingSchedule({
    now: new Date("2026-05-21T03:59:59.000Z"), // May 20 23:59:59 America/New_York
    billingDayOfMonth: 21,
  });

  assert.equal(schedule.timeZone, "America/New_York");
  assert.equal(schedule.paymentDate, "2026-05-21");
  assert.equal(schedule.scheduledChargeAt.toISOString(), "2026-05-21T04:00:00.000Z");
  assert.equal(schedule.due, false);
});

test("worker restart after payment date midnight is due", () => {
  const schedule = buildBillingSchedule({
    now: new Date("2026-05-21T04:00:00.000Z"), // May 21 00:00:00 America/New_York
    billingDayOfMonth: 21,
  });

  assert.equal(schedule.scheduledChargeAt.toISOString(), "2026-05-21T04:00:00.000Z");
  assert.equal(schedule.due, true);
});

test("billing period is payment-date to payment-date, not calendar month", () => {
  const schedule = buildBillingSchedule({
    now: new Date("2026-05-21T12:00:00.000Z"),
    billingDayOfMonth: 21,
  });

  assert.equal(schedule.periodStart.toISOString(), "2026-05-21T04:00:00.000Z");
  assert.equal(schedule.periodEnd.toISOString(), "2026-06-21T03:59:59.999Z");
  assert.notEqual(schedule.periodStart.toISOString(), "2026-05-01T00:00:00.000Z");
});

test("tenant with payment day 21 has local service period 21 through 20", () => {
  const schedule = buildBillingSchedule({
    now: new Date("2026-05-22T12:00:00.000Z"),
    billingDayOfMonth: 21,
  });

  assert.equal(schedule.paymentDate, "2026-05-21");
  assert.equal(schedule.nextPaymentDate, "2026-06-21");
  assert.equal(schedule.periodEnd.toLocaleDateString("en-CA", { timeZone: schedule.timeZone }), "2026-06-20");
});

test("timezone boundary around America/New_York midnight controls eligibility", () => {
  const before = buildBillingSchedule({
    now: new Date("2026-11-21T04:59:59.000Z"), // Nov 20 23:59:59 EST
    billingDayOfMonth: 21,
  });
  const atMidnight = buildBillingSchedule({
    now: new Date("2026-11-21T05:00:00.000Z"), // Nov 21 00:00:00 EST
    billingDayOfMonth: 21,
  });

  assert.equal(before.scheduledChargeAt.toISOString(), "2026-11-21T05:00:00.000Z");
  assert.equal(before.due, false);
  assert.equal(atMidnight.due, true);
});

test("a card is charged ONLY on the payment date — never the day after", () => {
  const beforePaymentDate = buildBillingSchedule({
    now: new Date("2026-05-20T16:00:00.000Z"),
    billingDayOfMonth: 21,
  });
  const dayAfter = buildBillingSchedule({
    now: new Date("2026-05-22T16:00:00.000Z"),
    billingDayOfMonth: 21,
  });

  assert.equal(beforePaymentDate.due, false);
  assert.equal(beforePaymentDate.chargeWindowMissed, false);

  // Previously `due` stayed true for the rest of the month, so a restart on any
  // later day would charge. It must not.
  assert.equal(dayAfter.due, false, "must not charge the day after the payment date");
  assert.equal(dayAfter.chargeWindowMissed, true, "the miss must be visible instead");
  assert.equal(dayAfter.paymentDate, "2026-05-21");
});

test("tenant-specific billing timezone metadata is honored when valid", () => {
  assert.equal(resolveBillingTimeZone({ billingTimeZone: "America/Los_Angeles" }), "America/Los_Angeles");
  assert.equal(resolveBillingTimeZone({ billingTimeZone: "Not/AZone" }), "America/New_York");
});

test("autopay reminder window opens 3 calendar days before payment date local midnight", () => {
  const onReminderDay = buildBillingSchedule({
    now: new Date("2026-05-18T04:00:00.000Z"), // May 18 00:00 America/New_York
    billingDayOfMonth: 21,
  });
  assert.equal(onReminderDay.reminderDate, "2026-05-18");
  assert.equal(onReminderDay.reminderDue, true);
  assert.equal(onReminderDay.due, false);
  assert.equal(onReminderDay.scheduledReminderAt.toISOString(), "2026-05-18T04:00:00.000Z");
  assert.equal(onReminderDay.scheduledChargeAt.toISOString(), "2026-05-21T04:00:00.000Z");
});

test("day before reminder window is not reminderDue", () => {
  const beforeReminder = buildBillingSchedule({
    now: new Date("2026-05-17T23:59:59.000Z"),
    billingDayOfMonth: 21,
  });
  assert.equal(beforeReminder.reminderDue, false);
});

test("payment due date is charge due but not reminderDue", () => {
  const onDueDate = buildBillingSchedule({
    now: new Date("2026-05-21T04:00:00.000Z"),
    billingDayOfMonth: 21,
  });
  assert.equal(onDueDate.due, true);
  assert.equal(onDueDate.reminderDue, false);
});


// ── Regression: the invoice-creation window must open for EVERY billing day ───
// Every test above uses billingDayOfMonth 21, which works. The schema default is
// 1, which did not: buildBillingSchedule anchors the payment date inside the
// current month, so for day 1 the [reminder, charge) window is in the past on
// every day of the year and the T-3 invoice phase never ran. 16 of 30 live
// tenants sat on that default and never auto-generated an invoice.

function daysWindowOpen(billingDayOfMonth: number): number {
  let open = 0;
  for (let d = 0; d < 365; d++) {
    // 09:00 America/New_York on each day of 2026
    const now = new Date(Date.UTC(2026, 0, 1, 14, 0, 0) + d * 86400000);
    if (buildUpcomingBillingSchedule({ now, billingDayOfMonth }).reminderDue) open++;
  }
  return open;
}

test("invoice-creation window opens ~3 days every month for every billing day", () => {
  for (const day of [1, 2, 3, 5, 15, 21, 28]) {
    const open = daysWindowOpen(day);
    assert.ok(
      open >= 33 && open <= 39,
      `billingDayOfMonth=${day}: window opened on ${open}/365 days, expected ~36 (3 per month)`,
    );
  }
});

test("billing day 1: window opens before the 1st, anchored on the UPCOMING charge", () => {
  // Jul 29 2026, 09:00 ET — three days before the Aug 1 charge.
  const now = new Date("2026-07-29T13:00:00.000Z");
  const upcoming = buildUpcomingBillingSchedule({ now, billingDayOfMonth: 1 });

  assert.equal(upcoming.paymentDate, "2026-08-01", "should point at the next charge, not Jul 1");
  assert.equal(upcoming.reminderDate, "2026-07-29");
  assert.equal(upcoming.reminderDue, true, "the T-3 invoice window must be open");
  assert.equal(upcoming.due, false, "the charge itself is not due yet");

  // The invoice created in this window must cover the period the charge pays for.
  assert.equal(upcoming.periodStart.toISOString(), "2026-08-01T04:00:00.000Z");
  assert.equal(upcoming.nextPaymentDate, "2026-09-01");

  // The old builder is what was broken — kept so the regression stays visible.
  const current = buildBillingSchedule({ now, billingDayOfMonth: 1 });
  assert.equal(current.paymentDate, "2026-07-01");
  assert.equal(current.reminderDue, false);
});

test("on the billing day itself the window is closed and the charge is due", () => {
  const now = new Date("2026-08-01T13:00:00.000Z"); // Aug 1, 09:00 ET
  const upcoming = buildUpcomingBillingSchedule({ now, billingDayOfMonth: 1 });
  assert.equal(upcoming.paymentDate, "2026-08-01");
  assert.equal(upcoming.reminderDue, false);
  assert.equal(buildBillingSchedule({ now, billingDayOfMonth: 1 }).due, true);
});

test("upcoming schedule rolls to next month once the billing day has passed", () => {
  const now = new Date("2026-08-02T13:00:00.000Z"); // day after
  const upcoming = buildUpcomingBillingSchedule({ now, billingDayOfMonth: 1 });
  assert.equal(upcoming.paymentDate, "2026-09-01");
  assert.equal(upcoming.reminderDate, "2026-08-29");
});

test("short months clamp: billing day 31 lands on the last day of February", () => {
  const now = new Date("2026-02-25T14:00:00.000Z");
  const upcoming = buildUpcomingBillingSchedule({ now, billingDayOfMonth: 31 });
  assert.equal(upcoming.paymentDate, "2026-02-28");
  assert.equal(upcoming.reminderDue, true);
});


// ── A charge is an event on a date, not a condition true all month ───────────

test("due is true on the payment date and on no other day of the month", () => {
  for (const day of [1, 5, 15, 21, 28]) {
    let dueDays: string[] = [];
    for (let d = 0; d < 365; d++) {
      const now = new Date(Date.UTC(2026, 0, 1, 14, 0, 0) + d * 86400000);
      if (buildBillingSchedule({ now, billingDayOfMonth: day }).due) {
        dueDays.push(now.toISOString().slice(0, 10));
      }
    }
    assert.ok(
      dueDays.length >= 11 && dueDays.length <= 13,
      `billingDayOfMonth=${day}: charge was due on ${dueDays.length} days of the year, expected ~12 (one per month)`,
    );
    for (const iso of dueDays) {
      assert.equal(
        Number(iso.slice(-2)),
        day,
        `billingDayOfMonth=${day}: charge was due on ${iso}, which is not the payment date`,
      );
    }
  }
});

test("due and chargeWindowMissed are never both true", () => {
  for (const day of [1, 14, 28]) {
    for (let d = 0; d < 365; d++) {
      const now = new Date(Date.UTC(2026, 0, 1, 9, 0, 0) + d * 86400000);
      const s = buildBillingSchedule({ now, billingDayOfMonth: day });
      assert.ok(!(s.due && s.chargeWindowMissed), `both true on ${now.toISOString()} (day=${day})`);
    }
  }
});

test("hourly re-runs on the payment date stay due; the next day does not", () => {
  for (let h = 0; h < 24; h++) {
    const now = new Date(Date.UTC(2026, 4, 21, 4 + h, 0, 0)); // May 21 local, hour by hour
    const s = buildBillingSchedule({ now, billingDayOfMonth: 21 });
    if (h < 20) assert.equal(s.due, true, `hour ${h} on the payment date should still be due`);
  }
  const nextDay = buildBillingSchedule({ now: new Date(Date.UTC(2026, 4, 22, 12, 0, 0)), billingDayOfMonth: 21 });
  assert.equal(nextDay.due, false);
});
