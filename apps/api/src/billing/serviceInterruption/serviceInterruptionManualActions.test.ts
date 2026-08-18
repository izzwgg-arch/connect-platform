import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  SERVICE_INTERRUPTION_AUDIT,
  decideManualForce,
  decideManualRestore,
} from "./serviceInterruptionManualActions";
import { writeServiceInterruption } from "./serviceInterruptionSettings";

const cutOff = (extra: Record<string, unknown> = {}) =>
  writeServiceInterruption({}, {
    interruptedAt: "2026-08-24T14:00:00Z",
    disabledArsMembers: [{ arsId: "214", outboundRouteId: "125" }],
    ...extra,
  });

// ─── Restore: hard to refuse ─────────────────────────────────────────────────

test("restoring a switched-off customer returns exactly what to put back", () => {
  const d = decideManualRestore(cutOff());
  assert.equal(d.ok, true);
  assert.deepEqual((d as any).membersToEnable, [{ arsId: "214", outboundRouteId: "125" }]);
});

test("restore works even when the feature has since been switched off", () => {
  // Otherwise turning the switch off would make the restore button refuse.
  assert.equal(decideManualRestore(cutOff({ enabled: false })).ok, true);
});

test("restore works even with no unpaid invoice recorded", () => {
  assert.equal(decideManualRestore(cutOff({ invoiceId: null })).ok, true);
});

test("restoring someone who is already on is refused, but harmlessly", () => {
  const d = decideManualRestore(writeServiceInterruption({}, { enabled: true }));
  assert.equal(d.ok, false);
  assert.match((d as any).reason, /not switched off/);
});

test("⛔ interrupted with nothing recorded is refused rather than faked", () => {
  // Reporting a successful restore that puts nothing back is worse than
  // refusing: the customer stays off and the system believes they are on.
  const d = decideManualRestore(writeServiceInterruption({}, { interruptedAt: "2026-08-24T14:00:00Z" }));
  assert.equal(d.ok, false);
  assert.match((d as any).reason, /by hand/);
});

// ─── Force: the dangerous one ────────────────────────────────────────────────

test("forcing requires a written reason", () => {
  const meta = writeServiceInterruption({}, { enabled: true });
  assert.equal(decideManualForce(meta, { reason: "" }).ok, false);
  assert.equal(decideManualForce(meta, { reason: "  " }).ok, false);
  assert.equal(decideManualForce(meta, { reason: "nope" }).ok, false, "too short to mean anything");
  assert.equal(decideManualForce(meta, { reason: "cheque bounced twice" }).ok, true);
});

test("forcing an already-off customer is refused", () => {
  const d = decideManualForce(cutOff(), { reason: "cheque bounced twice" });
  assert.equal(d.ok, false);
  assert.match((d as any).reason, /already switched off/);
});

test("the two actions are not symmetrical — restore needs no reason", () => {
  assert.equal(decideManualRestore(cutOff()).ok, true);
  assert.equal(decideManualForce(writeServiceInterruption({}, {}), { reason: "" }).ok, false);
});

// ─── Audit ───────────────────────────────────────────────────────────────────

test("both manual paths have distinct audit actions", () => {
  const names = Object.values(SERVICE_INTERRUPTION_AUDIT);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.match(n, /^SERVICE_INTERRUPTION_/);
});
