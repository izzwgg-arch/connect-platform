/**
 * Guard: resolvePbxEventTarget must never guess a tenant for an ambiguous
 * extension number when the event carries no tenant evidence (2026-08-29).
 *
 * The defect: `.find()` took the FIRST LINKED candidate for extNumber "101"
 * platform-wide, so a Loopcom Demo call whose ring notify arrived tenant-less
 * (the SignalWire DialBegin race) created its CallInvite under Trimpro and
 * pushed the caller's number at Trimpro's user — a cross-tenant leak AND a
 * lost ring in one move. server.ts cannot be imported by tests, so this reads
 * the SOURCE (CRLF-normalised; comments stripped for negative assertions).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "server.ts"), "utf8").replace(/\r\n/g, "\n");
const fnStart = src.indexOf("async function resolvePbxEventTarget");
assert.ok(fnStart > 0, "resolvePbxEventTarget exists");
const fnBody = src.slice(fnStart, src.indexOf("\nasync function ", fnStart + 10));

// Strip whole-line // comments so negative assertions cannot match prose.
const code = fnBody
  .split("\n")
  .filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l))
  .join("\n");

test("the ambiguity refusal is present and executable", () => {
  assert.ok(code.includes("const hasTenantEvidence = Boolean(evt.pbxTenantId || evt.pbxExtensionId);"));
  assert.ok(code.includes("if (!hasTenantEvidence && distinctTenants.size > 1) {"));
  assert.ok(/if \(!hasTenantEvidence && distinctTenants\.size > 1\) \{[\s\S]{0,400}?return null;/.test(code));
});

test("the first-match-wins guess is gone from the no-evidence path", () => {
  assert.ok(!code.includes("candidates.find("), "candidates.find() must not return");
});
