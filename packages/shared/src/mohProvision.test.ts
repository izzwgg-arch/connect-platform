import test from "node:test";
import assert from "node:assert/strict";
import {
  visibleMohCatalogForTenant,
  planMissingMohProfiles,
  pickDefaultMohClass,
  type MohProvisionCatalogRow,
} from "./mohProvision";

const T = "tenantA";

// Mirrors the real production catalog shape (2026-07-26): four shared main-
// tenant classes + a handful of tenant-owned singles.
const SHARED: MohProvisionCatalogRow[] = [
  { tenantId: "connectT", pbxTenantId: "1", mohClassName: "moh1", name: "default", isDefault: false, isActive: true, selectable: true },
  { tenantId: "connectT", pbxTenantId: "1", mohClassName: "moh3", name: "main", isDefault: true, isActive: true, selectable: true },
  { tenantId: "connectT", pbxTenantId: "1", mohClassName: "moh5", name: "No Music", isDefault: false, isActive: true, selectable: true },
  { tenantId: "connectT", pbxTenantId: "1", mohClassName: "moh8", name: "Secro", isDefault: false, isActive: true, selectable: true },
];
const OWN: MohProvisionCatalogRow = { tenantId: T, pbxTenantId: "2", mohClassName: "moh2", name: "1", isDefault: false, isActive: true, selectable: true };

test("visibility: shared main-tenant + own + unassigned rows; other tenants' rows excluded", () => {
  const foreign: MohProvisionCatalogRow = { tenantId: "tenantB", pbxTenantId: "3", mohClassName: "moh4", name: "Fleetease", isDefault: false, isActive: true, selectable: true };
  const unassigned: MohProvisionCatalogRow = { tenantId: null, pbxTenantId: "9", mohClassName: "moh9", name: "Orphan", isDefault: false, isActive: true, selectable: true };
  const out = visibleMohCatalogForTenant([...SHARED, OWN, foreign, unassigned], T);
  const classes = out.map((r) => r.mohClassName).sort();
  assert.deepEqual(classes, ["moh1", "moh2", "moh3", "moh5", "moh8", "moh9"]);
});

test("visibility: inactive and non-selectable rows are dropped; tenant row wins a class collision", () => {
  const dead: MohProvisionCatalogRow = { ...SHARED[0], mohClassName: "mohX", isActive: false };
  const unsel: MohProvisionCatalogRow = { ...SHARED[0], mohClassName: "mohY", selectable: false };
  const sharedDup: MohProvisionCatalogRow = { ...SHARED[0], mohClassName: "moh2", name: "shared-name" };
  const out = visibleMohCatalogForTenant([dead, unsel, sharedDup, OWN], T);
  assert.deepEqual(out.map((r) => r.mohClassName), ["moh2"]);
  assert.equal(out[0].tenantId, T, "tenant-owned row must win the dedupe");
});

test("plan: creates profiles for uncovered classes with friendly names", () => {
  const plan = planMissingMohProfiles(visibleMohCatalogForTenant(SHARED, T), []);
  assert.deepEqual(plan, [
    { name: "Default", vitalPbxMohClassName: "moh1" },
    { name: "Main", vitalPbxMohClassName: "moh3" },
    { name: "No Music", vitalPbxMohClassName: "moh5" },
    { name: "Secro", vitalPbxMohClassName: "moh8" },
  ]);
});

test("plan: idempotent — never duplicates classes covered by existing profiles (even inactive ones)", () => {
  const existing = [
    { name: "Main", vitalPbxMohClassName: "moh8" }, // hand-made, WRONG name for the class — still respected
    { name: "Classic", vitalPbxMohClassName: "moh3" },
  ];
  const plan = planMissingMohProfiles(visibleMohCatalogForTenant(SHARED, T), existing);
  assert.deepEqual(plan.map((p) => p.vitalPbxMohClassName).sort(), ["moh1", "moh5"]);
  // name "Main" is taken by the hand-made profile → the moh3 class is covered anyway;
  // no entry may reuse a taken name
  assert.ok(!plan.some((p) => p.name.toLowerCase() === "main"));
  assert.ok(!plan.some((p) => p.name.toLowerCase() === "classic"));
});

test("plan: name collision falls back to 'Name (class)'", () => {
  const catalog: MohProvisionCatalogRow[] = [
    { tenantId: null, pbxTenantId: "1", mohClassName: "moh3", name: "main", isDefault: true, isActive: true, selectable: true },
  ];
  const plan = planMissingMohProfiles(catalog, [{ name: "Main", vitalPbxMohClassName: "moh99" }]);
  assert.deepEqual(plan, [{ name: "Main (moh3)", vitalPbxMohClassName: "moh3" }]);
});

test("default class: tenant-owned beats shared default; shared isDefault beats name 'default'", () => {
  const all = [...SHARED, OWN];
  assert.equal(pickDefaultMohClass(visibleMohCatalogForTenant(all, T), T), "moh2");
  assert.equal(pickDefaultMohClass(visibleMohCatalogForTenant(SHARED, T), T), "moh3");
  const noFlag = SHARED.map((r) => ({ ...r, isDefault: false }));
  assert.equal(pickDefaultMohClass(visibleMohCatalogForTenant(noFlag, T), T), "moh1");
  assert.equal(pickDefaultMohClass([], T), null);
});
