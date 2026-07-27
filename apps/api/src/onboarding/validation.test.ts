// Schema tests for the public onboarding payloads: optional billing email,
// cell-phone routing fields, and the apply-number payload.

import test from "node:test";
import assert from "node:assert/strict";
import { publicSubmitSchema, publicApplyNumberSchema, extensionInputSchema, publicSaveSchema, isSubmissionWriteBlocked, isReusableTemplate } from "./validation";

const baseSubmit = {
  companyName: "Bobs Plumbing",
  contactFirstName: "Bob",
  contactLastName: "Jones",
  mainEmail: "bob@x.com",
  extensions: [],
};

test("submit: billing email is optional", () => {
  const parsed = publicSubmitSchema.parse(baseSubmit);
  assert.equal(parsed.billingEmail, undefined);
  const withBilling = publicSubmitSchema.parse({ ...baseSubmit, billingEmail: "billing@x.com" });
  assert.equal(withBilling.billingEmail, "billing@x.com");
  assert.throws(() => publicSubmitSchema.parse({ ...baseSubmit, billingEmail: "not-an-email" }));
});

test("extension: cell routing accepts also/only with a 10-digit number, rejects junk", () => {
  assert.doesNotThrow(() => extensionInputSchema.parse({ extNumber: "101", cellMode: "also", cellNumber: "5622096644" }));
  assert.doesNotThrow(() => extensionInputSchema.parse({ extNumber: "101", cellMode: "only", cellNumber: "9145550000" }));
  assert.doesNotThrow(() => extensionInputSchema.parse({ extNumber: "101" })); // no cell at all
  assert.throws(() => extensionInputSchema.parse({ extNumber: "101", cellMode: "sometimes", cellNumber: "5622096644" }));
  assert.throws(() => extensionInputSchema.parse({ extNumber: "101", cellMode: "also", cellNumber: "562-209-6644" }));
  assert.throws(() => extensionInputSchema.parse({ extNumber: "101", cellMode: "also", cellNumber: "12345" }));
});

test("apply-number: choice is required and constrained", () => {
  assert.doesNotThrow(() => publicApplyNumberSchema.parse({ choice: "new", selectedNumber: "8455551234" }));
  assert.doesNotThrow(() => publicApplyNumberSchema.parse({ choice: "port", porting: { numbers: "2125550000" } }));
  assert.throws(() => publicApplyNumberSchema.parse({ choice: "steal" }));
  assert.throws(() => publicApplyNumberSchema.parse({}));
});

test("REGRESSION: autosave accepts currentStep as a NUMBER (live 2026-07-27 — every save 500'd)", () => {
  // The wizard has always sent the step index as a number; the schema only
  // took strings, so every autosave failed and progress was never saved.
  assert.equal(publicSaveSchema.parse({ currentStep: 3, answers: {} }).currentStep, "3");
  assert.equal(publicSaveSchema.parse({ currentStep: "3" }).currentStep, "3");
  assert.equal(publicSaveSchema.parse({}).currentStep, undefined);
});

test("REGRESSION: a finished (ACTIVE) submission is NOT writable (live 2026-07-27 — a second submit renamed a built tenant)", () => {
  // Only the two pre-submit statuses may write; everything after submit is
  // locked, including the statuses the orchestrator sets on completion.
  assert.equal(isSubmissionWriteBlocked({ status: "INVITE_SENT" }), false);
  assert.equal(isSubmissionWriteBlocked({ status: "IN_PROGRESS" }), false);
  for (const s of ["SUBMITTED", "AWAITING_PBX_SETUP", "AWAITING_PORT", "AWAITING_PAYMENT", "READY_TO_SYNC", "ACTIVE", "COMPLETED", "CANCELED"]) {
    assert.equal(isSubmissionWriteBlocked({ status: s }), true, `${s} must be write-blocked`);
  }
  // Unknown/blank statuses fail closed.
  assert.equal(isSubmissionWriteBlocked({ status: "" }), true);
  assert.equal(isSubmissionWriteBlocked({}), true);
});

test("reusable test templates are spawn-only — never writable, whatever their status", () => {
  const template = { status: "INVITE_SENT", answers: { reusableTestLink: true } };
  assert.equal(isReusableTemplate(template), true);
  assert.equal(isSubmissionWriteBlocked(template), true);
  assert.equal(isReusableTemplate({ status: "INVITE_SENT", answers: {} }), false);
});

test("submit: extensions still validated (numeric, vm password digits)", () => {
  assert.throws(() => extensionInputSchema.parse({ extNumber: "10a" }));
  assert.throws(() => extensionInputSchema.parse({ extNumber: "101", vmPassword: "abcd" }));
  assert.doesNotThrow(() => extensionInputSchema.parse({ extNumber: "101", vmPassword: "1234" }));
});
