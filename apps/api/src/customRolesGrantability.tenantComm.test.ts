import test, { mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

const NEW_KEYS = [
  "can_view_tenant_call_history",
  "can_view_tenant_voicemails",
  "can_view_tenant_chats",
  "can_view_tenant_call_recordings",
] as const;

// Grantability resolver toggles for tests
let basePerms: string[] = [];
let customPerms: string[] = [];

mock.module("./platformRolePermissions", {
  namedExports: {
    getEffectivePortalPermissionListForBucket: async () => basePerms,
    getEffectiveCustomRolePermissions: async () => customPerms as any,
  },
});

let registerCustomRoleRoutes: any;
async function loadRoutes() {
  ({ registerCustomRoleRoutes } = await import("./customRoleRoutes"));
}

async function appAs(user: { sub: string; tenantId: string; role: string }) {
  const app = Fastify();
  app.addHook("preHandler", async (req) => { (req as any).user = user; });
  await loadRoutes();
  registerCustomRoleRoutes(app);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("grantability: super admin sees all keys (includes tenant comm)", async () => {
  const app = await appAs({ sub: "a", tenantId: "t1", role: "SUPER_ADMIN" });
  const res = await app.inject({ method: "GET", url: "/admin/custom-roles/permissions-catalog" });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  for (const k of NEW_KEYS) {
    assert.ok(body.grantableKeys.includes(k), `${k} should be grantable by SUPER_ADMIN`);
  }
  await app.close();
});

test("grantability: tenant admin cannot grant keys they don't effectively hold", async () => {
  basePerms = []; // TENANT_ADMIN base snapshot has none of the new keys unless added later
  customPerms = []; // no custom role assigned yet
  const app = await appAs({ sub: "u1", tenantId: "t1", role: "TENANT_ADMIN" });
  const res = await app.inject({ method: "GET", url: "/admin/custom-roles/permissions-catalog" });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  for (const k of NEW_KEYS) {
    assert.ok(!body.grantableKeys.includes(k), `${k} should NOT be grantable without effective permission`);
  }
  await app.close();
});

test("grantability: tenant admin can grant keys present via their custom roles", async () => {
  basePerms = []; // base still empty for this scenario
  customPerms = [
    "can_view_tenant_call_history",
    "can_view_tenant_voicemails",
  ];
  const app = await appAs({ sub: "u1", tenantId: "t1", role: "TENANT_ADMIN" });
  const res = await app.inject({ method: "GET", url: "/admin/custom-roles/permissions-catalog" });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(body.grantableKeys.includes("can_view_tenant_call_history"));
  assert.ok(body.grantableKeys.includes("can_view_tenant_voicemails"));
  assert.ok(!body.grantableKeys.includes("can_view_tenant_call_recordings"));
  assert.ok(!body.grantableKeys.includes("can_view_tenant_chats"));
  await app.close();
});
