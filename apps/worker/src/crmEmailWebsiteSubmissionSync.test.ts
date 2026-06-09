import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const syncSource = readFileSync(join(process.cwd(), "src", "crmEmailSync.ts"), "utf8");

test("website submission scan is rule-gated and can be disabled by env", () => {
  const block = syncSource.slice(
    syncSource.indexOf("async function runWebsiteSubmissionRuleScan"),
    syncSource.indexOf("export async function processCrmEmailSyncJob"),
  );
  assert.match(block, /CRM_WEBSITE_SUBMISSION_EMAIL_ENABLED/);
  assert.match(block, /crmWebsiteSubmissionEmailRule\.findMany/);
  assert.match(block, /active: true/);
});

test("website submission scan processes full bodies only after active rules exist", () => {
  const block = syncSource.slice(
    syncSource.indexOf("async function runWebsiteSubmissionRuleScan"),
    syncSource.indexOf("export async function processCrmEmailSyncJob"),
  );
  assert.match(block, /messages\/\$\{encodeURIComponent\(msgId\)\}/);
  assert.match(block, /format", "full"/);
  assert.match(block, /ruleMatchesEmail/);
  assert.match(block, /processWebsiteSubmissionEmail/);
});

test("existing tracked-thread reply sync remains present and classified as inbound", () => {
  assert.match(syncSource, /Known CRM threads for this connection/);
  assert.match(syncSource, /threads\/\$\{encodeURIComponent\(t\.gmailThreadId\)\}/);
  assert.match(syncSource, /classifyGmailMessage\(\{ labelIds: labels, fromEmail, senderEmailAddress: conn\.emailAddress \}\)/);
  assert.match(syncSource, /type: "EMAIL_REPLY"/);
});

test("audit includes website submission aggregate counts only", () => {
  assert.match(syncSource, /websiteSubmissionCandidates/);
  assert.match(syncSource, /websiteSubmissionMatched/);
  assert.match(syncSource, /websiteSubmissionProcessed/);
  assert.match(syncSource, /websiteSubmissionErrors/);
});
