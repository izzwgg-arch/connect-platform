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
