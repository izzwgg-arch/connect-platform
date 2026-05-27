import test from "node:test";
import assert from "node:assert/strict";
import {
  CampaignImportPreviewRegistry,
  crmCampaignImportBatchFilePrefix,
  displayFileNameFromCrmImportBatchStoredName,
  parseCrmImportBatchCampaignId,
  autoMapHeaders,
  parseCsv,
  mappingHasPhoneOrEmail,
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

// ── autoMapHeaders — new field aliases ─────────────────────────────────────

test("autoMapHeaders maps Phone1 (case-insensitive) to phone", () => {
  const m = autoMapHeaders(["Phone1", "email"]);
  assert.equal(m[0], "phone");
  assert.equal(m[1], "email");
});

test("autoMapHeaders maps phone2 to phone2", () => {
  const m = autoMapHeaders(["phone", "phone2"]);
  assert.equal(m[0], "phone");
  assert.equal(m[1], "phone2");
});

test("autoMapHeaders maps 'Phone2' (mixed case) to phone2", () => {
  const m = autoMapHeaders(["Phone2"]);
  assert.equal(m[0], "phone2");
});

test("autoMapHeaders maps 'secondary phone' to phone2", () => {
  const m = autoMapHeaders(["secondary phone"]);
  assert.equal(m[0], "phone2");
});

test("autoMapHeaders maps 'owner nme' (misspelled) to displayName", () => {
  const m = autoMapHeaders(["owner nme", "email"]);
  assert.equal(m[0], "displayName");
});

test("autoMapHeaders maps 'owner name' to displayName", () => {
  const m = autoMapHeaders(["owner name"]);
  assert.equal(m[0], "displayName");
});

test("autoMapHeaders maps address fields correctly", () => {
  const m = autoMapHeaders(["address", "city", "state", "zip"]);
  assert.equal(m[0], "address");
  assert.equal(m[1], "city");
  assert.equal(m[2], "state");
  assert.equal(m[3], "zip");
});

test("autoMapHeaders maps 'street address' to address", () => {
  const m = autoMapHeaders(["street address"]);
  assert.equal(m[0], "address");
});

test("autoMapHeaders maps 'postal code' to zip", () => {
  const m = autoMapHeaders(["postal code"]);
  assert.equal(m[0], "zip");
});

test("autoMapHeaders maps 'st' to state", () => {
  const m = autoMapHeaders(["phone", "st"]);
  assert.equal(m[1], "state");
});

test("autoMapHeaders maps full fixture row: Phone1,phone2,owner nme,address,city,state,email,company", () => {
  const headers = ["Phone1", "phone2", "owner nme", "address", "city", "state", "email", "company"];
  const m = autoMapHeaders(headers);
  assert.equal(m[0], "phone");
  assert.equal(m[1], "phone2");
  assert.equal(m[2], "displayName");
  assert.equal(m[3], "address");
  assert.equal(m[4], "city");
  assert.equal(m[5], "state");
  assert.equal(m[6], "email");
  assert.equal(m[7], "company");
});

test("autoMapHeaders is case-insensitive for all aliases", () => {
  const m = autoMapHeaders(["PHONE", "EMAIL", "COMPANY", "ADDRESS", "CITY", "STATE", "ZIP"]);
  assert.equal(m[0], "phone");
  assert.equal(m[1], "email");
  assert.equal(m[2], "company");
  assert.equal(m[3], "address");
  assert.equal(m[4], "city");
  assert.equal(m[5], "state");
  assert.equal(m[6], "zip");
});

test("autoMapHeaders trims whitespace from headers", () => {
  const m = autoMapHeaders(["  phone  ", " email "]);
  assert.equal(m[0], "phone");
  assert.equal(m[1], "email");
});

test("autoMapHeaders does not map same field twice", () => {
  // Both 'phone' and 'phone1' map to 'phone'; only the first should win
  const m = autoMapHeaders(["phone", "phone1"]);
  assert.equal(m[0], "phone");
  assert.equal(m[1], undefined);
});

// ── parseCsv — fixture rows ─────────────────────────────────────────────────

// ── mappingHasPhoneOrEmail ──────────────────────────────────────────────────

test("mappingHasPhoneOrEmail returns true when phone is mapped", () => {
  const m = autoMapHeaders(["Phone1", "address"]);
  assert.equal(mappingHasPhoneOrEmail(m), true);
});

test("mappingHasPhoneOrEmail returns true when email is mapped", () => {
  const m = autoMapHeaders(["email address", "city"]);
  assert.equal(mappingHasPhoneOrEmail(m), true);
});

test("mappingHasPhoneOrEmail returns false when only unmappable headers", () => {
  const m = autoMapHeaders(["notes", "company"]);
  assert.equal(mappingHasPhoneOrEmail(m), false);
});

test("mappingHasPhoneOrEmail returns false for empty mapping", () => {
  assert.equal(mappingHasPhoneOrEmail({}), false);
});

test("mappingHasPhoneOrEmail returns true with both phone and email present", () => {
  const m = autoMapHeaders(["phone", "email", "city"]);
  assert.equal(mappingHasPhoneOrEmail(m), true);
});

// ── CampaignImportPreviewRegistry — campaign member dedup ───────────────────

test("registry dedupes same contact id in enrolled set (mirrors campaign member dedup)", () => {
  const reg = new CampaignImportPreviewRegistry();
  const id1 = reg.createSyntheticFromRow({ phoneNorm: "5551234567", emailRaw: "" });
  // Simulate a second row with the same phone → should resolve to the same id
  const looked = reg.lookup("5551234567", "");
  assert.equal(looked, id1, "same phone must resolve to same synthetic id");
  // The enrolledContactIds Set in the import engine prevents double-member creation:
  // we verify the lookup is deterministic so the Set can dedup correctly.
  assert.equal(reg.lookup("5551234567", ""), id1);
});

test("registry lookup by email when phone differs finds same synthetic contact", () => {
  const reg = new CampaignImportPreviewRegistry();
  const id1 = reg.createSyntheticFromRow({ phoneNorm: "1234567890", emailRaw: "shared@example.com" });
  // A second row for same email but no phone should resolve to the same id
  reg.registerAliasesForExisting(id1, "", "shared@example.com");
  assert.equal(reg.lookup("", "shared@example.com"), id1);
});

test("registry does not merge two distinct contacts (different phone and email)", () => {
  const reg = new CampaignImportPreviewRegistry();
  const id1 = reg.createSyntheticFromRow({ phoneNorm: "1111111111", emailRaw: "a@test.com" });
  const id2 = reg.createSyntheticFromRow({ phoneNorm: "2222222222", emailRaw: "b@test.com" });
  assert.notEqual(id1, id2, "distinct contacts must get distinct synthetic ids");
  assert.equal(reg.lookup("1111111111", "a@test.com"), id1);
  assert.equal(reg.lookup("2222222222", "b@test.com"), id2);
});

test("campaign import batch filename is tied to campaign id (generic import cannot spoof)", () => {
  const campaignId = "camp_abc";
  const stored = `${crmCampaignImportBatchFilePrefix(campaignId)}leads.csv`;
  assert.equal(parseCrmImportBatchCampaignId(stored), campaignId);
  // A generic (non-campaign) import filename has no campaign prefix
  assert.equal(parseCrmImportBatchCampaignId("standalone.csv"), null);
});

// ── parseCsv — fixture rows ─────────────────────────────────────────────────

test("parseCsv parses fixture header and two data rows correctly", () => {
  const csv = [
    "Phone1,phone2,owner nme,address,city,state,email,company",
    "9087531655,,Vitalino Castano,36 Watchung Ave,PLAINFIELD,NJ,vitalino@example.com,Example Co",
    "2402866010,2024199029,Edward Wilburn,7111 Allentown Rd,Fort Washington,MD,edward@example.com,Example Co",
  ].join("\n");

  const rows = parseCsv(csv);
  assert.equal(rows.length, 3);

  const [header, row1, row2] = rows;
  assert.deepEqual(header, ["Phone1", "phone2", "owner nme", "address", "city", "state", "email", "company"]);

  // Row 1: phone2 is empty
  assert.equal(row1![0], "9087531655");
  assert.equal(row1![1], "");
  assert.equal(row1![2], "Vitalino Castano");
  assert.equal(row1![3], "36 Watchung Ave");
  assert.equal(row1![4], "PLAINFIELD");
  assert.equal(row1![5], "NJ");
  assert.equal(row1![6], "vitalino@example.com");
  assert.equal(row1![7], "Example Co");

  // Row 2: two phone numbers
  assert.equal(row2![0], "2402866010");
  assert.equal(row2![1], "2024199029");
  assert.equal(row2![2], "Edward Wilburn");
  assert.equal(row2![3], "7111 Allentown Rd");
  assert.equal(row2![4], "Fort Washington");
  assert.equal(row2![5], "MD");
  assert.equal(row2![6], "edward@example.com");
  assert.equal(row2![7], "Example Co");
});
