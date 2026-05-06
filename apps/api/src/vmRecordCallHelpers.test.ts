import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyHelperOriginateFailure,
  greetingFileChanged,
  parseReachablePjsipContacts,
  shouldAllowOriginate,
} from "./vmRecordCallHelpers";

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
