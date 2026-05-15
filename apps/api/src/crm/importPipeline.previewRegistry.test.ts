import test from "node:test";
import assert from "node:assert/strict";
import { CampaignImportPreviewRegistry } from "./importPipeline";

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
