/**
 * LoopCom Mobile — portal wiring guards (2026-09-15).
 *
 * permissionToggleCoverage.test.ts already proves the generic contract for
 * every nav item (one key per page, toggles on both editors, the honesty
 * invariant). These guards pin the mobile-specific decisions:
 *   - the customer page gates on ITS OWN key through PermissionGate and has
 *     no owner-role check (granting the key is the launch);
 *   - the console page is owner-checked in source AND its nav item carries
 *     the SUPER_ADMIN force line + OWNER_ONLY_FIXED_NAV_ITEMS row;
 *   - the console renders no native <select> (ConnectSelect is the only
 *     dropdown platform-wide);
 *   - visibility simulated through the real isNavItemVisibleForUser.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { navItems, isNavItemVisibleForUser, OWNER_ONLY_FIXED_NAV_ITEMS } from "./navConfig";

const read = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

const mobileItem = navItems.find((i) => i.id === "workspace.mobile")!;
const consoleItem = navItems.find((i) => i.id === "admin.mobile_console")!;

test("both nav items exist with their own keys", () => {
  assert.ok(mobileItem, "workspace.mobile nav item missing");
  assert.equal(mobileItem.permission, "can_view_workspace_mobile");
  assert.equal(mobileItem.href, "/mobile");
  assert.ok(consoleItem, "admin.mobile_console nav item missing");
  assert.equal(consoleItem.permission, "can_view_admin_mobile_console");
  assert.equal(consoleItem.href, "/admin/mobile-console");
});

test("granting the customer page's keys really shows it — for a plain USER jwt too", () => {
  const can = (p: string) => p === "can_view_section_workspace" || p === "can_view_workspace_mobile";
  assert.equal(isNavItemVisibleForUser(mobileItem, can as any, "USER"), true);
  assert.equal(isNavItemVisibleForUser(mobileItem, can as any, "TENANT_ADMIN"), true);
  // and without the key it stays hidden
  assert.equal(isNavItemVisibleForUser(mobileItem, ((p: string) => p === "can_view_section_workspace") as any, "TENANT_ADMIN"), false);
});

test("the console is owner-only even with its keys granted, and the role editor is told", () => {
  const can = () => true;
  assert.equal(isNavItemVisibleForUser(consoleItem, can as any, "TENANT_ADMIN"), false);
  assert.equal(isNavItemVisibleForUser(consoleItem, can as any, "SUPER_ADMIN"), true);
  assert.ok(OWNER_ONLY_FIXED_NAV_ITEMS.includes("admin.mobile_console"), "console must be in OWNER_ONLY_FIXED_NAV_ITEMS so its toggle row renders Locked");
});

test("the customer page gates on PermissionGate with its own key", () => {
  const page = read("app/(platform)/mobile/page.tsx");
  assert.match(page, /PermissionGate permission="can_view_workspace_mobile"/);
  assert.doesNotMatch(page, /SUPER_ADMIN/, "the customer page must not require an owner role");
});

test("the console page checks the owner role and uses ConnectSelect, never a native select", () => {
  const page = read("app/(platform)/admin/mobile-console/page.tsx");
  assert.match(page, /role === "SUPER_ADMIN"/);
  assert.doesNotMatch(page, /<select[\s>]/, "native <select> is banned — ConnectSelect only");
  assert.match(page, /ConnectSelect/);
  // The money action must say what it buys before it buys it.
  assert.match(page, /PURCHASES 1 eSIM/);
});
