/**
 * Unit tests for CRM bulk email worker logic.
 *
 * Tests cover:
 *  - renderTemplate: token substitution, missing tokens, nested tokens
 *  - buildContactVars: name splitting, email/phone/city/state
 *  - buildFunderVars: organization, funder-specific tokens
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderTemplate, buildContactVars, buildFunderVars } from "./crmBulkEmailJob";

// ── renderTemplate ─────────────────────────────────────────────────────────────

test("renderTemplate: replaces a simple token", () => {
  const result = renderTemplate("Hello {{firstName}}", { firstName: "Alice" });
  assert.equal(result, "Hello Alice");
});

test("renderTemplate: replaces dotted token", () => {
  const result = renderTemplate("Hi {{contact.firstName}}", { "contact.firstName": "Bob" });
  assert.equal(result, "Hi Bob");
});

test("renderTemplate: unknown token becomes empty string", () => {
  const result = renderTemplate("Hello {{unknown}}", {});
  assert.equal(result, "Hello ");
});

test("renderTemplate: multiple tokens in one template", () => {
  const result = renderTemplate(
    "Dear {{firstName}} {{lastName}}, your company is {{company}}.",
    { firstName: "Jane", lastName: "Doe", company: "Acme" },
  );
  assert.equal(result, "Dear Jane Doe, your company is Acme.");
});

test("renderTemplate: no tokens returns template unchanged", () => {
  const result = renderTemplate("No tokens here.", { firstName: "X" });
  assert.equal(result, "No tokens here.");
});

test("renderTemplate: missing var falls back to empty string, not 'undefined'", () => {
  const result = renderTemplate("{{missing}}", {});
  assert.equal(result, "");
  assert.ok(!result.includes("undefined"));
});

test("renderTemplate: subject line with merge tokens", () => {
  const result = renderTemplate(
    "Follow-up for {{contact.company}} — Attn: {{contact.firstName}}",
    { "contact.company": "Acme Corp", "contact.firstName": "John" },
  );
  assert.equal(result, "Follow-up for Acme Corp — Attn: John");
});

// ── buildContactVars ───────────────────────────────────────────────────────────

test("buildContactVars: full name split into first/last", () => {
  const vars = buildContactVars({
    firstName: "Alice",
    lastName: "Smith",
    displayName: "Alice Smith",
    company: "Acme",
    title: "CEO",
    primaryEmail: { email: "alice@acme.com" },
    primaryPhone: { numberRaw: "+15551234567" },
  });
  assert.equal(vars["firstName"], "Alice");
  assert.equal(vars["lastName"], "Smith");
  assert.equal(vars["name"], "Alice Smith");
  assert.equal(vars["company"], "Acme");
  assert.equal(vars["email"], "alice@acme.com");
  assert.equal(vars["phone"], "+15551234567");
});

test("buildContactVars: dotted tokens match plain tokens", () => {
  const vars = buildContactVars({
    firstName: "Bob",
    lastName: "Jones",
    displayName: "Bob Jones",
    company: null,
    primaryEmail: null,
    primaryPhone: null,
  });
  assert.equal(vars["contact.firstName"], vars["firstName"]);
  assert.equal(vars["contact.lastName"], vars["lastName"]);
  assert.equal(vars["contact.name"], vars["name"]);
});

test("buildContactVars: falls back to displayName split when firstName null", () => {
  const vars = buildContactVars({
    firstName: null,
    lastName: null,
    displayName: "Charlie Brown",
    company: null,
    primaryEmail: null,
    primaryPhone: null,
  });
  assert.equal(vars["firstName"], "Charlie");
  assert.equal(vars["lastName"], "Brown");
});

test("buildContactVars: missing email/phone become empty strings", () => {
  const vars = buildContactVars({
    firstName: "X",
    lastName: "Y",
    displayName: "X Y",
    company: null,
    primaryEmail: null,
    primaryPhone: null,
  });
  assert.equal(vars["email"], "");
  assert.equal(vars["phone"], "");
});

// ── buildFunderVars ────────────────────────────────────────────────────────────

test("buildFunderVars: basic funder fields", () => {
  const vars = buildFunderVars({
    name: "John Funder",
    organization: "Funder Co",
    email: "john@funder.com",
    phone: "+15559876543",
    city: "Austin",
    state: "TX",
  });
  assert.equal(vars["name"], "John Funder");
  assert.equal(vars["organization"], "Funder Co");
  assert.equal(vars["funder.organization"], "Funder Co");
  assert.equal(vars["email"], "john@funder.com");
  assert.equal(vars["city"], "Austin");
  assert.equal(vars["state"], "TX");
});

test("buildFunderVars: funder.name token", () => {
  const vars = buildFunderVars({
    name: "Jane Funder",
    organization: null,
    email: null,
    phone: null,
    city: null,
    state: null,
  });
  assert.equal(vars["funder.name"], "Jane Funder");
  assert.equal(vars["organization"], "");
  assert.equal(vars["email"], "");
});

test("buildFunderVars: firstName is first word of name", () => {
  const vars = buildFunderVars({
    name: "Robert Johnson",
    organization: null,
    email: null,
    phone: null,
    city: null,
    state: null,
  });
  assert.equal(vars["firstName"], "Robert");
  assert.equal(vars["lastName"], "Johnson");
});

// ── Integration: renderTemplate with buildContactVars ─────────────────────────

test("renderTemplate + buildContactVars: full email render", () => {
  const vars = buildContactVars({
    firstName: "Sarah",
    lastName: "Connor",
    displayName: "Sarah Connor",
    company: "Skynet",
    title: null,
    primaryEmail: { email: "sarah@skynet.com" },
    primaryPhone: null,
  });
  const subject = renderTemplate("Hello {{firstName}}, update from {{company}}", vars);
  const body = renderTemplate(
    "Dear {{contact.firstName}} {{contact.lastName}},\n\nThis is regarding your account at {{contact.company}}.\n\nBest,\nTeam",
    vars,
  );
  assert.equal(subject, "Hello Sarah, update from Skynet");
  assert.ok(body.includes("Dear Sarah Connor"));
  assert.ok(body.includes("Skynet"));
});
