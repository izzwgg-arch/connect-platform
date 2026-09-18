import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { effectiveDeskPhoneUser, tenantContextOf } from "./effectiveUser";

const ADMIN_TENANT = "11111111-1111-4111-8111-111111111111";
const CUSTOMER = "22222222-2222-4222-8222-222222222222";
const req = (role: string, ctx?: string) => ({
  user: { sub: "u1", tenantId: ADMIN_TENANT, email: "izzy@loopcom.net", role },
  headers: ctx === undefined ? {} : { "x-tenant-context": ctx },
});

describe("effectiveDeskPhoneUser — the super-admin tenant switcher reaches the desk-phone doors", () => {
  it("a super-admin acting as a customer runs the wizard FOR that customer", () => {
    const u = effectiveDeskPhoneUser(req("SUPER_ADMIN", CUSTOMER));
    assert.equal(u.tenantId, CUSTOMER);
    assert.equal(u.sub, "u1", "the actor stays the admin (audit rows name the real person)");
    assert.equal(u.role, "SUPER_ADMIN");
  });
  it("⛔ a tenant admin's header is ignored — their token's tenant is the only one they touch", () => {
    assert.equal(effectiveDeskPhoneUser(req("TENANT_ADMIN", CUSTOMER)).tenantId, ADMIN_TENANT);
    assert.equal(effectiveDeskPhoneUser(req("USER", CUSTOMER)).tenantId, ADMIN_TENANT);
  });
  it("no header, a blank header, or the admin's own tenant → the token's tenant, same object", () => {
    const r = req("SUPER_ADMIN");
    assert.equal(effectiveDeskPhoneUser(r), r.user);
    assert.equal(effectiveDeskPhoneUser(req("SUPER_ADMIN", "")).tenantId, ADMIN_TENANT);
    assert.equal(effectiveDeskPhoneUser(req("SUPER_ADMIN", ADMIN_TENANT)).tenantId, ADMIN_TENANT);
  });
  it("only a UUID-shaped context counts (a slug, a path, an injection attempt are ignored)", () => {
    assert.equal(tenantContextOf({ headers: { "x-tenant-context": "vpbx:landau" } }), null);
    assert.equal(tenantContextOf({ headers: { "x-tenant-context": "../etc" } }), null);
    assert.equal(tenantContextOf({ headers: { "x-tenant-context": " " + CUSTOMER + " " } }), CUSTOMER);
    assert.equal(effectiveDeskPhoneUser(req("SUPER_ADMIN", "not-a-uuid")).tenantId, ADMIN_TENANT);
  });
  it("no user → undefined passes through (the route's own 401 fires)", () => {
    assert.equal(effectiveDeskPhoneUser({ headers: {} }), undefined);
  });
});
