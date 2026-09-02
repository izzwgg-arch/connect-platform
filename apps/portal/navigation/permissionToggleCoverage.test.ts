import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTION_PERMISSION_KEYS,
  PORTAL_PERMISSION_KEYS,
  SIDEBAR_ITEMS,
} from "@connect/shared";
import {
  OWNER_ONLY_FIXED_NAV_ITEMS,
  OWNER_ONLY_LIFTABLE_NAV_ITEMS,
  isNavItemVisibleForUser,
  navItems,
} from "./navConfig";

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

/**
 * THE HONESTY INVARIANT (Izzy, 2026-09-01: "I've turned on toggles for people,
 * and they don't see it" — he had granted pages whose visibility is FORCED to
 * platform staff in isNavItemVisibleForUser, and the matrix offered live
 * toggles for them anyway).
 *
 * For EVERY sidebar page and EVERY jwt role a custom-role holder can have:
 * granting the page's keys either actually shows the page, or the editor
 * declares the gate on the row (Locked chip / launch-gated note / jwt note).
 * A toggle that cannot take effect and says nothing is forbidden.
 */
test("no lying toggle: every togglable row is really visible when granted", () => {
  const src = stripComments(read(CUSTOM_ROLE_PAGE));
  const locked = new Set<string>(OWNER_ONLY_FIXED_NAV_ITEMS);
  const launchGated = new Set<string>(OWNER_ONLY_LIFTABLE_NAV_ITEMS);
  const notedIds = [...src.matchAll(/"([a-z0-9_.]+)":\s*"[^"]+"/g)]
    .map((m) => m[1])
    .filter((id) => id.includes("."));
  const noted = new Set<string>(notedIds);

  // The editor must actually mark the locked/launch-gated classes.
  assert.match(src, /LOCKED_NAV_ITEMS/, "the editor must have a locked-row concept");
  assert.match(src, /OWNER_ONLY_FIXED_NAV_ITEMS/, "locked rows must derive from the force-line list");
  assert.match(src, /LAUNCH_GATED_NAV_ITEMS/, "launch-gated rows must be noted");

  const liars: string[] = [];
  for (const item of navItems) {
    const granted = new Set<string>([item.permission, item.sectionPermission]);
    const can = (perm: string) => granted.has(perm);
    for (const jwt of ["TENANT_ADMIN", "USER"]) {
      const visible = isNavItemVisibleForUser(item, can as never, jwt, null);
      const declared = locked.has(item.id) || launchGated.has(item.id) || noted.has(item.id);
      if (!visible && !declared) liars.push(`${item.id} (jwt ${jwt})`);
    }
  }
  assert.deepEqual(
    liars,
    [],
    `rows whose toggle cannot take effect and say nothing: ${liars.join(", ")}`,
  );
});

test("locked rows never render a live toggle", () => {
  const src = stripComments(read(CUSTOM_ROLE_PAGE));
  assert.match(
    src,
    /const disabled = locked \|\| !itemGrantable \|\| !sectionOn;/,
    "a locked row must disable its toggle",
  );
  assert.match(src, /Locked<\/span>/, "a locked row must carry the Locked chip");
});

test("the Owner toggle exists and the key is kept out of the generic action panel", () => {
  const src = stripComments(read(CUSTOM_ROLE_PAGE));
  assert.match(src, /ACCOUNT_OWNER_PERMISSION_KEY/, "the editor must render the owner toggle");
  assert.match(src, /Owner — full access to their account/, "the owner card must exist");
  const hidden = src.match(/HIDDEN_ACTION_KEYS[\s\S]*?\]\)/)?.[0] || "";
  assert.match(hidden, /ACCOUNT_OWNER_PERMISSION_KEY/, "the owner key must not double-render as a generic action row");
});

/**
 * ONE KEY PER PAGE (Izzy, 2026-09-02: "Every toggle should be individual ...
 * they're all separated"). Before this, 16 sidebar rows shared a key with a
 * sibling, so a toggle for one moved the others on BOTH editors — and Direct /
 * Meetings additionally hid behind a SUPER_ADMIN force line, so a granted key
 * showed nothing ("I gave Ezra permission, and he doesn't see it").
 */
test("⛔ no two sidebar pages share a permission key — every toggle is individual", () => {
  const byKey = new Map<string, string[]>();
  for (const item of navItems) {
    const list = byKey.get(item.permission as string) || [];
    list.push(item.id);
    byKey.set(item.permission as string, list);
  }
  const shared = [...byKey.entries()].filter(([, ids]) => ids.length > 1).map(([k, ids]) => `${k}: ${ids.join(", ")}`);
  assert.deepEqual(shared, [], `these pages would move together on both editors: ${shared.join(" | ")}`);
});

test("⛔ an action key that is also a sidebar page renders ONE toggle in the custom-role editor, not two", () => {
  // Desk Phones rides can_setup_desk_phones and Remote Support rides
  // can_remote_support; both are also ACTION_PERMISSION_KEYS. Drawing them in
  // the Action Permissions panel too is two toggles bound to one key.
  const src = stripComments(read(CUSTOM_ROLE_PAGE));
  assert.match(src, /const NAV_BOUND_ACTION_KEYS = new Set<string>\(navItems\.map\(\(item\) => item\.permission as string\)\)/);
  assert.match(
    src,
    /ACTION_PERMISSION_KEYS\.filter\(\(k\) => [^\n]*!NAV_BOUND_ACTION_KEYS\.has\(k\)\)/,
    "the Action Permissions panel must skip keys already rendered as a sidebar row",
  );
  const navBound = navItems.map((i) => i.permission as string).filter((k) => (ACTION_PERMISSION_KEYS as readonly string[]).includes(k));
  assert.ok(navBound.includes("can_setup_desk_phones") && navBound.includes("can_remote_support"), "the two known nav-bound action keys must still be nav-bound");
});

test("⛔ the Owner-only lift is retired: Direct and Meetings gate on their own keys with no jwt force line", () => {
  assert.deepEqual([...OWNER_ONLY_LIFTABLE_NAV_ITEMS], []);
  const direct = navItems.find((i) => i.id === "workspace.direct")!;
  const meetings = navItems.find((i) => i.id === "workspace.meetings")!;
  assert.equal(direct.permission, "can_view_workspace_direct");
  assert.equal(meetings.permission, "can_view_workspace_meetings");
  for (const item of [direct, meetings]) {
    const granted = new Set<string>([item.permission, item.sectionPermission]);
    const can = ((p: string) => granted.has(p)) as never;
    for (const jwt of ["TENANT_ADMIN", "USER"]) {
      assert.equal(isNavItemVisibleForUser(item, can, jwt, null), true, `${item.id} must show for a ${jwt} who holds its key`);
    }
  }
  // The Permissions screen no longer draws the lift toggle at all.
  const perms = stripComments(read(PERMISSIONS_PAGE));
  assert.doesNotMatch(perms, /setOwnerOnly\(/, "the Owner-only lift toggle must not come back");
  assert.doesNotMatch(perms, /OWNER_ONLY_LIFTABLE/, "the Permissions screen must not read the retired list");
});

test("granting exactly one page's keys reveals exactly that page (or nothing, for a Locked platform page)", () => {
  // The separation property, exhaustively: for every nav item, a role holding
  // ONLY [section key, item key] sees that item and no other. A Locked item is
  // allowed to show nothing to a non-super jwt; it must still never leak a
  // sibling.
  const locked = new Set<string>(OWNER_ONLY_FIXED_NAV_ITEMS);
  const leaks: string[] = [];
  for (const item of navItems) {
    const granted = new Set<string>([item.permission, item.sectionPermission]);
    const can = ((p: string) => granted.has(p)) as never;
    for (const jwt of ["TENANT_ADMIN", "USER", "SUPER_ADMIN"]) {
      const visible = navItems.filter((other) => isNavItemVisibleForUser(other, can, jwt, null)).map((o) => o.id);
      const others = visible.filter((id) => id !== item.id);
      if (others.length) leaks.push(`${item.id} (jwt ${jwt}) also reveals ${others.join(", ")}`);
      const selfVisible = visible.includes(item.id);
      const mayHide = jwt !== "SUPER_ADMIN" && (locked.has(item.id) || (item.id === "crm.diagnostics" && jwt === "USER"));
      if (!selfVisible && !mayHide) leaks.push(`${item.id} (jwt ${jwt}) does not show when granted`);
    }
  }
  assert.deepEqual(leaks, []);
});
