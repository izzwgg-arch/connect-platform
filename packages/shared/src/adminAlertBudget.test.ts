import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideAdminAlert,
  ADMIN_ALERT_DAILY_CAP,
  ADMIN_ALERT_DEFAULT_COOLDOWN_MS,
} from "./adminAlertBudget";

const NOW = 1_785_990_000_000;

test("a first-ever alert sends", () => {
  assert.deepEqual(
    decideAdminAlert({ now: NOW, lastSentAtMs: null, sentLast24h: 0 }),
    { send: true },
  );
});

test("the same alert is held back inside its cooldown", () => {
  const d = decideAdminAlert({
    now: NOW,
    lastSentAtMs: NOW - 60_000,
    cooldownMs: 3600_000,
    sentLast24h: 1,
  });
  assert.deepEqual(d, { send: false, reason: "cooldown" });
});

test("the same alert sends again once the cooldown has passed", () => {
  const d = decideAdminAlert({
    now: NOW,
    lastSentAtMs: NOW - 3600_001,
    cooldownMs: 3600_000,
    sentLast24h: 1,
  });
  assert.deepEqual(d, { send: true });
});

// This is the regression that mattered: the old cooldown lived in memory, so a
// restart presented every alert as never-sent and it went out again. A caller
// reading the last send from the database now suppresses it.
test("a restart does not re-arm an alert — a durable last-send still suppresses", () => {
  const justSentBeforeTheRestart = NOW - 5 * 60_000;
  const d = decideAdminAlert({
    now: NOW,
    lastSentAtMs: justSentBeforeTheRestart,
    cooldownMs: ADMIN_ALERT_DEFAULT_COOLDOWN_MS,
    sentLast24h: 3,
  });
  assert.deepEqual(d, { send: false, reason: "cooldown" });
});

test("the daily cap stops alerts whose text keeps changing", () => {
  // Each of these has a different identity, so the cooldown never bites.
  const d = decideAdminAlert({
    now: NOW,
    lastSentAtMs: null,
    sentLast24h: ADMIN_ALERT_DAILY_CAP,
    });
  assert.deepEqual(d, { send: false, reason: "daily_cap" });
});

test("the cap is checked before the cooldown, so a flood of new alerts cannot slip past", () => {
  const d = decideAdminAlert({
    now: NOW,
    lastSentAtMs: null,
    cooldownMs: 0,
    sentLast24h: ADMIN_ALERT_DAILY_CAP + 500,
  });
  assert.deepEqual(d, { send: false, reason: "daily_cap" });
});

test("one below the cap still sends", () => {
  assert.deepEqual(
    decideAdminAlert({ now: NOW, lastSentAtMs: null, sentLast24h: ADMIN_ALERT_DAILY_CAP - 1 }),
    { send: true },
  );
});

test("the cap is far below a mailbox's daily allowance, leaving room for customer mail", () => {
  assert.ok(ADMIN_ALERT_DAILY_CAP <= 100, "alerts must never be able to crowd out invoices and voicemail email");
});

// api and worker are separate processes with separate clocks. A stamp from the
// future must suppress rather than send — they share one mailbox budget.
test("a last-send stamp in the future suppresses", () => {
  const d = decideAdminAlert({
    now: NOW,
    lastSentAtMs: NOW + 60_000,
    cooldownMs: 3600_000,
    sentLast24h: 2,
  });
  assert.deepEqual(d, { send: false, reason: "cooldown" });
});

test("a zero cooldown still honours the cap", () => {
  assert.deepEqual(
    decideAdminAlert({ now: NOW, lastSentAtMs: NOW, cooldownMs: 0, sentLast24h: 0 }),
    { send: true },
  );
});

test("an explicit cap of zero silences alerts entirely", () => {
  assert.deepEqual(
    decideAdminAlert({ now: NOW, lastSentAtMs: null, sentLast24h: 0, dailyCap: 0 }),
    { send: false, reason: "daily_cap" },
  );
});

test("a day of the real 2026-08-06 traffic is bounded by the cap", () => {
  let sent = 0;
  // 451 alerts arrived that day under ~12 distinct subjects, with the process
  // restarting throughout. Replay them against a durable last-send stamp.
  const lastSentBySubject = new Map<string, number>();
  for (let i = 0; i < 451; i++) {
    const subject = `alert-${i % 12}`;
    const now = NOW + i * 2 * 60_000; // roughly one alert every two minutes
    const d = decideAdminAlert({
      now,
      lastSentAtMs: lastSentBySubject.get(subject) ?? null,
      cooldownMs: ADMIN_ALERT_DEFAULT_COOLDOWN_MS,
      sentLast24h: sent,
    });
    if (d.send) {
      sent++;
      lastSentBySubject.set(subject, now);
    }
  }
  assert.ok(sent <= ADMIN_ALERT_DAILY_CAP, `expected at most ${ADMIN_ALERT_DAILY_CAP}, got ${sent}`);
  assert.ok(sent < 60, `451 alerts should collapse to a readable handful, got ${sent}`);
});
