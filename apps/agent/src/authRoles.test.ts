import { test } from "node:test";
import assert from "node:assert/strict";
import { mapUserRole, elevateForCustomOwnerRole, ADMIN_USER_ROLES } from "./authRoles";
import { verifyPortalJwt } from "./auth";
import { createHmac } from "node:crypto";

test("TENANT_ADMIN is admin-grade — the bug this file exists to fix", () => {
  assert.equal(mapUserRole("TENANT_ADMIN"), "owner");
  assert.equal(mapUserRole("SUPER_ADMIN"), "owner");
});

test("non-admin platform roles stay customers", () => {
  for (const r of ["MANAGER", "ADMIN", "BILLING_ADMIN", "SUPPORT", "READ_ONLY", "EXTENSION_USER", "USER", "MESSAGING", "BILLING"]) {
    assert.equal(mapUserRole(r), "customer", `${r} must not be admin-grade`);
  }
});

test("⛔ unknown / empty / junk roles fail CLOSED", () => {
  for (const r of [null, undefined, "", "   ", "owner", "OWNER", "root", "admin'; --"]) {
    assert.equal(mapUserRole(r as any), "customer", `${String(r)} must fail closed`);
  }
});

test("role matching tolerates case and whitespace but nothing else", () => {
  assert.equal(mapUserRole(" tenant_admin "), "owner");
  assert.equal(mapUserRole("Tenant_Admin"), "owner");
  assert.equal(mapUserRole("TENANT_ADMINISTRATOR"), "customer");
});

test("ADMIN_USER_ROLES is exactly the two platform admin roles", () => {
  assert.deepEqual([...ADMIN_USER_ROLES].sort(), ["SUPER_ADMIN", "TENANT_ADMIN"]);
});

test("a custom role named 'owner' promotes a customer", async () => {
  const prisma = { userCustomRole: { findFirst: async () => ({ id: "x" }) } };
  const got = await elevateForCustomOwnerRole(prisma, { tenantId: "t1", clientUserId: "u1", role: "customer" });
  assert.equal(got, "owner");
});

test("no matching custom role leaves the customer a customer", async () => {
  const prisma = { userCustomRole: { findFirst: async () => null } };
  const got = await elevateForCustomOwnerRole(prisma, { tenantId: "t1", clientUserId: "u1", role: "customer" });
  assert.equal(got, "customer");
});

test("⛔ the elevation query is scoped to the caller's own tenant and user", async () => {
  let where: any = null;
  const prisma = { userCustomRole: { findFirst: async (q: any) => { where = q.where; return null; } } };
  await elevateForCustomOwnerRole(prisma, { tenantId: "t1", clientUserId: "u1", role: "customer" });
  assert.equal(where.tenantId, "t1");
  assert.equal(where.userId, "u1");
  assert.equal(where.customRole.tenantId, "t1", "the role itself must belong to the same tenant");
  assert.equal(where.customRole.active, true, "an inactive role must not confer admin");
});

test("⛔ a DB failure must NOT promote anyone", async () => {
  const prisma = { userCustomRole: { findFirst: async () => { throw new Error("db down"); } } };
  const got = await elevateForCustomOwnerRole(prisma, { tenantId: "t1", clientUserId: "u1", role: "customer" });
  assert.equal(got, "customer");
});

test("elevation is a no-op for someone already admin, and never queries", async () => {
  let called = false;
  const prisma = { userCustomRole: { findFirst: async () => { called = true; return null; } } };
  const got = await elevateForCustomOwnerRole(prisma, { tenantId: "t1", clientUserId: "u1", role: "owner" });
  assert.equal(got, "owner");
  assert.equal(called, false);
});

test("portal JWT now grants admin mode to a TENANT_ADMIN", () => {
  const secret = "s3cret";
  const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const mk = (role: string) => {
    const h = b64({ alg: "HS256", typ: "JWT" });
    const p = b64({ sub: "u1", tenantId: "t1", email: "a@b.c", role });
    const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
    return `${h}.${p}.${sig}`;
  };
  assert.equal(verifyPortalJwt(mk("TENANT_ADMIN"), secret)?.role, "owner");
  assert.equal(verifyPortalJwt(mk("SUPER_ADMIN"), secret)?.role, "owner");
  assert.equal(verifyPortalJwt(mk("SUPPORT"), secret)?.role, "customer");
});
