import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_PERMISSION_KEYS,
  CRM_PORTAL_PERMISSION_KEYS,
  DEFAULT_ROLE_PERMISSIONS,
  LEGACY_PERMISSION_EXPANSIONS,
  SIDEBAR_ITEMS,
  SIDEBAR_SECTIONS,
  isPortalPermissionKey,
} from "./portalPermissions";

/**
 * ONE KEY PER SIDEBAR PAGE (Izzy, 2026-09-02, verbatim: "Every toggle should be
 * individual ... they're all separated").
 *
 * Before this, Direct rode Chat's key, Meetings rode Overview's, Install rode
 * Contacts', the five Store pages shared one key, and eleven admin/platform
 * pages shared can_manage_global_settings or can_view_admin_assistant — so a
 * toggle for one page silently moved its siblings on BOTH permission editors.
 * These tests pin the catalog half of the fix; the portal's
 * permissionToggleCoverage.test.ts pins that navConfig uses these keys and
 * that no two nav items share one.
 */

const PER_PAGE_KEYS: Array<{ id: string; key: string }> = [
  { id: "workspace.direct", key: "can_view_workspace_direct" },
  { id: "workspace.meetings", key: "can_view_workspace_meetings" },
  { id: "workspace.install", key: "can_view_workspace_install" },
  { id: "store.orders", key: "can_view_store_orders" },
  { id: "store.deliveries", key: "can_view_store_deliveries" },
  { id: "store.drivers", key: "can_view_store_drivers" },
  { id: "store.specials", key: "can_view_store_specials" },
  { id: "store.teach", key: "can_view_store_teach" },
  { id: "pbx.ivr_migration", key: "can_view_pbx_ivr_migration" },
  { id: "crm.diagnostics", key: "can_view_crm_diagnostics" },
  { id: "apps.signalwire", key: "can_view_apps_signalwire" },
  { id: "admin.support", key: "can_view_admin_support" },
  { id: "admin.compliance", key: "can_view_admin_compliance" },
  { id: "admin.pbx_console", key: "can_view_admin_pbx_console" },
  { id: "admin.pbx_routing", key: "can_view_admin_pbx_routing" },
  { id: "admin.pbx_teams", key: "can_view_admin_pbx_teams" },
  { id: "admin.remote_support_controls", key: "can_view_admin_remote_support_controls" },
  { id: "admin.integrations", key: "can_view_admin_integrations" },
  { id: "admin.voice_agent", key: "can_view_admin_voice_agent" },
  { id: "admin.ai_trainer", key: "can_view_admin_ai_trainer" },
  { id: "admin.elevenlabs", key: "can_view_admin_elevenlabs" },
  { id: "admin.polly", key: "can_view_admin_polly" },
];

test("every split page has its own key in the shared catalog, and it is a real PortalPermissionKey", () => {
  for (const { id, key } of PER_PAGE_KEYS) {
    const item = SIDEBAR_ITEMS.find((i) => i.id === id);
    assert.ok(item, `${id} must be in SIDEBAR_ITEMS — the POST normalizer drops keys it does not know, so a toggle on an unknown key saves nothing`);
    assert.equal(item!.permission, key, `${id} must carry ${key}`);
    assert.ok(isPortalPermissionKey(key), `${key} must pass isPortalPermissionKey`);
    assert.ok(SIDEBAR_SECTIONS.some((s) => s.id === item!.section), `${id} must sit in a known section`);
  }
});

test("⛔ no two SIDEBAR_ITEMS entries share a key, except the legacy tracking aliases that predate this rule", () => {
  // tracking.notifications/integrations/health reuse tracking.audit/settings keys
  // and are NOT rendered by navConfig today; every page the sidebar actually
  // draws has a unique key (the portal test pins that side).
  const legacyTrackingAliases = new Set(["tracking.notifications", "tracking.integrations", "tracking.health"]);
  const seen = new Map<string, string>();
  const dupes: string[] = [];
  for (const item of SIDEBAR_ITEMS) {
    if (legacyTrackingAliases.has(item.id)) continue;
    const prior = seen.get(item.permission);
    if (prior) dupes.push(`${item.id} shares ${item.permission} with ${prior}`);
    seen.set(item.permission, item.id);
  }
  assert.deepEqual(dupes, [], `two sidebar pages on one key means one toggle moves both: ${dupes.join("; ")}`);
});

test("⛔ the launch gate is the KEY: Direct and Meetings are in NO default bucket except SUPER_ADMIN's", () => {
  for (const key of ["can_view_workspace_direct", "can_view_workspace_meetings"] as const) {
    assert.equal(DEFAULT_ROLE_PERMISSIONS.END_USER.includes(key), false, `${key} must not be an END_USER default`);
    assert.equal(DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN.includes(key), false, `${key} must not be a TENANT_ADMIN default`);
    assert.equal(DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN.includes(key), true, `${key} must reach SUPER_ADMIN via the force-add bucket`);
  }
});

test("platform-internal and Store keys are in no customer bucket by default", () => {
  const customerBuckets = [DEFAULT_ROLE_PERMISSIONS.END_USER, DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN];
  const mustBeAbsent = PER_PAGE_KEYS.map((p) => p.key).filter(
    (k) => k !== "can_view_workspace_install" && k !== "can_view_crm_diagnostics",
  );
  for (const key of mustBeAbsent) {
    for (const bucket of customerBuckets) {
      assert.equal(bucket.includes(key as never), false, `${key} must not be a default for a customer bucket`);
    }
  }
});

test("the Install link keeps reaching every ordinary user: can_view_workspace_install is an END_USER default", () => {
  // It rode Contacts' key before the split; every END_USER holds Contacts, so
  // every END_USER (and therefore TENANT_ADMIN) must still hold Install — the
  // forward-merge in platformRolePermissions.ts delivers a new DEFAULT key to
  // the live buckets, so no customer loses the desktop download link.
  assert.equal(DEFAULT_ROLE_PERMISSIONS.END_USER.includes("can_view_workspace_install"), true);
  assert.equal(DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN.includes("can_view_workspace_install"), true);
});

test("CRM Diagnostics stays a CRM key: carried by the CRM-admin expansion and gated like every CRM page", () => {
  assert.ok(LEGACY_PERMISSION_EXPANSIONS.can_manage_crm_admin.includes("can_view_crm_diagnostics"));
  assert.equal(LEGACY_PERMISSION_EXPANSIONS.can_manage_crm.includes("can_view_crm_diagnostics"), false, "a CRM manager never saw diagnostics; the split must not widen that");
  assert.ok(CRM_PORTAL_PERMISSION_KEYS.includes("can_view_crm_diagnostics"), "must be stripped for users without CrmUserAccess like every other CRM key");
});

test("the Store data capability is untouched: can_view_supermarket_orders is still an action key, still in no default bucket", () => {
  assert.ok((ACTION_PERMISSION_KEYS as readonly string[]).includes("can_view_supermarket_orders"));
  assert.equal(DEFAULT_ROLE_PERMISSIONS.END_USER.includes("can_view_supermarket_orders"), false);
  assert.equal(DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN.includes("can_view_supermarket_orders"), false);
});
