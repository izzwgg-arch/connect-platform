import { test } from "node:test";
import assert from "node:assert/strict";
import { requiredProof, decideCompletion } from "./proofRequirements";
import { exceptionRule, validateException, isValidExceptionReason } from "./exceptionRules";

// ── proof requirements ──────────────────────────────────────────────────────
test("required proof by order flags", () => {
  assert.deepEqual(requiredProof({ signatureRequired: true }), ["signature"]);
  assert.deepEqual(requiredProof({ ageRestricted: true }), ["pin", "photo"]);
  assert.deepEqual(requiredProof({}), ["tap"]);
  assert.deepEqual(requiredProof({}, { standard: ["photo"] }), ["photo"]);
  // age-restricted wins over signature
  assert.deepEqual(requiredProof({ signatureRequired: true, ageRestricted: true }), ["pin", "photo"]);
});

test("completion blocks: duplicate, missing proof, proximity", () => {
  const base = { requiredProof: ["signature"] as any, providedProof: [] as any, nearDestination: true, hasLocation: true, alreadySubmitted: false };
  assert.deepEqual(decideCompletion(base).blocks, ["missing_proof"]);
  assert.equal(decideCompletion({ ...base, providedProof: ["signature"] }).ok, true);
  assert.ok(decideCompletion({ ...base, alreadySubmitted: true, providedProof: ["signature"] }).blocks.includes("already_submitted"));
});

test("proximity: override reason unblocks weak-GPS; no location blocks", () => {
  const b = { requiredProof: ["tap"] as any, providedProof: ["tap"] as any, nearDestination: false };
  assert.deepEqual(decideCompletion({ ...b, hasLocation: true, alreadySubmitted: false }).blocks, ["not_near_destination"]);
  assert.deepEqual(decideCompletion({ ...b, hasLocation: false, alreadySubmitted: false }).blocks, ["no_location"]);
  assert.equal(decideCompletion({ ...b, hasLocation: false, alreadySubmitted: false, overrideReason: "weak GPS at door" }).ok, true);
});

test("decideCompletion returns ALL blocks, not just the first", () => {
  const d = decideCompletion({ requiredProof: ["signature"], providedProof: [], nearDestination: false, hasLocation: true, alreadySubmitted: true });
  assert.ok(d.blocks.includes("already_submitted"));
  assert.ok(d.blocks.includes("missing_proof"));
  assert.ok(d.blocks.includes("not_near_destination"));
});

// ── exception rules ──────────────────────────────────────────────────────────
test("reason → downstream behavior", () => {
  const cu = exceptionRule("customer_unavailable");
  assert.equal(cu.targetStatus, "CUSTOMER_UNAVAILABLE");
  assert.equal(cu.notifiesCustomer, true);
  assert.equal(cu.createsRedelivery, true);
  const veh = exceptionRule("vehicle_issue");
  assert.equal(veh.notifiesCustomer, false); // internal — don't alarm the customer
  assert.equal(veh.requiresApproval, true);
});

test("'other' always requires a note (anti-misuse)", () => {
  assert.equal(validateException({ reason: "other", hasPhoto: true, note: "" }).ok, false);
  assert.deepEqual(validateException({ reason: "other", hasPhoto: false, note: "gate locked, callbox dead" }).ok, true);
});

test("validation enforces required photo/note per reason", () => {
  assert.deepEqual(validateException({ reason: "damaged", hasPhoto: false, note: "crushed" }).missing, ["photo"]);
  assert.deepEqual(validateException({ reason: "cannot_access", hasPhoto: true, note: "" }).missing, ["note"]);
  assert.equal(validateException({ reason: "damaged", hasPhoto: true, note: "crushed box" }).ok, true);
});

test("reason code validity guard", () => {
  assert.equal(isValidExceptionReason("refused"), true);
  assert.equal(isValidExceptionReason("nonsense"), false);
});
