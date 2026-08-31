import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTION_PERMISSION_KEYS,
  PORTAL_PERMISSION_KEYS,
  SIDEBAR_ITEMS,
} from "@connect/shared";
import { navItems } from "./navConfig";

/**
 * IZZY'S STANDING RULE, 2026-08-31, verbatim:
 *
 *   "whenever we build a new page, there should be a toggle for it in its
 *    section, on and off, and in custom roles, roles for everything, toggles
 *    for all permissions. Always, always, always."
 *
 * These tests are the enforcement. They exist because on 2026-08-31 the
 * /admin/permissions screen was moved off the drifted shared SIDEBAR_ITEMS
 * catalog and the custom-role editor at /admin/roles/[id] was LEFT BEHIND on
 * it - so 23 real sidebar pages (Direct, Meetings, Desk Phones, Install, every
 * Store page and 13 admin pages) had no toggle anywhere in custom roles.
 *
 * A unit test of either screen's helpers passes straight through that: the bug
 * was WHICH CATALOG the page imported. So these read the pages' SOURCE.
 */

const ROOT = process.env.PORTAL_GUARD_ROOT || join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const PERMISSIONS_PAGE = "app/(platform)/admin/permissions/page.tsx";
const CUSTOM_ROLE_PAGE = "app/(platform)/admin/roles/[id]/page.tsx";

/** Strip comments so a rule quoted in a doc block can never satisfy a guard. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("every sidebar page has a toggle in the custom-role editor", () => {
  const src = stripComments(read(CUSTOM_ROLE_PAGE));

  // The matrix must be built from the real sidebar, not the shared catalog.
  assert.match(
    src,
    /const SECTION_GROUPS[\s\S]{0,400}navItems/,
    "the custom-role matrix must be built from navItems (the real sidebar)",
  );
  assert.doesNotMatch(
    src,
    /const SECTION_GROUPS\s*=\s*SIDEBAR_SECTIONS\.map/,
    "the custom-role matrix must not be rebuilt from the drifted SIDEBAR_ITEMS catalog",
  );
  assert.match(src, /from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/navigation\/navConfig"/);
});

test("every sidebar page has a row on the permissions screen", () => {
  const src = stripComments(read(PERMISSIONS_PAGE));
  assert.match(src, /navItems/, "the permissions screen must render navItems");
  assert.doesNotMatch(
    src,
    /const SECTION_GROUPS\s*=\s*SIDEBAR_SECTIONS\.map/,
    "the permissions screen must not regress to the shared catalog",
  );
});

test("switching a section off clears its children from the SAME catalog it rendered", () => {
  const src = stripComments(read(CUSTOM_ROLE_PAGE));
  assert.doesNotMatch(
    src,
    /for \(const item of SIDEBAR_ITEMS\)/,
    "toggleSection must clear children from the rendered catalog, not SIDEBAR_ITEMS",
  );
  assert.match(src, /SECTION_ITEM_PERMISSIONS/);
});

test("no sidebar page is missing from the rendered catalog", () => {
  const navIds = new Set(navItems.map((i) => i.id));
  // Pages the sidebar renders must all be reachable as toggles.
  assert.ok(navIds.size > 0, "navConfig must have items");
  const missing = navItems.filter((i) => !i.permission || !i.sectionPermission);
  assert.deepEqual(
    missing.map((i) => i.id),
    [],
    "every sidebar item needs both a permission and a sectionPermission",
  );
});

test("every portal permission key has a toggle somewhere in the custom-role editor", () => {
  const src = stripComments(read(CUSTOM_ROLE_PAGE));
  const hidden = new Set<string>(
    (src.match(/HIDDEN_ACTION_KEYS[\s\S]*?\]\)/)?.[0].match(/"([a-z0-9_]+)"/g) || []).map((q) =>
      q.replace(/"/g, ""),
    ),
  );

  const covered = new Set<string>([
    ...navItems.map((i) => i.permission),
    ...navItems.map((i) => i.sectionPermission),
    ...(ACTION_PERMISSION_KEYS as readonly string[]),
    // the "Other pages" orphan group keeps legacy sidebar keys reachable
    ...SIDEBAR_ITEMS.map((i) => i.permission),
  ]);

  const orphans = (PORTAL_PERMISSION_KEYS as readonly string[]).filter(
    (k) => !covered.has(k) && !hidden.has(k),
  );
  assert.deepEqual(
    orphans,
    [],
    `these permission keys have no toggle anywhere in custom roles: ${orphans.join(", ")}`,
  );
});

test("legacy sidebar keys are not dropped by the catalog switch", () => {
  const covered = new Set<string>([
    ...navItems.map((i) => i.permission),
    ...navItems.map((i) => i.sectionPermission),
    ...(ACTION_PERMISSION_KEYS as readonly string[]),
  ]);
  const orphans = SIDEBAR_ITEMS.filter((i) => !covered.has(i.permission));
  if (orphans.length) {
    const src = stripComments(read(CUSTOM_ROLE_PAGE));
    assert.match(
      src,
      /Other pages/,
      `the orphan group must exist to carry: ${orphans.map((o) => o.permission).join(", ")}`,
    );
  }
});
