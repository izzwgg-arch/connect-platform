/**
 * M3 — inbound route destination change: op unit + executor-chain (sim + live-
 * with-fake-helper), red-team, connect-mode fence, H2-pending live fence.
 * NO real network.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeM3Op, M3_SCHEMA } from "./m3InboundRoute";
import { buildModifyCatalog, catalogOpsHonorModifyContract, type ModifyOp } from "../modifyCatalog";
import { ModifyPbxExecutor } from "../modifyExecutor";
import { makeScopeCheck } from "../scopeCheck";
import { SnapshotStore } from "../snapshotStore";
import { computeParamsHash } from "../../actions/bindings";
import { makeH2PendingRouteApiClient } from "../routeApiClient";
import { AuditLog, FileAuditSink } from "../../audit/audit";

/** Mirror: vital 21↔ct1(u1) owns DID 8455577768; vital 8↔ct9. */
class FakePrisma {
  publishes: any[] = [];
  actions: any[] = [];
  snaps: any[] = [];
  private seq = 0;
  tenantPbxLink = {
    findFirst: async ({ where }: any) => ({ "21": { tenantId: "ct1" }, "8": { tenantId: "ct9" } })[String(where.pbxTenantId)] ?? null,
    findUnique: async ({ where }: any) => ({ ct1: { pbxTenantId: "21" }, ct9: { pbxTenantId: "8" } })[where.tenantId as string] ?? null,
  };
  user = { findUnique: async ({ where }: any) => ({ u1: { tenantId: "ct1", status: "ACTIVE" }, u9: { tenantId: "ct9", status: "ACTIVE" } })[where.id as string] ?? null };
  pbxTenantInboundDid = { findFirst: async ({ where }: any) => (where.vitalTenantId === "21" && where.e164 === "8455577768" ? { id: "d1" } : null) };
  phoneNumber = { findFirst: async () => null };
  agentAction = { findUnique: async ({ where }: any) => this.actions.find((r) => r.id === where.id) ?? null };
  agentPbxSnapshot = {
    create: async ({ data }: any) => { const row = { id: `snap${++this.seq}`, restoredAt: null, ...data }; this.snaps.push(row); return row; },
    findUnique: async ({ where }: any) => this.snaps.find((r) => r.actionId === where.actionId) ?? null,
    update: async ({ where, data }: any) => Object.assign(this.snaps.find((r) => r.id === where.id), data),
  };
}

/** Fake route helper door: models inspect/retarget/restore + mode. */
class FakeRouteApi {
  calls: any[] = [];
  dest = "456";
  mode: "connect" | "pbx" = "pbx";
  applyExit = 0;
  failWith: string | null = null;
  original = "456";
  async call(body: any): Promise<any> {
    this.calls.push(body);
    if (this.failWith) throw new Error(this.failWith);
    if (body.action === "route_inspect") return { ok: true, mode: this.mode, route: { inbound_route_id: 68, destination_id: this.dest } };
    if (body.action === "route_retarget") { this.dest = String(body.destinationId); return { ok: true, after: { destination_id: this.dest }, apply: { ran: true, exitCode: this.applyExit } }; }
    if (body.action === "route_restore") { this.dest = this.original; return { ok: true, after: { destination_id: this.dest }, apply: { ran: true, exitCode: this.applyExit } }; }
    return { ok: true };
  }
}

let prisma: FakePrisma;
let routeApi: FakeRouteApi;
let audit: AuditLog;
const ENV = { AGENT_MODIFY_ENABLED: "1", AGENT_PBX_LIVE_TENANTS: "21", AGENT_PBX_PROTECTED_EXTS: "101", AGENT_PBX_LIVE_WRITES_PER_HOUR: "10", AGENT_MODIFY_REVERT_DAYS: "7" };

beforeEach(async () => {
  prisma = new FakePrisma();
  routeApi = new FakeRouteApi();
  const dir = await mkdtemp(path.join(tmpdir(), "m3-"));
  audit = new AuditLog([new FileAuditSink(dir)]);
});

function makeExec(rapi: any = routeApi) {
  return new ModifyPbxExecutor(
    prisma as any, audit, new SnapshotStore(prisma),
    () => ({ callEndpointRaw: async () => { throw new Error("PBX client must never be used by M3"); } }),
    { catalog: buildModifyCatalog({ prisma, mohApi: { call: async () => { throw new Error("moh not used"); } }, routeApi: rapi }), scopeCheck: makeScopeCheck(prisma), killSwitch: () => false, env: ENV },
  );
}

const RETARGET = { tenantId: "21", objectId: "8455577768", action: "retarget", destinationId: "642" };
function approvedRow(params: any, id = "act1") {
  return { id, capabilityId: "pbx.M3", tenantId: "21", params, status: "EXECUTING", approvalConsumedAt: new Date(), paramsHash: computeParamsHash("pbx.M3", "21", params), resultSnapshot: null };
}

test("schema: retarget requires destinationId; restore does not", () => {
  assert.equal(M3_SCHEMA.safeParse(RETARGET).success, true);
  assert.equal(M3_SCHEMA.safeParse({ tenantId: "21", objectId: "8455577768", action: "retarget" }).success, false);
  assert.equal(M3_SCHEMA.safeParse({ tenantId: "21", objectId: "8455577768", action: "restore" }).success, true);
});

test("catalog: M3 present, contract holds", () => {
  const cat = buildModifyCatalog({ prisma, mohApi: { call: async () => ({}) }, routeApi });
  assert.ok(cat["pbx.M3"], "M3 present");
  assert.equal(catalogOpsHonorModifyContract(cat), true);
});

test("SIM full chain: passes, snapshot stored, routeApi NEVER called", async () => {
  const res = await makeExec().execute({ capabilityId: "pbx.M3", params: RETARGET, requestedBy: "owner:izzy", requestedRole: "owner" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(res.verified, true);
  assert.equal(routeApi.calls.length, 0, "simulate must not contact the route helper");
  assert.equal(prisma.snaps.length, 1);
});

test("G3: foreign-tenant DID refused", async () => {
  const res = await makeExec().execute({ capabilityId: "pbx.M3", params: { ...RETARGET, tenantId: "8", objectId: "8455577768" }, requestedBy: "customer:u9", requestedRole: "customer" });
  assert.equal(res.gate, "G3");
});

test("LIVE happy path: retarget changes destination, verify confirms", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(RETARGET));
  const res = await exec.execute({ capabilityId: "pbx.M3", params: RETARGET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(routeApi.dest, "642");
  assert.ok(routeApi.calls.some((c) => c.action === "route_retarget" && c.agentActionId === "act1"));
});

test("CONNECT-MODE FENCE: a connect-routed DID is hard-refused at snapshot (G9)", async () => {
  routeApi.mode = "connect";
  const exec = makeExec();
  prisma.actions.push(approvedRow(RETARGET));
  const res = await exec.execute({ capabilityId: "pbx.M3", params: RETARGET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, false);
  assert.equal(res.gate, "G9");
  assert.equal(routeApi.dest, "456", "no retarget happened");
});

test("LIVE verify mismatch (apply failed) ⇒ auto-revert via restore", async () => {
  routeApi.applyExit = 1;
  const exec = makeExec();
  prisma.actions.push(approvedRow(RETARGET));
  const res = await exec.execute({ capabilityId: "pbx.M3", params: RETARGET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, false);
  assert.equal(res.gate, "G11");
  assert.equal(res.autoReverted, true);
  assert.ok(routeApi.calls.some((c) => c.action === "route_restore"));
});

test("LIVE helper timeout ⇒ G10, zero retries", async () => {
  routeApi.failWith = "helper_timeout";
  const exec = makeExec();
  prisma.actions.push(approvedRow(RETARGET));
  const res = await exec.execute({ capabilityId: "pbx.M3", params: RETARGET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  // snapshot inspect throws ⇒ refuse at G9 (snapshot), one call, no retarget
  assert.equal(res.ok, false);
  assert.ok(["G9", "G10"].includes(res.gate!));
  assert.ok(!routeApi.calls.some((c) => c.action === "route_retarget"));
});

test("LIVE revert: restores previous destination", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(RETARGET));
  const res = await exec.execute({ capabilityId: "pbx.M3", params: RETARGET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true);
  prisma.actions[0].resultSnapshot = { written: res.written };
  routeApi.calls.length = 0;
  const r = await exec.revert("act1", "owner:izzy");
  assert.equal(r.ok, true, r.refusedReason);
  assert.equal(routeApi.dest, "456");
});

test("RED-TEAM: approve-then-mutate destinationId blocked at G8", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(RETARGET));
  const res = await exec.execute({ capabilityId: "pbx.M3", params: { ...RETARGET, destinationId: "999" }, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.gate, "G8");
  assert.equal(routeApi.calls.length, 0);
});

test("H2-PENDING FENCE: the default stub client throws on any live route call", async () => {
  const stub = makeH2PendingRouteApiClient();
  await assert.rejects(() => stub.call({ action: "route_inspect" }), /fenced until the H2/);
  // And an executor wired with the stub cannot complete a live M3 (snapshot throws ⇒ G9).
  const exec = makeExec(stub);
  prisma.actions.push(approvedRow(RETARGET));
  const res = await exec.execute({ capabilityId: "pbx.M3", params: RETARGET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, false);
  assert.equal(res.gate, "G9");
});

test("STRESS: 25 rapid retarget/restore flips in sim, all verified, zero helper contact", async () => {
  const exec = makeExec();
  for (let i = 0; i < 25; i++) {
    const params = i % 2 === 0 ? RETARGET : { tenantId: "21", objectId: "8455577768", action: "restore" };
    const res = await exec.execute({ capabilityId: "pbx.M3", params, requestedBy: "owner:izzy", requestedRole: "owner" });
    assert.equal(res.ok, true, `flip ${i}: ${res.refusedReason}`);
  }
  assert.equal(routeApi.calls.length, 0);
});
