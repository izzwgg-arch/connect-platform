import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyMohOrigin,
  computeMohPlayability,
  decideNativeMohSync,
  MAIN_PBX_TENANT_ID,
} from "./mohCatalog";

// ── classifyMohOrigin ────────────────────────────────────────────────────────
test("origin: tenant-owned class (pbxTenantId != 1) → tenant", () => {
  assert.equal(classifyMohOrigin({ pbxTenantId: "2", mohClassName: "moh2" }), "tenant");
});

test("origin: main-tenant class (pbxTenantId == 1) → main", () => {
  assert.equal(classifyMohOrigin({ pbxTenantId: MAIN_PBX_TENANT_ID, mohClassName: "moh5" }), "main");
});

test("origin: default class → global_default regardless of owner", () => {
  assert.equal(classifyMohOrigin({ pbxTenantId: "1", isDefault: true, mohClassName: "moh3" }), "global_default");
  assert.equal(classifyMohOrigin({ pbxTenantId: "2", mohClassName: "default" }), "global_default");
});

test("origin: connect upload wins over everything", () => {
  assert.equal(
    classifyMohOrigin({ pbxTenantId: "2", isDefault: true, mohClassName: "connect_a_plus_center_jazz", isConnectUpload: true }),
    "connect_upload",
  );
});

test("origin: no owner → unassigned", () => {
  assert.equal(classifyMohOrigin({ pbxTenantId: null, mohClassName: "moh9" }), "unassigned");
  assert.equal(classifyMohOrigin({ pbxTenantId: "", mohClassName: "moh9" }), "unassigned");
});

// ── computeMohPlayability ────────────────────────────────────────────────────
test("playability: active + files present + loaded/unknown → selectable", () => {
  assert.deepEqual(
    computeMohPlayability({ isActive: true, loadedInAsterisk: null, fileCount: 40 }),
    { selectable: true, unavailableReason: null, filesPresent: true },
  );
  assert.deepEqual(
    computeMohPlayability({ isActive: true, loadedInAsterisk: true, fileCount: 1 }),
    { selectable: true, unavailableReason: null, filesPresent: true },
  );
});

test("playability: zero files → blocked no_files (would be silence)", () => {
  const r = computeMohPlayability({ isActive: true, loadedInAsterisk: null, fileCount: 0 });
  assert.equal(r.selectable, false);
  assert.equal(r.unavailableReason, "no_files");
  assert.equal(r.filesPresent, false);
});

test("playability: stream/custom class with 0 files is still playable", () => {
  const r = computeMohPlayability({ isActive: true, loadedInAsterisk: null, fileCount: 0, classType: "stream" });
  assert.equal(r.selectable, true);
  assert.equal(r.filesPresent, true);
});

test("playability: explicitly not loaded in Asterisk → blocked not_loaded", () => {
  const r = computeMohPlayability({ isActive: true, loadedInAsterisk: false, fileCount: 5 });
  assert.equal(r.selectable, false);
  assert.equal(r.unavailableReason, "not_loaded");
});

test("playability: inactive → blocked deactivated (highest precedence)", () => {
  const r = computeMohPlayability({ isActive: false, loadedInAsterisk: true, fileCount: 5 });
  assert.equal(r.selectable, false);
  assert.equal(r.unavailableReason, "deactivated");
});

// ── decideNativeMohSync ──────────────────────────────────────────────────────
test("native-sync: owned class runs (tenant may stamp its own music_group_id)", () => {
  const d = decideNativeMohSync({ classKind: "native", classPbxTenantId: "2", tenantPbxTenantId: "2" });
  assert.equal(d.run, true);
  assert.equal(d.reason, "owned_class");
});

test("native-sync: main/foreign class is SKIPPED (the moh5→T2 silence fix)", () => {
  const d = decideNativeMohSync({ classKind: "native", classPbxTenantId: "1", tenantPbxTenantId: "2" });
  assert.equal(d.run, false);
  assert.equal(d.reason, "foreign_class_native_sync_suppressed");
});

test("native-sync: other-tenant class is SKIPPED", () => {
  const d = decideNativeMohSync({ classKind: "native", classPbxTenantId: "3", tenantPbxTenantId: "2" });
  assert.equal(d.run, false);
  assert.equal(d.reason, "foreign_class_native_sync_suppressed");
});

test("native-sync: unassigned class is SKIPPED", () => {
  const d = decideNativeMohSync({ classKind: "native", classPbxTenantId: "", tenantPbxTenantId: "2" });
  assert.equal(d.run, false);
  assert.equal(d.reason, "foreign_class_native_sync_suppressed");
});

test("native-sync: connect upload never native-syncs", () => {
  const d = decideNativeMohSync({ classKind: "connect", classPbxTenantId: null, tenantPbxTenantId: "2" });
  assert.equal(d.run, false);
  assert.equal(d.reason, "connect_uploaded_moh_no_vitalpbx_music_group");
});

test("native-sync: missing tenant pbx link is SKIPPED", () => {
  const d = decideNativeMohSync({ classKind: "native", classPbxTenantId: "2", tenantPbxTenantId: "" });
  assert.equal(d.run, false);
  assert.equal(d.reason, "tenant_pbx_link_missing");
});

// ── Scenario: moh2 → moh5 → moh2 assignment (AstDB target follows selection) ──
test("scenario: switching selectable classes always yields a selectable target", () => {
  // Both classes are selectable (files present); assignment is class-name based.
  const moh2 = computeMohPlayability({ isActive: true, loadedInAsterisk: null, fileCount: 1 });
  const moh5 = computeMohPlayability({ isActive: true, loadedInAsterisk: null, fileCount: 40 });
  assert.equal(moh2.selectable, true);
  assert.equal(moh5.selectable, true);
  // moh5 is main-owned → native sync suppressed for T2; moh2 is owned → native sync runs.
  assert.equal(decideNativeMohSync({ classKind: "native", classPbxTenantId: "1", tenantPbxTenantId: "2" }).run, false);
  assert.equal(decideNativeMohSync({ classKind: "native", classPbxTenantId: "2", tenantPbxTenantId: "2" }).run, true);
});
