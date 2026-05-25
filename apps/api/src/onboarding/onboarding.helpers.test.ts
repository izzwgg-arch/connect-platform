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
    { extNumber: "101", name: "Alice, Sr.", email: "a\"b@example.com", vmEnabled: true, class_of_service: "default" },
    { extNumber: "102", name: "Bob\nSmith", email: "b@example.com" },
  ]);
  assert.ok(filename.startsWith("vitalpbx_extensions_"));
  assert.ok(filename.endsWith(".csv"));
  assert.equal(mime.startsWith("text/csv"), true);
  const lines = body.split(/\r?\n/);
  assert.equal(lines[0], "mode,extension,ext_name,email,class_of_service,vm_enabled,device_user,device_password");
  // Row 1: mode=add, correct ext, name/email escaping
  assert.ok(lines[1].startsWith("add,101,"));
  assert.ok(/"Alice, Sr\."/.test(lines[1]));
  assert.ok(/a""b@example\.com/.test(lines[1]));
  assert.ok(lines[1].includes(",yes,101,"));
  // Row 2: newline in name is quoted — check raw body since split breaks multi-line cells
  assert.ok(/"Bob\nSmith"/.test(body));
});

test("VitalPBX CSV duplicate detection", () => {
  assert.throws(() => generateVitalPbxCsv([
    { extNumber: "101" },
    { extNumber: "101" },
  ]), /duplicate_extension/);
});
