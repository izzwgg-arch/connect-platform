import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The signed-URL helpers now REFUSE to sign without a key rather than falling
// back to the repo literal "dev-signing-secret" (tenant-isolation audit §3b).
// These tests exercise signature mechanics, not key resolution — key resolution
// has its own suite in `urlSigningSecret.test.ts` — so pin one here.
process.env.CRM_VOICEMAIL_DROP_URL_SIGNING_SECRET ||= "test-crm-vm-drop-signing-secret";

import {
  buildSignedCrmVoicemailDropUrl,
  buildPbxFileBaseName,
  normalizeCrmVoicemailDropPublicBaseUrl,
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

test("voicemail drop preview URLs use same-origin /api on portal hosts", () => {
  assert.equal(
    normalizeCrmVoicemailDropPublicBaseUrl("https://app.connectcomunications.com"),
    "https://app.connectcomunications.com/api",
  );
  const url = buildSignedCrmVoicemailDropUrl(
    "https://app.connectcomunications.com",
    "drop1",
    "tenants/t/drop/pbx.wav",
    60,
  );
  assert.match(url, /^https:\/\/app\.connectcomunications\.com\/api\/crm\/voicemail-drops\/drop1\/stream\?/);
});

test("voicemail drop preview URLs preserve direct API hosts", () => {
  assert.equal(normalizeCrmVoicemailDropPublicBaseUrl("http://localhost:3001"), "http://localhost:3001");
  const url = buildSignedCrmVoicemailDropUrl("http://localhost:3001", "drop1", "tenants/t/drop/pbx.wav", 60);
  assert.match(url, /^http:\/\/localhost:3001\/crm\/voicemail-drops\/drop1\/stream\?/);
});

test("voicemail drop stream route uses range-aware audio responses", () => {
  const source = readFileSync("src/crm/voicemailDropRoutes.ts", "utf8");
  const streamBlock = source.slice(
    source.indexOf('app.get("/crm/voicemail-drops/:id/stream"'),
    source.indexOf('app.get("/crm/voicemail-drops/:id"', source.indexOf('app.get("/crm/voicemail-drops/:id/stream"')),
  );
  assert.match(streamBlock, /sendBufferWithOptionalRange\(req, reply, bytes, contentTypeForCrmVoicemailDrop\(drop\.pbxStorageKey\)\)/);
});
