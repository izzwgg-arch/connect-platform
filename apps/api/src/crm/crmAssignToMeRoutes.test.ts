import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function readRoute(pathFromApiRoot: string) {
  const cwd = process.cwd();
  const localPath = resolve(cwd, pathFromApiRoot);
  if (existsSync(localPath)) return readFileSync(localPath, "utf8");
  return readFileSync(resolve(cwd, "apps/api", pathFromApiRoot), "utf8");
}

const contactRoutesSource = readRoute("src/crm/contactRoutes.ts");
const importRoutesSource = readRoute("src/crm/importRoutes.ts");

test("contacts assign-to-me route requires CRM access and campaign allow-list", () => {
  assert.match(contactRoutesSource, /app\.post\("\/crm\/contacts\/assign-to-me"[\s\S]*?requireCrmAccess/);
  assert.match(contactRoutesSource, /app\.post\("\/crm\/contacts\/assign-to-me"[\s\S]*?assertCrmCampaignAllowed/);
});

test("contacts assign-to-me route only assigns caller as queue assignee", () => {
  assert.match(contactRoutesSource, /assignedToUserId:\s*userId/);
  assert.doesNotMatch(contactRoutesSource, /app\.post\("\/crm\/contacts\/assign-to-me"[\s\S]*?assignedToUserId:\s*parsed\.data/);
});

test("contacts assign-to-me route blocks other-owned contacts and members", () => {
  assert.match(contactRoutesSource, /contactIdsOwnedByOther/);
  assert.match(contactRoutesSource, /existingAssignedToOther/);
  assert.match(contactRoutesSource, /skippedAssigned/);
});

test("contacts list campaign filter is tenant and campaign scoped", () => {
  assert.match(contactRoutesSource, /campaignId:\s*z\.string\(\)\.optional\(\)/);
  assert.match(contactRoutesSource, /assertCrmCampaignAllowed\(user,\s*campaignId,\s*reply\)/);
  assert.match(contactRoutesSource, /crmCampaignMembers:\s*\{\s*some:\s*\{\s*tenantId,\s*campaignId/s);
});

test("standalone import can enroll imported leads into My Queue for importer only", () => {
  assert.match(importRoutesSource, /const assignToMe = .*assignToMe/);
  assert.match(importRoutesSource, /assertCrmCampaignAllowed\(user,\s*campaignId,\s*reply\)/);
  assert.match(importRoutesSource, /assignedToUserId:\s*userId/);
  assert.doesNotMatch(importRoutesSource, /assignedToUserId:\s*fields\.assignedToUserId/);
});

test("standalone import requires active destination campaign for My Queue", () => {
  assert.match(importRoutesSource, /campaign_required/);
  assert.match(importRoutesSource, /campaign_not_active/);
});
