import test from "node:test";
import assert from "node:assert/strict";
import { vmStablePbxMessageId } from "./voicemailIngest";

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
