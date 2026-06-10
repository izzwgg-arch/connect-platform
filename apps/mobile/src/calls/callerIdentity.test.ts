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
