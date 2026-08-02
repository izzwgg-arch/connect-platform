/**
 * Regression tests for the CROSS-TENANT LEAK found 2026-08-02.
 *
 * Calls were being written into other companies' call history: PBX-verified over
 * 7 days, 3,517 matched records, 116 filed under the wrong company (3.3%), 11
 * real customers affected in both directions. Every one of them came through the
 * branch that trusted a caller-supplied tenant id without checking it against
 * the call's own PBX marker.
 *
 * Run: node --import tsx --test src/pbxTenantResolve.crossTenant.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { observedPbxTenantCodeFromCall } from "./pbxTenantResolve";

test("reads the owning tenant Asterisk stamps into the dcontext", () => {
  assert.equal(observedPbxTenantCodeFromCall(["T102_cos-all"], []), "T102");
});

test("reads it from the channel when the dcontext has none", () => {
  assert.equal(
    observedPbxTenantCodeFromCall(["connect-mobile-wake-dial"], ["PJSIP/T102_101_1-0000abcd"]),
    "T102",
  );
});

test("agrees with itself across legs of the same call", () => {
  assert.equal(
    observedPbxTenantCodeFromCall(["T21_cos-all", "T21_internal"], ["PJSIP/T21_101-0000dead"]),
    "T21",
  );
});

test("THE LEAK: T102 and T21 are different companies and must never collapse", () => {
  const demo = observedPbxTenantCodeFromCall(["T102_cos-all"], []);
  const landau = observedPbxTenantCodeFromCall(["T21_cos-all"], []);
  assert.equal(demo, "T102");
  assert.equal(landau, "T21");
  assert.notEqual(demo, landau);
});

test("T1 must not match T10/T102 — prefix collision would misfile whole tenants", () => {
  assert.equal(observedPbxTenantCodeFromCall(["T1_cos-all"], []), "T1");
  assert.equal(observedPbxTenantCodeFromCall(["T10_cos-all"], []), "T10");
  assert.equal(observedPbxTenantCodeFromCall(["T102_cos-all"], []), "T102");
});

test("conflicting markers resolve to NOTHING rather than picking a side", () => {
  // A call whose legs disagree about ownership must fail closed. Choosing one
  // is exactly how records landed in the wrong company.
  assert.equal(observedPbxTenantCodeFromCall(["T21_cos-all", "T8_cos-all"], []), null);
  assert.equal(observedPbxTenantCodeFromCall(["T2_cos-all"], ["PJSIP/T21_101-0000beef"]), null);
});

test("no marker at all returns null (falls through to evidence-based paths)", () => {
  assert.equal(observedPbxTenantCodeFromCall(["connect-mobile-wake-dial"], []), null);
  assert.equal(observedPbxTenantCodeFromCall([], []), null);
  assert.equal(observedPbxTenantCodeFromCall(null, null), null);
});

test("junk and malformed input can never throw on the ingest path", () => {
  assert.equal(observedPbxTenantCodeFromCall(["", "   ", "TX_nope", "T_no"], []), null);
  assert.equal(observedPbxTenantCodeFromCall([undefined as any, null as any], [42 as any]), null);
});

test("a tenant code embedded mid-string is still read correctly", () => {
  assert.equal(observedPbxTenantCodeFromCall([], ["Local/101@T8_cos-all-00001;2"]), "T8");
});
