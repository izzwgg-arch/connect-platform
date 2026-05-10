/**
 * Ensures worker build wires the shared fair-scheduler (worker voicemail sync depends on it).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { interleaveVoicemailHelperSlots, selectDistinctFairHelperPicks } from "@connect/shared";

test("worker can run fair helper pick selection (shared module)", () => {
  type S = { tenantId: string; extNumber: string; tag: string };
  const m = new Map<string, S[]>();
  m.set("t_a", [
    { tenantId: "t_a", extNumber: "2", tag: "a2" },
    { tenantId: "t_a", extNumber: "10", tag: "a10" },
  ]);
  m.set("t_b", [{ tenantId: "t_b", extNumber: "1", tag: "b1" }]);
  const interleaved = interleaveVoicemailHelperSlots(m);
  const { picks } = selectDistinctFairHelperPicks(interleaved, 2, 0, (x) => `${x.tenantId}:${x.extNumber}`);
  assert.equal(picks.length, 2);
});
