import { strict as assert } from "node:assert";
import { test } from "node:test";

import { decideForTenant } from "./serviceInterruptionSweep";
import { startCountdown, writeServiceInterruption } from "./serviceInterruptionSettings";

const DAY = 24 * 3600 * 1000;
const FAILED = new Date("2026-08-17T14:00:00Z");
const invoice = { id: "inv_1", firstFailedAt: FAILED, balanceDueCents: 14000 };
const on = (extra: Record<string, unknown> = {}) => writeServiceInterruption({}, { enabled: true, ...extra });

// ─── The switch ──────────────────────────────────────────────────────────────

test("a tenant with the switch off is never touched", () => {
  const d = decideForTenant({ metadata: {}, openFailedInvoice: invoice, now: new Date(FAILED.getTime() + 30 * DAY) });
  assert.equal(d.action, "none");
  assert.match((d as any).reason, /switched off/);
});

test("a tenant with nothing owed is left alone", () => {
  const d = decideForTenant({ metadata: on(), openFailedInvoice: null, now: FAILED });
  assert.equal(d.action, "none");
});

// ─── The countdown ───────────────────────────────────────────────────────────

test("the first failure starts the clock", () => {
  const d = decideForTenant({ metadata: on(), openFailedInvoice: invoice, now: FAILED });
  assert.equal(d.action, "start_countdown");
  assert.equal((d as any).failedAt.toISOString(), FAILED.toISOString());
});

test("a new invoice starts a new clock", () => {
  const meta = startCountdown(on(), { invoiceId: "inv_1", failedAt: FAILED });
  const d = decideForTenant({
    metadata: meta,
    openFailedInvoice: { id: "inv_2", firstFailedAt: new Date(FAILED.getTime() + 40 * DAY), balanceDueCents: 9000 },
    now: new Date(FAILED.getTime() + 40 * DAY),
  });
  assert.equal(d.action, "start_countdown");
  assert.equal((d as any).invoiceId, "inv_2");
});

// ─── Reminders ───────────────────────────────────────────────────────────────

test("the countdown sends 7 down to 1, once each, and never repeats", () => {
  let meta: unknown = startCountdown(on(), { invoiceId: "inv_1", failedAt: FAILED });
  const sent: number[] = [];
  for (let day = 0; day < 7; day++) {
    const now = new Date(FAILED.getTime() + day * DAY);
    // Two sweeps the same day — the second must decide nothing.
    const first = decideForTenant({ metadata: meta, openFailedInvoice: invoice, now });
    assert.equal(first.action, "send_reminder", `day ${day}`);
    sent.push((first as any).daysLeft);
    meta = writeServiceInterruption(meta, { lastReminderDaysLeft: (first as any).daysLeft, lastReminderAt: now.toISOString() });

    const second = decideForTenant({ metadata: meta, openFailedInvoice: invoice, now });
    assert.equal(second.action, "none", `day ${day} second sweep`);
  }
  assert.deepEqual(sent, [7, 6, 5, 4, 3, 2, 1]);
});

test("a sweep that runs late still sends the right number, not a stale one", () => {
  let meta: unknown = startCountdown(on(), { invoiceId: "inv_1", failedAt: FAILED });
  meta = writeServiceInterruption(meta, { lastReminderDaysLeft: 7 });
  // The worker was down for two days; the next sweep says 4, not 6.
  const d = decideForTenant({ metadata: meta, openFailedInvoice: invoice, now: new Date(FAILED.getTime() + 3 * DAY) });
  assert.equal((d as any).daysLeft, 4);
});

// ─── Cutoff ──────────────────────────────────────────────────────────────────

test("on day seven the service is interrupted", () => {
  const meta = startCountdown(on(), { invoiceId: "inv_1", failedAt: FAILED });
  const d = decideForTenant({ metadata: meta, openFailedInvoice: invoice, now: new Date(FAILED.getTime() + 7 * DAY) });
  assert.equal(d.action, "interrupt");
});

test("an already-interrupted tenant is not interrupted twice", () => {
  let meta: unknown = startCountdown(on(), { invoiceId: "inv_1", failedAt: FAILED });
  meta = writeServiceInterruption(meta, { interruptedAt: new Date(FAILED.getTime() + 7 * DAY).toISOString() });
  const d = decideForTenant({ metadata: meta, openFailedInvoice: invoice, now: new Date(FAILED.getTime() + 9 * DAY) });
  assert.equal(d.action, "none");
  assert.match((d as any).reason, /already interrupted/);
});

test("a longer grace period is honoured", () => {
  const meta = startCountdown(writeServiceInterruption({}, { enabled: true, graceDays: 14 }), {
    invoiceId: "inv_1",
    failedAt: FAILED,
  });
  const atSeven = decideForTenant({ metadata: meta, openFailedInvoice: invoice, now: new Date(FAILED.getTime() + 7 * DAY) });
  assert.equal(atSeven.action, "send_reminder");
  assert.equal((atSeven as any).daysLeft, 7);
  const atFourteen = decideForTenant({ metadata: meta, openFailedInvoice: invoice, now: new Date(FAILED.getTime() + 14 * DAY) });
  assert.equal(atFourteen.action, "interrupt");
});

// ─── Restore ─────────────────────────────────────────────────────────────────

test("paying restores service", () => {
  let meta: unknown = startCountdown(on(), { invoiceId: "inv_1", failedAt: FAILED });
  meta = writeServiceInterruption(meta, { interruptedAt: new Date(FAILED.getTime() + 7 * DAY).toISOString() });
  const d = decideForTenant({ metadata: meta, openFailedInvoice: null, now: new Date(FAILED.getTime() + 8 * DAY) });
  assert.equal(d.action, "restore");
});

test("⛔ switching the FEATURE off must still restore someone already cut off", () => {
  // Otherwise turning the switch off strands a customer with no phones.
  let meta: unknown = startCountdown(on(), { invoiceId: "inv_1", failedAt: FAILED });
  meta = writeServiceInterruption(meta, {
    interruptedAt: new Date(FAILED.getTime() + 7 * DAY).toISOString(),
    enabled: false,
  });
  const d = decideForTenant({ metadata: meta, openFailedInvoice: null, now: new Date(FAILED.getTime() + 8 * DAY) });
  assert.equal(d.action, "restore");
});

test("restore is decided before anything else", () => {
  // Paid, but the clock is still running and the switch is on — restore wins.
  let meta: unknown = startCountdown(on(), { invoiceId: "inv_1", failedAt: FAILED });
  meta = writeServiceInterruption(meta, { interruptedAt: new Date(FAILED.getTime() + 7 * DAY).toISOString() });
  const d = decideForTenant({ metadata: meta, openFailedInvoice: null, now: new Date(FAILED.getTime() + 7 * DAY) });
  assert.equal(d.action, "restore");
});
