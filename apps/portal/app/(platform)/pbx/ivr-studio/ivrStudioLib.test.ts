import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDestinationRef, parseDestinationRef, validateDestinationRef, describeDestination,
  type ExtensionSuggestion,
} from "./ivrStudioLib";

const extRow: ExtensionSuggestion = { extension: "101", name: "Reception", pbxDeviceName: "T21_101_1", pbxSipUsername: null };

test("buildDestinationRef: extension uses tenant CoS context when derivable", () => {
  assert.equal(buildDestinationRef("extension", "101", "", { extensionRow: extRow }), "T21_cos-all,101,1");
  // falls back to from-internal when no tenant context
  assert.equal(buildDestinationRef("extension", "102", "", {}), "from-internal,102,1");
});

test("buildDestinationRef: queue / ring_group / voicemail CEP shapes", () => {
  assert.equal(buildDestinationRef("queue", "900", "", {}), "ext-queues,900,1");
  assert.equal(buildDestinationRef("ring_group", "601", "", {}), "ext-group,601,1");
  assert.equal(buildDestinationRef("voicemail", "101", "", {}), "ext-local,vmu101,1");
});

test("buildDestinationRef: terminate is fixed; external/ivr/announcement/custom pass through", () => {
  assert.equal(buildDestinationRef("terminate", "", "", {}), "connect-default-fallback,s,1");
  assert.equal(buildDestinationRef("external_number", "", "+18455551234", {}), "+18455551234");
  assert.equal(buildDestinationRef("ivr", "", "connect-tenant-ivr,p1,1", {}), "connect-tenant-ivr,p1,1");
  assert.equal(buildDestinationRef("custom", "", "some-ctx,s,1", {}), "some-ctx,s,1");
});

test("parseDestinationRef round-trips the canonical shapes", () => {
  assert.deepEqual(parseDestinationRef("extension", "T21_cos-all,101,1"), { selected: "101", free: "" });
  assert.deepEqual(parseDestinationRef("extension", "from-internal,105,1"), { selected: "105", free: "" });
  assert.deepEqual(parseDestinationRef("queue", "ext-queues,900,1"), { selected: "900", free: "" });
  assert.deepEqual(parseDestinationRef("voicemail", "ext-local,vmu101,1"), { selected: "101", free: "" });
  assert.deepEqual(parseDestinationRef("external_number", "+18455551234"), { selected: "", free: "+18455551234" });
});

test("validateDestinationRef mirrors the server contract", () => {
  assert.equal(validateDestinationRef("terminate", "connect-default-fallback,s,1"), null);
  assert.equal(validateDestinationRef("extension", "T21_cos-all,101,1"), null);
  assert.equal(validateDestinationRef("external_number", "+18455551234"), null);
  assert.equal(validateDestinationRef("external_number", "8455551234"), null); // server allows optional +
  assert.ok(validateDestinationRef("external_number", "not-a-number")); // letters → error
  assert.ok(validateDestinationRef("extension", "")); // empty → error
  assert.ok(validateDestinationRef("extension", "not a cep")); // malformed → error
  assert.ok(validateDestinationRef("", "anything")); // no type → error
});

test("describeDestination prefers a label, else derives from ref", () => {
  assert.equal(describeDestination("queue", "ext-queues,900,1", "Sales"), "Sales");
  assert.equal(describeDestination("extension", "T21_cos-all,101,1", null), "Extension 101");
  assert.equal(describeDestination("terminate", "connect-default-fallback,s,1", null), "Hang up");
  assert.equal(describeDestination("external_number", "+18455551234", null), "External +18455551234");
});

test("every destination type produces a non-empty, valid ref from a normal selection", () => {
  const cases: Array<[Parameters<typeof buildDestinationRef>[0], string, string]> = [
    ["extension", "101", ""], ["queue", "900", ""], ["ring_group", "601", ""], ["voicemail", "101", ""],
    ["ivr", "", "connect-tenant-ivr,p1,1"], ["announcement", "", "app-announce,notice,1"],
    ["external_number", "", "+18455551234"], ["terminate", "", ""], ["custom", "", "ctx,s,1"],
  ];
  for (const [type, sel, free] of cases) {
    const ref = buildDestinationRef(type, sel, free, { extensionRow: extRow });
    assert.ok(ref.length > 0, `${type} produced empty ref`);
    assert.equal(validateDestinationRef(type, ref), null, `${type} ref '${ref}' should validate`);
  }
});
