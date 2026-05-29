import test from "node:test";
import assert from "node:assert/strict";
import { resolveEffectiveCrmTenantId } from "./guard";

test("resolveEffectiveCrmTenantId uses x-tenant-context for super-admin", () => {
  const tenantId = resolveEffectiveCrmTenantId(
    { headers: { "x-tenant-context": "selected-tenant" } },
    { sub: "user-1", tenantId: "home-tenant", role: "SUPER_ADMIN" },
  );
  assert.equal(tenantId, "selected-tenant");
});

test("resolveEffectiveCrmTenantId keeps JWT tenant for regular users", () => {
  const tenantId = resolveEffectiveCrmTenantId(
    { headers: { "x-tenant-context": "other-tenant" } },
    { sub: "user-1", tenantId: "home-tenant", role: "TENANT_ADMIN" },
  );
  assert.equal(tenantId, "home-tenant");
});
