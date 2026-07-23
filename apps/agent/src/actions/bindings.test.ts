import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requiresBinding,
  canonicalJson,
  computeParamsHash,
  makeBoundApprovalToken,
  verifyBoundApprovalToken,
} from "./bindings";
import { makeApprovalToken } from "./tokens";

process.env.AGENT_APPROVAL_SECRET = "test-approval-secret";

test("requiresBinding: modify/repair yes, legacy A/P no", () => {
  assert.equal(requiresBinding("pbx.M1"), true);
  assert.equal(requiresBinding("pbx.M14"), true);
  assert.equal(requiresBinding("pbx.E2"), true);
  assert.equal(requiresBinding("repair.R1"), true);
  assert.equal(requiresBinding("pbx.P4"), false);
  assert.equal(requiresBinding("action.A1.temp_forward"), false);
  assert.equal(requiresBinding("read.extension_status"), false);
  assert.equal(requiresBinding("pbx.Mystery"), false); // M must be followed by a digit
});

test("canonicalJson: key order never changes the output", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }), canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1])); // arrays keep order
});

test("paramsHash: any change to capability, tenant, or params changes the hash", () => {
  const base = computeParamsHash("pbx.M1", "21", { objectId: "moh1", classId: "jazz" });
  assert.equal(base, computeParamsHash("pbx.M1", "21", { classId: "jazz", objectId: "moh1" })); // order-insensitive
  assert.notEqual(base, computeParamsHash("pbx.M2", "21", { objectId: "moh1", classId: "jazz" }));
  assert.notEqual(base, computeParamsHash("pbx.M1", "8", { objectId: "moh1", classId: "jazz" }));
  assert.notEqual(base, computeParamsHash("pbx.M1", "21", { objectId: "moh1", classId: "rock" }));
});

test("bound token round-trips", () => {
  const hash = computeParamsHash("pbx.M1", "21", { objectId: "o1" });
  const tok = makeBoundApprovalToken("act1", "approve", hash);
  assert.deepEqual(verifyBoundApprovalToken(tok), { actionId: "act1", decision: "approve", paramsHash: hash });
});

test("bound token tamper matrix: signature, expiry, format", () => {
  const hash = computeParamsHash("pbx.M1", "21", { objectId: "o1" });
  const tok = makeBoundApprovalToken("act1", "approve", hash);
  assert.equal(verifyBoundApprovalToken(tok + "x"), null); // sig tamper
  assert.equal(verifyBoundApprovalToken(makeBoundApprovalToken("act1", "approve", hash, -1000)), null); // expired
  // body tamper: swap decision inside the b64 body without re-signing
  const [body, sig] = tok.split(".");
  const decoded = Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  const forged = Buffer.from(decoded.replace(".approve.", ".deny.")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(verifyBoundApprovalToken(`${forged}.${sig}`), null);
});

test("legacy unbound token is NEVER valid as a bound token", () => {
  const legacy = makeApprovalToken("act1", "approve");
  assert.equal(verifyBoundApprovalToken(legacy), null);
});

test("no secret configured ⇒ nothing verifies (fail-closed)", () => {
  const prev = process.env.AGENT_APPROVAL_SECRET;
  const prevInt = process.env.AGENT_INTERNAL_SECRET;
  const hash = computeParamsHash("pbx.M1", "21", { objectId: "o1" });
  const tok = makeBoundApprovalToken("act1", "approve", hash);
  delete process.env.AGENT_APPROVAL_SECRET;
  delete process.env.AGENT_INTERNAL_SECRET;
  assert.equal(verifyBoundApprovalToken(tok), null);
  process.env.AGENT_APPROVAL_SECRET = prev;
  if (prevInt) process.env.AGENT_INTERNAL_SECRET = prevInt;
});
