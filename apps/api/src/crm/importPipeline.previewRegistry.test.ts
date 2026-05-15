import test from "node:test";
import assert from "node:assert/strict";
import {
  CampaignImportPreviewRegistry,
  crmCampaignImportBatchFilePrefix,
  displayFileNameFromCrmImportBatchStoredName,
  parseCrmImportBatchCampaignId,
} from "./importPipeline";

test("preview registry dedupes same phone across synthetic creates", () => {
  const reg = new CampaignImportPreviewRegistry();
  const id1 = reg.createSyntheticFromRow({ phoneNorm: "5551234567", emailRaw: "" });
  assert.equal(reg.lookup("5551234567", ""), id1);
  const id2 = reg.createSyntheticFromRow({ phoneNorm: "999", emailRaw: "a@b.co" });
  assert.notEqual(id1, id2);
});

test("registerAliasesForExisting links new email to synthetic id", () => {
  const reg = new CampaignImportPreviewRegistry();
  const id = reg.createSyntheticFromRow({ phoneNorm: "111", emailRaw: "" });
  reg.registerAliasesForExisting(id, "111", "x@example.test");
  assert.equal(reg.lookup("111", "x@example.test"), id);
});

test("campaign import batch file prefix is stable for DB queries", () => {
  const cid = "clxyzcampaignid012";
  assert.equal(crmCampaignImportBatchFilePrefix(cid), `campaign:${cid}:`);
});

test("display name strips campaign tag for known campaign", () => {
  const cid = "camp1";
  const stored = `${crmCampaignImportBatchFilePrefix(cid)}leads-may.csv`;
  assert.equal(displayFileNameFromCrmImportBatchStoredName(stored), "leads-may.csv");
});

test("display name leaves standalone imports unchanged", () => {
  assert.equal(displayFileNameFromCrmImportBatchStoredName("normal-upload.csv"), "normal-upload.csv");
});

test("prefix + original reproduces stored campaign import fileName", () => {
  const cid = "c2";
  const orig = "foo.csv";
  const stored = `${crmCampaignImportBatchFilePrefix(cid)}${orig}`;
  assert.ok(stored.startsWith(crmCampaignImportBatchFilePrefix(cid)));
  assert.equal(displayFileNameFromCrmImportBatchStoredName(stored), orig);
});

test("parseCrmImportBatchCampaignId extracts campaign id from stored name", () => {
  assert.equal(parseCrmImportBatchCampaignId("campaign:abc123:file.csv"), "abc123");
  assert.equal(parseCrmImportBatchCampaignId("normal.csv"), null);
});
