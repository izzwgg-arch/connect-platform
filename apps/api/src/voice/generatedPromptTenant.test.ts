/**
 * Which customer a generated recording is filed under.
 *
 * This is a regression suite for a live incident on 2026-08-06: twelve
 * greetings made for a customer through the IVR Studio were filed under the
 * signed-in super-admin's own tenant, because both generate routes read the
 * tenant from the request BODY and the Studio only ever sends it in the QUERY
 * STRING. Nothing threw, every request answered 200, and the recordings simply
 * never appeared for the customer they were made for — which reads exactly like
 * "I made them, I reloaded, they were deleted".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGeneratedPromptTenantId } from "./generatedPromptStore";

/** Enough of the client for the vpbx: branch; every call is optional. */
function fakeDb(opts: {
  directory?: { tenantSlug: string; vitalTenantId: string; tenantCode: string } | null;
  link?: { tenantId: string } | null;
  tenantByName?: { id: string } | null;
} = {}) {
  return {
    pbxTenantDirectory: { findFirst: async () => opts.directory ?? null },
    tenantPbxLink: { findFirst: async () => opts.link ?? null },
    tenant: { findFirst: async () => opts.tenantByName ?? null },
  } as any;
}

test("THE BUG: a super-admin's query-string tenant wins over their own tenant", async () => {
  const got = await resolveGeneratedPromptTenantId(fakeDb(), {
    isSuperAdmin: true,
    bodyTenantId: undefined, // the Studio has never sent this
    queryTenantId: "cust_abc",
    userTenantId: "admin_home_tenant",
  });
  assert.equal(got, "cust_abc", "recording must belong to the customer on screen, not the admin");
});

test("body still works, and wins when both are sent", async () => {
  assert.equal(
    await resolveGeneratedPromptTenantId(fakeDb(), {
      isSuperAdmin: true, bodyTenantId: "from_body", queryTenantId: "from_query", userTenantId: "admin",
    }),
    "from_body",
  );
});

test("a super-admin with neither falls back to their own tenant", async () => {
  assert.equal(
    await resolveGeneratedPromptTenantId(fakeDb(), {
      isSuperAdmin: true, bodyTenantId: null, queryTenantId: null, userTenantId: "admin",
    }),
    "admin",
  );
});

test("a tenant admin is pinned to their own tenant however hard they try", async () => {
  assert.equal(
    await resolveGeneratedPromptTenantId(fakeDb(), {
      isSuperAdmin: false, bodyTenantId: "someone_else", queryTenantId: "also_someone_else", userTenantId: "mine",
    }),
    "mine",
    "a customer must never be able to write a recording into another company",
  );
});

test("the switcher's vpbx:<slug> form resolves through the PBX link", async () => {
  const db = fakeDb({
    directory: { tenantSlug: "acme_co", vitalTenantId: "42", tenantCode: "T42" },
    link: { tenantId: "connect_acme" },
  });
  assert.equal(
    await resolveGeneratedPromptTenantId(db, { isSuperAdmin: true, queryTenantId: "vpbx:acme_co", userTenantId: "admin" }),
    "connect_acme",
  );
});

test("vpbx: falls back to matching the tenant by name when there's no PBX link", async () => {
  const db = fakeDb({ directory: null, tenantByName: { id: "connect_acme" } });
  assert.equal(
    await resolveGeneratedPromptTenantId(db, { isSuperAdmin: true, queryTenantId: "vpbx:acme_co", userTenantId: "admin" }),
    "connect_acme",
  );
});

test("an unresolvable vpbx: slug returns null rather than the admin's own tenant", async () => {
  // Filing it under the admin is precisely the failure this suite exists for.
  // Null makes the route answer "choose a customer", which is recoverable.
  const db = fakeDb({ directory: null, tenantByName: null });
  assert.equal(
    await resolveGeneratedPromptTenantId(db, { isSuperAdmin: true, queryTenantId: "vpbx:nobody", userTenantId: "admin" }),
    null,
  );
});

test("whitespace is not a tenant", async () => {
  assert.equal(
    await resolveGeneratedPromptTenantId(fakeDb(), {
      isSuperAdmin: true, bodyTenantId: "  ", queryTenantId: "  ", userTenantId: "admin",
    }),
    "admin",
  );
});
