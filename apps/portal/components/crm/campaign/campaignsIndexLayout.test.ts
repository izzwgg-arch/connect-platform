import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { campaignsIndexLayout } from "./campaignsIndexLayout";

const here = dirname(fileURLToPath(import.meta.url));
const campaignsPagePath = join(here, "../../../app/(platform)/crm/campaigns/page.tsx");

test("campaigns index layout uses document-flow grid classes", () => {
  assert.equal(campaignsIndexLayout.workspaceGrid, "campaigns-workspace-grid");
  assert.equal(campaignsIndexLayout.tableScroll, "campaigns-table-scroll");
});

test("campaigns index avoids workspace scroll trap and bottom quick action strip", () => {
  const src = readFileSync(campaignsPagePath, "utf8");
  assert.doesNotMatch(src, /CRMWorkspaceShell/);
  assert.doesNotMatch(src, /CRMWorkspaceScrollRegion/);
  assert.doesNotMatch(src, /CampaignQuickActionStrip/);
  assert.match(src, /campaigns-workspace-grid/);
});
