/**
 * M1 — tenant MOH selection: op unit tests + full executor-chain integration
 * (sim), red-team, and stress. NO network, NO real DB.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeM1Op, M1_SCHEMA } from "./m1MohTenant";
import { buildModifyCatalog, catalogOpsHonorModifyContract } from "../modifyCatalog";
import { ModifyPbxExecutor } from "../modifyExecutor";
import { makeScopeCheck } from "../scopeCheck";
import { SnapshotStore } from "../snapshotStore";
import { computeParamsHash } from "../../actions/bindings";
import { AuditLog, FileAuditSink } from "../../audit/audit";

/** Connect-mirror fixture: vital 21 ↔ Connect ct1, owned by user u1; profiles p8 (moh8) + p3 (moh3); foreign tenant ct9/vital 8 with profile px. */
class FakePrisma {
  overrides = new Map<string, any>([["ct1", { isActive: false, profileId: null, expiresAt: null }]]);
  publishes: any[] = [];
  actions: any[] = [];
  snaps: any[] = [];
  private seq = 0;

  tenantPbxLink = {
    findFirst: async ({ where }: any) => ({ "21": { tenantId: "ct1" }, "8": { tenantId: "ct9" } })[String(where.pbxTenantId)] ?? null,
    findUnique: async ({ where }: any) => ({ ct1: { pbxTenantId: "21" }, ct9: { pbxTenantId: "8" } })[where.tenantId as string] ?? null,
  };
  user = {
    findUnique: async ({ where }: any) => ({ u1: { tenantId: "ct1", status: "ACTIVE" }, u9: { tenantId: "ct9", status: "ACTIVE" } })[where.id as string] ?? null,
  };
  mohProfile = {
    findFirst: async ({ where }: any) => {
      const all = [
        { id: "p8", tenantId: "ct1", isActive: true, vitalPbxMohClassName: "moh8" },
        { id: "p3", tenantId: "ct1", isActive: true, vitalPbxMohClassName: "moh3" },
        { id: "pDead", tenantId: "ct1", isActive: false, vitalPbxMohClassName: "moh2" },
        { id: "px", tenantId: "ct9", isActive: true, vitalPbxMohClassName: "moh5" },
      ];
      return (
        all.find(
          (p) =>
            (where.id === undefined || p.id === where.id) &&
            (where.tenantId === undefined || p.tenantId === where.tenantId) &&
            (where.isActive === undefined || p.isActive === where.isActive),
        ) ?? null
      );
    },
  };
  mohOverrideState = {
    findUnique: async ({ where }: any) => this.overrides.get(where.tenantId) ?? null,
  };
  mohPublishRecord = {
    findFirst: async ({ where }: any) => this.publishes.filter((p) => p.tenantId === where.tenantId).sort((a, b) => b.publishedAt - a.publishedAt)[0] ?? null,
  };
  agentAction = { findUnique: async ({ where }: any) => this.actions.find((r) => r.id === where.id) ?? null };
  agentPbxSnapshot = {
    create: async ({ data }: any) => {
      const row = { id: `snap${++this.seq}`, capturedAt: new Date(), restoredAt: null, ...data };
      this.snaps.push(row);
      return row;
    },
    findUnique: async ({ where }: any) => this.snaps.find((r) => r.actionId === where.actionId) ?? null,
    update: async ({ where, data }: any) => Object.assign(this.snaps.find((r) => r.id === where.id), data),
  };
}

/** mohApi spy: records calls; configurable behavior; simulates api side effects on the fake DB. */
class SpyMohApi {
  calls: any[] = [];
  failWith: string | null = null;
  constructor(private prisma: FakePrisma, private world: { publishSucceeds: boolean; queuePatchOk: boolean; queuesTotal: number }) {}
  async call(body: Record<string, unknown>): Promise<any> {
    this.calls.push(body);
    if (this.failWith) throw new Error(this.failWith);
    const ct = String(body.tenantId) === "21" ? "ct1" : "ct9";
    if (body.action === "activate") {
      this.prisma.overrides.set(ct, { isActive: true, profileId: body.profileId, expiresAt: body.expiresAt ?? null });
    } else if (body.action === "deactivate") {
      this.prisma.overrides.set(ct, { isActive: false, profileId: null, expiresAt: null });
    }
    const cls = body.profileId === "p3" ? "moh3" : "moh8";
    this.prisma.publishes.push({
      id: `pub${this.prisma.publishes.length + 1}`,
      tenantId: ct,
      publishedAt: Date.now() + this.prisma.publishes.length,
      status: this.world.publishSucceeds ? "success" : "failed",
      newMohClass: cls,
      nativeSync: {
        queuesTotal: this.world.queuesTotal,
        helperResponse: { queuePatch: this.world.queuePatchOk ? { patched: 1, error: null } : { patched: 0, error: "patch_failed: boom" } },
      },
    });
    return { ok: true, publishResult: this.world.publishSucceeds ? { recordId: "pub", mohClass: cls, mode: "override" } : null, publishError: this.world.publishSucceeds ? null : "publish blew up" };
  }
}

let prisma: FakePrisma;
let mohApi: SpyMohApi;
let audit: AuditLog;
const ENV = { AGENT_MODIFY_ENABLED: "1", AGENT_PBX_LIVE_TENANTS: "21", AGENT_PBX_PROTECTED_EXTS: "101", AGENT_PBX_LIVE_WRITES_PER_HOUR: "10", AGENT_MODIFY_REVERT_DAYS: "7" };

beforeEach(async () => {
  prisma = new FakePrisma();
  mohApi = new SpyMohApi(prisma, { publishSucceeds: true, queuePatchOk: true, queuesTotal: 1 });
  const dir = await mkdtemp(path.join(tmpdir(), "m1-"));
  audit = new AuditLog([new FileAuditSink(dir)]);
});

function makeExec() {
  return new ModifyPbxExecutor(
    prisma as any,
    audit,
    new SnapshotStore(prisma),
    () => ({ callEndpointRaw: async () => { throw new Error("PBX client must never be used by M1"); } }),
    { catalog: buildModifyCatalog({ prisma, mohApi }), scopeCheck: makeScopeCheck(prisma), killSwitch: () => false, env: ENV },
  );
}

const ACTIVATE = { tenantId: "21", objectId: "21", action: "activate", profileId: "p8" };

function approvedRow(params: any, id = "act1") {
  return { id, capabilityId: "pbx.M1", tenantId: "21", params, status: "EXECUTING", approvalConsumedAt: new Date(), paramsHash: computeParamsHash("pbx.M1", "21", params), resultSnapshot: null };
}

// ── schema ──

test("schema: objectId must equal tenantId; activate requires profileId; expiry bounds", () => {
  assert.equal(M1_SCHEMA.safeParse(ACTIVATE).success, true);
  assert.equal(M1_SCHEMA.safeParse({ ...ACTIVATE, objectId: "8" }).success, false);
  assert.equal(M1_SCHEMA.safeParse({ tenantId: "21", objectId: "21", action: "activate" }).success, false);
  assert.equal(M1_SCHEMA.safeParse({ tenantId: "21", objectId: "21", action: "deactivate" }).success, true);
  assert.equal(M1_SCHEMA.safeParse({ ...ACTIVATE, expiresHours: 0 }).success, false);
  assert.equal(M1_SCHEMA.safeParse({ ...ACTIVATE, expiresHours: 24 }).success, true);
});

test("catalog: includes pbx.M1, honors the modify contract", () => {
  const cat = buildModifyCatalog({ prisma, mohApi });
  assert.ok(cat["pbx.M1"], "M1 present");
  assert.equal(catalogOpsHonorModifyContract(cat), true);
});

// ── simulate: full chain, zero network ──

test("SIM full chain G0–G11: passes, snapshot stored, mohApi NEVER called", async () => {
  const res = await makeExec().execute({ capabilityId: "pbx.M1", params: ACTIVATE, requestedBy: "customer:u1", requestedRole: "customer" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(res.verified, true);
  assert.equal(mohApi.calls.length, 0, "simulate must not contact the api");
  assert.equal(prisma.snaps.length, 1);
  const snapState: any = prisma.snaps[0].stateJson;
  assert.equal(snapState.connectTenantId, "ct1");
  assert.equal(snapState.targetClass, "moh8");
});

test("SIM revert: restores without network", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(ACTIVATE));
  const res = await exec.execute({ capabilityId: "pbx.M1", params: ACTIVATE, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1" });
  assert.equal(res.ok, true);
  prisma.actions[0].resultSnapshot = { written: res.written };
  const r = await exec.revert("act1", "owner:izzy");
  assert.equal(r.ok, true);
  assert.equal(mohApi.calls.length, 0);
});

// ── scope fence (G3) ──

test("G3: foreign tenant refused; foreign profile refused; dead profile refused at snapshot", async () => {
  const exec = makeExec();
  const foreignTenant = await exec.execute({ capabilityId: "pbx.M1", params: { tenantId: "8", objectId: "8", action: "activate", profileId: "px" }, requestedBy: "customer:u1", requestedRole: "customer" });
  assert.equal(foreignTenant.gate, "G3");

  const foreignProfile = await exec.execute({ capabilityId: "pbx.M1", params: { ...ACTIVATE, profileId: "px" }, requestedBy: "customer:u1", requestedRole: "customer" });
  assert.equal(foreignProfile.gate, "G3", "profile of another tenant must fail the scope fence");

  const dead = await exec.execute({ capabilityId: "pbx.M1", params: { ...ACTIVATE, profileId: "pDead" }, requestedBy: "customer:u1", requestedRole: "customer" });
  assert.equal(dead.ok, false); // inactive profile: passes scope (exists) but snapshot ownership/active check refuses
  assert.equal(dead.gate, "G9");
});

// ── live path ──

test("LIVE happy path: api called once with attribution, verify checks override+publish+queue evidence", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(ACTIVATE));
  const res = await exec.execute({ capabilityId: "pbx.M1", params: ACTIVATE, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(res.verified, true);
  assert.equal(mohApi.calls.length, 1);
  assert.equal(mohApi.calls[0].agentActionId, "act1");
  assert.equal(mohApi.calls[0].action, "activate");
});

test("LIVE: publish failure ⇒ verify fails ⇒ automatic revert fires (via api)", async () => {
  mohApi = new SpyMohApi(prisma, { publishSucceeds: false, queuePatchOk: true, queuesTotal: 1 });
  const exec = makeExec();
  prisma.actions.push(approvedRow(ACTIVATE));
  const res = await exec.execute({ capabilityId: "pbx.M1", params: ACTIVATE, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, false);
  assert.equal(res.gate, "G11");
  assert.equal(res.autoReverted, true);
  // dispatch + revert = 2 api calls; revert deactivates (previous state was inactive)
  assert.equal(mohApi.calls.length, 2);
  assert.equal(mohApi.calls[1].action, "deactivate");
});

test("LIVE X4 CONTRACT: queue evidence missing/failed ⇒ verify fails ⇒ auto-revert", async () => {
  mohApi = new SpyMohApi(prisma, { publishSucceeds: true, queuePatchOk: false, queuesTotal: 1 });
  const exec = makeExec();
  prisma.actions.push(approvedRow(ACTIVATE));
  const res = await exec.execute({ capabilityId: "pbx.M1", params: ACTIVATE, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, false);
  assert.equal(res.gate, "G11");
  assert.match(res.refusedReason!, /queue coverage/);
  assert.equal(res.autoReverted, true);
});

test("LIVE: tenant with no queues passes without queue evidence", async () => {
  mohApi = new SpyMohApi(prisma, { publishSucceeds: true, queuePatchOk: false, queuesTotal: 0 });
  const exec = makeExec();
  prisma.actions.push(approvedRow(ACTIVATE));
  const res = await exec.execute({ capabilityId: "pbx.M1", params: ACTIVATE, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true, res.refusedReason);
});

test("LIVE: api timeout ⇒ G10 outcome recorded, ZERO retries", async () => {
  mohApi.failWith = "moh_api_error status=timeout";
  const exec = makeExec();
  prisma.actions.push(approvedRow(ACTIVATE));
  const res = await exec.execute({ capabilityId: "pbx.M1", params: ACTIVATE, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.gate, "G10");
  assert.match(res.refusedReason!, /No retry/);
  assert.equal(mohApi.calls.length, 1, "exactly one attempt, never blind-retried");
});

test("LIVE revert: restores the PREVIOUS profile when one was active", async () => {
  prisma.overrides.set("ct1", { isActive: true, profileId: "p3", expiresAt: null });
  const exec = makeExec();
  prisma.actions.push(approvedRow(ACTIVATE));
  const res = await exec.execute({ capabilityId: "pbx.M1", params: ACTIVATE, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true);
  prisma.actions[0].resultSnapshot = { written: res.written };
  const r = await exec.revert("act1", "owner:izzy");
  assert.equal(r.ok, true, r.refusedReason);
  const revertCall = mohApi.calls.at(-1)!;
  assert.equal(revertCall.action, "activate");
  assert.equal(revertCall.profileId, "p3"); // back to the previous music
});

// ── red-team ──

test("RED-TEAM: approve-then-mutate profileId blocked at G8", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(ACTIVATE));
  const res = await exec.execute({ capabilityId: "pbx.M1", params: { ...ACTIVATE, profileId: "p3" }, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.gate, "G8");
  assert.equal(mohApi.calls.length, 0);
});

test("RED-TEAM: live against non-allow-listed tenant blocked at G6 even with valid-looking approval", async () => {
  const params = { tenantId: "8", objectId: "8", action: "activate", profileId: "px" };
  const exec = makeExec();
  prisma.actions.push({ ...approvedRow(params), tenantId: "8", paramsHash: computeParamsHash("pbx.M1", "8", params) });
  const res = await exec.execute({ capabilityId: "pbx.M1", params, requestedBy: "customer:u9", requestedRole: "customer", actionId: "act1", mode: "live" });
  assert.equal(res.ok, false);
  assert.ok(["G3", "G6"].includes(res.gate!)); // both fences stand between them and it
  assert.equal(mohApi.calls.length, 0);
});

// ── stress ──

test("STRESS: 25 rapid A→B→A flips in sim — every one verified, zero api calls, snapshots intact", async () => {
  const exec = makeExec();
  for (let i = 0; i < 25; i++) {
    const profileId = i % 2 === 0 ? "p8" : "p3";
    const res = await exec.execute({ capabilityId: "pbx.M1", params: { ...ACTIVATE, profileId }, requestedBy: "owner:izzy", requestedRole: "owner" });
    assert.equal(res.ok, true, `flip ${i}: ${res.refusedReason}`);
  }
  assert.equal(mohApi.calls.length, 0);
  assert.equal(prisma.snaps.length, 25);
});

test("STRESS: live budget caps rapid live flips at the configured limit", async () => {
  const exec = makeExec();
  let allowed = 0;
  let refusedAtG4 = 0;
  for (let i = 0; i < 12; i++) {
    const params = { ...ACTIVATE, profileId: i % 2 === 0 ? "p8" : "p3" };
    const id = `act${i}`;
    prisma.actions.push(approvedRow(params, id));
    const res = await exec.execute({ capabilityId: "pbx.M1", params, requestedBy: "owner:izzy", requestedRole: "owner", actionId: id, mode: "live" });
    if (res.ok) allowed++;
    else if (res.gate === "G4") refusedAtG4++;
  }
  assert.equal(allowed, 10); // AGENT_PBX_LIVE_WRITES_PER_HOUR
  assert.equal(refusedAtG4, 2);
});
