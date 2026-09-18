import assert from "node:assert/strict";
import { test } from "node:test";
import { coerceFields, coerceFieldValue, initialFieldValues, validateFields, type OpportunityField } from "./dynamicFields";

const VENDORS_SCHEMA: OpportunityField[] = [
  { key: "need", label: "What you need", type: "text", required: true },
  { key: "budget", label: "Budget", type: "money", required: true },
  { key: "deadline", label: "Deadline", type: "date", required: true },
];

const REAL_ESTATE_SCHEMA: OpportunityField[] = [
  { key: "propertyType", label: "Property type", type: "select", required: true, options: ["Office", "Retail", "Industrial", "Land", "Mixed use"] },
  { key: "sqft", label: "Square feet", type: "number", required: true },
  { key: "term", label: "Term", type: "select", required: true, options: ["Sale", "Lease", "Sublease"] },
];

const WHOLESALE_SCHEMA: OpportunityField[] = [
  { key: "regions", label: "Regions", type: "multiselect", required: true, options: ["Northeast", "Midwest", "West"] },
];

test("a fully valid submission has no errors", () => {
  const errors = validateFields(VENDORS_SCHEMA, { need: "Signage", budget: 5000, deadline: "2026-12-01" });
  assert.deepEqual(errors, []);
});

test("a missing required field reports 'X is required.'", () => {
  const errors = validateFields(VENDORS_SCHEMA, { need: "Signage" });
  assert.deepEqual(errors, ["Budget is required.", "Deadline is required."]);
});

test("an optional field left out is not an error", () => {
  const schema: OpportunityField[] = [{ key: "note", label: "Note", type: "text", required: false }];
  assert.deepEqual(validateFields(schema, {}), []);
});

test("a money field must be a non-negative number", () => {
  assert.deepEqual(validateFields(VENDORS_SCHEMA, { need: "x", budget: -5, deadline: "2026-01-01" }), ["Budget must be a positive amount."]);
  assert.deepEqual(validateFields(VENDORS_SCHEMA, { need: "x", budget: "5000", deadline: "2026-01-01" }), ["Budget must be a positive amount."]);
});

test("a date field must parse as a valid date", () => {
  assert.deepEqual(validateFields(VENDORS_SCHEMA, { need: "x", budget: 1, deadline: "not a date" }), ["Deadline must be a valid date."]);
});

test("a select field must be one of its options, sentence lists them", () => {
  const errors = validateFields(REAL_ESTATE_SCHEMA, { propertyType: "Yacht", sqft: 500, term: "Sale" });
  assert.deepEqual(errors, ["Property type must be one of: Office, Retail, Industrial, Land, Mixed use."]);
});

test("a multiselect field must be a non-empty array drawn from its options", () => {
  assert.deepEqual(validateFields(WHOLESALE_SCHEMA, { regions: [] }), ["Regions must be chosen from: Northeast, Midwest, West."]);
  assert.deepEqual(validateFields(WHOLESALE_SCHEMA, { regions: ["Mars"] }), ["Regions must be chosen from: Northeast, Midwest, West."]);
  assert.deepEqual(validateFields(WHOLESALE_SCHEMA, { regions: ["Midwest", "West"] }), []);
});

test("a number field rejects a non-numeric value", () => {
  assert.deepEqual(validateFields(REAL_ESTATE_SCHEMA, { propertyType: "Office", sqft: "big", term: "Sale" }), ["Square feet must be a number."]);
});

test("initialFieldValues gives every field a typed starting value", () => {
  assert.deepEqual(initialFieldValues(VENDORS_SCHEMA), { need: "", budget: "", deadline: "" });
  assert.deepEqual(initialFieldValues(WHOLESALE_SCHEMA), { regions: [] });
  const boolSchema: OpportunityField[] = [{ key: "urgent", label: "Urgent", type: "boolean" }];
  assert.deepEqual(initialFieldValues(boolSchema), { urgent: false });
});

test("coerceFieldValue turns numeric text into a number, and blank text into undefined", () => {
  const moneyField: OpportunityField = { key: "budget", label: "Budget", type: "money" };
  assert.equal(coerceFieldValue(moneyField, "5000"), 5000);
  assert.equal(coerceFieldValue(moneyField, ""), undefined);
  const textField: OpportunityField = { key: "need", label: "Need", type: "text" };
  assert.equal(coerceFieldValue(textField, ""), undefined);
  assert.equal(coerceFieldValue(textField, "Signage"), "Signage");
});

test("coerceFields drops blank optional fields so validateFields doesn't see a bad type for an absent value", () => {
  const schema: OpportunityField[] = [
    { key: "need", label: "Need", type: "text", required: true },
    { key: "note", label: "Note", type: "text", required: false },
  ];
  const coerced = coerceFields(schema, { need: "Signage", note: "" });
  assert.deepEqual(coerced, { need: "Signage" });
  assert.deepEqual(validateFields(schema, coerced), []);
});

test("a full round trip: raw string form values coerce and validate cleanly for a real-estate posting", () => {
  const raw = { propertyType: "Office", sqft: "2500", term: "Lease" };
  const coerced = coerceFields(REAL_ESTATE_SCHEMA, raw);
  assert.deepEqual(coerced, { propertyType: "Office", sqft: 2500, term: "Lease" });
  assert.deepEqual(validateFields(REAL_ESTATE_SCHEMA, coerced), []);
});
