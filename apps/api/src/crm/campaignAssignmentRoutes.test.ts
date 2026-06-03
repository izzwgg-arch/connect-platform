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

const campaignRoutesSource = readRoute("src/crm/campaignRoutes.ts");

test("campaign bulk assignment permits CRM access users for self-assignment", () => {
  assert.match(campaignRoutesSource, /app\.post\("\/crm\/campaigns\/:id\/members\/bulk-assign"[\s\S]*?requireCrmAccess/);
  assert.match(campaignRoutesSource, /const assigningSelf = assignedToUserId === userId/);
  assert.match(campaignRoutesSource, /OR:\s*\[\{ assignedToUserId: null \}, \{ assignedToUserId: userId \}\]/);
});

test("campaign bulk assignment gates cross-agent and clear assignment to managers", () => {
  assert.match(campaignRoutesSource, /CRM manager access required to assign leads to another agent/);
  assert.match(campaignRoutesSource, /CRM manager access required to clear campaign member assignments/);
  assert.match(campaignRoutesSource, /callerCanAssignOthers/);
});

test("campaign bulk assignment validates tenant CRM-enabled assignee", () => {
  assert.match(campaignRoutesSource, /db\.user\.findFirst\(\{[\s\S]*?tenantId[\s\S]*?status:\s*\{\s*not:\s*"DISABLED"/);
  assert.match(campaignRoutesSource, /db\.crmUserAccess\.findUnique\(\{[\s\S]*?tenantId_userId:\s*\{\s*tenantId,\s*userId:\s*assignedToUserId/);
  assert.match(campaignRoutesSource, /invalid_assignee/);
});

test("campaign assignment drives My Queue without separate queue rows", () => {
  assert.match(campaignRoutesSource, /data:\s*\{\s*assignedToUserId\s*\}/);
  assert.match(campaignRoutesSource, /app\.get\("\/crm\/queue"[\s\S]*?assignedToUserId:\s*userId/);
  assert.doesNotMatch(campaignRoutesSource, /crmQueue\.create|queueEntry\.create|crmQueueEntry/);
});
