import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyOutboundSipFailure,
  ensureOutboundSipRegistration,
  normalizeMobileDialTarget,
} from "./mobileOutboundDial.js";

test("normalizeMobileDialTarget strips formatting and preserves feature codes", () => {
  assert.equal(normalizeMobileDialTarget("(555) 123-4567"), "5551234567");
  assert.equal(normalizeMobileDialTarget("+1 555 123 4567"), "15551234567");
  assert.equal(normalizeMobileDialTarget("*67"), "*67");
  assert.equal(normalizeMobileDialTarget("101"), "101");
});

test("ensureOutboundSipRegistration waits for healthy registration", async () => {
  let registered = false;
  let registerCalls = 0;
  const result = await ensureOutboundSipRegistration({
    isConnected: () => true,
    isRegistered: () => registered,
    register: async () => {
      registerCalls += 1;
      setTimeout(() => {
        registered = true;
      }, 50);
    },
    waitMs: 500,
  });
  assert.equal(result.ok, true);
  assert.equal(registerCalls, 1);
  assert.equal(result.forcedRefresh, true);
});

test("ensureOutboundSipRegistration fails when register throws", async () => {
  const result = await ensureOutboundSipRegistration({
    isConnected: () => false,
    isRegistered: () => false,
    register: async () => {
      throw new Error("SIP reg failed (403): Authentication Error");
    },
    waitMs: 200,
  });
  assert.equal(result.ok, false);
  assert.match(result.error || "", /403/);
});

test("classifyOutboundSipFailure maps common SIP codes", () => {
  assert.equal(
    classifyOutboundSipFailure({ sipCode: 403, sipReason: "Forbidden", sipCause: "Rejected" }).category,
    "OUTBOUND_AUTH_FAILED",
  );
  assert.equal(
    classifyOutboundSipFailure({ sipCode: 404, sipReason: "Not Found", sipCause: "Not Found" }).category,
    "OUTBOUND_BAD_NUMBER",
  );
  assert.equal(
    classifyOutboundSipFailure({ sipCode: 486, sipReason: "Busy Here", sipCause: "Busy" }).category,
    "OUTBOUND_UNAVAILABLE",
  );
  assert.equal(
    classifyOutboundSipFailure({ sipCode: 488, sipReason: "Not Acceptable Here", sipCause: "Incompatible SDP" }).category,
    "OUTBOUND_MEDIA_FAILED",
  );
  assert.equal(
    classifyOutboundSipFailure({ sipCode: 503, sipReason: "Service Unavailable", sipCause: "Unavailable" }).category,
    "OUTBOUND_TRUNK_FAILED",
  );
  assert.equal(
    classifyOutboundSipFailure({ localReason: "SIP UA not registered" }).category,
    "OUTBOUND_NOT_REGISTERED",
  );
  assert.equal(
    classifyOutboundSipFailure({ sipCause: "NotAllowedError", localReason: "getUserMedia failed" }).category,
    "OUTBOUND_PERMISSION_DENIED",
  );
});
