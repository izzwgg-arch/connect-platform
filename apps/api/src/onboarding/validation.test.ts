// Schema tests for the public onboarding payloads: optional billing email,
// cell-phone routing fields, and the apply-number payload.

import test from "node:test";
import assert from "node:assert/strict";
import { publicSubmitSchema, publicApplyNumberSchema, extensionInputSchema } from "./validation";

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

test("submit: extensions still validated (numeric, vm password digits)", () => {
  assert.throws(() => extensionInputSchema.parse({ extNumber: "10a" }));
  assert.throws(() => extensionInputSchema.parse({ extNumber: "101", vmPassword: "abcd" }));
  assert.doesNotThrow(() => extensionInputSchema.parse({ extNumber: "101", vmPassword: "1234" }));
});
