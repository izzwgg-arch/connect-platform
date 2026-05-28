import test from "node:test";
import assert from "node:assert/strict";

import { isValidStatusTransition } from "./provisioning";
import { generateVitalPbxCsv } from "./vitalpbxTemplate";

test("status transition helper allows forward moves and cancel, blocks from terminal", () => {
  assert.equal(isValidStatusTransition("INVITE_SENT", "IN_PROGRESS"), true);
  assert.equal(isValidStatusTransition("IN_PROGRESS", "SUBMITTED"), true);
  assert.equal(isValidStatusTransition("SUBMITTED", "CANCELED"), true);
  assert.equal(isValidStatusTransition("COMPLETED", "ACTIVE"), false);
  assert.equal(isValidStatusTransition("CANCELED", "ACTIVE"), false);
});

test("VitalPBX CSV escaping + filename shape", () => {
  const { filename, mime, body } = generateVitalPbxCsv([
    { extNumber: "101", name: "Alice, Sr.", email: 'a"b@example.com' },
    { extNumber: "102", name: "Bob\nSmith", email: "b@example.com" },
  ]);
  assert.ok(filename.startsWith("vitalpbx_extensions_"));
  assert.ok(filename.endsWith(".csv"));
  assert.equal(mime.startsWith("text/csv"), true);
  const lines = body.split(/\r?\n/);
  // Header row: first column should be "mode"
  assert.ok(lines[0].startsWith("mode,extension,ext_name,"));
  // Two extensions → header + 4 data rows (2 per ext)
  assert.ok(lines.length >= 5);
  // Row 1 (ext 101 add): ext_name contains Alice quoted because of comma
  assert.ok(/"Alice, Sr\."/.test(lines[1]));
  // Row 1: outgoing_rec and incoming_rec should be yes
  assert.ok(/yes/.test(lines[1]));
  // Row 2 (ext 101 add_device): vitxi_client=yes
  assert.ok(/add_device/.test(lines[2]));
  assert.ok(/Default WebRTC Profile/.test(lines[2]));
  assert.ok(/101_1/.test(lines[2]));
  assert.ok(/yes/.test(lines[2]));
});

test("VitalPBX CSV duplicate detection", () => {
  assert.throws(() => generateVitalPbxCsv([
    { extNumber: "101" },
    { extNumber: "101" },
  ]), /duplicate_extension/);
});
