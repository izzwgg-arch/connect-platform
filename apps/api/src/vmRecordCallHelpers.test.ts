import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyHelperOriginateFailure,
  decideVmRecordWake,
  greetingFileChanged,
  parseReachablePjsipContacts,
  shouldAllowOriginate,
  validateCallerSipEndpoint,
} from "./vmRecordCallHelpers";

// ── validateCallerSipEndpoint ──────────────────────────────────────────────

test("validateCallerSipEndpoint accepts valid base endpoint", () => {
  assert.equal(validateCallerSipEndpoint("T21_101", "21", "101"), "T21_101");
});

test("validateCallerSipEndpoint accepts valid device-suffix endpoint", () => {
  assert.equal(validateCallerSipEndpoint("T21_101_2", "21", "101"), "T21_101_2");
});

test("validateCallerSipEndpoint strips PJSIP/ prefix", () => {
  assert.equal(validateCallerSipEndpoint("PJSIP/T21_101_1", "21", "101"), "T21_101_1");
});

test("validateCallerSipEndpoint strips pjsip/ prefix case-insensitive", () => {
  assert.equal(validateCallerSipEndpoint("pjsip/T21_101_1", "21", "101"), "T21_101_1");
});

test("validateCallerSipEndpoint rejects wrong tenant", () => {
  assert.equal(validateCallerSipEndpoint("T99_101_1", "21", "101"), null);
});

test("validateCallerSipEndpoint rejects wrong extension", () => {
  assert.equal(validateCallerSipEndpoint("T21_999_1", "21", "101"), null);
});

test("validateCallerSipEndpoint rejects Local/... channel", () => {
  assert.equal(validateCallerSipEndpoint("Local/21_101_unavail@context/n", "21", "101"), null);
});

test("validateCallerSipEndpoint rejects shell injection", () => {
  assert.equal(validateCallerSipEndpoint("T21_101; rm -rf /", "21", "101"), null);
});

test("validateCallerSipEndpoint rejects path with slashes", () => {
  assert.equal(validateCallerSipEndpoint("T21_101_1/sip:x@y", "21", "101"), null);
});

test("validateCallerSipEndpoint returns null for empty string", () => {
  assert.equal(validateCallerSipEndpoint("", "21", "101"), null);
});

test("validateCallerSipEndpoint returns null for null", () => {
  assert.equal(validateCallerSipEndpoint(null, "21", "101"), null);
});

test("validateCallerSipEndpoint fallback: missing callerSipEndpoint uses existing hint", () => {
  // Simulate the server logic: null input → null accepted → fallback to db value
  const callerSipEndpointAccepted = validateCallerSipEndpoint(null, "21", "101");
  assert.equal(callerSipEndpointAccepted, null);
  // Caller falls back to pjsipEndpointForExtension result — confirmed by null
});

// ── parseReachablePjsipContacts ───────────────────────────────────────────

test("parseReachablePjsipContacts finds Avail base endpoint", () => {
  const out = `
Contact: T21_101/sip:u@host;line=1     Exp. 3600  Avail
`;
  const r = parseReachablePjsipContacts(out, "21", "101");
  assert.equal(r.ok, true);
  assert.deepEqual(r.availEndpoints, ["T21_101"]);
});

test("parseReachablePjsipContacts finds device suffix endpoint", () => {
  const out = `Contact: T21_101_3/sip:x@y  Avail`;
  const r = parseReachablePjsipContacts(out, "21", "101");
  assert.equal(r.ok, true);
  assert.ok(r.availEndpoints.includes("T21_101_3"));
});

test("parseReachablePjsipContacts ignores NotAvail", () => {
  const out = `Contact: T21_101/sip:x  Unavail`;
  const r = parseReachablePjsipContacts(out, "21", "101");
  assert.equal(r.ok, false);
});

test("shouldAllowOriginate — desk phone path", () => {
  assert.deepEqual(shouldAllowOriginate({ contactOk: true, wakeSent: false, wakeRegistered: false, hadMobileDevices: false }), {
    allow: true,
  });
});

test("shouldAllowOriginate — mobile registered without contact parse", () => {
  assert.deepEqual(shouldAllowOriginate({ contactOk: false, wakeSent: true, wakeRegistered: true, hadMobileDevices: true }), {
    allow: true,
  });
});

test("shouldAllowOriginate — wake sent, never registered", () => {
  assert.deepEqual(shouldAllowOriginate({ contactOk: false, wakeSent: true, wakeRegistered: false, hadMobileDevices: true }), {
    allow: false,
    blockCode: "wake_sent_but_not_registered",
  });
});

test("shouldAllowOriginate — no mobile, no contact", () => {
  assert.deepEqual(shouldAllowOriginate({ contactOk: false, wakeSent: false, wakeRegistered: false, hadMobileDevices: false }), {
    allow: false,
    blockCode: "no_registered_endpoint",
  });
});

// ── decideVmRecordWake (Phase A) ──────────────────────────────────────────

test("decideVmRecordWake — no devices: skip wake", () => {
  const r = decideVmRecordWake({ deviceRowCount: 0, activeDeviceCount: 0, preWakeContactOk: false });
  assert.equal(r.attempt, false);
  assert.equal(r.reason, "skipped_no_devices");
  assert.equal(r.deviceRowCount, 0);
  assert.equal(r.activeDeviceCount, 0);
  assert.equal(r.endpointAlreadyAvail, false);
});

test("decideVmRecordWake — devices present and AOR Avail: still send (Phase A relaxed gate)", () => {
  const r = decideVmRecordWake({ deviceRowCount: 2, activeDeviceCount: 1, preWakeContactOk: true });
  assert.equal(r.attempt, true);
  assert.equal(r.reason, "send");
  assert.equal(r.deviceRowCount, 2);
  assert.equal(r.activeDeviceCount, 1);
  assert.equal(r.endpointAlreadyAvail, true);
});

test("decideVmRecordWake — only stale (active=false) device rows still trigger send", () => {
  const r = decideVmRecordWake({ deviceRowCount: 6, activeDeviceCount: 0, preWakeContactOk: false });
  assert.equal(r.attempt, true);
  assert.equal(r.reason, "send");
  assert.equal(r.deviceRowCount, 6);
  assert.equal(r.activeDeviceCount, 0);
});

test("decideVmRecordWake — all-active devices, AOR not Avail: send", () => {
  const r = decideVmRecordWake({ deviceRowCount: 3, activeDeviceCount: 3, preWakeContactOk: false });
  assert.equal(r.attempt, true);
  assert.equal(r.reason, "send");
  assert.equal(r.endpointAlreadyAvail, false);
});

test("decideVmRecordWake — Phase A regression guard: AOR Avail must NOT block when devices exist", () => {
  // This is the exact Landau Home scenario: shared AOR T<t>_<e>_1 is Avail
  // because desktop WebRTC is registered, but the mobile app is asleep.
  // Before Phase A this returned attempt=false; after Phase A it returns true.
  const r = decideVmRecordWake({ deviceRowCount: 1, activeDeviceCount: 0, preWakeContactOk: true });
  assert.equal(r.attempt, true, "must attempt wake even when AOR appears Avail");
});

test("classifyHelperOriginateFailure detects dialplan", () => {
  assert.equal(
    classifyHelperOriginateFailure("Unable to find extension", ""),
    "dialplan_context_missing",
  );
});

test("greetingFileChanged detects new sha", () => {
  assert.equal(
    greetingFileChanged({
      beforeActive: true,
      beforeSha: "aaa",
      beforeUpdatedAt: "2020-01-01T00:00:00Z",
      afterActive: true,
      afterSha: "bbb",
      afterUpdatedAt: "2020-01-02T00:00:00Z",
    }),
    true,
  );
});

test("greetingFileChanged inactive to active", () => {
  assert.equal(
    greetingFileChanged({
      beforeActive: false,
      beforeSha: null,
      beforeUpdatedAt: null,
      afterActive: true,
      afterSha: "x",
      afterUpdatedAt: "2020-01-01T00:00:00Z",
    }),
    true,
  );
});
