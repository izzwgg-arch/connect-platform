import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function routeBlock(source: string, route: string, until: string): string {
  const start = source.indexOf(route);
  assert.ok(start >= 0, `missing route ${route}`);
  const end = source.indexOf(until, start + route.length);
  return source.slice(start, end > start ? end : undefined);
}

test("campaigns: PATCH and DELETE use requireCrmManager and campaign scope", () => {
  const source = read("apps/api/src/crm/campaignRoutes.ts");
  const patch = routeBlock(source, 'app.patch("/crm/campaigns/:id"', 'app.delete("/crm/campaigns/:id"');
  const del = routeBlock(source, 'app.delete("/crm/campaigns/:id"', "app.post(\"/crm/campaigns/:id/members/add\"");
  assert.match(patch, /requireCrmManager\(req, reply\)/);
  assert.match(patch, /assertCrmCampaignAllowed/);
  assert.match(del, /requireCrmManager\(req, reply\)/);
  assert.match(del, /assertCrmCampaignAllowed/);
  assert.match(del, /status: "ARCHIVED"/);
  assert.doesNotMatch(del, /crmCampaign\.delete/);
});

test("funders: PATCH is CRM access; DELETE archives with requireCrmManager", () => {
  const source = read("apps/api/src/crm/funderRoutes.ts");
  const patch = routeBlock(source, 'app.patch("/crm/funders/:id"', 'app.delete("/crm/funders/:id"');
  const del = routeBlock(source, 'app.delete("/crm/funders/:id"', 'app.post("/crm/funders/:id/restore"');
  assert.match(patch, /requireCrmAccess\(req, reply\)/);
  assert.match(patch, /tenantId/);
  assert.match(del, /requireCrmManager\(req, reply\)/);
  assert.match(del, /active: false, archivedAt: new Date\(\)/);
  assert.doesNotMatch(del, /funder\.delete/);
});

test("contacts: PATCH enforces contact scope; DELETE soft-archives with requireCrmManager", () => {
  const source = read("apps/api/src/crm/contactRoutes.ts");
  const patch = routeBlock(source, 'app.patch("/crm/contacts/:id"', 'app.get("/crm/contacts/:id/duplicates"');
  const del = routeBlock(source, 'app.delete("/crm/contacts/:id"', 'app.post("/crm/contacts/:id/restore"');
  assert.match(patch, /requireCrmAccess\(req, reply\)/);
  assert.match(patch, /assertCrmContactAllowed/);
  assert.match(del, /requireCrmManager\(req, reply\)/);
  assert.match(del, /active: false, archivedAt: new Date\(\)/);
  assert.doesNotMatch(del, /contact\.delete/);
});

test("contacts: restore uses requireCrmManager", () => {
  const source = read("apps/api/src/crm/contactRoutes.ts");
  const restore = routeBlock(source, 'app.post("/crm/contacts/:id/restore"', "app.patch(\"/crm/contacts/:id/phones\"");
  assert.match(restore, /requireCrmManager\(req, reply\)/);
});
