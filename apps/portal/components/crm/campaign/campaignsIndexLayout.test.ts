import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { campaignsIndexLayout } from "./campaignsIndexLayout";

const here = dirname(fileURLToPath(import.meta.url));
const campaignsPagePath = join(here, "../../../app/(platform)/crm/campaigns/page.tsx");

test("campaigns index layout exposes workspace scroll region classes", () => {
  assert.equal(campaignsIndexLayout.tableScroll, "campaigns-table-scroll");
  assert.equal(campaignsIndexLayout.rightRailScroll, "campaigns-right-rail-scroll");
  assert.match(campaignsIndexLayout.pageInner, /crm-campaign-index-inner/);
});

test("campaigns index page uses workspace shell and omits bottom quick action strip", () => {
  const src = readFileSync(campaignsPagePath, "utf8");
  assert.match(src, /CRMWorkspaceShell/);
  assert.match(src, /CRMWorkspaceScrollRegion/);
  assert.doesNotMatch(src, /CampaignQuickActionStrip/);
  assert.doesNotMatch(src, /pb-36/);
});
