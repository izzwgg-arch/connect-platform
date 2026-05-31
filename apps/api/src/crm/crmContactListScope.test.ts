import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildCrmContactListScopeWhere,
  buildCrmContactMetaListScopeWhere,
  mergeAndWhereClauses,
  shouldApplyCrmContactListScope,
} from "./crmContactAccess.js";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");

function readRoute(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

const restrictedAgent = {
  userId: "agent-1",
  platformRole: "EXTENSION_USER",
  crmAccessRole: "AGENT",
  campaignRestriction: ["camp-a", "camp-b"],
};

const managerCtx = {
  userId: "mgr-1",
  platformRole: "EXTENSION_USER",
  crmAccessRole: "MANAGER",
  campaignRestriction: ["camp-a"],
};

test("shouldApplyCrmContactListScope: restricted agent yes, manager/admin no", () => {
  assert.equal(shouldApplyCrmContactListScope(restrictedAgent), true);
  assert.equal(shouldApplyCrmContactListScope(managerCtx), false);
  assert.equal(
    shouldApplyCrmContactListScope({ ...restrictedAgent, platformRole: "TENANT_ADMIN" }),
    false,
  );
  assert.equal(
    shouldApplyCrmContactListScope({ ...restrictedAgent, campaignRestriction: null }),
    false,
  );
});

test("buildCrmContactListScopeWhere: assigned OR allowed campaign membership", () => {
  const where = buildCrmContactListScopeWhere("tenant-1", restrictedAgent);
  assert.ok(where);
  assert.ok(Array.isArray(where!.OR));
  assert.equal((where!.OR as unknown[]).length, 2);
  const assigned = (where!.OR as any[])[0];
  assert.equal(assigned.crmMeta.is.assignedToUserId, "agent-1");
  assert.equal(assigned.crmMeta.is.tenantId, "tenant-1");
  const campaign = (where!.OR as any[])[1];
  assert.deepEqual(campaign.crmCampaignMembers.some.campaignId.in, ["camp-a", "camp-b"]);
  assert.equal(campaign.crmCampaignMembers.some.tenantId, "tenant-1");
});

test("buildCrmContactListScopeWhere: manager returns null (tenant-wide)", () => {
  assert.equal(buildCrmContactListScopeWhere("tenant-1", managerCtx), null);
});

test("buildCrmContactMetaListScopeWhere: stats scope mirrors contact scope", () => {
  const where = buildCrmContactMetaListScopeWhere("tenant-1", restrictedAgent);
  assert.ok(where?.OR);
  assert.equal((where!.OR as any[])[0].assignedToUserId, "agent-1");
});

test("mergeAndWhereClauses: combines search + scope without clobbering OR", () => {
  const searchWhere = { OR: [{ displayName: { contains: "acme" } }] };
  const scopeWhere = buildCrmContactListScopeWhere("tenant-1", restrictedAgent);
  const merged = mergeAndWhereClauses({ tenantId: "tenant-1" }, searchWhere, scopeWhere);
  assert.ok(Array.isArray(merged.AND));
  assert.equal((merged.AND as unknown[]).length, 3);
});

test("mergeAndWhereClauses: single clause returned as-is", () => {
  assert.deepEqual(mergeAndWhereClauses({ tenantId: "t1" }), { tenantId: "t1" });
});

test("contactRoutes: GET /crm/contacts applies list scope helpers", () => {
  const source = readRoute("apps/api/src/crm/contactRoutes.ts");
  const block = source.slice(
    source.indexOf('app.get("/crm/contacts"'),
    source.indexOf('app.post("/crm/contacts"'),
  );
  assert.match(block, /resolveCrmContactScopeContext/);
  assert.match(block, /buildCrmContactListScopeWhere/);
  assert.match(block, /mergeAndWhereClauses/);
});

test("contactRoutes: GET /crm/contacts/stats uses scoped meta counts", () => {
  const source = readRoute("apps/api/src/crm/contactRoutes.ts");
  const block = source.slice(
    source.indexOf('app.get("/crm/contacts/stats"'),
    source.indexOf('app.get("/crm/contacts/lookup"'),
  );
  assert.match(block, /buildCrmContactMetaListScopeWhere/);
  assert.match(block, /scopedMetaWhere/);
});

test("contactRoutes: lookup filters by scope and userCanAccessCrmContact", () => {
  const source = readRoute("apps/api/src/crm/contactRoutes.ts");
  const block = source.slice(
    source.indexOf('app.get("/crm/contacts/lookup"'),
    source.indexOf('app.get("/crm/contacts"'),
  );
  assert.match(block, /buildCrmContactListScopeWhere/);
  assert.match(block, /userCanAccessCrmContact/);
});

test("contactRoutes: duplicates search respects contact list scope", () => {
  const source = readRoute("apps/api/src/crm/contactRoutes.ts");
  const block = source.slice(
    source.indexOf('app.get("/crm/contacts/:id/duplicates"'),
    source.indexOf('app.post("/crm/contacts/merge"'),
  );
  assert.match(block, /assertCrmContactAllowed/);
  assert.match(block, /buildCrmContactListScopeWhere/);
});

test("tenant isolation: scope where always includes tenantId on relations", () => {
  const where = buildCrmContactListScopeWhere("tenant-x", restrictedAgent)!;
  assert.equal((where.OR as any[])[0].crmMeta.is.tenantId, "tenant-x");
  assert.equal((where.OR as any[])[1].crmCampaignMembers.some.tenantId, "tenant-x");
});

test("timezone filters preserved: list route still uses buildLeadTimezoneMetaFilter before scope merge", () => {
  const source = readRoute("apps/api/src/crm/contactRoutes.ts");
  const block = source.slice(
    source.indexOf('app.get("/crm/contacts"'),
    source.indexOf('app.post("/crm/contacts"'),
  );
  assert.match(block, /buildLeadTimezoneMetaFilter/);
  assert.match(block, /timezoneFilter/);
});

test("campaign member list remains campaign-gated via assertCrmCampaignAllowed", () => {
  const source = readRoute("apps/api/src/crm/campaignRoutes.ts");
  const block = source.slice(
    source.indexOf('app.get("/crm/campaigns/:id/members"'),
    source.indexOf('app.patch("/crm/campaigns/:id/members/:memberId"'),
  );
  assert.match(block, /assertCrmCampaignAllowed/);
});
