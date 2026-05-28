/**
 * Tests for diagnoseWebhookSignature and verifyCardknoxSignature.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { verifyCardknoxSignature, diagnoseWebhookSignature } from "@connect/integrations";

// ── verifyCardknoxSignature ───────────────────────────────────────────────────

test("verifyCardknoxSignature: valid form-encoded body + correct PIN returns true", () => {
  const pin = "testpin123";
  // Cardknox signature: MD5(sorted field values + pin)
  const fields = { xResult: "A", xRefNum: "12345", xStatus: "Approved" };
  const sorted = Object.keys(fields)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((k) => String((fields as any)[k]));
  const source = sorted.join("") + pin;
  const sig = createHash("md5").update(source).digest("hex");

  const rawBody = new URLSearchParams(fields).toString();
  assert.equal(verifyCardknoxSignature(rawBody, sig, pin), true);
});

test("verifyCardknoxSignature: wrong PIN returns false", () => {
  const fields = { xResult: "A", xRefNum: "12345" };
  const rawBody = new URLSearchParams(fields).toString();
  assert.equal(verifyCardknoxSignature(rawBody, "somesig", "wrongpin"), false);
});

test("verifyCardknoxSignature: JSON body (Fastify serialization bug) returns false", () => {
  // Simulates the old bug: Fastify parses form body → object → JSON.stringify
  const fields = { xResult: "A", xRefNum: "12345", xStatus: "Approved" };
  const pin = "realpin";
  const sorted = Object.keys(fields)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((k) => String((fields as any)[k]));
  const correctSig = createHash("md5").update(sorted.join("") + pin).digest("hex");

  // Pass the JSON representation instead of form-encoded (the old bug)
  const jsonBody = JSON.stringify(fields);
  assert.equal(verifyCardknoxSignature(jsonBody, correctSig, pin), false,
    "JSON body should NOT verify against form-encoded signature (this was the bug)");
});

test("verifyCardknoxSignature: missing signature returns false", () => {
  assert.equal(verifyCardknoxSignature("xResult=A&xRefNum=123", undefined, "pin"), false);
});

test("verifyCardknoxSignature: missing webhookPin returns false", () => {
  assert.equal(verifyCardknoxSignature("xResult=A&xRefNum=123", "anysig", undefined), false);
});

// ── diagnoseWebhookSignature ──────────────────────────────────────────────────

test("diagnoseWebhookSignature: no headers returns no_header for both", () => {
  const result = diagnoseWebhookSignature({}, "xResult=A", "pin");
  assert.equal(result.hasCkSignature, false);
  assert.equal(result.hasSolaSignature, false);
  assert.equal(result.ckSignatureResult, "no_header");
  assert.equal(result.solaSignatureResult, "no_header");
});

test("diagnoseWebhookSignature: correct ck-signature returns match", () => {
  const pin = "mypin";
  const fields = { xResult: "A", xStatus: "Approved" };
  const rawBody = new URLSearchParams(fields).toString();
  const sorted = Object.keys(fields)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((k) => String((fields as any)[k]));
  const sig = createHash("md5").update(sorted.join("") + pin).digest("hex");

  const result = diagnoseWebhookSignature({ "ck-signature": sig }, rawBody, pin);
  assert.equal(result.ckSignatureResult, "match");
});

test("diagnoseWebhookSignature: wrong ck-signature returns mismatch", () => {
  const result = diagnoseWebhookSignature({ "ck-signature": "badsig" }, "xResult=A", "pin");
  assert.equal(result.ckSignatureResult, "mismatch");
});

test("diagnoseWebhookSignature: no webhookSecret with header returns no_secret", () => {
  const result = diagnoseWebhookSignature({ "ck-signature": "anysig" }, "xResult=A", undefined);
  assert.equal(result.ckSignatureResult, "no_secret");
  assert.equal(result.hasWebhookSecret, false);
});

test("diagnoseWebhookSignature: detects JSON vs form-encoded body", () => {
  const jsonResult = diagnoseWebhookSignature({}, JSON.stringify({ xResult: "A" }), "pin");
  assert.equal(jsonResult.rawBodyIsJson, true);
  assert.equal(jsonResult.rawBodyIsFormEncoded, false);

  const formResult = diagnoseWebhookSignature({}, "xResult=A&xStatus=Approved", "pin");
  assert.equal(formResult.rawBodyIsJson, false);
  assert.equal(formResult.rawBodyIsFormEncoded, true);
});
