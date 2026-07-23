/**
 * M2 — per-extension MOH: op unit + executor-chain (sim + live), red-team, stress.
 * NO network, NO real DB.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeM2Op, M2_SCHEMA } from "./m2MohExtension";
import { buildModifyCatalog, catalogOpsHonorModifyContract } from "../modifyCatalog";
import { ModifyPbxExecutor } from "../modifyExecutor";
import { makeScopeCheck } from "../scopeCheck";
import { SnapshotStore } from "../snapshotStore";
import { computeParamsHash } from "../../actions/bindings";
import { AuditLog, FileAuditSink } from "../../audit/audit";

/** Connect-mirror fixture: vital 21 ↔ ct1 (user u1), exts 103 & 101(protected); profiles p8/p3; foreign vital 8 ↔ ct9. */
class FakePrisma {
  extOverrides = new Map<string, any>(); // key `${tenant}:${ext}`
  publishes: any[] = [];
  actions: any[] = [];
  snaps: any[] = [];
  private seq = 0;

  tenantPbxLink = {
    findFirst: async ({ where }: any) => ({ "21": { tenantId: "ct1" }, "8": { tenantId: "ct9" } })[String(where.pbxTenantId)] ?? null,
    findUnique: async ({ where }: any) => ({ ct1: { pbxTenantId: "21" }, ct9: { pbxTenantId: "8" } })[where.tenantId as string] ?? null,
  };
  user = { findUnique: async ({ where }: any) => ({ u1: { tenantId: "ct1", status: "ACTIVE" } })[where.id as string] ?? null };
  extension = {
    findFirst: async ({ where }: any) => (where.tenantId === "ct1" && ["103", "101"].includes(String(where.extNumber)) ? { id: `e${where.extNumber}` } : null),
  };
  mohProfile = {
    findFirst: async ({ where }: any) => {
      const all = [
        { id: "p8", tenantId: "ct1", isActive: true, vitalPbxMohClassName: "moh8" },
        { id: "p3", tenantId: "ct1", isActive: true, vitalPbxMohClassName: "moh3" },
        { id: "px", tenantId: "ct9", isActive: true, vitalPbxMohClassName: "moh5" },
      ];
      return all.find((p) => (where.id === undefined || p.id === where.id) && (where.tenantId === undefined || p.tenantId === where.tenantId) && (where.isActive === undefined || p.isActive === where.isActive)) ?? null;
    },
  };
  mohExtensionOverride = {
    findUnique: async ({ where }: any) => {
      const k = where.tenantId_extension;
      return this.extOverrides.get(`${k.tenantId}:${k.extension}`) ?? null;
    },
  };
  mohPublishRecord = { findFirst: async ({ where }: any) => this.publishes.filter((p) => p.tenantId === where.tenantId).sort((a, b) => b.publishedAt - a.publishedAt)[0] ?? null };
  agentAction = { findUnique: async ({ where }: any) => this.actions.find((r) => r.id === where.id) ?? null };
  agentPbxSnapshot = {
    create: async ({ data }: any) => { const row = { id: `snap${++this.seq}`, restoredAt: null, ...data }; this.snaps.push(row); return row; },
    findUnique: async ({ where }: any) => this.snaps.find((r) => r.actionId === where.actionId) ?? null,
    update: async ({ where, data }: any) => Object.assign(this.snaps.find((r) => r.id === where.id), data),
  };
}

class SpyMohApi {
  calls: any[] = [];
  failWith: string | null = null;
  constructor(private prisma: FakePrisma, private world: { publishSucceeds: boolean }) {}
  async call(body: Record<string, unknown>): Promise<any> {
    this.calls.push(body);
    if (this.failWith) throw new Error(this.failWith);
    const ct = String(body.tenantId) === "21" ? "ct1" : "ct9";
    const ext = String(body.extension);
    if (body.action === "ext_set") this.prisma.extOverrides.set(`${ct}:${ext}`, { extension: ext, enabled: true, mohProfileId: body.profileId, vitalPbxMohClassName: body.profileId === "p3" ? "moh3" : "moh8" });
    else if (body.action === "ext_clear") this.prisma.extOverrides.delete(`${ct}:${ext}`);
    this.prisma.publishes.push({ id: `pub${this.prisma.publishes.length + 1}`, tenantId: ct, publishedAt: Date.now() + this.prisma.publishes.length, status: this.world.publishSucceeds ? "success" : "failed", newMohClass: "moh8" });
    return { ok: true, extensionOverride: this.prisma.extOverrides.get(`${ct}:${ext}`) ?? null, publishResult: this.world.publishSucceeds ? { recordId: "pub", mohClass: "moh8", mode: "override" } : null, publishError: this.world.publishSucceeds ? null : "publish blew up" };
  }
}

let prisma: FakePrisma;
let mohApi: SpyMohApi;
let audit: AuditLog;
const ENV = { AGENT_MODIFY_ENABLED: "1", AGENT_PBX_LIVE_TENANTS: "21", AGENT_PBX_PROTECTED_EXTS: "101", AGENT_PBX_LIVE_WRITES_PER_HOUR: "10", AGENT_MODIFY_REVERT_DAYS: "7" };

beforeEach(async () => {
  prisma = new FakePrisma();
  mohApi = new SpyMohApi(prisma, { publishSucceeds: true });
  const dir = await mkdtemp(path.join(tmpdir(), "m2-"));
  audit = new AuditLog([new FileAuditSink(dir)]);
});

function makeExec() {
  return new ModifyPbxExecutor(
    prisma as any, audit, new SnapshotStore(prisma),
    () => ({ callEndpointRaw: async () => { throw new Error("PBX client must never be used by M2"); } }),
    { catalog: buildModifyCatalog({ prisma, mohApi }), scopeCheck: makeScopeCheck(prisma), killSwitch: () => false, env: ENV },
  );
}

const SET = { tenantId: "21", objectId: "103", action: "set", profileId: "p8" };
function approvedRow(params: any, id = "act1") {
  return { id, capabilityId: "pbx.M2", tenantId: "21", params, status: "EXECUTING", approvalConsumedAt: new Date(), paramsHash: computeParamsHash("pbx.M2", "21", params), resultSnapshot: null };
}

test("schema: set requires profileId; clear does not; objectId is the extension", () => {
  assert.equal(M2_SCHEMA.safeParse(SET).success, true);
  assert.equal(M2_SCHEMA.safeParse({ tenantId: "21", objectId: "103", action: "set" }).success, false);
  assert.equal(M2_SCHEMA.safeParse({ tenantId: "21", objectId: "103", action: "clear" }).success, true);
});

test("catalog: M1 + M2 present, contract holds", () => {
  const cat = buildModifyCatalog({ prisma, mohApi });
  assert.ok(cat["pbx.M1"] && cat["pbx.M2"], "M1 and M2 present");
  assert.equal(catalogOpsHonorModifyContract(cat), true);
});

test("SIM full chain: passes, snapshot stored, mohApi never called", async () => {
  const res = await makeExec().execute({ capabilityId: "pbx.M2", params: SET, requestedBy: "customer:u1", requestedRole: "customer" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(res.verified, true);
  assert.equal(mohApi.calls.length, 0);
  assert.equal((prisma.snaps[0].stateJson as any).extension, "103");
});

test("G5: PROTECTED extension 101 refused", async () => {
  const res = await makeExec().execute({ capabilityId: "pbx.M2", params: { ...SET, objectId: "101" }, requestedBy: "customer:u1", requestedRole: "customer" });
  assert.equal(res.gate, "G5");
});

test("G3: extension not in tenant refused; foreign profile refused", async () => {
  const exec = makeExec();
  const noExt = await exec.execute({ capabilityId: "pbx.M2", params: { ...SET, objectId: "999" }, requestedBy: "customer:u1", requestedRole: "customer" });
  assert.equal(noExt.gate, "G3");
  const foreignProfile = await exec.execute({ capabilityId: "pbx.M2", params: { ...SET, profileId: "px" }, requestedBy: "customer:u1", requestedRole: "customer" });
  assert.equal(foreignProfile.gate, "G3");
});

test("LIVE happy path: ext_set with attribution, verify passes", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M2", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(mohApi.calls[0].action, "ext_set");
  assert.equal(mohApi.calls[0].extension, "103");
  assert.equal(mohApi.calls[0].agentActionId, "act1");
});

test("LIVE clear: removes override, verify confirms inheritance", async () => {
  prisma.extOverrides.set("ct1:103", { extension: "103", enabled: true, mohProfileId: "p3", vitalPbxMohClassName: "moh3" });
  const params = { tenantId: "21", objectId: "103", action: "clear" };
  const exec = makeExec();
  prisma.actions.push(approvedRow(params));
  const res = await exec.execute({ capabilityId: "pbx.M2", params, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(prisma.extOverrides.has("ct1:103"), false);
});

test("LIVE revert: restores the PREVIOUS extension override", async () => {
  prisma.extOverrides.set("ct1:103", { extension: "103", enabled: true, mohProfileId: "p3", vitalPbxMohClassName: "moh3" });
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M2", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true);
  prisma.actions[0].resultSnapshot = { written: res.written };
  const r = await exec.revert("act1", "owner:izzy");
  assert.equal(r.ok, true, r.refusedReason);
  const last = mohApi.calls.at(-1)!;
  assert.equal(last.action, "ext_set");
  assert.equal(last.profileId, "p3");
});

test("LIVE revert when NO prior override: clears back to inheritance", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M2", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  prisma.actions[0].resultSnapshot = { written: res.written };
  const r = await exec.revert("act1", "owner:izzy");
  assert.equal(r.ok, true);
  assert.equal(mohApi.calls.at(-1)!.action, "ext_clear");
});

test("LIVE publish failure ⇒ verify fails ⇒ auto-revert", async () => {
  mohApi = new SpyMohApi(prisma, { publishSucceeds: false });
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M2", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, false);
  assert.equal(res.gate, "G11");
  assert.equal(res.autoReverted, true);
});

test("LIVE: api timeout ⇒ G10, zero retries", async () => {
  mohApi.failWith = "timeout";
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M2", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.gate, "G10");
  assert.equal(mohApi.calls.length, 1);
});

test("RED-TEAM: approve-then-mutate profile blocked at G8", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M2", params: { ...SET, profileId: "p3" }, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.gate, "G8");
  assert.equal(mohApi.calls.length, 0);
});

test("STRESS: 25 rapid set→clear→set flips in sim, all verified, zero api", async () => {
  const exec = makeExec();
  for (let i = 0; i < 25; i++) {
    const params = i % 2 === 0 ? SET : { tenantId: "21", objectId: "103", action: "clear" };
    const res = await exec.execute({ capabilityId: "pbx.M2", params, requestedBy: "owner:izzy", requestedRole: "owner" });
    assert.equal(res.ok, true, `flip ${i}: ${res.refusedReason}`);
  }
  assert.equal(mohApi.calls.length, 0);
  assert.equal(prisma.snaps.length, 25);
});
