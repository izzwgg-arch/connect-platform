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
