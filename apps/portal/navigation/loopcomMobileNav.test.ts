/**
 * LoopCom Mobile — portal wiring guards (2026-09-15; extended 2026-09-16 for
 * the approved full product area: its OWN sidebar section, ten pages, one key
 * per page).
 *
 * permissionToggleCoverage.test.ts already proves the generic contract for
 * every nav item (one key per page, toggles on both editors, the honesty
 * invariant). These guards pin the mobile-specific decisions:
 *   - ten customer pages in section "mobile", each gating through
 *     PermissionGate on ITS OWN key, no owner-role checks (granting is the
 *     launch) — and the Dashboard keeps the ORIGINAL launch key so existing
 *     grants survive the workspace.mobile → mobile.dashboard move;
 *   - the console page is owner-checked in source AND its nav item carries
 *     the SUPER_ADMIN force line + OWNER_ONLY_FIXED_NAV_ITEMS row;
 *   - no native <select> anywhere in the section (ConnectSelect only);
 *   - visibility simulated through the real isNavItemVisibleForUser.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { navItems, isNavItemVisibleForUser, NAV_SECTION_ORDER, navSectionMeta, OWNER_ONLY_FIXED_NAV_ITEMS } from "./navConfig";

const read = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

const MOBILE_PAGES: Array<{ id: string; href: string; permission: string; source: string }> = [
  { id: "mobile.dashboard", href: "/mobile", permission: "can_view_workspace_mobile", source: "app/(platform)/mobile/page.tsx" },
  { id: "mobile.users", href: "/mobile/users", permission: "can_view_mobile_users", source: "app/(platform)/mobile/users/page.tsx" },
  { id: "mobile.lines", href: "/mobile/lines", permission: "can_view_mobile_lines", source: "app/(platform)/mobile/lines/page.tsx" },
  { id: "mobile.plans", href: "/mobile/plans", permission: "can_view_mobile_plans", source: "app/(platform)/mobile/plans/page.tsx" },
  { id: "mobile.usage", href: "/mobile/usage", permission: "can_view_mobile_usage", source: "app/(platform)/mobile/usage/page.tsx" },
  { id: "mobile.billing", href: "/mobile/billing", permission: "can_view_mobile_billing", source: "app/(platform)/mobile/billing/page.tsx" },
  { id: "mobile.porting", href: "/mobile/porting", permission: "can_view_mobile_porting", source: "app/(platform)/mobile/porting/page.tsx" },
  { id: "mobile.devices", href: "/mobile/devices", permission: "can_view_mobile_devices", source: "app/(platform)/mobile/devices/page.tsx" },
  { id: "mobile.support", href: "/mobile/support", permission: "can_view_mobile_support", source: "app/(platform)/mobile/support/page.tsx" },
  { id: "mobile.settings", href: "/mobile/settings", permission: "can_view_mobile_settings", source: "app/(platform)/mobile/settings/page.tsx" },
];

const consoleItem = navItems.find((i) => i.id === "admin.mobile_console")!;

test("the mobile section exists with all ten pages, each on its own key", () => {
  assert.ok(NAV_SECTION_ORDER.includes("mobile"), "'mobile' must be in NAV_SECTION_ORDER");
  assert.equal(navSectionMeta.mobile?.label, "LoopCom Mobile");
  for (const page of MOBILE_PAGES) {
    const item = navItems.find((i) => i.id === page.id);
    assert.ok(item, `${page.id} nav item missing`);
    assert.equal(item!.href, page.href, `${page.id} href`);
    assert.equal(item!.permission, page.permission, `${page.id} permission key`);
    assert.equal(item!.section, "mobile", `${page.id} must live in the mobile section`);
    assert.equal(item!.sectionPermission, "can_view_section_mobile", `${page.id} section key`);
  }
  // One key per page: no two mobile pages share a permission key.
  const keys = MOBILE_PAGES.map((p) => p.permission);
  assert.equal(new Set(keys).size, keys.length, "every mobile page must have its OWN key");
});

test("granting a page's keys really shows it — for a plain USER jwt too (the honesty rule)", () => {
  for (const page of MOBILE_PAGES) {
    const item = navItems.find((i) => i.id === page.id)!;
    const can = (p: string) => p === "can_view_section_mobile" || p === page.permission;
    assert.equal(isNavItemVisibleForUser(item, can as any, "USER"), true, `${page.id} must show for a USER jwt with its keys`);
    assert.equal(isNavItemVisibleForUser(item, can as any, "TENANT_ADMIN"), true, `${page.id} must show for a TENANT_ADMIN with its keys`);
    // and without the page key it stays hidden
    assert.equal(isNavItemVisibleForUser(item, ((p: string) => p === "can_view_section_mobile") as any, "TENANT_ADMIN"), false, `${page.id} must hide without its own key`);
  }
});

test("the console is owner-only even with its keys granted, and the role editor is told", () => {
  const can = () => true;
  assert.equal(isNavItemVisibleForUser(consoleItem, can as any, "TENANT_ADMIN"), false);
  assert.equal(isNavItemVisibleForUser(consoleItem, can as any, "SUPER_ADMIN"), true);
  assert.ok(OWNER_ONLY_FIXED_NAV_ITEMS.includes("admin.mobile_console"), "console must be in OWNER_ONLY_FIXED_NAV_ITEMS so its toggle row renders Locked");
});

test("every customer page gates through PermissionGate on its own key, with no owner-role check", () => {
  for (const page of MOBILE_PAGES) {
    const source = read(page.source);
    assert.match(source, new RegExp(`PermissionGate permission="${page.permission}"`), `${page.source} must gate on ${page.permission}`);
    assert.doesNotMatch(source, /SUPER_ADMIN/, `${page.source} must not require an owner role`);
    assert.doesNotMatch(source, /<select[\s>]/, `${page.source}: native <select> is banned — ConnectSelect only`);
  }
});

test("the console page checks the owner role, uses ConnectSelect, and the money action says what it buys", () => {
  const page = read("app/(platform)/admin/mobile-console/page.tsx");
  assert.match(page, /role === "SUPER_ADMIN"/);
  assert.doesNotMatch(page, /<select[\s>]/, "native <select> is banned — ConnectSelect only");
  assert.match(page, /ConnectSelect/);
  // The money action must say what it buys before it buys it.
  assert.match(page, /PURCHASES 1 eSIM/);
  // Invoice generation states its ledger and idempotency before running.
  assert.match(page, /cannot double-bill/);
});

test("detail pages under the section gate on their parent page's key", () => {
  const lineDetail = read("app/(platform)/mobile/lines/[id]/page.tsx");
  assert.match(lineDetail, /PermissionGate permission="can_view_mobile_lines"/);
  const invoiceDetail = read("app/(platform)/mobile/billing/[id]/page.tsx");
  assert.match(invoiceDetail, /PermissionGate permission="can_view_mobile_billing"/);
});
