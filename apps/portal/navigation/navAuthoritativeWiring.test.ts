import test from "node:test";
import assert from "node:assert/strict";
import { navItems, isNavItemVisibleForUser } from "./navConfig";
import type { Permission } from "../types/app";

/**
 * Proves the full custom-role wiring at the nav layer:
 *   - A nav item is visible IFF both its section permission AND its own
 *     permission are present (ON = visible, OFF = hidden).
 *   - Removing either the item permission or the section permission hides it.
 *
 * Combined with the authoritative resolver (a user's effective permission set
 * IS exactly their custom role's toggles), this guarantees every single toggle
 * in the editor maps to a real, deterministic show/hide outcome.
 *
 * backendJwtRole is set to SUPER_ADMIN so the JWT-gated special cases
 * (admin.billing, admin.server_health, crm.diagnostics) don't force-hide — isolating the test to the
 * permission wiring that custom roles control.
 */
const can = (set: Set<string>) => ((p: Permission) => set.has(p as string)) as (p: Permission) => boolean;

test("every nav toggle: visible only when BOTH section + item permission are ON", () => {
  for (const item of navItems) {
    const on = new Set<string>([item.sectionPermission as string, item.permission as string]);
    assert.equal(
      isNavItemVisibleForUser(item, can(on), "SUPER_ADMIN"),
      true,
      `${item.id} must be VISIBLE when its section + item permission are ON`,
    );

    const itemOff = new Set<string>([item.sectionPermission as string]);
    assert.equal(
      isNavItemVisibleForUser(item, can(itemOff), "SUPER_ADMIN"),
      false,
      `${item.id} must be HIDDEN when its item permission is OFF`,
    );

    const sectionOff = new Set<string>([item.permission as string]);
    assert.equal(
      isNavItemVisibleForUser(item, can(sectionOff), "SUPER_ADMIN"),
      false,
      `${item.id} must be HIDDEN when its section permission is OFF`,
    );
  }
});

test("authoritative role set: only toggled sections/items show, everything else is hidden", () => {
  // Mirrors the real "Dom" production role: Workspace + CRM only.
  const domSet = new Set<string>([
    "can_view_section_workspace", "can_view_workspace_overview", "can_view_workspace_team_directory",
    "can_view_workspace_call_history", "can_view_workspace_voicemail", "can_view_workspace_chat",
    "can_view_workspace_contacts",
    "can_view_section_crm", "can_view_crm_dashboard", "can_view_crm_contacts", "can_view_crm_forms",
    "can_view_crm_tasks", "can_view_crm_live_call", "can_view_crm_scripts", "can_view_crm_voicemail_drops",
    "can_view_crm_checklists", "can_view_crm_campaigns", "can_view_crm_queue", "can_view_crm_funders",
    "can_view_crm_reports", "can_view_crm_email",
  ]);

  const visible = navItems.filter((i) => isNavItemVisibleForUser(i, can(domSet), "SUPER_ADMIN"));

  // Nothing outside Workspace/CRM may leak through.
  for (const item of visible) {
    assert.ok(
      item.section === "workspace" || item.section === "crm",
      `${item.id} (section=${item.section}) leaked into a Workspace+CRM-only role`,
    );
  }

  // Spot checks: required-visible and required-hidden.
  const ids = new Set(visible.map((i) => i.id));
  assert.ok(ids.has("workspace.overview"), "workspace.overview should be visible");
  assert.ok(ids.has("crm.dashboard"), "crm.dashboard should be visible");
  assert.ok(!ids.has("pbx.extensions"), "pbx.extensions must be hidden (PBX section OFF)");
  assert.ok(!ids.has("admin.users"), "admin.users must be hidden (Admin section OFF)");
  assert.ok(!ids.has("settings.tenant"), "settings.tenant must be hidden (Settings section OFF)");
  assert.ok(!ids.has("apps.home"), "apps.home must be hidden (Apps section OFF)");
  assert.ok(!ids.has("billing.overview"), "billing.overview must be hidden (Billing section OFF)");
});

test("empty role set hides everything", () => {
  const empty = new Set<string>();
  for (const item of navItems) {
    assert.equal(isNavItemVisibleForUser(item, can(empty), "SUPER_ADMIN"), false, `${item.id} must be hidden for empty role`);
  }
});
