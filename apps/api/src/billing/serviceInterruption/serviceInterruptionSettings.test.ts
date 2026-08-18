import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  clearCountdown,
  isInterrupted,
  readServiceInterruption,
  startCountdown,
  writeServiceInterruption,
} from "./serviceInterruptionSettings";

const FAILED = new Date("2026-08-17T14:00:00Z");

// ─── Off is the default, and absent means off ────────────────────────────────

test("a tenant with no metadata at all is switched off", () => {
  for (const meta of [null, undefined, {}, "nonsense", 42, []]) {
    assert.equal(readServiceInterruption(meta).enabled, false, String(meta));
  }
});

test("only a real boolean true switches a customer on", () => {
  // A truthy string must never cut off a paying customer's phones.
  for (const bad of ["true", "false", 1, "yes", {}]) {
    assert.equal(readServiceInterruption({ serviceInterruption: { enabled: bad } }).enabled, false, String(bad));
  }
  assert.equal(readServiceInterruption({ serviceInterruption: { enabled: true } }).enabled, true);
});

test("grace days are clamped, and absent means use the default", () => {
  const read = (v: unknown) => readServiceInterruption({ serviceInterruption: { graceDays: v } }).graceDays;
  assert.equal(read(undefined), null);
  assert.equal(read("nonsense"), null);
  assert.equal(read(14), 14);
  assert.equal(read(0), 1, "never zero — that would cut off the same day");
  assert.equal(read(9999), 60);
});

test("corrupt dates read as absent rather than throwing", () => {
  const s = readServiceInterruption({ serviceInterruption: { countdownStartedAt: "not-a-date", interruptedAt: "" } });
  assert.equal(s.countdownStartedAt, null);
  assert.equal(s.interruptedAt, null);
});

// ─── Writing ─────────────────────────────────────────────────────────────────

test("writing preserves every other metadata key", () => {
  const before = { collections: { dunningEnabled: true }, billingTelecomFees: { e911: 300 } };
  const after = writeServiceInterruption(before, { enabled: true });
  assert.deepEqual((after as any).collections, { dunningEnabled: true });
  assert.deepEqual((after as any).billingTelecomFees, { e911: 300 });
  assert.equal(readServiceInterruption(after).enabled, true);
});

// ─── The countdown ───────────────────────────────────────────────────────────

test("starting the countdown records the first failure", () => {
  const meta = startCountdown({}, { invoiceId: "inv_1", failedAt: FAILED });
  const s = readServiceInterruption(meta);
  assert.equal(s.countdownStartedAt, FAILED.toISOString());
  assert.equal(s.invoiceId, "inv_1");
  assert.equal(s.interruptedAt, null);
});

test("a retry on the SAME invoice does not restart the clock", () => {
  const first = startCountdown({}, { invoiceId: "inv_1", failedAt: FAILED });
  const retryAt = new Date(FAILED.getTime() + 3 * 24 * 3600 * 1000);
  const second = startCountdown(first, { invoiceId: "inv_1", failedAt: retryAt });
  assert.equal(
    readServiceInterruption(second).countdownStartedAt,
    FAILED.toISOString(),
    "autopay retries must not push the cutoff back forever",
  );
});

test("a different invoice does start a new clock", () => {
  const first = startCountdown({}, { invoiceId: "inv_1", failedAt: FAILED });
  const later = new Date(FAILED.getTime() + 40 * 24 * 3600 * 1000);
  const second = startCountdown(first, { invoiceId: "inv_2", failedAt: later });
  assert.equal(readServiceInterruption(second).countdownStartedAt, later.toISOString());
  assert.equal(readServiceInterruption(second).invoiceId, "inv_2");
});

test("the countdown restarts after a restore, even on the same invoice", () => {
  let meta: unknown = startCountdown({}, { invoiceId: "inv_1", failedAt: FAILED });
  meta = clearCountdown(meta, new Date("2026-08-20T00:00:00Z"));
  const again = new Date("2026-09-01T00:00:00Z");
  meta = startCountdown(meta, { invoiceId: "inv_1", failedAt: again });
  assert.equal(readServiceInterruption(meta).countdownStartedAt, again.toISOString());
});

// ─── Interruption state ──────────────────────────────────────────────────────

test("isInterrupted is true only between the cutoff and the restore", () => {
  assert.equal(isInterrupted({}), false);
  const cut = writeServiceInterruption({}, { interruptedAt: "2026-08-24T14:00:00Z" });
  assert.equal(isInterrupted(cut), true);
  const back = writeServiceInterruption(cut, { restoredAt: "2026-08-25T16:00:00Z" });
  assert.equal(isInterrupted(back), false);
});

test("clearing wipes the disabled-member record so a later restore cannot replay it", () => {
  let meta: unknown = writeServiceInterruption({}, {
    interruptedAt: "2026-08-24T14:00:00Z",
    disabledArsMembers: [{ arsId: "50", outboundRouteId: "101" }],
  });
  assert.equal(readServiceInterruption(meta).disabledArsMembers.length, 1);
  meta = clearCountdown(meta, new Date("2026-08-25T16:00:00Z"));
  assert.deepEqual(readServiceInterruption(meta).disabledArsMembers, []);
  assert.equal(readServiceInterruption(meta).interruptedAt, null);
});

test("malformed disabled-member rows are dropped, not half-read", () => {
  const s = readServiceInterruption({
    serviceInterruption: {
      disabledArsMembers: [{ arsId: "50", outboundRouteId: "101" }, { arsId: "" }, null, "x", { outboundRouteId: "9" }],
    },
  });
  assert.deepEqual(s.disabledArsMembers, [{ arsId: "50", outboundRouteId: "101" }]);
});
