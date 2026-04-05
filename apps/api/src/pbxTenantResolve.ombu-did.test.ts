/**
 * Ombutel-synced PbxTenantInboundDid is consulted before dialplan/channel/trunk hints.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveCdrTenant } from "./pbxTenantResolve";
import type { PrismaClient } from "@connect/db";

function mockDb(): PrismaClient {
  const directory = [
    {
      vitalTenantId: "2",
      tenantSlug: "a_plus_center",
      tenantCode: "T2",
    },
    {
      vitalTenantId: "8",
      tenantSlug: "gesheft",
      tenantCode: "T8",
    },
  ];
  const inboundByE164 = new Map<string, { vitalTenantId: string; pbxTenantCode: string | null; connectTenantId: string | null }>([
    ["8457823064", { vitalTenantId: "2", pbxTenantCode: "T2", connectTenantId: "conn-t2" }],
    ["8452449666", { vitalTenantId: "8", pbxTenantCode: "T8", connectTenantId: "conn-t8" }],
  ]);
  return {
    pbxTenantDirectory: {
      findMany: async () => directory,
    },
    tenantPbxLink: {
      findMany: async () => [
        { pbxTenantId: "2", pbxTenantCode: null, status: "LINKED", tenantId: "conn-t2" },
        { pbxTenantId: "8", pbxTenantCode: null, status: "LINKED", tenantId: "conn-t8" },
      ],
      findUnique: async () => null,
    },
    pbxTenantInboundDid: {
      findFirst: async ({ where }: { where: { e164?: string } }) => {
        const k = where?.e164;
        return k ? inboundByE164.get(k) ?? null : null;
      },
    },
  } as unknown as PrismaClient;
}

test("resolveCdrTenant: inbound to 8457823064 → vital tenant 2 / T2 (ombu_inbound_did_to)", async () => {
  const db = mockDb();
  const r = await resolveCdrTenant(db, "inst1", {
    telephonyTenantId: null,
    pbxVitalTenantIdHint: null,
    pbxTenantCodeHint: null,
    dcontexts: ["from-trunk-maintrunk"],
    channels: ["SIP/foo-bar"],
    fromNumber: "2015550100",
    toNumber: "+1 (845) 782-3064",
    ruleResolver: async () => null,
  });
  assert.equal(r.pbxVitalTenantId, "2");
  assert.equal(r.pbxTenantCode, "T2");
  assert.equal(r.tenantId, "conn-t2");
  assert.equal(r.tenantResolutionSource, "ombu_inbound_did_to");
});

test("resolveCdrTenant: inbound to 8452449666 → vital tenant 8 / T8 (ombu_inbound_did_to)", async () => {
  const db = mockDb();
  const r = await resolveCdrTenant(db, "inst1", {
    telephonyTenantId: null,
    pbxVitalTenantIdHint: null,
    pbxTenantCodeHint: null,
    dcontexts: ["from-trunk-carrier"],
    channels: ["PJSIP/trunk-abc"],
    fromNumber: "7185550000",
    toNumber: "8452449666",
    ruleResolver: async () => null,
  });
  assert.equal(r.pbxVitalTenantId, "8");
  assert.equal(r.pbxTenantCode, "T8");
  assert.equal(r.tenantId, "conn-t8");
  assert.equal(r.tenantResolutionSource, "ombu_inbound_did_to");
});
