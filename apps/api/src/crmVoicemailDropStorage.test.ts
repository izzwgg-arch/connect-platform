import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPbxFileBaseName,
  verifySignedCrmVoicemailDropUrl,
} from "./crmVoicemailDropStorage";

test("buildPbxFileBaseName scopes names by tenant and drop id", () => {
  const name = buildPbxFileBaseName("tenant/ABC", "drop id 123");
  assert.match(name, /^crm_vm_tenant_ABC_drop_id_123$/i);
  assert.doesNotMatch(name, /[/. ]/);
});

test("verifySignedCrmVoicemailDropUrl rejects invalid signatures", () => {
  const result = verifySignedCrmVoicemailDropUrl("drop1", "tenants/t/drop/pbx.wav", String(Math.floor(Date.now() / 1000) + 60), "0".repeat(64));
  assert.deepEqual(result, { ok: false, reason: "invalid" });
});
