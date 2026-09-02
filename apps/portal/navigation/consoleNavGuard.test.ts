/**
 * The platform console must never appear in a customer's sidebar.
 *
 * ⛔ WHY THIS FILE EXISTS (2026-08-20 tenant-leak sweep). The PBX Console and
 * its two module doors show and CHANGE every customer's trunks, dial plans,
 * ring groups and queues. They were keyed off `can_view_admin_pbx_instances`
 * — and the LIVE PlatformRolePermissionSnapshot gives that key to
 * TENANT_ADMIN, which 10 active customer admins hold. Three things were
 * hiding the console from them (the Admin section key, the SUPER_ADMIN force
 * in isNavItemVisibleForUser, and the api's own requireOwner), so nothing
 * leaked — but the item key itself was agreeing with the customer, not with
 * the server, and that is one refactor away from advertising the whole
 * platform's routing in a customer's sidebar.
 *
 * These guards read the SOURCE, because the defect they prevent is a config
 * line, not a function. They pin two independent properties:
 *   1. every console nav item is keyed on the SAME permission the api's
 *      PORTAL_API_PERMISSION_RULES entry demands for /admin/pbx-console, and
 *   2. every console nav item is additionally SUPER_ADMIN-forced.
 * Either alone keeps customers out; the test requires both, so losing one in
 * a refactor is a red test rather than a silent exposure.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const norm = (s: string) => s.replace(/\r\n/g, "\n");
const NAV = norm(readFileSync(join(__dirname, "navConfig.ts"), "utf8"));
const API_ROUTES = norm(readFileSync(join(__dirname, "..", "..", "api", "src", "server.ts"), "utf8"));

/** Every nav item that opens the platform PBX console. */
const CONSOLE_ITEMS = ["admin.pbx_console", "admin.pbx_routing", "admin.pbx_teams"];

/** The key the api demands for the whole /admin/pbx-console prefix. */
const CONSOLE_API_KEY = "can_manage_global_settings";

function navItemLine(id: string): string {
  const line = NAV.split("\n").find((l) => l.includes(`id: "${id}"`) && l.includes("href:"));
  assert.ok(line, `nav item ${id} must exist`);
  return line!;
}

test("the api still gates the whole /admin/pbx-console prefix on can_manage_global_settings", () => {
  // If this changes, the nav keys below are aligned to the wrong thing and the
  // rest of this file is worthless — so it is asserted first, from the api.
  assert.match(
    API_ROUTES,
    /\{\s*prefix:\s*"\/admin\/pbx-console",\s*permission:\s*"can_manage_global_settings"\s*\}/,
    "the console prefix rule must still demand can_manage_global_settings",
  );
});

test("every console nav item is keyed on its OWN per-page key, and no default bucket holds it", async () => {
  // 2026-09-02: one key per sidebar page (Izzy: "every toggle should be
  // individual"). The three console doors used to share can_manage_global_settings
  // with four other admin pages, so one toggle moved seven rows. Each now has
  // its own key; the property that protects customers is that NO default
  // bucket (END_USER / TENANT_ADMIN) holds any of them — the api prefix rule
  // (asserted above) and the SUPER_ADMIN force line (asserted below) are the
  // other two locks.
  const { DEFAULT_ROLE_PERMISSIONS } = await import("@connect/shared");
  const expected: Record<string, string> = {
    "admin.pbx_console": "can_view_admin_pbx_console",
    "admin.pbx_routing": "can_view_admin_pbx_routing",
    "admin.pbx_teams": "can_view_admin_pbx_teams",
  };
  for (const id of CONSOLE_ITEMS) {
    const line = navItemLine(id);
    const key = (line.match(/permission:\s*"([^"]+)"/) || [])[1];
    assert.equal(key, expected[id], `${id} must be keyed on its own key ${expected[id]}, not ${key}`);
    assert.equal(DEFAULT_ROLE_PERMISSIONS.END_USER.includes(key as never), false, `${key} must not be an END_USER default`);
    assert.equal(DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN.includes(key as never), false, `${key} must not be a TENANT_ADMIN default`);
  }
});

test("⛔ no console nav item may use a key the TENANT_ADMIN bucket holds", () => {
  // The two keys measured in the live snapshot as held by TENANT_ADMIN
  // (2026-08-20: 92 keys, including these). Keying a platform-wide screen off
  // either is the exact latent exposure this sweep found.
  const TENANT_ADMIN_HELD = ["can_view_admin_pbx_instances", "can_view_admin_tenants"];
  for (const id of CONSOLE_ITEMS) {
    const line = navItemLine(id);
    for (const key of TENANT_ADMIN_HELD) {
      assert.ok(
        !line.includes(`permission: "${key}"`),
        `${id} is keyed on ${key}, which customer admins hold — use ${CONSOLE_API_KEY}`,
      );
    }
  }
});

test("every console nav item is ALSO SUPER_ADMIN-forced in isNavItemVisibleForUser", () => {
  // Belt and braces: the key above is the lock, this is the deadbolt. Both are
  // required so that losing either one fails a test instead of exposing a page.
  for (const id of CONSOLE_ITEMS) {
    const re = new RegExp(
      `item\\.id === "${id.replace(".", "\\.")}" && backendJwtRole !== "SUPER_ADMIN"\\) return false`,
    );
    assert.match(NAV, re, `${id} must be SUPER_ADMIN-forced in isNavItemVisibleForUser`);
  }
});

test("the console's module doors deep-link into the console, not to routes of their own", () => {
  // A separate page would need its own permission rule in the api; these two
  // are query-string doors into the already-gated console page on purpose.
  for (const id of ["admin.pbx_routing", "admin.pbx_teams"]) {
    const line = navItemLine(id);
    const href = (line.match(/href:\s*"([^"]+)"/) || [])[1];
    assert.ok(
      href.startsWith("/admin/pbx-console?"),
      `${id} must be a door into /admin/pbx-console (got ${href}) so the prefix rule covers it`,
    );
  }
});

test("the console PAGE itself gates on the same key, not a customer-held one", () => {
  // The page's PermissionGate is the third layer named in its own header
  // comment. It was keyed on can_view_admin_pbx_instances, which customers
  // hold — so the layer existed but did not gate. Nothing leaked (the api
  // refuses every call), but the frame rendered for a customer.
  const page = norm(readFileSync(join(__dirname, "..", "app", "(platform)", "admin", "pbx-console", "page.tsx"), "utf8"));
  const gate = page.match(/<PermissionGate permission=\{"([^"]+)" as never\}/);
  assert.ok(gate, "the console page must wrap itself in a PermissionGate");
  assert.equal(gate![1], CONSOLE_API_KEY, `the page gate must use ${CONSOLE_API_KEY}, not ${gate![1]}`);
});
