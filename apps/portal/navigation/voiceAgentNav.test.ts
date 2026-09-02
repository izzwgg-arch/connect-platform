import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { navItems, isNavItemVisibleForUser } from "./navConfig";

/**
 * The voice-agent admin nav item must be SUPER_ADMIN-forced (it exposes every
 * tenant's phone-AI config), and it must exist. Nav key == page gate == api
 * gate is the house convention; this pins the nav half.
 */

const NAV = readFileSync(path.join(__dirname, "navConfig.ts"), "utf8").replace(/\r\n/g, "\n");

test("admin.voice_agent exists and points at /admin/voice-agent", () => {
  const item = navItems.find((n) => n.id === "admin.voice_agent");
  assert.ok(item, "admin.voice_agent nav item must exist");
  assert.equal(item!.href, "/admin/voice-agent");
  // Its own key since 2026-09-02 (was can_manage_global_settings, shared with
  // six other admin rows). Still in no default bucket; the force line below is
  // the lock.
  assert.equal(item!.permission, "can_view_admin_voice_agent");
  assert.equal(item!.sectionPermission, "can_view_section_admin");
});

test("admin.voice_agent is SUPER_ADMIN-forced in isNavItemVisibleForUser (source)", () => {
  assert.match(
    NAV,
    /item\.id === "admin\.voice_agent" && backendJwtRole !== "SUPER_ADMIN"\) return false/,
    "admin.voice_agent must be SUPER_ADMIN-forced",
  );
});

test("a non-super admin never sees admin.voice_agent even with both permissions", () => {
  const item = navItems.find((n) => n.id === "admin.voice_agent")!;
  const holdsBoth = ((p: string) => p === "can_view_section_admin" || p === "can_view_admin_voice_agent") as any;
  assert.equal(isNavItemVisibleForUser(item, holdsBoth, "TENANT_ADMIN"), false, "TENANT_ADMIN must not see it");
  assert.equal(isNavItemVisibleForUser(item, holdsBoth, "SUPER_ADMIN"), true, "SUPER_ADMIN sees it");
});
