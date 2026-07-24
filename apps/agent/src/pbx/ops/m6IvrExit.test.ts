/**
 * M6 — IVR timeout/invalid destination: op unit + executor chain (sim + live),
 * red-team, super-stress. NO network, NO real DB.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeM6Op, M6_SCHEMA } from "./m6IvrExit";
import { buildModifyCatalog, catalogOpsHonorModifyContract } from "../modifyCatalog";
import { ModifyPbxExecutor } from "../modifyExecutor";
import { makeScopeCheck } from "../scopeCheck";
import { SnapshotStore } from "../snapshotStore";
import { computeParamsHash } from "../../actions/bindings";
import { AuditLog, FileAuditSink } from "../../audit/audit";

class FakePrisma {
  profiles = new Map<string, any>([["pMain", { id: "pMain", tenantId: "ct1", timeoutDestinationType: "extension", timeoutDestinationRef: "T21_cos-all,101,1", invalidDestinationType: null, invalidDestinationRef: null }]]);
  actions: any[] = [];
  snaps: any[] = [];
  private seq = 0;
  tenantPbxLink = {
    findFirst: async ({ where }: any) => ({ "21": { tenantId: "ct1" }, "8": { tenantId: "ct9" } })[String(where.pbxTenantId)] ?? null,
    findUnique: async ({ where }: any) => ({ ct1: { pbxTenantId: "21" }, ct9: { pbxTenantId: "8" } })[where.tenantId as string] ?? null,
  };
  user = { findUnique: async ({ where }: any) => ({ u1: { tenantId: "ct1", status: "ACTIVE" } })[where.id as string] ?? null };
  ivrRouteProfile = {
    findFirst: async ({ where }: any) => {
      const p = this.profiles.get(where.id);
      if (!p) return null;
      if (where.tenantId !== undefined && p.tenantId !== where.tenantId) return null;
      return p;
    },
  };
  agentAction = { findUnique: async ({ where }: any) => this.actions.find((r) => r.id === where.id) ?? null };
  agentPbxSnapshot = {
    create: async ({ data }: any) => { const row = { id: `snap${++this.seq}`, restoredAt: null, ...data }; this.snaps.push(row); return row; },
    findUnique: async ({ where }: any) => this.snaps.find((r) => r.actionId === where.actionId) ?? null,
    update: async ({ where, data }: any) => Object.assign(this.snaps.find((r) => r.id === where.id), data),
  };
}

class SpyIvrApi {
  calls: any[] = [];
  failWith: string | null = null;
  constructor(private prisma: FakePrisma, private world: { publishSucceeds: boolean }) {}
  async call(body: Record<string, unknown>): Promise<any> {
    this.calls.push(body);
    if (this.failWith) throw new Error(this.failWith);
    const f = ({ timeout: { type: "timeoutDestinationType", ref: "timeoutDestinationRef" }, invalid: { type: "invalidDestinationType", ref: "invalidDestinationRef" } } as any)[String(body.exitSlot)];
    const p = this.prisma.profiles.get(String(body.profileId));
    if (p) { p[f.type] = body.destinationType ?? null; p[f.ref] = body.destinationRef ?? null; }
    return { ok: true, profile: p, publishResult: this.world.publishSucceeds ? { recordId: "pub", mode: "business", keysWritten: 5 } : null, publishError: this.world.publishSucceeds ? null : "publish blew up" };
  }
}

let prisma: FakePrisma;
let ivrApi: SpyIvrApi;
let audit: AuditLog;
const ENV = { AGENT_MODIFY_ENABLED: "1", AGENT_PBX_LIVE_TENANTS: "21", AGENT_PBX_PROTECTED_EXTS: "101", AGENT_PBX_LIVE_WRITES_PER_HOUR: "10", AGENT_MODIFY_REVERT_DAYS: "7" };

beforeEach(async () => {
  prisma = new FakePrisma();
  ivrApi = new SpyIvrApi(prisma, { publishSucceeds: true });
  const dir = await mkdtemp(path.join(tmpdir(), "m6-"));
  audit = new AuditLog([new FileAuditSink(dir)]);
});

function makeExec() {
  return new ModifyPbxExecutor(
    prisma as any, audit, new SnapshotStore(prisma),
    () => ({ callEndpointRaw: async () => { throw new Error("PBX client must never be used by M6"); } }),
    { catalog: buildModifyCatalog({ prisma, mohApi: { call: async () => ({}) }, ivrApi }), scopeCheck: makeScopeCheck(prisma), killSwitch: () => false, env: ENV },
  );
}

const SET = { tenantId: "21", objectId: "pMain:timeout", profileId: "pMain", exitSlot: "timeout", action: "set", destinationType: "queue", destinationRef: "ext-queues,900,1" };
function approvedRow(params: any, id = "act1") {
  return { id, capabilityId: "pbx.M6", tenantId: "21", params, status: "EXECUTING", approvalConsumedAt: new Date(), paramsHash: computeParamsHash("pbx.M6", "21", params), resultSnapshot: null };
}

test("schema: objectId must be '<profileId>:<slot>'; set needs type+ref", () => {
  assert.equal(M6_SCHEMA.safeParse(SET).success, true);
  assert.equal(M6_SCHEMA.safeParse({ ...SET, objectId: "x" }).success, false);
  assert.equal(M6_SCHEMA.safeParse({ tenantId: "21", objectId: "pMain:invalid", profileId: "pMain", exitSlot: "invalid", action: "clear" }).success, true);
  assert.equal(M6_SCHEMA.safeParse({ ...SET, exitSlot: "banner", objectId: "pMain:banner" }).success, false);
});

test("catalog: M6 present, contract holds", () => {
  const cat = buildModifyCatalog({ prisma, mohApi: { call: async () => ({}) }, ivrApi });
  assert.ok(cat["pbx.M6"]);
  assert.equal(catalogOpsHonorModifyContract(cat), true);
});

test("SIM full chain: passes, snapshot captures prior exit dest, ivrApi never called", async () => {
  const res = await makeExec().execute({ capabilityId: "pbx.M6", params: SET, requestedBy: "customer:u1", requestedRole: "customer" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(res.verified, true);
  assert.equal(ivrApi.calls.length, 0);
  assert.equal((prisma.snaps[0].stateJson as any).destinationRef, "T21_cos-all,101,1");
});

test("G3: foreign profile refused", async () => {
  prisma.profiles.set("pForeign", { id: "pForeign", tenantId: "ct9" });
  const res = await makeExec().execute({ capabilityId: "pbx.M6", params: { ...SET, objectId: "pForeign:timeout", profileId: "pForeign" }, requestedBy: "customer:u1", requestedRole: "customer" });
  assert.equal(res.gate, "G3");
});

test("LIVE happy path: timeout dest set with attribution, verify passes", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M6", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(ivrApi.calls[0].action, "set_exit");
  assert.equal(ivrApi.calls[0].exitSlot, "timeout");
  assert.equal(prisma.profiles.get("pMain").timeoutDestinationRef, "ext-queues,900,1");
});

test("LIVE clear: nulls the slot, verify confirms", async () => {
  const params = { tenantId: "21", objectId: "pMain:timeout", profileId: "pMain", exitSlot: "timeout", action: "clear" };
  const exec = makeExec();
  prisma.actions.push(approvedRow(params));
  const res = await exec.execute({ capabilityId: "pbx.M6", params, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(prisma.profiles.get("pMain").timeoutDestinationType, null);
});

test("LIVE revert restores prior exit destination", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M6", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true);
  prisma.actions[0].resultSnapshot = { written: res.written };
  const r = await exec.revert("act1", "owner:izzy");
  assert.equal(r.ok, true, r.refusedReason);
  assert.equal(prisma.profiles.get("pMain").timeoutDestinationRef, "T21_cos-all,101,1");
});

test("LIVE publish failure ⇒ verify fails ⇒ auto-revert", async () => {
  ivrApi = new SpyIvrApi(prisma, { publishSucceeds: false });
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M6", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, false);
  assert.equal(res.gate, "G11");
  assert.equal(res.autoReverted, true);
});

test("LIVE: api timeout ⇒ G10, zero retries", async () => {
  ivrApi.failWith = "timeout";
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M6", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.gate, "G10");
  assert.equal(ivrApi.calls.length, 1);
});

test("RED-TEAM: approve-then-mutate destination blocked at G8", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M6", params: { ...SET, destinationRef: "ext-queues,999,1" }, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.gate, "G8");
  assert.equal(ivrApi.calls.length, 0);
});

test("SUPER-STRESS: 200 rapid timeout/invalid set/clear (sim) — all verified, zero api", async () => {
  const exec = makeExec();
  const slots = ["timeout", "invalid"];
  let ok = 0;
  for (let i = 0; i < 200; i++) {
    const slot = slots[i % 2];
    const set = i % 3 !== 0;
    const params = set
      ? { tenantId: "21", objectId: `pMain:${slot}`, profileId: "pMain", exitSlot: slot, action: "set", destinationType: "extension", destinationRef: "T21_cos-all,101,1" }
      : { tenantId: "21", objectId: `pMain:${slot}`, profileId: "pMain", exitSlot: slot, action: "clear" };
    const res = await exec.execute({ capabilityId: "pbx.M6", params, requestedBy: "owner:izzy", requestedRole: "owner" });
    if (res.ok) ok++;
  }
  assert.equal(ok, 200);
  assert.equal(ivrApi.calls.length, 0);
  assert.equal(prisma.snaps.length, 200);
});
