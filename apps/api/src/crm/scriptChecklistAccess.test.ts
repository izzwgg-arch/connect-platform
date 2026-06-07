import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..", "..", "..", "..");

function readRoute(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

test("script write routes use requireCrmAccess (all CRM roles)", () => {
  const source = readRoute("apps/api/src/crm/scriptRoutes.ts");
  assert.match(source, /app\.post\("\/crm\/scripts"[\s\S]*?requireCrmAccess/);
  assert.match(source, /app\.patch\("\/crm\/scripts\/:id"[\s\S]*?requireCrmAccess/);
  assert.doesNotMatch(source, /requireCrmAdmin/);
});

test("checklist write routes use requireCrmAccess (all CRM roles)", () => {
  const source = readRoute("apps/api/src/crm/checklistRoutes.ts");
  assert.match(source, /app\.post\("\/crm\/checklists"[\s\S]*?requireCrmAccess/);
  assert.match(source, /app\.patch\("\/crm\/checklists\/:id"[\s\S]*?requireCrmAccess/);
  assert.doesNotMatch(source, /requireCrmAdmin/);
});

test("script defaults are tenant-scoped and replace through CrmTenantSettings", () => {
  const source = readRoute("apps/api/src/crm/scriptRoutes.ts");
  const listBlock = source.slice(
    source.indexOf('app.get("/crm/scripts"'),
    source.indexOf('app.get("/crm/scripts/:id"'),
  );
  const patchBlock = source.slice(
    source.indexOf('app.patch("/crm/scripts/:id"'),
    source.indexOf('app.delete("/crm/scripts/:id"'),
  );
  assert.match(listBlock, /FROM "CrmTenantSettings"/);
  assert.match(listBlock, /WHERE "tenantId" = \$\{tenantId\}/);
  assert.match(listBlock, /defaultScriptId/);
  assert.match(listBlock, /isDefault: script\.id === settingsRows\[0\]\?\.defaultScriptId/);
  assert.match(patchBlock, /crmScript\.findFirst\(\{ where: \{ id, tenantId \}/);
  assert.match(patchBlock, /crmTenantSettings\.upsert/);
  assert.match(patchBlock, /SET "defaultScriptId" = \$\{id\}/);
  assert.match(patchBlock, /WHERE "tenantId" = \$\{tenantId\} AND "defaultScriptId" = \$\{id\}/);
});

test("checklist defaults are tenant-scoped and replace through CrmTenantSettings", () => {
  const source = readRoute("apps/api/src/crm/checklistRoutes.ts");
  const listBlock = source.slice(
    source.indexOf('app.get("/crm/checklists"'),
    source.indexOf('app.get("/crm/checklists/:id"'),
  );
  const patchBlock = source.slice(
    source.indexOf('app.patch("/crm/checklists/:id"'),
    source.indexOf('app.delete("/crm/checklists/:id"'),
  );
  assert.match(listBlock, /FROM "CrmTenantSettings"/);
  assert.match(listBlock, /WHERE "tenantId" = \$\{tenantId\}/);
  assert.match(listBlock, /defaultChecklistId/);
  assert.match(listBlock, /isDefault: checklist\.id === settingsRows\[0\]\?\.defaultChecklistId/);
  assert.match(patchBlock, /crmChecklist\.findFirst\(\{ where: \{ id, tenantId \}/);
  assert.match(patchBlock, /crmTenantSettings\.upsert/);
  assert.match(patchBlock, /SET "defaultChecklistId" = \$\{id\}/);
  assert.match(patchBlock, /WHERE "tenantId" = \$\{tenantId\} AND "defaultChecklistId" = \$\{id\}/);
});

test("contact workspace passes tenant defaults into script and checklist panels", () => {
  const source = readRoute("apps/portal/app/(platform)/crm/contacts/[id]/page.tsx");
  assert.match(source, /defaultScriptId\?: string \| null/);
  assert.match(source, /setDefaultScriptId\(scriptsRes\.value\.defaultScriptId \?\? null\)/);
  assert.match(source, /defaultScriptId=\{defaultScriptId\}/);
  assert.match(source, /defaultChecklistId\?: string \| null/);
  assert.match(source, /setDefaultChecklistId\(checklistRes\.value\.defaultChecklistId \?\? null\)/);
  assert.match(source, /defaultChecklistId=\{defaultChecklistId\}/);
});

test("checklist respond enforces CRM contact scope", () => {
  const source = readRoute("apps/api/src/crm/checklistRoutes.ts");
  assert.match(source, /app\.post\("\/crm\/checklists\/:id\/respond"[\s\S]*?assertCrmContactAllowed/);
});

test("voicemail drop write routes use requireCrmAccess (Agent/Manager)", () => {
  const source = readRoute("apps/api/src/crm/voicemailDropRoutes.ts");
  assert.match(source, /app\.post\("\/crm\/voicemail-drops"[\s\S]*?requireCrmAccess/);
  assert.match(source, /app\.patch\("\/crm\/voicemail-drops\/:id"[\s\S]*?requireCrmAccess/);
  assert.match(source, /app\.delete\("\/crm\/voicemail-drops\/:id"[\s\S]*?requireCrmAccess/);
  assert.doesNotMatch(source, /requireCrmAdmin/);
});

test("voicemail drop action enforces CRM contact scope", () => {
  const source = readRoute("apps/api/src/crm/voicemailDropRoutes.ts");
  const block = source.slice(
    source.indexOf('app.post("/crm/voicemail-drops/drop"'),
    source.indexOf('app.post("/crm/voicemail-drops/:id/play-test"'),
  );
  assert.match(block, /assertCrmContactAllowed/);
});

test("disposition route enforces CRM contact scope", () => {
  const source = readRoute("apps/api/src/crm/contactRoutes.ts");
  const block = source.slice(
    source.indexOf('app.post("/crm/contacts/:id/disposition"'),
    source.indexOf('app.post("/crm/contacts/:id/phones"'),
  );
  assert.match(block, /assertCrmContactAllowed/);
});
