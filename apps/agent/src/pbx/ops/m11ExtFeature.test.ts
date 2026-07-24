/**
 * M11 — extension DND/CF: op unit + executor chain (sim + live), red-team,
 * super-stress. NO real DB; the "PBX diversion store" is a fake extFeatureApi.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeM11Op, M11_SCHEMA } from "./m11ExtFeature";
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
  extension = { findFirst: async ({ where }: any) => (where.tenantId === "ct1" && ["103", "101"].includes(String(where.extNumber)) ? { id: `e${where.extNumber}` } : null) };
  mohProfile = { findFirst: async () => null };
  agentAction = { findUnique: async ({ where }: any) => this.actions.find((r) => r.id === where.id) ?? null };
  agentPbxSnapshot = {
    create: async ({ data }: any) => { const row = { id: `snap${++this.seq}`, restoredAt: null, ...data }; this.snaps.push(row); return row; },
    findUnique: async ({ where }: any) => this.snaps.find((r) => r.actionId === where.actionId) ?? null,
    update: async ({ where, data }: any) => Object.assign(this.snaps.find((r) => r.id === where.id), data),
  };
}

/** Fake diversion store keyed by `${ext}:${feature}` → {enable,destination}. */
class SpyExtApi {
  calls: any[] = [];
  failWith: string | null = null;
  store: Record<string, { enable: string; destination: string }> = {};
  async call(body: any): Promise<any> {
    this.calls.push(body);
    if (this.failWith) throw new Error(this.failWith);
    const key = `${body.extension}:${body.feature}`;
    if (body.action === "get") return { ok: true, state: this.store[key] ?? { enable: "no", destination: "" } };
    const before = this.store[key] ?? { enable: "no", destination: "" };
    this.store[key] = { enable: body.enable, destination: body.enable === "yes" ? (body.destination ?? "") : "" };
    return { ok: true, before, after: this.store[key] };
  }
}

let prisma: FakePrisma;
let extFeatureApi: SpyExtApi;
let audit: AuditLog;
const ENV = { AGENT_MODIFY_ENABLED: "1", AGENT_PBX_LIVE_TENANTS: "21", AGENT_PBX_PROTECTED_EXTS: "101", AGENT_PBX_LIVE_WRITES_PER_HOUR: "10", AGENT_MODIFY_REVERT_DAYS: "7" };

beforeEach(async () => {
  prisma = new FakePrisma();
  extFeatureApi = new SpyExtApi();
  const dir = await mkdtemp(path.join(tmpdir(), "m11-"));
  audit = new AuditLog([new FileAuditSink(dir)]);
});

function makeExec() {
  return new ModifyPbxExecutor(
    prisma as any, audit, new SnapshotStore(prisma),
    () => ({ callEndpointRaw: async () => { throw new Error("PBX client must never be used by M11"); } }),
    { catalog: buildModifyCatalog({ prisma, mohApi: { call: async () => ({}) }, extFeatureApi }), scopeCheck: makeScopeCheck(prisma), killSwitch: () => false, env: ENV },
  );
}

const DND_ON = { tenantId: "21", objectId: "103", feature: "DND", enable: "yes" };
const CFU_ON = { tenantId: "21", objectId: "103", feature: "CFU", enable: "yes", destination: "+18455550142" };
function approvedRow(params: any, id = "act1") {
  return { id, capabilityId: "pbx.M11", tenantId: "21", params, status: "EXECUTING", approvalConsumedAt: new Date(), paramsHash: computeParamsHash("pbx.M11", "21", params), resultSnapshot: null };
}

test("schema: DND needs no destination; enabling a forward requires a destination", () => {
  assert.equal(M11_SCHEMA.safeParse(DND_ON).success, true);
  assert.equal(M11_SCHEMA.safeParse(CFU_ON).success, true);
  assert.equal(M11_SCHEMA.safeParse({ tenantId: "21", objectId: "103", feature: "CFU", enable: "yes" }).success, false); // no dest
  assert.equal(M11_SCHEMA.safeParse({ tenantId: "21", objectId: "103", feature: "CFU", enable: "no" }).success, true); // clearing needs none
  assert.equal(M11_SCHEMA.safeParse({ ...CFU_ON, destination: "not-a-number" }).success, false);
  assert.equal(M11_SCHEMA.safeParse({ ...DND_ON, feature: "SPY" }).success, false);
});

test("catalog: M11 present, contract holds", () => {
  const cat = buildModifyCatalog({ prisma, mohApi: { call: async () => ({}) }, extFeatureApi });
  assert.ok(cat["pbx.M11"]);
  assert.equal(catalogOpsHonorModifyContract(cat), true);
});

test("SIM full chain: passes; extFeatureApi never called", async () => {
  const res = await makeExec().execute({ capabilityId: "pbx.M11", params: DND_ON, requestedBy: "customer:u1", requestedRole: "customer" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(res.verified, true);
  assert.equal(extFeatureApi.calls.length, 0);
});

test("G5: PROTECTED extension 101 refused", async () => {
  const res = await makeExec().execute({ capabilityId: "pbx.M11", params: { ...DND_ON, objectId: "101" }, requestedBy: "customer:u1", requestedRole: "customer" });
  assert.equal(res.gate, "G5");
});

test("G3: extension not in tenant refused", async () => {
  const res = await makeExec().execute({ capabilityId: "pbx.M11", params: { ...DND_ON, objectId: "999" }, requestedBy: "customer:u1", requestedRole: "customer" });
  assert.equal(res.gate, "G3");
});

test("LIVE DND on: set + verify; snapshot captured prior state", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(DND_ON));
  const res = await exec.execute({ capabilityId: "pbx.M11", params: DND_ON, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(extFeatureApi.store["103:DND"].enable, "yes");
  assert.equal((prisma.snaps[0].stateJson as any).before.enable, "no");
});

test("LIVE CFU on: forward destination set + verified", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(CFU_ON));
  const res = await exec.execute({ capabilityId: "pbx.M11", params: CFU_ON, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(extFeatureApi.store["103:CFU"].destination, "+18455550142");
});

test("LIVE revert restores prior state (was off)", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(DND_ON));
  const res = await exec.execute({ capabilityId: "pbx.M11", params: DND_ON, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true);
  prisma.actions[0].resultSnapshot = { written: res.written };
  const r = await exec.revert("act1", "owner:izzy");
  assert.equal(r.ok, true, r.refusedReason);
  assert.equal(extFeatureApi.store["103:DND"].enable, "no");
});

test("LIVE: helper timeout ⇒ refused (G9 snapshot or G10), zero blind retry", async () => {
  extFeatureApi.failWith = "timeout";
  const exec = makeExec();
  prisma.actions.push(approvedRow(DND_ON));
  const res = await exec.execute({ capabilityId: "pbx.M11", params: DND_ON, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, false);
  assert.ok(["G9", "G10"].includes(res.gate!));
});

test("RED-TEAM: approve-then-mutate destination blocked at G8", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(CFU_ON));
  const res = await exec.execute({ capabilityId: "pbx.M11", params: { ...CFU_ON, destination: "+19995550000" }, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.gate, "G8");
  assert.equal(extFeatureApi.calls.length, 0);
});

test("SUPER-STRESS: 200 rapid DND/CF toggles (sim) — all verified, zero api", async () => {
  const exec = makeExec();
  const feats = ["DND", "CFU", "CFB", "CFN"];
  let ok = 0;
  for (let i = 0; i < 200; i++) {
    const feature = feats[i % 4];
    const on = i % 2 === 0;
    const params: any = { tenantId: "21", objectId: "103", feature, enable: on ? "yes" : "no" };
    if (on && feature !== "DND") params.destination = "101";
    const res = await exec.execute({ capabilityId: "pbx.M11", params, requestedBy: "owner:izzy", requestedRole: "owner" });
    if (res.ok) ok++;
  }
  assert.equal(ok, 200);
  assert.equal(extFeatureApi.calls.length, 0);
  assert.equal(prisma.snaps.length, 200);
});
