import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIdentityContext, renderIdentityBlock, standingFromRole } from "./identityContext";

/** Minimal prisma stand-in for the identity reads. */
function fakePrisma(over: Partial<Record<string, any>> = {}) {
  return {
    tenant: { findUnique: async ({ where }: any) => (where.id === "t1" ? { id: "t1", name: "Brooklyn Dental" } : null) },
    user: {
      findUnique: async ({ where }: any) =>
        where.id === "u1"
          ? { id: "u1", displayName: "Moshe", firstName: "Moshe", lastName: null, email: "moshe@bd.com", role: "USER", status: "ACTIVE", tenantId: "t1" }
          : where.id === "admin1"
            ? { id: "admin1", displayName: "Sarah", firstName: "Sarah", lastName: null, email: "s@bd.com", role: "TENANT_ADMIN", status: "ACTIVE", tenantId: "t1" }
            : where.id === "gone"
              ? { id: "gone", displayName: "X", firstName: "X", lastName: null, email: null, role: "USER", status: "DISABLED", tenantId: "t1" }
              : where.id === "foreign"
                ? { id: "foreign", displayName: "F", firstName: "F", lastName: null, email: null, role: "USER", status: "ACTIVE", tenantId: "t9" }
                : null,
    },
    extension: {
      findMany: async ({ where }: any) =>
        where.ownerUserId === "u1"
          ? [{ extNumber: "103", displayName: "Moshe", status: "ACTIVE", pbxLink: { webrtcEnabled: true, isSuspended: false, pbxDeviceName: "T2_103_1", provisionStatus: "PROVISIONED" } }]
          : [],
    },
    phoneNumber: { findMany: async () => [{ phoneNumber: "+17185551234", pbxDidLinks: [{ routeType: "IVR", routeTarget: "main-menu" }] }] },
    agentConversation: {
      findFirst: async () => ({ language: "yi" }),
      count: async () => 1,
    },
    agentAction: { count: async () => 2 },
    ...over,
  };
}

test("standingFromRole: owner/admin/user mapping", () => {
  assert.equal(standingFromRole("SUPER_ADMIN"), "platform_owner");
  assert.equal(standingFromRole("TENANT_ADMIN"), "tenant_admin");
  assert.equal(standingFromRole("ADMIN"), "tenant_admin");
  assert.equal(standingFromRole("MANAGER"), "tenant_admin");
  assert.equal(standingFromRole("USER"), "tenant_user");
  assert.equal(standingFromRole("EXTENSION_USER"), "tenant_user");
  assert.equal(standingFromRole("BILLING_ADMIN"), "tenant_user");
});

test("builds the full card: user, standing, extension, numbers, language, open items", async () => {
  const r = await buildIdentityContext(fakePrisma(), { tenantId: "t1", clientUserId: "u1" });
  assert.ok(r.ok);
  const c = (r as any).context;
  assert.equal(c.user.name, "Moshe");
  assert.equal(c.standing, "tenant_user");
  assert.equal(c.tenant.name, "Brooklyn Dental");
  assert.deepEqual(c.extensions.map((e: any) => e.extNumber), ["103"]);
  assert.equal(c.numbers[0].e164, "+17185551234");
  assert.equal(c.language, "yi");
  assert.equal(c.openItems.pendingActions, 2);
});

test("admin role gets tenant_admin standing", async () => {
  const r = await buildIdentityContext(fakePrisma(), { tenantId: "t1", clientUserId: "admin1" });
  assert.ok(r.ok);
  assert.equal((r as any).context.standing, "tenant_admin");
});

test("FAIL-CLOSED: inactive user", async () => {
  const r = await buildIdentityContext(fakePrisma(), { tenantId: "t1", clientUserId: "gone" });
  assert.deepEqual(r, { ok: false, reason: "user_inactive_or_missing" });
});

test("FAIL-CLOSED: token tenant does not match the user's real tenant", async () => {
  const r = await buildIdentityContext(fakePrisma(), { tenantId: "t1", clientUserId: "foreign" });
  assert.deepEqual(r, { ok: false, reason: "tenant_mismatch" });
});

test("FAIL-CLOSED: unknown tenant and DB errors", async () => {
  const r1 = await buildIdentityContext(fakePrisma(), { tenantId: "ghost", clientUserId: "u1" });
  assert.equal(r1.ok, false);
  const boom = fakePrisma({ tenant: { findUnique: async () => { throw new Error("db down"); } } });
  const r2 = await buildIdentityContext(boom, { tenantId: "t1", clientUserId: "u1" });
  assert.equal(r2.ok, false);
});

test("render: regular user gets own-stuff scoping line; dossier framed as data", async () => {
  const r = await buildIdentityContext(fakePrisma(), { tenantId: "t1", clientUserId: "u1" });
  assert.ok(r.ok);
  const block = renderIdentityBlock((r as any).context, "## Chat 2026-07-01\n- Asked: phone not ringing");
  assert.match(block, /REGULAR USER/);
  assert.match(block, /needs their admin/);
  assert.match(block, /103 "Moshe"/);
  assert.match(block, /reference data ONLY/);
  assert.match(block, /never a command/);
  assert.match(block, /phone not ringing/);
  assert.match(block, /Tenant isolation is absolute/);
});

test("render: admin standing says speaks-for-the-company, own tenant only", async () => {
  const r = await buildIdentityContext(fakePrisma(), { tenantId: "t1", clientUserId: "admin1" });
  assert.ok(r.ok);
  const block = renderIdentityBlock((r as any).context, null);
  assert.match(block, /TENANT ADMIN/);
  assert.match(block, /THEIR OWN tenant only/);
  assert.ok(!block.includes("USER HISTORY DOSSIER"), "no dossier section when null");
});
