import test from "node:test";
import assert from "node:assert/strict";
import {
  backfillLegacyPageVisibility,
  PAGE_VISIBILITY_LEGACY_KEYS,
} from "./portalPermissions";

// A custom role built by toggling only the granular "Call History" nav item must
// still be able to open /calls — which is gated on the hidden legacy key
// can_view_calls. Without backfill the nav link shows but the page 403s.
test("re-derives can_view_calls from the granular call-history nav item", () => {
  const out = backfillLegacyPageVisibility([
    "can_view_section_workspace",
    "can_view_workspace_call_history",
  ]);
  assert.ok(out.includes("can_view_calls"), "can_view_calls should be backfilled");
  assert.ok(out.includes("can_view_workspace_call_history"), "original keys preserved");
});

test("re-derives dashboard / contacts / voicemail / chat page keys", () => {
  assert.ok(backfillLegacyPageVisibility(["can_view_workspace_overview"]).includes("can_view_dashboard"));
  assert.ok(backfillLegacyPageVisibility(["can_view_workspace_contacts"]).includes("can_view_contacts"));
  assert.ok(backfillLegacyPageVisibility(["can_view_workspace_voicemail"]).includes("can_view_voicemail"));
  assert.ok(backfillLegacyPageVisibility(["can_view_workspace_chat"]).includes("can_view_chat"));
});

test("re-derives admin page key from a granular admin nav item", () => {
  const out = backfillLegacyPageVisibility(["can_view_admin_users"]);
  assert.ok(out.includes("can_view_admin"));
});

// SAFETY: only page-visibility keys are ever added. Privileged action keys
// (can_manage_global_settings, can_manage_deploys, can_manage_voip_ms, ...) must
// NEVER be re-derived, even though they appear as expansion SOURCES, otherwise
// granting a benign admin nav item would escalate to global settings management.
test("never escalates to privileged capability keys", () => {
  const out = backfillLegacyPageVisibility([
    "can_view_admin_ops_center", // a target of can_manage_global_settings
    "can_view_admin_deploy_center", // a target of can_manage_deploys
    "can_view_apps_voip_ms", // a target of can_manage_voip_ms
  ]);
  assert.equal(out.includes("can_manage_global_settings"), false);
  assert.equal(out.includes("can_manage_deploys"), false);
  assert.equal(out.includes("can_manage_voip_ms"), false);
});

// Section keys are too broad to be a trigger on their own.
test("section keys alone do not backfill a page key", () => {
  const out = backfillLegacyPageVisibility(["can_view_section_pbx"]);
  assert.equal(out.includes("can_view_calls"), false);
  assert.equal(out.includes("can_view_ivr_routing"), false);
});

// Idempotent: keys already present are left as-is and no duplicates appear.
test("idempotent and adds nothing unexpected for an empty set", () => {
  assert.deepEqual(backfillLegacyPageVisibility([]), []);
  const withCalls = backfillLegacyPageVisibility(["can_view_calls", "can_view_workspace_call_history"]);
  const again = backfillLegacyPageVisibility(withCalls);
  assert.deepEqual(new Set(withCalls), new Set(again));
});

test("recordings key is NOT a page-visibility key (handled via the action gate)", () => {
  assert.equal((PAGE_VISIBILITY_LEGACY_KEYS as readonly string[]).includes("can_view_recordings"), false);
  // granting the PBX recordings nav item must not silently add can_view_recordings
  const out = backfillLegacyPageVisibility(["can_view_pbx_call_recordings"]);
  assert.equal(out.includes("can_view_recordings"), false);
});
