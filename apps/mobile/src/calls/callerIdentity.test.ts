import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCallerIdentity,
  callerDisplayLines,
  callbackNumber,
  suggestedContactName,
  splitRingGroupPrefix,
} from "./callerIdentity.js";

test("ring-group prefix + phone number (no CNAM): keeps prefix, number, both shown", () => {
  const id = normalizeCallerIdentity({
    direction: "inbound",
    number: "8455551212",
    displayName: "Sales:8455551212",
  });
  assert.equal(id.ringGroupPrefix, "Sales");
  assert.equal(id.externalNumber, "8455551212");
  assert.equal(id.displayName, null);
  const lines = callerDisplayLines(id);
  assert.equal(lines.prefixBadge, "Sales");
  assert.equal(lines.primary, "8455551212");
  assert.equal(callbackNumber(id), "8455551212");
});

test("ring-group prefix + CNAM name: prefix badge, name primary, number secondary", () => {
  const id = normalizeCallerIdentity({
    direction: "inbound",
    number: "8455551212",
    displayName: "Sales:John Smith",
  });
  assert.equal(id.ringGroupPrefix, "Sales");
  assert.equal(id.externalNumber, "8455551212");
  assert.equal(id.displayName, "John Smith");
  const lines = callerDisplayLines(id);
  assert.equal(lines.prefixBadge, "Sales");
  assert.equal(lines.primary, "John Smith");
  assert.equal(lines.secondary, "8455551212");
});

test("prefix-only fallback (duplicate group name, no real number in user field)", () => {
  const id = normalizeCallerIdentity({
    direction: "inbound",
    number: "",
    displayName: "New Tires:New Tires:",
  });
  assert.equal(id.ringGroupPrefix, "New Tires");
  assert.equal(id.displayName, null);
  assert.equal(id.externalNumber, null);
  const lines = callerDisplayLines(id);
  assert.equal(lines.prefixBadge, "New Tires");
});

test("prefix + empty CNAM, number only in display name after colon", () => {
  const id = normalizeCallerIdentity({
    direction: "inbound",
    number: "",
    displayName: "New Tires:8453050021",
  });
  assert.equal(id.ringGroupPrefix, "New Tires");
  assert.equal(id.externalNumber, "8453050021");
  assert.equal(callbackNumber(id), "8453050021");
});

test("phone number only (no prefix, no CNAM)", () => {
  const id = normalizeCallerIdentity({
    direction: "inbound",
    number: "+18455551212",
    displayName: "",
  });
  assert.equal(id.ringGroupPrefix, null);
  assert.equal(id.externalNumber, "+18455551212");
  assert.equal(id.displayName, null);
  const lines = callerDisplayLines(id);
  assert.equal(lines.primary, "+18455551212");
});

test("plain CNAM, no ring group prefix (no colon)", () => {
  const id = normalizeCallerIdentity({
    direction: "inbound",
    number: "8455551212",
    displayName: "A PLUS CENTER NY",
  });
  assert.equal(id.ringGroupPrefix, null);
  assert.equal(id.externalNumber, "8455551212");
  assert.equal(id.displayName, "A PLUS CENTER NY");
  const lines = callerDisplayLines(id);
  assert.equal(lines.primary, "A PLUS CENTER NY");
  assert.equal(lines.secondary, "8455551212");
});

test("inbound: tenant label is stripped from caller name, prefix badge untouched", () => {
  const id = normalizeCallerIdentity({
    direction: "inbound",
    number: "8454226997",
    displayName: "A PLUS CENTER WIRELESS CALLER",
    ringGroupPrefix: "Main",
    tenantId: "vpbx:a_plus_center",
  });
  assert.equal(id.ringGroupPrefix, "Main");
  assert.equal(id.displayName, "WIRELESS CALLER");
  const lines = callerDisplayLines(id);
  assert.equal(lines.prefixBadge, "Main");
  assert.equal(lines.primary, "WIRELESS CALLER");
  assert.equal(lines.secondary, "8454226997");
});

test("inbound: exact tenant CNAM falls back to caller number", () => {
  const id = normalizeCallerIdentity({
    direction: "inbound",
    number: "9172421944",
    displayName: "TRIMPRO INC",
    tenantId: "vpbx:trimpro",
  });
  assert.equal(id.displayName, null);
  assert.equal(callerDisplayLines(id).primary, "9172421944");
});

test("internal extension call: extension number + name, no external number", () => {
  const id = normalizeCallerIdentity({
    direction: "internal",
    number: "103",
    toNumber: "101",
    displayName: "Front Desk",
  });
  assert.equal(id.externalNumber, null);
  assert.equal(id.extensionNumber, "103");
  assert.equal(id.extensionName, "Front Desk");
  const lines = callerDisplayLines(id);
  assert.equal(lines.primary, "Front Desk");
  assert.equal(lines.secondary, "Ext 103");
});

test("outbound external call: dialed number is the party", () => {
  const id = normalizeCallerIdentity({
    direction: "outbound",
    toNumber: "8455551212",
  });
  assert.equal(id.externalNumber, "8455551212");
  assert.equal(callbackNumber(id), "8455551212");
});

test("outbound: own extension name in fromName is NEVER shown (shows dialed number)", () => {
  // Regression: dialing an external number not in contacts must not show the
  // dialing extension's own name ("Home") as the row name.
  const id = normalizeCallerIdentity({
    direction: "outbound",
    number: "101",
    displayName: "Home",
    toNumber: "8457833399",
  });
  assert.equal(id.displayName, null);
  assert.equal(id.ringGroupPrefix, null);
  assert.equal(id.externalNumber, "8457833399");
  const lines = callerDisplayLines(id);
  assert.equal(lines.primary, "8457833399");
  assert.equal(lines.secondary, null);
  assert.equal(suggestedContactName(id), null);
});

test("inbound: own extension name leaking as caller is suppressed (no contact, no CNAM)", () => {
  const id = normalizeCallerIdentity({
    direction: "inbound",
    number: "8457833399",
    displayName: "Home",
    selfNames: ["Home"],
  });
  assert.equal(id.displayName, null);
  const lines = callerDisplayLines(id);
  assert.equal(lines.primary, "8457833399");
});

test("inbound: real CNAM like WIRELESS CALLER is kept + number shown", () => {
  const id = normalizeCallerIdentity({
    direction: "inbound",
    number: "8457833399",
    displayName: "WIRELESS CALLER",
    selfNames: ["Home"],
  });
  assert.equal(id.displayName, "WIRELESS CALLER");
  const lines = callerDisplayLines(id);
  assert.equal(lines.primary, "WIRELESS CALLER");
  assert.equal(lines.secondary, "8457833399");
});

test("internal: own extension name as remote is suppressed", () => {
  const id = normalizeCallerIdentity({
    direction: "internal",
    number: "101",
    toNumber: "102",
    displayName: "Home",
    selfNames: ["Home"],
  });
  assert.equal(id.extensionName, null);
  const lines = callerDisplayLines(id);
  assert.equal(lines.primary, "Ext 101");
});

test("unknown caller: no number, no name", () => {
  const id = normalizeCallerIdentity({
    direction: "inbound",
    number: "",
    displayName: "",
  });
  assert.equal(id.externalNumber, null);
  assert.equal(id.displayName, null);
  assert.equal(callbackNumber(id), null);
  const lines = callerDisplayLines(id);
  assert.equal(lines.primary, "Unknown");
});

test("never uses the logged-in user's own extension/name as inbound caller", () => {
  // PBX (or a bad event ordering) hands us our own identity as the display
  // name; the external number must win, not our own name.
  const id = normalizeCallerIdentity({
    direction: "inbound",
    number: "8455551212",
    displayName: "Sales:My Own Name",
    selfNames: ["My Own Name"],
    selfExtensionNumbers: ["101"],
  });
  assert.equal(id.displayName, null);
  assert.equal(id.externalNumber, "8455551212");
  const lines = callerDisplayLines(id);
  assert.equal(lines.primary, "8455551212");
  assert.equal(lines.prefixBadge, "Sales");
});

test("contact match overrides display (resolved name passed as displayName)", () => {
  // When a contact is matched the caller resolves to the saved name while the
  // number is still surfaced as the secondary line.
  const id = normalizeCallerIdentity({
    direction: "inbound",
    number: "8455551212",
    displayName: "Acme Plumbing",
  });
  const lines = callerDisplayLines(id);
  assert.equal(lines.primary, "Acme Plumbing");
  assert.equal(lines.secondary, "8455551212");
});

test("add-to-contact: callbackNumber + suggestedContactName", () => {
  const withName = normalizeCallerIdentity({
    direction: "inbound",
    number: "8455551212",
    displayName: "Sales:John Smith",
  });
  assert.equal(callbackNumber(withName), "8455551212");
  assert.equal(suggestedContactName(withName), "John Smith");

  const numberOnly = normalizeCallerIdentity({
    direction: "inbound",
    number: "8455551212",
    displayName: "Sales:8455551212",
  });
  assert.equal(callbackNumber(numberOnly), "8455551212");
  assert.equal(suggestedContactName(numberOnly), null);
});

test("splitRingGroupPrefix ignores numeric pseudo-prefix", () => {
  assert.deepEqual(splitRingGroupPrefix("8455551212"), { prefix: null, rest: "8455551212" });
  assert.deepEqual(splitRingGroupPrefix("Sales:Bob"), { prefix: "Sales", rest: "Bob" });
  assert.deepEqual(splitRingGroupPrefix("Sales:"), { prefix: "Sales", rest: "" });
});

test("splitRingGroupPrefix collapses a repeated (tripled) prefix to one label", () => {
  // VitalPBX prepends the prefix on every ring-group pass.
  assert.deepEqual(
    splitRingGroupPrefix("Estimates:Estimates:Estimates:A PLUS CENTER TEST"),
    { prefix: "Estimates", rest: "A PLUS CENTER TEST" },
  );
  assert.deepEqual(
    splitRingGroupPrefix("New Tires:New Tires:8453050021"),
    { prefix: "New Tires", rest: "8453050021" },
  );
});

test("explicit ringGroupPrefix field (server-provided) is used and name stays clean", () => {
  // New wire shape: fromName is the bare CNAM, the prefix arrives separately.
  const id = normalizeCallerIdentity({
    direction: "inbound",
    number: "8455577768",
    displayName: "A PLUS CENTER TEST",
    ringGroupPrefix: "Estimates",
  });
  assert.equal(id.ringGroupPrefix, "Estimates");
  assert.equal(id.displayName, "A PLUS CENTER TEST");
  assert.equal(id.externalNumber, "8455577768");
  const lines = callerDisplayLines(id);
  assert.equal(lines.prefixBadge, "Estimates");
  assert.equal(lines.primary, "A PLUS CENTER TEST");
  assert.equal(lines.secondary, "8455577768");
});

test("explicit ringGroupPrefix overrides any prefix parsed from the display name", () => {
  const id = normalizeCallerIdentity({
    direction: "inbound",
    number: "8455551212",
    displayName: "Estimates:Estimates:John Smith",
    ringGroupPrefix: "Estimates",
  });
  assert.equal(id.ringGroupPrefix, "Estimates");
  assert.equal(id.displayName, "John Smith");
  const lines = callerDisplayLines(id);
  assert.equal(lines.prefixBadge, "Estimates");
  assert.equal(lines.primary, "John Smith");
});
