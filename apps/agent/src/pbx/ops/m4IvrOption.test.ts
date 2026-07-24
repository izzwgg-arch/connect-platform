/**
 * M4 — IVR menu digit change: op unit + executor chain (sim + live), red-team,
 * per-type coverage, and super-stress. NO network, NO real DB.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeM4Op, M4_SCHEMA } from "./m4IvrOption";
import { buildModifyCatalog, catalogOpsHonorModifyContract } from "../modifyCatalog";
import { ModifyPbxExecutor } from "../modifyExecutor";
import { makeScopeCheck } from "../scopeCheck";
import { SnapshotStore } from "../snapshotStore";
import { computeParamsHash } from "../../actions/bindings";
import { AuditLog, FileAuditSink } from "../../audit/audit";

/** vital 21↔ct1(u1); profiles pMain/pAfter own ct1; pForeign owns ct9. */
class FakePrisma {
  opts = new Map<string, any>(); // key `${profileId}:${digit}`
  publishes: any[] = [];
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
      const all = [{ id: "pMain", tenantId: "ct1" }, { id: "pAfter", tenantId: "ct1" }, { id: "pForeign", tenantId: "ct9" }];
      return all.find((p) => (where.id === undefined || p.id === where.id) && (where.tenantId === undefined || p.tenantId === where.tenantId)) ?? null;
    },
    findMany: async ({ where }: any) => [{ id: "pMain", tenantId: "ct1" }, { id: "pAfter", tenantId: "ct1" }].filter((p) => p.tenantId === where.tenantId),
  };
  ivrOptionRoute = {
    findFirst: async ({ where }: any) => this.opts.get(`${where.profileId}:${where.optionDigit}`) ?? null,
  };
  agentAction = { findUnique: async ({ where }: any) => this.actions.find((r) => r.id === where.id) ?? null };
  agentPbxSnapshot = {
    create: async ({ data }: any) => { const row = { id: `snap${++this.seq}`, restoredAt: null, ...data }; this.snaps.push(row); return row; },
    findUnique: async ({ where }: any) => this.snaps.find((r) => r.actionId === where.actionId) ?? null,
    update: async ({ where, data }: any) => Object.assign(this.snaps.find((r) => r.id === where.id), data),
  };
  mohPublishRecord = { findFirst: async () => null };
}

class SpyIvrApi {
  calls: any[] = [];
  failWith: string | null = null;
  constructor(private prisma: FakePrisma, private world: { publishSucceeds: boolean }) {}
  async call(body: Record<string, unknown>): Promise<any> {
    this.calls.push(body);
    if (this.failWith) throw new Error(this.failWith);
    const key = `${body.profileId}:${body.optionDigit}`;
    if (body.action === "set_option") this.prisma.opts.set(key, { destinationType: body.destinationType, destinationRef: body.destinationRef, label: body.label ?? null });
    else if (body.action === "clear_option") this.prisma.opts.delete(key);
    return { ok: true, publishResult: this.world.publishSucceeds ? { recordId: "pub", mode: "business", keysWritten: 5 } : null, publishError: this.world.publishSucceeds ? null : "publish blew up" };
  }
}

let prisma: FakePrisma;
let ivrApi: SpyIvrApi;
let audit: AuditLog;
const ENV = { AGENT_MODIFY_ENABLED: "1", AGENT_PBX_LIVE_TENANTS: "21", AGENT_PBX_PROTECTED_EXTS: "101", AGENT_PBX_LIVE_WRITES_PER_HOUR: "10", AGENT_MODIFY_REVERT_DAYS: "7" };

beforeEach(async () => {
  prisma = new FakePrisma();
  ivrApi = new SpyIvrApi(prisma, { publishSucceeds: true });
  const dir = await mkdtemp(path.join(tmpdir(), "m4-"));
  audit = new AuditLog([new FileAuditSink(dir)]);
});

function makeExec() {
  return new ModifyPbxExecutor(
    prisma as any, audit, new SnapshotStore(prisma),
    () => ({ callEndpointRaw: async () => { throw new Error("PBX client must never be used by M4"); } }),
    { catalog: buildModifyCatalog({ prisma, mohApi: { call: async () => ({}) }, ivrApi }), scopeCheck: makeScopeCheck(prisma), killSwitch: () => false, env: ENV },
  );
}

const SET = { tenantId: "21", objectId: "pMain:1", action: "set", profileId: "pMain", optionDigit: "1", destinationType: "queue", destinationRef: "ext-queues,900,1" };
function approvedRow(params: any, id = "act1") {
  return { id, capabilityId: "pbx.M4", tenantId: "21", params, status: "EXECUTING", approvalConsumedAt: new Date(), paramsHash: computeParamsHash("pbx.M4", "21", params), resultSnapshot: null };
}

test("schema: objectId must be '<profileId>:<digit>'; set requires type+ref", () => {
  assert.equal(M4_SCHEMA.safeParse(SET).success, true);
  assert.equal(M4_SCHEMA.safeParse({ ...SET, objectId: "wrong" }).success, false);
  assert.equal(M4_SCHEMA.safeParse({ tenantId: "21", objectId: "pMain:1", action: "set", profileId: "pMain", optionDigit: "1" }).success, false);
  assert.equal(M4_SCHEMA.safeParse({ tenantId: "21", objectId: "pMain:1", action: "clear", profileId: "pMain", optionDigit: "1" }).success, true);
});

test("catalog: M4 present, contract holds", () => {
  const cat = buildModifyCatalog({ prisma, mohApi: { call: async () => ({}) }, ivrApi });
  assert.ok(cat["pbx.M4"]);
  assert.equal(catalogOpsHonorModifyContract(cat), true);
});

test("SIM full chain: passes, snapshot stored, ivrApi never called", async () => {
  const res = await makeExec().execute({ capabilityId: "pbx.M4", params: SET, requestedBy: "customer:u1", requestedRole: "customer" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(res.verified, true);
  assert.equal(ivrApi.calls.length, 0);
  assert.equal((prisma.snaps[0].stateJson as any).profileId, "pMain");
});

test("G3: foreign IVR profile refused", async () => {
  const res = await makeExec().execute({ capabilityId: "pbx.M4", params: { ...SET, objectId: "pForeign:1", profileId: "pForeign" }, requestedBy: "customer:u1", requestedRole: "customer" });
  assert.equal(res.gate, "G3");
});

test("LIVE happy path: set_option with attribution, verify passes", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M4", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(ivrApi.calls[0].action, "set_option");
  assert.equal(ivrApi.calls[0].optionDigit, "1");
  assert.equal(ivrApi.calls[0].agentActionId, "act1");
});

test("LIVE clear: removes option, verify confirms", async () => {
  prisma.opts.set("pMain:1", { destinationType: "queue", destinationRef: "ext-queues,900,1", label: null });
  const params = { tenantId: "21", objectId: "pMain:1", action: "clear", profileId: "pMain", optionDigit: "1" };
  const exec = makeExec();
  prisma.actions.push(approvedRow(params));
  const res = await exec.execute({ capabilityId: "pbx.M4", params, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(prisma.opts.has("pMain:1"), false);
});

test("LIVE revert: restores the PREVIOUS option", async () => {
  prisma.opts.set("pMain:1", { destinationType: "extension", destinationRef: "T21_cos-all,101,1", label: "Reception" });
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M4", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true);
  prisma.actions[0].resultSnapshot = { written: res.written };
  const r = await exec.revert("act1", "owner:izzy");
  assert.equal(r.ok, true, r.refusedReason);
  const last = ivrApi.calls.at(-1)!;
  assert.equal(last.action, "set_option");
  assert.equal(last.destinationRef, "T21_cos-all,101,1");
});

test("LIVE revert when digit was empty: clears back", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M4", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  prisma.actions[0].resultSnapshot = { written: res.written };
  const r = await exec.revert("act1", "owner:izzy");
  assert.equal(r.ok, true);
  assert.equal(ivrApi.calls.at(-1)!.action, "clear_option");
});

test("LIVE publish failure ⇒ verify fails ⇒ auto-revert", async () => {
  ivrApi = new SpyIvrApi(prisma, { publishSucceeds: false });
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M4", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, false);
  assert.equal(res.gate, "G11");
  assert.equal(res.autoReverted, true);
});

test("LIVE: api timeout ⇒ G10, zero retries", async () => {
  ivrApi.failWith = "timeout";
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M4", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.gate, "G10");
  assert.equal(ivrApi.calls.length, 1);
});

test("RED-TEAM: approve-then-mutate destination blocked at G8", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M4", params: { ...SET, destinationRef: "ext-queues,999,1" }, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.gate, "G8");
  assert.equal(ivrApi.calls.length, 0);
});

test("SUPER-STRESS: 300 mixed set/clear across all 12 digits (sim) — all verified, zero api", async () => {
  const exec = makeExec();
  const digits = ["0","1","2","3","4","5","6","7","8","9","star","hash"];
  let ok = 0;
  for (let i = 0; i < 300; i++) {
    const digit = digits[i % 12];
    const set = i % 3 !== 0;
    const params = set
      ? { tenantId: "21", objectId: `pMain:${digit}`, action: "set", profileId: "pMain", optionDigit: digit, destinationType: "extension", destinationRef: "T21_cos-all,101,1" }
      : { tenantId: "21", objectId: `pMain:${digit}`, action: "clear", profileId: "pMain", optionDigit: digit };
    const res = await exec.execute({ capabilityId: "pbx.M4", params, requestedBy: "owner:izzy", requestedRole: "owner" });
    if (res.ok) ok++;
  }
  assert.equal(ok, 300);
  assert.equal(ivrApi.calls.length, 0);
  assert.equal(prisma.snaps.length, 300);
});
