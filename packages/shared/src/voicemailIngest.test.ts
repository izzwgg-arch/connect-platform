import test from "node:test";
import assert from "node:assert/strict";
import { vmStablePbxMessageId, vmSplitRingGroupPrefix } from "./voicemailIngest";

test("vmStablePbxMessageId prefers msg_id when present", () => {
  assert.equal(
    vmStablePbxMessageId({
      msgId: "1761219702-000000b2",
      pbxTenantIdOrTenantCuid: "2",
      extNumber: "105",
      origtime: "1700000000",
      callerDigits: "5551234567",
    }),
    "1761219702-000000b2",
  );
});

test("vmStablePbxMessageId composite is deterministic for idempotent upsert", () => {
  const a = vmStablePbxMessageId({
    msgId: "",
    pbxTenantIdOrTenantCuid: "28",
    extNumber: "101",
    origtime: "1778173987",
    callerDigits: "75861640",
  });
  const b = vmStablePbxMessageId({
    msgId: null,
    pbxTenantIdOrTenantCuid: "28",
    extNumber: "101",
    origtime: "1778173987",
    callerDigits: "75861640",
  });
  assert.equal(a, b);
  assert.equal(a, "28|101|1778173987|75861640");
});

test("vmSplitRingGroupPrefix pulls a ring-group prefix off the caller name", () => {
  assert.deepEqual(vmSplitRingGroupPrefix("Sales: John Smith"), { prefix: "Sales", name: "John Smith" });
  assert.deepEqual(vmSplitRingGroupPrefix("Sales - John Smith"), { prefix: "Sales", name: "John Smith" });
  assert.deepEqual(vmSplitRingGroupPrefix("[Sales] John Smith"), { prefix: "Sales", name: "John Smith" });
  assert.deepEqual(vmSplitRingGroupPrefix("Sales | John Smith"), { prefix: "Sales", name: "John Smith" });
  assert.deepEqual(vmSplitRingGroupPrefix("Front Desk: Jane Doe"), { prefix: "Front Desk", name: "Jane Doe" });
});

test("vmSplitRingGroupPrefix leaves ordinary names untouched (no false prefix)", () => {
  assert.deepEqual(vmSplitRingGroupPrefix("Smith, John"), { prefix: null, name: "Smith, John" });
  assert.deepEqual(vmSplitRingGroupPrefix("Jean-Pierre"), { prefix: null, name: "Jean-Pierre" });
  assert.deepEqual(vmSplitRingGroupPrefix("WIRELESS CALLER"), { prefix: null, name: "WIRELESS CALLER" });
  assert.deepEqual(vmSplitRingGroupPrefix(""), { prefix: null, name: "" });
  assert.deepEqual(vmSplitRingGroupPrefix(null), { prefix: null, name: "" });
});
