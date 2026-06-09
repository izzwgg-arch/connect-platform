import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  analyzeWebsiteSubmissionSample,
  extractWebsiteSubmissionFields,
  redactSensitiveText,
  ruleMatchesEmail,
} from "./websiteSubmissionExtraction";

const dir = dirname(fileURLToPath(import.meta.url));
const emailRoutesSource = readFileSync(join(dir, "emailRoutes.ts"), "utf8");
const processorSource = readFileSync(join(dir, "websiteSubmissionProcessor.ts"), "utf8");

test("website submission sample maps only supported CRM fields", () => {
  const sample = [
    "From: forms@example.com",
    "Subject: New Website Lead #123",
    "",
    "First Name: Ada",
    "Last Name: Lovelace",
    "Email: ada@example.test",
    "Phone: (555) 123-4567",
    "Favorite color: blue",
  ].join("\n");
  const analysis = analyzeWebsiteSubmissionSample({ rawEmail: sample });
  assert.equal(analysis.detectedSenderDomain, "example.com");
  assert.equal(analysis.mappedFields.firstName, "Ada");
  assert.equal(analysis.mappedFields.lastName, "Lovelace");
  assert.equal(analysis.mappedFields.email, "ada@example.test");
  assert.ok(analysis.unmappedSummary.some((line) => line.includes("favorite color")));
});

test("website submission extraction redacts sensitive values from summary", () => {
  const result = extractWebsiteSubmissionFields("Name: Jane Doe\nSSN: 123-45-6789\nBank Account: 123456789012");
  assert.equal(result.mappedFields.displayName, "Jane Doe");
  assert.doesNotMatch(JSON.stringify(result.unmappedSummary), /123-45-6789/);
  assert.match(JSON.stringify(result.unmappedSummary), /\[redacted:/);
});

test("rule matching respects sender/domain and subject patterns", () => {
  assert.equal(ruleMatchesEmail(
    { senderDomain: "example.com", subjectPattern: "New Lead" },
    { fromEmail: "forms@example.com", subject: "New Lead from website", body: "First Name: Ada" },
  ), true);
  assert.equal(ruleMatchesEmail(
    { senderDomain: "example.com", subjectPattern: "New Lead" },
    { fromEmail: "forms@other.test", subject: "New Lead from website", body: "First Name: Ada" },
  ), false);
});

test("email routes expose admin-gated website submission rule endpoints", () => {
  const block = emailRoutesSource.slice(
    emailRoutesSource.indexOf('app.get("/crm/email/website-submission-rules"'),
    emailRoutesSource.indexOf('app.post("/crm/email/sync-now"'),
  );
  assert.match(block, /requireCrmEmailSettingsAccess/);
  assert.match(block, /analyzeWebsiteSubmissionSample/);
  assert.match(block, /CRM_WEBSITE_SUBMISSION_RULE_CREATED/);
  assert.match(block, /loadWebsiteRuleConnection/);
});

test("processor creates contact docs notifications and avoids duplicate message ids", () => {
  assert.match(processorSource, /tenantId_gmailMessageId/);
  assert.match(processorSource, /source: "EMAIL_ATTACHMENT"/);
  assert.match(processorSource, /crmUserNotification\.create/);
  assert.match(processorSource, /type: "WEBSITE_SUBMISSION"/);
  assert.match(processorSource, /lowConfidence \|\| rule\.mode === "REVIEW_FIRST" \? "PENDING_REVIEW" : "PROCESSED"/);
});

test("redactSensitiveText masks SSN and account-like numbers", () => {
  const text = redactSensitiveText("SSN 123-45-6789 account 1234567890123456");
  assert.doesNotMatch(text, /123-45-6789/);
  assert.doesNotMatch(text, /1234567890123456/);
  assert.match(text, /\[redacted:/);
});
