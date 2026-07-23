import test from "node:test";
import assert from "node:assert/strict";
import { resolveTenantPbxPrefix } from "./pbxTenantPrefix";

function makeDb(opts: {
  link?: { tenantId: string; pbxInstanceId: string; pbxTenantId: string | null; pbxTenantCode: string | null } | null;
  directory?: { tenantCode: string; tenantSlug: string } | null;
}) {
  return {
    tenantPbxLink: {
      findUnique: async () => opts.link ?? null,
    },
    pbxTenantDirectory: {
      findUnique: async () => opts.directory ?? null,
    },
  } as any;
}

test("uses TenantPbxLink.pbxTenantCode directly when already populated", async () => {
  const db = makeDb({ link: { tenantId: "t8", pbxInstanceId: "inst1", pbxTenantId: "8", pbxTenantCode: "t8" } });
  const prefix = await resolveTenantPbxPrefix(db, "t8");
  assert.equal(prefix, "T8");
});

test("falls back to PbxTenantDirectory.tenantCode when the link has no pbxTenantCode", async () => {
  const db = makeDb({
    link: { tenantId: "t8", pbxInstanceId: "inst1", pbxTenantId: "8", pbxTenantCode: null },
    directory: { tenantCode: "T8", tenantSlug: "gesheft" },
  });
  const prefix = await resolveTenantPbxPrefix(db, "t8");
  assert.equal(prefix, "T8");
});

test("derives T<n> when neither the link nor the directory has a tenant code", async () => {
  const db = makeDb({
    link: { tenantId: "t8", pbxInstanceId: "inst1", pbxTenantId: "8", pbxTenantCode: null },
    directory: null,
  });
  const prefix = await resolveTenantPbxPrefix(db, "t8");
  assert.equal(prefix, "T8");
});

test("returns null when the tenant has no PBX link at all", async () => {
  const db = makeDb({ link: null });
  const prefix = await resolveTenantPbxPrefix(db, "unlinked-tenant");
  assert.equal(prefix, null);
});
