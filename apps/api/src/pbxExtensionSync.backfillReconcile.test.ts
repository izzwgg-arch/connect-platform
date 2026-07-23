// Phase 5 — idempotent backfill/reconcile: running the (now live-check-aware)
// full-instance sync must converge every drifted extension across ALL
// tenants in one pass, and stay converged (idempotent) on repeat runs — no
// duplicate rows, no flapping between PROVISIONED-eligible and PENDING.

import test from "node:test";
import assert from "node:assert/strict";
import { syncExtensionsFromPbx } from "./pbxExtensionSync";

function makeStatefulMockDb() {
  const extensions = new Map<string, any>(); // key: `${tenantId}:${extNumber}`
  const pbxExtensionLinks = new Map<string, any>(); // key: extensionId
  let upsertCount = 0;

  const db = {
    pbxTenantDirectory: {
      findMany: async () => [
        { vitalTenantId: "2", tenantSlug: "acme", tenantCode: "T2", displayName: "Acme" },
        { vitalTenantId: "8", tenantSlug: "gesheft", tenantCode: "T8", displayName: "Gesheft" },
      ],
    },
    tenantPbxLink: {
      findMany: async () => [
        { tenantId: "connect-t2", pbxTenantId: "2" },
        { tenantId: "connect-t8", pbxTenantId: "8" },
      ],
    },
    extension: {
      upsert: async ({ where, create, update }: any) => {
        const key = `${where.tenantId_extNumber.tenantId}:${where.tenantId_extNumber.extNumber}`;
        const existing = extensions.get(key);
        const row = existing ? { ...existing, ...update } : { id: `ext_${key}`, ownerUserId: null, ...create };
        extensions.set(key, row);
        return row;
      },
      updateMany: async () => ({ count: 0 }),
      update: async () => ({}),
    },
    pbxExtensionLink: {
      upsert: async ({ where, create, update }: any) => {
        upsertCount++;
        const existing = pbxExtensionLinks.get(where.extensionId);
        const row = existing ? { ...existing, ...update } : { id: `link_${where.extensionId}`, ...create };
        pbxExtensionLinks.set(where.extensionId, row);
        return row;
      },
    },
    user: { findUnique: async () => null, create: async () => ({ id: "u_new" }) },
    tenant: { findUnique: async () => ({ webrtcEnabled: true }), update: async () => ({}) },
  };

  return { db: db as any, extensions, pbxExtensionLinks, upsertCountRef: () => upsertCount };
}

function makeStubClient(): any {
  return {
    async listExtensions(vitalTenantId: string) {
      if (vitalTenantId === "2") {
        // Healthy tenant: T2_101_1 is correctly visible in the bulk list.
        return [
          {
            extension_id: "e101",
            extension: "101",
            name: "Acme User",
            devices: [{ user: "101_1", device_name: "T2_101_1", secret: "acme-secret" }],
          },
        ];
      }
      // Drifted tenant (T8 / Gesheft): bulk list omits the live T8_107_1 device.
      return [{ extension_id: "e107", extension: "107", name: "Gesheft User", devices: [] }];
    },
    async getExtensionDevices() {
      return [];
    },
    async callEndpoint() {
      return { data: [] };
    },
  };
}

test("PHASE 5: one full-instance sync pass reconciles both a healthy tenant and a drifted tenant together", async () => {
  const { db, pbxExtensionLinks } = makeStatefulMockDb();
  const client = makeStubClient();

  const result = await syncExtensionsFromPbx(db, "inst1", client, {
    liveEndpointReader: async (endpoint) =>
      endpoint === "T8_107_1"
        ? {
            endpoint,
            exists: true,
            fields: {},
            transport: "transport-wss",
            aor: endpoint,
            auth: endpoint,
            mediaEncryption: "dtls",
            webrtcFlag: true,
            isWebrtcCapable: true,
          }
        : null,
  });

  assert.equal(result.tenantResults.length, 2);
  assert.equal(result.totalLiveConfirmedWebrtc, 1, "only the drifted T8 extension needed the live cross-check");

  const acmeLink = pbxExtensionLinks.get("ext_connect-t2:101");
  const gesheftLink = pbxExtensionLinks.get("ext_connect-t8:107");
  assert.equal(acmeLink.webrtcEnabled, true);
  assert.equal(gesheftLink.webrtcEnabled, true, "T8_107_1 must be reconciled to webrtcEnabled=true in the same pass");
});

test("PHASE 5: re-running the full sync is idempotent — same converged state, no duplicate link rows", async () => {
  const { db, pbxExtensionLinks, extensions } = makeStatefulMockDb();
  const client = makeStubClient();
  const liveReader = async (endpoint: string) =>
    endpoint === "T8_107_1"
      ? {
          endpoint,
          exists: true,
          fields: {},
          transport: "transport-wss",
          aor: endpoint,
          auth: endpoint,
          mediaEncryption: "dtls",
          webrtcFlag: true,
          isWebrtcCapable: true,
        }
      : null;

  const first = await syncExtensionsFromPbx(db, "inst1", client, { liveEndpointReader: liveReader });
  const linkCountAfterFirst = pbxExtensionLinks.size;
  const extCountAfterFirst = extensions.size;

  const second = await syncExtensionsFromPbx(db, "inst1", client, { liveEndpointReader: liveReader });

  assert.equal(pbxExtensionLinks.size, linkCountAfterFirst, "no duplicate PbxExtensionLink rows on re-sync");
  assert.equal(extensions.size, extCountAfterFirst, "no duplicate Extension rows on re-sync");
  assert.equal(first.totalLiveConfirmedWebrtc, second.totalLiveConfirmedWebrtc);
  assert.equal(pbxExtensionLinks.get("ext_connect-t8:107").webrtcEnabled, true);
});
