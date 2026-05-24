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
    { extNumber: "101", name: "Alice, Sr.", email: "a\"b@example.com", voicemail: "enabled", class_of_service: "default" },
    { extNumber: "102", name: "Bob\nSmith", email: "b@example.com" },
  ]);
  assert.ok(filename.startsWith("vitalpbx_extensions_"));
  assert.ok(filename.endsWith(".csv"));
  assert.equal(mime.startsWith("text/csv"), true);
  const lines = body.split(/\r?\n/);
  assert.equal(lines[0], "extension,name,email,device,password,voicemail,class_of_service");
  // Confirm quotes are escaped and commas/newlines are quoted
  assert.ok(/"Alice, Sr\."/.test(lines[1]));
  assert.ok(/a""b@example\.com/.test(lines[1]));
  assert.ok(/"Bob\nSmith"/.test(lines[2]));
});

test("VitalPBX CSV duplicate detection", () => {
  assert.throws(() => generateVitalPbxCsv([
    { extNumber: "101" },
    { extNumber: "101" },
  ]), /duplicate_extension/);
});
