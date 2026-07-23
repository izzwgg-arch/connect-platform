import { test } from "node:test";
import assert from "node:assert/strict";
import { makeScopeCheck } from "./scopeCheck";

/**
 * Mirror fixture: Connect tenant t1 ↔ vital tenant "21" with ext 103 and DID
 * +17185551234; Connect tenant t9 ↔ vital "8" (someone else's). User u1 is
 * ACTIVE in t1; u9 in t9; dead is DISABLED.
 */
function fakePrisma() {
  return {
    user: {
      findUnique: async ({ where }: any) =>
        ({
          u1: { tenantId: "t1", status: "ACTIVE" },
          u9: { tenantId: "t9", status: "ACTIVE" },
          dead: { tenantId: "t1", status: "DISABLED" },
        })[where.id as string] ?? null,
    },
    tenantPbxLink: {
      findUnique: async ({ where }: any) =>
        ({ t1: { pbxTenantId: "21" }, t9: { pbxTenantId: "8" } })[where.tenantId as string] ?? null,
      findFirst: async ({ where }: any) =>
        ({ "21": { tenantId: "t1" }, "8": { tenantId: "t9" } })[String(where.pbxTenantId)] ?? null,
    },
    extension: {
      findFirst: async ({ where }: any) =>
        where.tenantId === "t1" && where.extNumber === "103" ? { id: "e1" } : null,
    },
    pbxTenantInboundDid: {
      findFirst: async ({ where }: any) =>
        where.vitalTenantId === "21" && where.e164 === "+17185551234" ? { id: "d1" } : null,
    },
    phoneNumber: {
      findFirst: async ({ where }: any) =>
        where.tenantId === "t1" && where.phoneNumber === "+17185559999" ? { id: "p1" } : null,
    },
    mohProfile: {
      findFirst: async ({ where }: any) =>
        (where.id === "prof1" && where.tenantId === "t1") || (where.id === "profX" && where.tenantId === "t9") ? { id: where.id } : null,
    },
  };
}

const check = makeScopeCheck(fakePrisma());
const base = { requestedRole: "customer" as const };

test("customer: own extension in own vital tenant passes", async () => {
  assert.equal(await check({ tenantId: "21", objectType: "extension", objectId: "103", requestedBy: "customer:u1", ...base }), true);
});

test("customer: op aimed at ANOTHER vital tenant refused, even for a real object there", async () => {
  assert.equal(await check({ tenantId: "8", objectType: "extension", objectId: "103", requestedBy: "customer:u1", ...base }), false);
});

test("customer: extension that does not exist in their tenant refused", async () => {
  assert.equal(await check({ tenantId: "21", objectType: "extension", objectId: "999", requestedBy: "customer:u1", ...base }), false);
});

test("customer from tenant t9 cannot pass for t1's vital tenant", async () => {
  assert.equal(await check({ tenantId: "21", objectType: "extension", objectId: "103", requestedBy: "customer:u9", ...base }), false);
});

test("inactive user refused", async () => {
  assert.equal(await check({ tenantId: "21", objectType: "extension", objectId: "103", requestedBy: "customer:dead", ...base }), false);
});

test("DID: passes via PBX mirror e164 and via owned PhoneNumber", async () => {
  assert.equal(await check({ tenantId: "21", objectType: "inbound_did", objectId: "+17185551234", requestedBy: "customer:u1", ...base }), true);
  assert.equal(await check({ tenantId: "21", objectType: "inbound_did", objectId: "+17185559999", requestedBy: "customer:u1", ...base }), true);
  assert.equal(await check({ tenantId: "21", objectType: "inbound_did", objectId: "+15550000000", requestedBy: "customer:u1", ...base }), false);
});

test("tenant objectType: objectId must equal the (verified) vital tenant", async () => {
  assert.equal(await check({ tenantId: "21", objectType: "tenant", objectId: "21", requestedBy: "customer:u1", ...base }), true);
  assert.equal(await check({ tenantId: "21", objectType: "tenant", objectId: "8", requestedBy: "customer:u1", ...base }), false);
});

test("FAIL-CLOSED: unmapped objectType refused even when everything else lines up", async () => {
  assert.equal(await check({ tenantId: "21", objectType: "ivr", objectId: "ivr1", requestedBy: "customer:u1", ...base }), false);
});

test("moh_tenant (M1): own tenant slot passes; own profile passes; foreign/unknown profile refused", async () => {
  assert.equal(await check({ tenantId: "21", objectType: "moh_tenant", objectId: "21", requestedBy: "customer:u1", ...base }), true);
  assert.equal(await check({ tenantId: "21", objectType: "moh_tenant", objectId: "21", requestedBy: "customer:u1", params: { profileId: "prof1" }, ...base }), true);
  assert.equal(await check({ tenantId: "21", objectType: "moh_tenant", objectId: "21", requestedBy: "customer:u1", params: { profileId: "profX" }, ...base }), false);
  assert.equal(await check({ tenantId: "21", objectType: "moh_tenant", objectId: "21", requestedBy: "customer:u1", params: { profileId: "ghost" }, ...base }), false);
  // slot id must be the tenant itself
  assert.equal(await check({ tenantId: "21", objectType: "moh_tenant", objectId: "8", requestedBy: "customer:u1", ...base }), false);
});

test("owner: any KNOWN vital tenant passes; unknown tenant refused", async () => {
  assert.equal(await check({ tenantId: "21", objectType: "extension", objectId: "103", requestedBy: "owner:izzy", requestedRole: "owner" }), true);
  assert.equal(await check({ tenantId: "77", objectType: "extension", objectId: "103", requestedBy: "owner:izzy", requestedRole: "owner" }), false);
});

test("FAIL-CLOSED: DB error refuses", async () => {
  const boom = makeScopeCheck({ user: { findUnique: async () => { throw new Error("db down"); } } });
  assert.equal(await boom({ tenantId: "21", objectType: "extension", objectId: "103", requestedBy: "customer:u1", ...base }), false);
});
