import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  crmLegacyPermissionKeysForAccess,
  expandLegacyPortalPermissions,
} from "@connect/shared";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");

function readRoute(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

const checklistSource = readRoute("apps/api/src/crm/checklistRoutes.ts");
const checklistPageSource = readRoute("apps/portal/app/(platform)/crm/checklists/page.tsx");

test("checklist create/update use requireCrmAccess (Agent/Manager allowed)", () => {
  assert.match(checklistSource, /app\.post\("\/crm\/checklists"[\s\S]*?requireCrmAccess/);
  assert.match(checklistSource, /app\.patch\("\/crm\/checklists\/:id"[\s\S]*?requireCrmAccess/);
  assert.doesNotMatch(checklistSource, /requireCrmAdmin/);
});

test("checklist create returns saved checklist in response", () => {
  const block = checklistSource.slice(
    checklistSource.indexOf('app.post("/crm/checklists"'),
    checklistSource.indexOf('app.patch("/crm/checklists/:id"'),
  );
  assert.match(block, /reply\.code\(201\)\.send\(\{ checklist \}\)/);
  assert.match(block, /include: \{ items:/);
});

test("checklist list and create share tenantId scoping", () => {
  const listBlock = checklistSource.slice(
    checklistSource.indexOf('app.get("/crm/checklists"'),
    checklistSource.indexOf('app.get("/crm/checklists/:id"'),
  );
  const createBlock = checklistSource.slice(
    checklistSource.indexOf('app.post("/crm/checklists"'),
    checklistSource.indexOf('app.patch("/crm/checklists/:id"'),
  );
  assert.match(listBlock, /where: \{ tenantId/);
  assert.match(createBlock, /tenantId,/);
  assert.match(createBlock, /data: \{[\s\S]*?tenantId/);
});

test("checklist list excludes inactive by default; includeInactive opt-in", () => {
  const listBlock = checklistSource.slice(
    checklistSource.indexOf('app.get("/crm/checklists"'),
    checklistSource.indexOf('app.get("/crm/checklists/:id"'),
  );
  assert.match(listBlock, /includeInactive === "true"/);
  assert.match(listBlock, /isActive: true/);
});

test("portal: Agent and Manager can view/create checklists (nav permission)", () => {
  for (const role of ["AGENT", "MANAGER"] as const) {
    const expanded = expandLegacyPortalPermissions(crmLegacyPermissionKeysForAccess(role));
    assert.ok(
      expanded.includes("can_view_crm_checklists" as any),
      `${role} must have checklist nav permission`,
    );
  }
});

test("portal: user without CRM access lacks checklist permission", () => {
  const expanded = expandLegacyPortalPermissions([]);
  assert.equal(expanded.includes("can_view_crm_checklists" as any), false);
});

test("portal checklist page merges saved rows after create (list refresh helper)", () => {
  assert.match(checklistPageSource, /mergeChecklistSummaries/);
  assert.match(checklistPageSource, /loadList\(\{ silent: true, mergeLocal: \[checklist\] \}\)/);
  assert.match(checklistPageSource, /formatCrmSaveError/);
});
