// Regression coverage for the Sync SIP admin-panel bug: the "no WebRTC
// device" message hardcoded the literal example prefix "T7_" for every
// tenant, and derived the extension number shown in the message/response via
// an ownerUserId-scoped `findFirst` that was decoupled from the specific
// PbxExtensionLink actually being synced (`ctx.link`) — confirmed to have
// printed extension 112 for a user whose real, currently-synced extension
// was 107 (tenant T8 / "Gesheft").

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

const state = {
  users: new Map<string, { id: string; tenantId: string; email: string; displayName: string | null }>(),
  // Simulates a user who owns TWO Extension rows (a stale/duplicate 112 plus
  // the real, currently-linked 107) — the exact shape that lets an
  // ownerUserId-scoped findFirst diverge from ctx.link.
  extensionsByOwnerIncludePbxLink: new Map<string, any>(),
  extensionsById: new Map<string, any>(),
  pbxExtensionLinks: new Map<string, any>(),
  tenantPbxLinks: new Map<string, any>(),
  pbxTenantDirectories: new Map<string, any>(),
  auditEntries: [] as any[],
  staleLabelOnlyLookupResult: null as { extNumber: string } | null,
};

function reset() {
  state.users.clear();
  state.extensionsByOwnerIncludePbxLink.clear();
  state.extensionsById.clear();
  state.pbxExtensionLinks.clear();
  state.tenantPbxLinks.clear();
  state.pbxTenantDirectories.clear();
  state.auditEntries = [];
  state.staleLabelOnlyLookupResult = null;
}

mock.module("@connect/db", {
  namedExports: {
    db: {
      user: {
        findUnique: async ({ where }: any) => state.users.get(where.id) || null,
      },
      extension: {
        // Two structurally different call shapes hit this same mock method,
        // exactly like production:
        //  - `loadLinkForAdminAction`'s lookup (`include: { pbxLink: true }`)
        //    intentionally still resolves by ownerUserId and always finds the
        //    CORRECT, currently-linked extension (107) here — this is what
        //    establishes ctx.link for the whole route.
        //  - The OLD, buggy label-only lookup (`select: { extNumber: true }`,
        //    no include) was a completely separate, decoupled query. This
        //    fixture simulates it resolving to a DIFFERENT, stale extension
        //    row (112) for the same owner — proving the two calls are not
        //    guaranteed to agree. The fix (below) stops calling this shape
        //    entirely in favor of `findUnique(ctx.link.extensionId)`.
        findFirst: async ({ where, include }: any) => {
          const key = `${where.ownerUserId}:${where.tenantId}`;
          if (include?.pbxLink) return state.extensionsByOwnerIncludePbxLink.get(key) || null;
          return state.staleLabelOnlyLookupResult ?? null;
        },
        // The FIXED lookup path — always keyed by the exact extensionId on
        // ctx.link, immune to duplicate/owner-scoped ambiguity.
        findUnique: async ({ where }: any) => state.extensionsById.get(where.id) || null,
      },
      pbxExtensionLink: {
        findUnique: async ({ where }: any) => state.pbxExtensionLinks.get(where.id) || null,
        update: async ({ where, data }: any) => {
          const row = state.pbxExtensionLinks.get(where.id);
          Object.assign(row, data);
          return row;
        },
      },
      pbxEndpointRegistration: {
        findUnique: async () => null,
      },
      tenantPbxLink: {
        findUnique: async ({ where }: any) => state.tenantPbxLinks.get(where.tenantId) || null,
      },
      pbxTenantDirectory: {
        findUnique: async ({ where }: any) => {
          const key = `${where.pbxInstanceId_vitalTenantId.pbxInstanceId}:${where.pbxInstanceId_vitalTenantId.vitalTenantId}`;
          return state.pbxTenantDirectories.get(key) || null;
        },
      },
    },
  },
});

let registerUserExtensionProvisioningRoutes: any;
async function loadRoutes() {
  ({ registerUserExtensionProvisioningRoutes } = await import("./userExtensionProvisioning"));
}

function buildApp(admin: { sub: string; tenantId: string; role: string }) {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as any).user = admin;
  });
  registerUserExtensionProvisioningRoutes(app, {
    getUser: (req: any) => req.user,
    requirePermission: async (req: any) => req.user,
    canManageUsers: () => true,
    resolveManagedTenant: async (_admin: any, requestedTenantId: string | null) => requestedTenantId || "t8",
    syncExtensionsFromPbx: async () => ({ tenantResults: [] }),
    audit: async (entry: any) => {
      state.auditEntries.push(entry);
    },
    resetSipPasswordOnPbx: async () => null,
    createWebrtcDeviceOnPbx: async () => null,
    encryptJson: (x: unknown) => JSON.stringify(x),
  });
  return app;
}

function seedGesheftFixture() {
  seedTenantT8();
  state.users.set("u_target", { id: "u_target", tenantId: "t8", email: "user@gesheft.test", displayName: "Gesheft User" });

  // Stale duplicate row from an old import — extension 112, same owner.
  state.extensionsById.set("ext112", { id: "ext112", tenantId: "t8", extNumber: "112", ownerUserId: "u_target" });
  // The real, currently-linked extension — 107.
  const link107 = {
    id: "link107",
    tenantId: "t8",
    extensionId: "ext107",
    pbxExtensionId: "pbx-107",
    pbxSipUsername: "107_1",
    pbxDeviceName: "T8_107_1",
    webrtcEnabled: false,
    sipPasswordEncrypted: null,
    provisionStatus: "PENDING",
    provisionSource: null,
    lastProvisionedAt: null,
    isSuspended: false,
  };
  state.pbxExtensionLinks.set("link107", link107);
  state.extensionsById.set("ext107", { id: "ext107", tenantId: "t8", extNumber: "107", ownerUserId: "u_target" });

  // loadLinkForAdminAction's ownerUserId-scoped lookup resolves (as it does
  // in production for the actual sync target) to the real extension + its
  // pbxLink — this is the ctx.link the whole route operates on.
  state.extensionsByOwnerIncludePbxLink.set("u_target:t8", {
    id: "ext107",
    tenantId: "t8",
    ownerUserId: "u_target",
    pbxLink: link107,
  });
  // The stale, decoupled label-only lookup the OLD code used — resolves to
  // extension 112, a different row than ctx.link's own extension (107).
  state.staleLabelOnlyLookupResult = { extNumber: "112" };
}

function seedTenantT8() {
  state.tenantPbxLinks.set("t8", { tenantId: "t8", pbxInstanceId: "inst1", pbxTenantId: "8", pbxTenantCode: "T8" });
  state.pbxTenantDirectories.set("inst1:8", { tenantCode: "T8", tenantSlug: "gesheft" });
}

test("PHASE 1 (regression) + PHASE 4 (fix): /phone/status reports extension 107, not the stale 112", async () => {
  await loadRoutes();
  reset();
  seedGesheftFixture();

  const app = buildApp({ sub: "admin1", tenantId: "t8", role: "SUPER_ADMIN" });
  const res = await app.inject({ method: "GET", url: "/admin/users/u_target/phone/status" });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.extensionNumber, "107", "must report the extension actually tied to ctx.link, not a decoupled lookup");
  await app.close();
});

test("PHASE 1 (regression) + PHASE 4 (fix): /phone/sync error message uses extension 107 and the real T8_ prefix, not 112 / hardcoded T7_", async () => {
  await loadRoutes();
  reset();
  seedGesheftFixture();
  // Sync leaves the link exactly as-is (no WebRTC device found this pass —
  // simulates the sync outcome before the pbxExtensionSync.ts live-check fix
  // has resolved T8_107_1, or a genuinely different extension with no device).

  const app = buildApp({ sub: "admin1", tenantId: "t8", role: "SUPER_ADMIN" });
  const res = await app.inject({ method: "POST", url: "/admin/users/u_target/phone/sync" });
  assert.equal(res.statusCode, 409);
  const body = JSON.parse(res.body);
  assert.equal(body.error, "NO_WEBRTC_DEVICE_ON_PBX");
  assert.match(body.message, /extension 107/, "must reference the real extension (107), not the stale 112");
  assert.doesNotMatch(body.message, /extension 112/);
  assert.match(body.message, /T8_107_1/, "example device name must use the tenant's real T8_ prefix");
  assert.doesNotMatch(body.message, /T7_107_1/, "must not use the hardcoded example tenant 7 prefix");
  await app.close();
});

test("tenant with no directory tenantCode still derives T<n> from pbxTenantId rather than hardcoding T7", async () => {
  await loadRoutes();
  reset();
  state.users.set("u2", { id: "u2", tenantId: "t30", email: "user@other.test", displayName: null });
  state.tenantPbxLinks.set("t30", { tenantId: "t30", pbxInstanceId: "inst1", pbxTenantId: "30", pbxTenantCode: null });
  const link = {
    id: "link_e2",
    tenantId: "t30",
    extensionId: "ext_e2",
    pbxExtensionId: "pbx-201",
    pbxSipUsername: "201",
    pbxDeviceName: null,
    webrtcEnabled: false,
    sipPasswordEncrypted: null,
    provisionStatus: "PENDING",
    provisionSource: null,
    lastProvisionedAt: null,
    isSuspended: false,
  };
  state.pbxExtensionLinks.set("link_e2", link);
  state.extensionsById.set("ext_e2", { id: "ext_e2", tenantId: "t30", extNumber: "201", ownerUserId: "u2" });
  state.extensionsByOwnerIncludePbxLink.set("u2:t30", { id: "ext_e2", tenantId: "t30", ownerUserId: "u2", pbxLink: link });

  const app = buildApp({ sub: "admin1", tenantId: "t30", role: "SUPER_ADMIN" });
  const res = await app.inject({ method: "POST", url: "/admin/users/u2/phone/sync" });
  assert.equal(res.statusCode, 409);
  const body = JSON.parse(res.body);
  assert.match(body.message, /T30_201_1/);
  assert.doesNotMatch(body.message, /T7_201_1/);
  await app.close();
});
