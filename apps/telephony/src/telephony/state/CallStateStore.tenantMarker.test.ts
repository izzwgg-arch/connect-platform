/**
 * The telephony half of the CROSS-TENANT LEAK fix (2026-08-02).
 *
 * This service produced the wrong tenant labels: 116 calls in 7 days written
 * into other companies' history, 11 customers. Two causes, both here —
 * first-leg-wins attribution that could never be corrected, and a resolver that
 * could not read the `T<n>_` marker Asterisk stamps on the call.
 *
 * Run: node --import tsx --test src/telephony/state/CallStateStore.tenantMarker.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { extractPbxTenantCodeFromCallFields } from "./pbxTenantMarker";

test("reads the tenant marker from a dcontext", () => {
  assert.equal(extractPbxTenantCodeFromCallFields("T102_cos-all"), "T102");
});

test("reads it from a channel", () => {
  assert.equal(extractPbxTenantCodeFromCallFields(undefined, "PJSIP/T8_108-0000f9d2"), "T8");
});

test("reads it from a Local channel mid-string", () => {
  assert.equal(extractPbxTenantCodeFromCallFields(undefined, "Local/111@T8_queue-call-to-agents-00009ffb;1"), "T8");
});

test("THE LEAK: T102 and T21 are different companies", () => {
  assert.notEqual(
    extractPbxTenantCodeFromCallFields("T102_cos-all"),
    extractPbxTenantCodeFromCallFields("T21_cos-all"),
  );
});

test("T1 / T10 / T102 never collide — a prefix match would misfile whole tenants", () => {
  assert.equal(extractPbxTenantCodeFromCallFields("T1_cos-all"), "T1");
  assert.equal(extractPbxTenantCodeFromCallFields("T10_cos-all"), "T10");
  assert.equal(extractPbxTenantCodeFromCallFields("T102_cos-all"), "T102");
});

test("conflicting markers yield NOTHING rather than picking a side", () => {
  assert.equal(extractPbxTenantCodeFromCallFields("T21_cos-all", "PJSIP/T8_101-0000beef"), null);
});

test("agreeing markers across legs resolve normally", () => {
  assert.equal(extractPbxTenantCodeFromCallFields("T21_cos-all", "PJSIP/T21_101-0000beef"), "T21");
});

test("no marker returns null so weaker resolution still runs", () => {
  assert.equal(extractPbxTenantCodeFromCallFields("ext-local-a_plus_center"), null);
  assert.equal(extractPbxTenantCodeFromCallFields("PJSIP/344022_Comfortcont-0000f9cd"), null);
  assert.equal(extractPbxTenantCodeFromCallFields(undefined, null), null);
});

test("malformed input can never throw on the live-call path", () => {
  assert.equal(extractPbxTenantCodeFromCallFields("", "   ", "TX_nope", "T_no"), null);
  assert.equal(extractPbxTenantCodeFromCallFields(42 as any, {} as any), null);
});
