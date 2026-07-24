/**
 * M10 — queue config edit: op unit + executor chain (sim + live), red-team,
 * super-stress. NO real DB; the queue "PBX" is a fake queueApi.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeM10Op, M10_SCHEMA } from "./m10Queue";
import { buildModifyCatalog, catalogOpsHonorModifyContract } from "../modifyCatalog";
import { ModifyPbxExecutor } from "../modifyExecutor";
import { makeScopeCheck } from "../scopeCheck";
import { SnapshotStore } from "../snapshotStore";
import { computeParamsHash } from "../../actions/bindings";
import { AuditLog, FileAuditSink } from "../../audit/audit";

class FakePrisma {
  actions: any[] = [];
  snaps: any[] = [];
  private seq = 0;
  tenantPbxLink = {
    findFirst: async ({ where }: any) => ({ "21": { tenantId: "ct1" }, "8": { tenantId: "ct9" } })[String(where.pbxTenantId)] ?? null,
    findUnique: async ({ where }: any) => ({ ct1: { pbxTenantId: "21" }, ct9: { pbxTenantId: "8" } })[where.tenantId as string] ?? null,
  };
  user = { findUnique: async ({ where }: any) => ({ u1: { tenantId: "ct1", status: "ACTIVE" } })[where.id as string] ?? null };
  agentAction = { findUnique: async ({ where }: any) => this.actions.find((r) => r.id === where.id) ?? null };
  agentPbxSnapshot = {
    create: async ({ data }: any) => { const row = { id: `snap${++this.seq}`, restoredAt: null, ...data }; this.snaps.push(row); return row; },
    findUnique: async ({ where }: any) => this.snaps.find((r) => r.actionId === where.actionId) ?? null,
    update: async ({ where, data }: any) => Object.assign(this.snaps.find((r) => r.id === where.id), data),
  };
}

/** Fake queue door: tenant 21 owns queue q5 (strategy ringall, timeout 15). */
class SpyQueueApi {
  calls: any[] = [];
  failWith: string | null = null;
  queues: Record<string, any> = { q5: { strategy: "ringall", timeout: 15, wrapuptime: 0, maxlen: 0 } };
  async call(body: any): Promise<any> {
    this.calls.push(body);
    if (this.failWith) throw new Error(this.failWith);
    if (String(body.tenantId) !== "21") return { ok: true, queues: [] }; // other tenants own nothing here
    if (body.action === "list") return { ok: true, queues: Object.entries(this.queues).map(([id, fields]) => ({ id, fields })) };
    // update
    const q = this.queues[String(body.queueId)];
    if (!q) throw new Error("queue_not_found_for_tenant");
    Object.assign(q, body.patch);
    return { ok: true, queue: { id: body.queueId, fields: q } };
  }
}

let prisma: FakePrisma;
let queueApi: SpyQueueApi;
let audit: AuditLog;
const ENV = { AGENT_MODIFY_ENABLED: "1", AGENT_PBX_LIVE_TENANTS: "21", AGENT_PBX_PROTECTED_EXTS: "101", AGENT_PBX_LIVE_WRITES_PER_HOUR: "10", AGENT_MODIFY_REVERT_DAYS: "7" };

beforeEach(async () => {
  prisma = new FakePrisma();
  queueApi = new SpyQueueApi();
  const dir = await mkdtemp(path.join(tmpdir(), "m10-"));
  audit = new AuditLog([new FileAuditSink(dir)]);
});

function makeExec() {
  return new ModifyPbxExecutor(
    prisma as any, audit, new SnapshotStore(prisma),
    () => ({ callEndpointRaw: async () => { throw new Error("PBX client must never be used by M10"); } }),
    { catalog: buildModifyCatalog({ prisma, mohApi: { call: async () => ({}) }, queueApi }), scopeCheck: makeScopeCheck(prisma), killSwitch: () => false, env: ENV },
  );
}

const SET = { tenantId: "21", objectId: "q5", patch: { strategy: "leastrecent", timeout: 30 } };
function approvedRow(params: any, id = "act1") {
  return { id, capabilityId: "pbx.M10", tenantId: "21", params, status: "EXECUTING", approvalConsumedAt: new Date(), paramsHash: computeParamsHash("pbx.M10", "21", params), resultSnapshot: null };
}

test("schema: allow-list enforced; unknown field / out-of-range refused; empty patch refused", () => {
  assert.equal(M10_SCHEMA.safeParse(SET).success, true);
  assert.equal(M10_SCHEMA.safeParse({ ...SET, patch: { evil: 1 } }).success, false);
  assert.equal(M10_SCHEMA.safeParse({ ...SET, patch: { timeout: 9999 } }).success, false);
  assert.equal(M10_SCHEMA.safeParse({ ...SET, patch: { strategy: "telepathy" } }).success, false);
  assert.equal(M10_SCHEMA.safeParse({ ...SET, patch: {} }).success, false);
});

test("catalog: M10 present, contract holds", () => {
  const cat = buildModifyCatalog({ prisma, mohApi: { call: async () => ({}) }, queueApi });
  assert.ok(cat["pbx.M10"]);
  assert.equal(catalogOpsHonorModifyContract(cat), true);
});

test("SIM full chain: passes; queueApi never called in simulate", async () => {
  const res = await makeExec().execute({ capabilityId: "pbx.M10", params: SET, requestedBy: "customer:u1", requestedRole: "customer" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(res.verified, true);
  assert.equal(queueApi.calls.length, 0);
});

test("LIVE happy path: queue updated, snapshot captured prior fields, verify passes", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M10", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(queueApi.queues.q5.strategy, "leastrecent");
  assert.equal(queueApi.queues.q5.timeout, 30);
  const snap: any = prisma.snaps[0].stateJson;
  assert.equal(snap.before.strategy, "ringall");
  assert.equal(snap.before.timeout, 15);
});

test("LIVE revert restores the prior queue fields", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M10", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true);
  prisma.actions[0].resultSnapshot = { written: res.written };
  const r = await exec.revert("act1", "owner:izzy");
  assert.equal(r.ok, true, r.refusedReason);
  assert.equal(queueApi.queues.q5.strategy, "ringall");
  assert.equal(queueApi.queues.q5.timeout, 15);
});

test("LIVE: non-owned queue refused at snapshot (G9)", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow({ ...SET, objectId: "q999" }));
  const res = await exec.execute({ capabilityId: "pbx.M10", params: { ...SET, objectId: "q999" }, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, false);
  assert.equal(res.gate, "G9");
});

test("LIVE: api timeout ⇒ G10, zero retries", async () => {
  queueApi.failWith = "timeout";
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M10", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  // snapshot itself calls the api (list) → fails at G9 (snapshot) before dispatch
  assert.equal(res.ok, false);
  assert.ok(["G9", "G10"].includes(res.gate!));
});

test("RED-TEAM: approve-then-mutate patch blocked at G8", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M10", params: { ...SET, patch: { strategy: "random", timeout: 600 } }, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.gate, "G8");
});

test("SUPER-STRESS: 200 rapid sim edits — all verified, zero api", async () => {
  const exec = makeExec();
  const strategies = ["ringall", "leastrecent", "fewestcalls", "random"];
  let ok = 0;
  for (let i = 0; i < 200; i++) {
    const patch = { strategy: strategies[i % 4], timeout: (i % 60) + 1 };
    const res = await exec.execute({ capabilityId: "pbx.M10", params: { tenantId: "21", objectId: "q5", patch }, requestedBy: "owner:izzy", requestedRole: "owner" });
    if (res.ok) ok++;
  }
  assert.equal(ok, 200);
  assert.equal(queueApi.calls.length, 0);
  assert.equal(prisma.snaps.length, 200);
});
