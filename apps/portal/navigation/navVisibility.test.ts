import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_NAV_VISIBILITY,
  NAV_ITEMS_ALWAYS_VISIBLE,
  isNavItemHiddenBySetting,
  isNavItemOwnerOnlyLifted,
  normalizeNavVisibility,
  type PortalNavVisibility,
} from "@connect/shared";
import {
  OWNER_ONLY_FIXED_NAV_ITEMS,
  OWNER_ONLY_LIFTABLE_NAV_ITEMS,
  isNavItemVisibleForUser,
  navItems,
} from "./navConfig";
import type { Permission } from "../types/app";

/**
 * The owner's per-page sidebar switches (2026-08-31, Izzy: "every single page,
 * I should have a toggle on and off for view in the sidebar, aside from the
 * custom role permission").
 *
 * The property that matters most is the SUBTRACT-ONLY one: this layer may hide
 * any page, and may never reveal one the permission checks would refuse. The
 * second property is that the two owner-only lists partition correctly — a
 * liftable page really lifts, a fixed one really cannot be lifted by any
 * stored value.
 */

const can = (set: Set<string>) => ((p: Permission) => set.has(p as string)) as (p: Permission) => boolean;
const fullSet = (item: (typeof navItems)[number]) =>
  new Set<string>([item.sectionPermission as string, item.permission as string]);

const vis = (partial: Partial<PortalNavVisibility>): PortalNavVisibility => ({
  ...EMPTY_NAV_VISIBILITY,
  ...partial,
});

test("omitting visibility keeps every item's previous behaviour exactly", () => {
  for (const item of navItems) {
    const withOmitted = isNavItemVisibleForUser(item, can(fullSet(item)), "SUPER_ADMIN");
    const withEmpty = isNavItemVisibleForUser(item, can(fullSet(item)), "SUPER_ADMIN", vis({}));
    assert.equal(withOmitted, withEmpty, `${item.id}: empty visibility must equal omitted visibility`);
    assert.equal(withOmitted, true, `${item.id} must be visible with full permissions and no hides`);
  }
});

test("hiding an item hides it for EVERYONE, super admin included", () => {
  for (const item of navItems) {
    if (NAV_ITEMS_ALWAYS_VISIBLE.includes(item.id)) continue;
    const hiddenVis = vis({ hidden: [item.id] });
    assert.equal(
      isNavItemVisibleForUser(item, can(fullSet(item)), "SUPER_ADMIN", hiddenVis),
      false,
      `${item.id} must be hidden when switched off, even for SUPER_ADMIN`,
    );
  }
});

test("hiding one item never touches its siblings — including ones sharing its permission key", () => {
  // The whole reason this layer exists: Direct shares Chat's key, Meetings
  // shares Overview's, the five Store pages share one key. Hiding one must
  // leave the others alone.
  for (const item of navItems) {
    if (NAV_ITEMS_ALWAYS_VISIBLE.includes(item.id)) continue;
    const hiddenVis = vis({ hidden: [item.id] });
    for (const other of navItems) {
      if (other.id === item.id) continue;
      const before = isNavItemVisibleForUser(other, can(fullSet(other)), "SUPER_ADMIN");
      const after = isNavItemVisibleForUser(other, can(fullSet(other)), "SUPER_ADMIN", hiddenVis);
      assert.equal(after, before, `hiding ${item.id} must not change ${other.id}`);
    }
  }
});

test("⛔ SUBTRACT-ONLY: no visibility value can reveal a page the permissions refuse", () => {
  // Even a hand-crafted record that "lifts" everything and hides nothing must
  // never show an item whose permission is missing.
  const liftAll = vis({ ownerOnlyLifted: navItems.map((i) => i.id) });
  for (const item of navItems) {
    const missingItemPerm = new Set<string>([item.sectionPermission as string]);
    assert.equal(
      isNavItemVisibleForUser(item, can(missingItemPerm), "SUPER_ADMIN", liftAll),
      false,
      `${item.id} must stay hidden without its permission, whatever the visibility record says`,
    );
  }
});

test("the Permissions page itself can never be hidden — even by a hand-edited stored value", () => {
  const permItem = navItems.find((i) => i.id === "admin.permissions");
  assert.ok(permItem, "admin.permissions must exist in the nav");
  // The raw value claims it is hidden; the normalizer must drop it.
  const normalized = normalizeNavVisibility({ hidden: ["admin.permissions"], ownerOnlyLifted: [] });
  assert.equal(normalized.hidden.includes("admin.permissions"), false, "normalizer must strip the protected id");
  // And even an un-normalized record passed straight in is refused by the rule.
  assert.equal(isNavItemHiddenBySetting("admin.permissions", vis({ hidden: ["admin.permissions"] })), false);
  assert.equal(
    isNavItemVisibleForUser(permItem!, can(fullSet(permItem!)), "SUPER_ADMIN", vis({ hidden: ["admin.permissions"] })),
    true,
    "admin.permissions must stay visible so the owner can undo any mistake",
  );
});

test("liftable owner-only pages really lift: Meetings/Direct reach a TENANT_ADMIN once lifted", () => {
  for (const id of OWNER_ONLY_LIFTABLE_NAV_ITEMS) {
    const item = navItems.find((i) => i.id === id);
    assert.ok(item, `${id} must exist in the nav`);
    // Default: hidden from a tenant admin who holds the permission.
    assert.equal(
      isNavItemVisibleForUser(item!, can(fullSet(item!)), "TENANT_ADMIN"),
      false,
      `${id} must default to owner-only`,
    );
    // Lifted: visible to that same tenant admin.
    const lifted = vis({ ownerOnlyLifted: [id] });
    assert.equal(
      isNavItemVisibleForUser(item!, can(fullSet(item!)), "TENANT_ADMIN", lifted),
      true,
      `${id} must reach a permission-holding TENANT_ADMIN once its owner-only default is lifted`,
    );
    assert.equal(isNavItemOwnerOnlyLifted(id, lifted), true);
  }
});

test("⛔ FIXED owner-only pages ignore the lift entirely — no stored value opens the platform console family", () => {
  const liftAll = vis({ ownerOnlyLifted: navItems.map((i) => i.id) });
  for (const id of OWNER_ONLY_FIXED_NAV_ITEMS) {
    const item = navItems.find((i) => i.id === id);
    if (!item) continue; // admin.billing et al are all present today, but a removed page is not a failure
    assert.equal(
      isNavItemVisibleForUser(item, can(fullSet(item)), "TENANT_ADMIN", liftAll),
      false,
      `${id} is platform-internal and must stay SUPER_ADMIN-only whatever the visibility record says`,
    );
    assert.equal(
      isNavItemVisibleForUser(item, can(fullSet(item)), "SUPER_ADMIN", liftAll),
      true,
      `${id} must still be visible to the owner`,
    );
  }
});

test("every SUPER_ADMIN-forced nav id is classified as either liftable or fixed", () => {
  // A new owner-only force line added to isNavItemVisibleForUser without a
  // classification would silently render as a dash on the Permissions screen
  // while actually being force-hidden — a switchless hidden page. Read the
  // source so the list cannot drift.
  const src = readFileSync(join(__dirname, "navConfig.ts"), "utf8").replace(/\r\n/g, "\n");
  const noComments = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  const forced = [...noComments.matchAll(/item\.id === "([a-z0-9_.]+)"\s*&&[\s\S]{0,120}?backendJwtRole !== "SUPER_ADMIN"/g)]
    .map((m) => m[1]);
  assert.ok(forced.length >= 10, `expected to find the force lines in navConfig source (got ${forced.length})`);
  const classified = new Set<string>([...OWNER_ONLY_FIXED_NAV_ITEMS, ...OWNER_ONLY_LIFTABLE_NAV_ITEMS]);
  for (const id of forced) {
    assert.ok(classified.has(id), `${id} is SUPER_ADMIN-forced but in neither owner-only list — classify it`);
  }
});

test("normalizeNavVisibility refuses junk and fails open", () => {
  assert.deepEqual(normalizeNavVisibility(null), EMPTY_NAV_VISIBILITY);
  assert.deepEqual(normalizeNavVisibility("garbage"), EMPTY_NAV_VISIBILITY);
  assert.deepEqual(normalizeNavVisibility([1, 2]), EMPTY_NAV_VISIBILITY);
  const messy = normalizeNavVisibility({
    hidden: ["store.orders", "store.orders", 42, "not a nav id!", "x".repeat(80), "<script>.bad"],
    ownerOnlyLifted: ["workspace.meetings", null],
  });
  assert.deepEqual(messy.hidden, ["store.orders"]);
  assert.deepEqual(messy.ownerOnlyLifted, ["workspace.meetings"]);
});

test("every nav permission key is a real PortalPermissionKey the api will accept", async () => {
  // The Permissions screen renders navItems and saves their keys through
  // POST /admin/role-permissions, whose normalizer silently DROPS any key
  // isPortalPermissionKey does not recognise. A nav item keyed on an unknown
  // string would render a toggle that saves nothing — loudly fail instead.
  const { isPortalPermissionKey } = await import("@connect/shared");
  for (const item of navItems) {
    assert.ok(
      isPortalPermissionKey(item.permission as string),
      `${item.id}: permission ${item.permission} is not in the shared catalog — its toggle would silently save nothing`,
    );
    assert.ok(
      isPortalPermissionKey(item.sectionPermission as string),
      `${item.id}: section permission ${item.sectionPermission} is not in the shared catalog`,
    );
  }
});
