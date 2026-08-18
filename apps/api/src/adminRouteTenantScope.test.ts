import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Guard for the fix to §4 of AGENT_HANDOFF_TENANT_ISOLATION_AUDIT_2026-08-17.md.
 *
 * `requireAdmin` admits ADMIN, TENANT_ADMIN **and** SUPER_ADMIN, and six
 * `/admin/*` handlers behind it queried with no tenant filter — so any of the 8
 * live TENANT_ADMIN accounts (8 different real customer tenants) could read the
 * whole customer list, flip another customer's `isApproved` / `dailySmsCap`, read
 * every Android device with its user's email, and approve or kill another
 * company's SMS campaign.
 *
 * ⛔ These are SOURCE guards. `server.ts` is ~36k lines with no exported route
 * handlers and a live database behind every one, so a behavioural test would need
 * the whole app booted. The failure mode being guarded is a one-word edit
 * (`requireSuperAdmin` → `requireAdmin`, or dropping the `where`), which reading
 * the source catches exactly.
 */

const SERVER_SRC = readFileSync(resolve(__dirname, "./server.ts"), "utf8");

/** The handler body between a route registration and the next top-level `app.<verb>(`. */
function handlerBody(registration: string): string {
  const start = SERVER_SRC.indexOf(registration);
  assert.notEqual(start, -1, `route not found in server.ts: ${registration}`);
  const rest = SERVER_SRC.slice(start + registration.length);
  const end = rest.search(/\napp\.(get|post|patch|put|delete)\(/);
  return end === -1 ? rest : rest.slice(0, end);
}

// ── The scoping helper ────────────────────────────────────────────────────────

test("⛔ ownTenantScopeWhere exists and FAILS CLOSED on an unusable tenantId", () => {
  const fn = /function ownTenantScopeWhere\(user: JwtUser\)[\s\S]*?\n\}/.exec(SERVER_SRC);
  assert.ok(fn, "ownTenantScopeWhere must exist");
  const body = fn![0];
  assert.ok(body.includes('isRole(user, ["SUPER_ADMIN"])'), "super-admins must be unscoped");
  // ⛔ The whole bug class: an `undefined` where is "no filter" in Prisma, which
  // returns the entire platform. A non-super-admin must never reach that.
  assert.ok(
    body.includes("{ id: { in: [] } }"),
    "an unusable tenantId must produce an empty-result filter, never undefined",
  );
  for (const marker of ['=== "local"', '=== "global"', 'startsWith("vpbx:")']) {
    assert.ok(body.includes(marker), `the placeholder tenant marker ${marker} must be refused`);
  }
});

test("⛔ ownTenantIdScopeWhere fails closed the same way", () => {
  const fn = /function ownTenantIdScopeWhere\(user: JwtUser\)[\s\S]*?\n\}/.exec(SERVER_SRC);
  assert.ok(fn, "ownTenantIdScopeWhere must exist");
  assert.ok(
    fn![0].includes("{ tenantId: { in: [] } }"),
    "the tenantId-column variant must also produce an empty-result filter",
  );
});

// ── Routes that are SCOPED (tenant admins keep using them) ────────────────────

test("⛔ GET /admin/tenants is tenant-scoped, not an unfiltered findMany", () => {
  const body = handlerBody('app.get("/admin/tenants", async (req, reply) => {');
  assert.ok(body.includes("requireAdmin(req, reply)"), "tenant admins must still reach it");
  assert.ok(
    /db\.tenant\.findMany\(\{\s*where:\s*ownTenantScopeWhere\(admin\)/.test(body),
    "the tenant list must be scoped by ownTenantScopeWhere",
  );
  assert.ok(
    !/db\.tenant\.findMany\(\{ orderBy: \{ createdAt: "desc" \} \}\)/.test(body),
    "the unfiltered findMany must be gone",
  );
});

test("GET /admin/tenants: both response shapes derive from the SAME scoped list", () => {
  const body = handlerBody('app.get("/admin/tenants", async (req, reply) => {');
  // The ?light=1 branch and the full branch both read `tenants`; there must be
  // exactly one tenant.findMany in the handler or one shape could leak.
  assert.equal(
    (body.match(/db\.tenant\.findMany/g) || []).length,
    1,
    "one scoped query must feed both the light and the full response",
  );
});

test("⛔ GET /admin/sms/campaigns is tenant-scoped", () => {
  const body = handlerBody('app.get("/admin/sms/campaigns", async (req, reply) => {');
  assert.ok(body.includes("ownTenantIdScopeWhere(admin)"), "campaign list must be tenant-scoped");
  assert.ok(
    !/findMany\(\{ where: query\.status \? \{ status: query\.status \} : undefined/.test(body),
    "the status-only where must be gone",
  );
});

// ── Routes that move to SUPER_ADMIN ───────────────────────────────────────────

const SUPER_ADMIN_ONLY = [
  'app.patch("/admin/tenants/:id", async (req, reply) => {',
  'app.get("/admin/wake-health", async (req, reply) => {',
  'app.post("/admin/sms/campaigns/:id/approve", async (req, reply) => {',
  'app.post("/admin/sms/campaigns/:id/reject", async (req, reply) => {',
];

for (const registration of SUPER_ADMIN_ONLY) {
  const label = /app\.\w+\("([^"]+)"/.exec(registration)![1];
  test(`⛔ ${label} requires SUPER_ADMIN, not requireAdmin`, () => {
    const body = handlerBody(registration);
    assert.ok(
      body.includes("requireSuperAdmin(req, reply)"),
      `${label} must gate on requireSuperAdmin`,
    );
    assert.ok(
      !body.includes("requireAdmin(req, reply)"),
      `${label} must NOT admit TENANT_ADMIN via requireAdmin`,
    );
  });
}

test("requireSuperAdmin really means SUPER_ADMIN alone", () => {
  const fn = /function canAccessAdminSbc\(user: JwtUser\): boolean \{[\s\S]*?\n\}/.exec(SERVER_SRC);
  assert.ok(fn);
  assert.ok(
    fn![0].includes('isRole(user, ["SUPER_ADMIN"])'),
    "requireSuperAdmin delegates to canAccessAdminSbc — it must list SUPER_ADMIN only",
  );
  assert.ok(
    /async function requireSuperAdmin\([\s\S]{0,200}?canAccessAdminSbc/.test(SERVER_SRC),
    "requireSuperAdmin must still delegate to canAccessAdminSbc",
  );
});

test("requireAdmin still admits TENANT_ADMIN — this fix must not narrow it globally", () => {
  const fn = /async function requireAdmin\(req: any, reply: any\)[\s\S]*?\n\}/.exec(SERVER_SRC);
  assert.ok(fn);
  assert.ok(
    fn![0].includes('["ADMIN", "TENANT_ADMIN", "SUPER_ADMIN"]'),
    "requireAdmin must keep its existing role set — the scoping is per route, not global",
  );
});

// ── The missing permission-map entry ──────────────────────────────────────────

test("⛔ /admin/wake-health now has a PORTAL_API_PERMISSION_RULES entry", () => {
  assert.ok(
    /\{ prefix: "\/admin\/wake-health", permission: "can_view_admin_server_health" \}/.test(SERVER_SRC),
    "wake-health matched no rule at all, so the global permission gate never ran for it",
  );
});

test("⛔ the wake-health key is NOT one the live TENANT_ADMIN bucket holds", () => {
  // Live PlatformRolePermissionSnapshot(id="default") v2, read 2026-08-18: the
  // TENANT_ADMIN bucket's 92 keys include can_view_admin, _billing,
  // _cdr_tenant_map, _console, _onboarding, _pbx_events, _pbx_instances,
  // _phone_numbers, _roles, _tenants and _users — but NOT _server_health.
  const TENANT_ADMIN_ADMIN_KEYS = [
    "can_view_admin",
    "can_view_admin_billing",
    "can_view_admin_cdr_tenant_map",
    "can_view_admin_console",
    "can_view_admin_onboarding",
    "can_view_admin_pbx_events",
    "can_view_admin_pbx_instances",
    "can_view_admin_phone_numbers",
    "can_view_admin_roles",
    "can_view_admin_tenants",
    "can_view_admin_users",
  ];
  assert.ok(
    !TENANT_ADMIN_ADMIN_KEYS.includes("can_view_admin_server_health"),
    "choosing a key the TENANT_ADMIN bucket holds would make the gate decorative",
  );
});
