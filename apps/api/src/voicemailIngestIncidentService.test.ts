import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFingerprint,
  classifyHelperFailure,
  VM_SCENARIO,
  voicemailIngestIncidentsEnabled,
} from "@connect/db";

test("buildFingerprint is stable and colon-safe", () => {
  const a = buildFingerprint(VM_SCENARIO.NOTIFY_UPSERT_ZERO, ["t1", "101", "ctx:a"]);
  const b = buildFingerprint(VM_SCENARIO.NOTIFY_UPSERT_ZERO, ["t1", "101", "ctx:a"]);
  assert.equal(a, b);
  assert.ok(a.includes("NOTIFY_UPSERT_ZERO"));
  assert.ok(!a.includes("ctx:a") || a.includes("ctx_a"));
});

test("classifyHelperFailure maps HTTP statuses", () => {
  const e404 = Object.assign(new Error("not_found"), { httpStatus: 404 });
  assert.equal(classifyHelperFailure(e404), VM_SCENARIO.HELPER_ROUTE_MISSING);
  const e401 = Object.assign(new Error("nope"), { httpStatus: 401 });
  assert.equal(classifyHelperFailure(e401), VM_SCENARIO.HELPER_SECRET_MISMATCH);
});

test("classifyHelperFailure maps timeout / abort", () => {
  const abort = new Error("Aborted");
  abort.name = "AbortError";
  assert.equal(classifyHelperFailure(abort), VM_SCENARIO.HELPER_UNREACHABLE);
});

test("classifyHelperFailure returns null for unrelated errors", () => {
  assert.equal(classifyHelperFailure(new Error("random")), null);
});

test("voicemailIngestIncidentsEnabled defaults true", () => {
  const prev = process.env.VOICEMAIL_INGEST_INCIDENTS_ENABLED;
  delete process.env.VOICEMAIL_INGEST_INCIDENTS_ENABLED;
  assert.equal(voicemailIngestIncidentsEnabled(), true);
  process.env.VOICEMAIL_INGEST_INCIDENTS_ENABLED = "false";
  assert.equal(voicemailIngestIncidentsEnabled(), false);
  if (prev === undefined) delete process.env.VOICEMAIL_INGEST_INCIDENTS_ENABLED;
  else process.env.VOICEMAIL_INGEST_INCIDENTS_ENABLED = prev;
});
