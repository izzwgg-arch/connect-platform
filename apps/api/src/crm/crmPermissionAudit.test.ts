import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  crmLegacyPermissionKeysForAccess,
  expandLegacyPortalPermissions,
} from "@connect/shared";
import { crmRoleBypassesContactRestriction } from "./guard.js";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

test("portal: Agent/Manager CRM nav includes audited feature permissions", () => {
  for (const role of ["AGENT", "MANAGER"] as const) {
    const expanded = expandLegacyPortalPermissions(crmLegacyPermissionKeysForAccess(role));
    for (const perm of [
      "can_view_crm_checklists",
      "can_view_crm_scripts",
      "can_view_crm_voicemail_drops",
      "can_view_crm_live_call",
      "can_view_crm_email",
    ]) {
      assert.ok(expanded.includes(perm as any), `${role} missing ${perm}`);
    }
    assert.equal(expanded.includes("can_view_crm_settings" as any), false, `${role} must not get settings`);
  }
});

test("portal: CRM Admin gets settings but not platform admin console by default", () => {
  const expanded = expandLegacyPortalPermissions(crmLegacyPermissionKeysForAccess("ADMIN"));
  assert.ok(expanded.includes("can_view_crm_settings" as any));
  assert.equal(expanded.includes("can_view_admin_console" as any), false);
});

test("guard: every CRM access role bypasses contact campaign restrictions", () => {
  assert.equal(crmRoleBypassesContactRestriction("AGENT"), true);
  assert.equal(crmRoleBypassesContactRestriction("MANAGER"), true);
  assert.equal(crmRoleBypassesContactRestriction("ADMIN"), true);
  assert.equal(crmRoleBypassesContactRestriction(null), false);
});

test("email templates: branding logo upload uses requireCrmAccess", () => {
  const source = read("apps/api/src/crm/emailRoutes.ts");
  const block = source.slice(
    source.indexOf('app.post("/crm/email/branding/logo"'),
    source.indexOf('app.get("/crm/email/signature"'),
  );
  assert.match(block, /requireCrmAccess\(req, reply\)/);
  assert.doesNotMatch(block, /requireCrmEmailSettingsAccess/);
});

test("email templates: edit checks CRM manager role via loadCrmUserAccessRole", () => {
  const source = read("apps/api/src/crm/emailRoutes.ts");
  assert.match(source, /async function canEditTemplate/);
  assert.match(source, /loadCrmUserAccessRole/);
  assert.match(source, /crmRoleBypassesContactRestriction/);
});

test("live workspace contact actions enforce assertCrmContactAllowed", () => {
  const taskSource = read("apps/api/src/crm/taskRoutes.ts");
  assert.match(taskSource, /assertCrmContactAllowed/);

  const timelineSource = read("apps/api/src/crm/timelineRoutes.ts");
  assert.match(timelineSource, /assertCrmContactAllowed/);
});

test("email settings diagnostics remain admin-only", () => {
  const source = read("apps/api/src/crm/emailRoutes.ts");
  assert.match(source, /diagnostics\/reply-tracking[\s\S]*?requireCrmEmailSettingsAccess/);
});

test("tenant isolation: contact detail route checks scope after tenant lookup", () => {
  const source = read("apps/api/src/crm/contactRoutes.ts");
  const block = source.slice(
    source.indexOf('app.get("/crm/contacts/:id"'),
    source.indexOf('app.delete("/crm/contacts/:id"'),
  );
  assert.match(block, /tenantId/);
  assert.match(block, /assertCrmContactAllowed/);
});
