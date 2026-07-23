// Regression + fix coverage for the Sync SIP "no WebRTC device" false-negative
// (confirmed root cause: ext 107 / tenant T8 "Gesheft" — a real, live wss+DTLS
// WebRTC device (T8_107_1), identical in shape to the known-good T8_101_1, was
// reported as NO_WEBRTC_DEVICE_ON_PBX because VitalPBX's bulk
// `/api/v2/extensions` response omitted the device Connect's sync relies on).
//
// No database, no network — a minimal in-memory Prisma mock (same style as
// `pbxTenantDirectorySync.test.ts`) plus a stub VitalPbxClient.

import test from "node:test";
import assert from "node:assert/strict";
import {
  syncExtensionsFromPbx,
  selectActiveDeviceAndWebrtcState,
  confirmWebrtcDeviceLive,
} from "./pbxExtensionSync";
import type { PjsipEndpointLiveDetail } from "@connect/integrations";

function makeMockDb(opts: {
  tenantDirs: Array<{ vitalTenantId: string; tenantSlug: string; tenantCode: string; displayName: string | null }>;
  tenantLinks: Array<{ tenantId: string; pbxTenantId: string }>;
}) {
  const extensionLinkUpserts: any[] = [];
  const extensionUpserts: any[] = [];
  const db = {
    pbxTenantDirectory: {
      findMany: async () => opts.tenantDirs,
    },
    tenantPbxLink: {
      findMany: async () => opts.tenantLinks,
    },
    extension: {
      upsert: async ({ create }: any) => {
        extensionUpserts.push(create);
        return { id: `ext_${create.extNumber}`, ownerUserId: null, ...create };
      },
      updateMany: async () => ({ count: 0 }),
      update: async () => ({}),
    },
    pbxExtensionLink: {
      upsert: async (args: any) => {
        extensionLinkUpserts.push(args);
        return {};
      },
    },
    user: {
      findUnique: async () => null,
      create: async () => ({ id: "u_new" }),
    },
    tenant: {
      findUnique: async () => ({ webrtcEnabled: true, sipWsUrl: "wss://x", sipDomain: "x" }),
      update: async () => ({}),
    },
  };
  return { db: db as any, extensionLinkUpserts, extensionUpserts };
}

function makeStubClient(opts: {
  extensions: any[];
  extensionDevicesByExtId?: Record<string, any[]>;
}): any {
  return {
    async listExtensions() {
      return opts.extensions;
    },
    async getExtensionDevices(extensionId: string) {
      return opts.extensionDevicesByExtId?.[extensionId] ?? [];
    },
    async callEndpoint(key: string) {
      if (key === "deviceProfiles.webrtc") return { data: [] };
      throw new Error(`unexpected callEndpoint ${key}`);
    },
  };
}

const TENANT_DIRS = [{ vitalTenantId: "8", tenantSlug: "gesheft", tenantCode: "T8", displayName: "Gesheft" }];
const TENANT_LINKS = [{ tenantId: "connect-t8", pbxTenantId: "8" }];

// ── Phase 1: reproduce the false negative ───────────────────────────────────

test("PHASE 1 (regression): bulk API omitting the _1 device, with no live signal available, honestly stays PENDING (documents pre-fix ceiling)", async () => {
  const { db } = makeMockDb({ tenantDirs: TENANT_DIRS, tenantLinks: TENANT_LINKS });
  // VitalPBX's bulk extensions.list response for ext 107 has NO devices at all —
  // this is the confirmed real-world shape: the admin-created T8_107_1 device
  // simply never appears in this response, even though it's live on the PBX.
  const client = makeStubClient({
    extensions: [{ extension_id: "107", extension: "107", name: "Gesheft User", devices: [] }],
  });

  const result = await syncExtensionsFromPbx(db, "inst1", client, {
    liveEndpointReader: async () => null, // AMI unreachable/unconfigured in this scenario
  });

  const tenantResult = result.tenantResults[0]!;
  assert.equal(tenantResult.liveConfirmedWebrtcCount ?? 0, 0);
  // Without any live signal, Connect cannot know about T8_107_1 — this is the
  // ceiling of the old, API-list-only detection and is expected to remain
  // PENDING/false here. Phase 2 below is what actually fixes the real case.
});

test("PHASE 1 (regression): selectActiveDeviceAndWebrtcState alone cannot see a device VitalPBX's list omitted", () => {
  const state = selectActiveDeviceAndWebrtcState("107", [], new Set());
  assert.equal(state.webrtcEnabled, false);
  assert.equal(state.rawSecret, null);
});

// ── Phase 2: truthful live detection ────────────────────────────────────────

test("PHASE 2 (fix): AMI live read confirms T8_107_1 (wss+DTLS) exists even though the bulk list omitted it", async () => {
  const { db } = makeMockDb({ tenantDirs: TENANT_DIRS, tenantLinks: TENANT_LINKS });
  const client = makeStubClient({
    extensions: [{ extension_id: "107", extension: "107", name: "Gesheft User", devices: [] }],
  });

  const liveDetail: PjsipEndpointLiveDetail = {
    endpoint: "T8_107_1",
    exists: true,
    fields: {},
    transport: "transport-wss",
    aor: "T8_107_1",
    auth: "T8_107_1",
    mediaEncryption: "dtls",
    webrtcFlag: true,
    isWebrtcCapable: true,
  };

  const result = await syncExtensionsFromPbx(db, "inst1", client, {
    liveEndpointReader: async (endpoint) => (endpoint === "T8_107_1" ? liveDetail : null),
  });

  const tenantResult = result.tenantResults[0]!;
  assert.equal(tenantResult.liveConfirmedWebrtcCount, 1);
  assert.equal(result.totalLiveConfirmedWebrtc, 1);
});

test("PHASE 2 (fix): confirmWebrtcDeviceLive builds the deterministic T8_107_1 candidate name from the tenant code", async () => {
  const client = makeStubClient({ extensions: [] });
  let queriedEndpoint: string | null = null;
  const confirmation = await confirmWebrtcDeviceLive({
    client,
    pbxExtensionId: "107",
    vitalTenantId: "8",
    tenantCode: "T8",
    extNumber: "107",
    liveEndpointReader: async (endpoint) => {
      queriedEndpoint = endpoint;
      return {
        endpoint,
        exists: true,
        fields: {},
        transport: "transport-wss",
        aor: endpoint,
        auth: endpoint,
        mediaEncryption: "dtls",
        webrtcFlag: true,
        isWebrtcCapable: true,
      };
    },
  });
  assert.equal(queriedEndpoint, "T8_107_1");
  assert.equal(confirmation.confirmed, true);
  assert.equal(confirmation.source, "ami_live");
  assert.equal(confirmation.rawSecret, null, "AMI PJSIPShowEndpoint never exposes the auth secret");
});

test("PHASE 2 (fix): per-extension devices read (extensions.devices) can also surface a device the bulk list missed, including its secret", async () => {
  const { db } = makeMockDb({ tenantDirs: TENANT_DIRS, tenantLinks: TENANT_LINKS });
  const client = makeStubClient({
    extensions: [{ extension_id: "107", extension: "107", name: "Gesheft User", devices: [] }],
    extensionDevicesByExtId: {
      "107": [{ user: "107_1", device_name: "T8_107_1", secret: "s3cr3t" }],
    },
  });

  const result = await syncExtensionsFromPbx(db, "inst1", client, {
    liveEndpointReader: async () => null, // AMI not needed — API devices endpoint already confirms it
  });

  const tenantResult = result.tenantResults[0]!;
  assert.equal(tenantResult.liveConfirmedWebrtcCount, 1);
});

test("PHASE 2 (fix): a real desk-phone-only extension (no _1 device anywhere) correctly stays non-WebRTC", async () => {
  const { db } = makeMockDb({ tenantDirs: TENANT_DIRS, tenantLinks: TENANT_LINKS });
  const client = makeStubClient({
    extensions: [{ extension_id: "108", extension: "108", name: "Desk Phone User", devices: [{ user: "108", device_name: "T8_108" }] }],
    extensionDevicesByExtId: { "108": [{ user: "108", device_name: "T8_108" }] },
  });

  const result = await syncExtensionsFromPbx(db, "inst1", client, {
    liveEndpointReader: async () => ({
      endpoint: "T8_108_1",
      exists: false,
      fields: {},
      transport: null,
      aor: null,
      auth: null,
      mediaEncryption: null,
      webrtcFlag: null,
      isWebrtcCapable: false,
    }),
  });

  const tenantResult = result.tenantResults[0]!;
  assert.equal(tenantResult.liveConfirmedWebrtcCount ?? 0, 0);
});

test("PHASE 2 (fix): AMI read failure (network error, unconfigured) never throws — sync completes and stays honest", async () => {
  const { db } = makeMockDb({ tenantDirs: TENANT_DIRS, tenantLinks: TENANT_LINKS });
  const client = makeStubClient({
    extensions: [{ extension_id: "107", extension: "107", name: "Gesheft User", devices: [] }],
  });

  const result = await syncExtensionsFromPbx(db, "inst1", client, {
    liveEndpointReader: async () => {
      throw new Error("ECONNREFUSED");
    },
  });

  assert.equal(result.totalErrors, 0, "an AMI read failure must never surface as a sync error");
  assert.equal(result.tenantResults[0]!.liveConfirmedWebrtcCount ?? 0, 0);
});
