/**
 * M5 — IVR greeting/prompt recording change: op unit + executor chain (sim +
 * live), red-team, super-stress. NO network, NO real DB.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeM5Op, M5_SCHEMA } from "./m5IvrPrompt";
import { buildModifyCatalog, catalogOpsHonorModifyContract } from "../modifyCatalog";
import { ModifyPbxExecutor } from "../modifyExecutor";
import { makeScopeCheck } from "../scopeCheck";
import { SnapshotStore } from "../snapshotStore";
import { computeParamsHash } from "../../actions/bindings";
import { AuditLog, FileAuditSink } from "../../audit/audit";

class FakePrisma {
  profiles = new Map<string, any>([["pMain", { id: "pMain", tenantId: "ct1", pbxPromptRef: "custom/old-greeting", pbxInvalidPromptRef: null, pbxTimeoutPromptRef: null, pbxRetryPromptRef: null }]]);
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
    const field = ({ greeting: "pbxPromptRef", invalid: "pbxInvalidPromptRef", timeout: "pbxTimeoutPromptRef", retry: "pbxRetryPromptRef" } as any)[String(body.promptSlot)];
    const p = this.prisma.profiles.get(String(body.profileId));
    if (p) p[field] = body.promptRef ?? null;
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
  const dir = await mkdtemp(path.join(tmpdir(), "m5-"));
  audit = new AuditLog([new FileAuditSink(dir)]);
});

function makeExec() {
  return new ModifyPbxExecutor(
    prisma as any, audit, new SnapshotStore(prisma),
    () => ({ callEndpointRaw: async () => { throw new Error("PBX client must never be used by M5"); } }),
    { catalog: buildModifyCatalog({ prisma, mohApi: { call: async () => ({}) }, ivrApi }), scopeCheck: makeScopeCheck(prisma), killSwitch: () => false, env: ENV },
  );
}

const SET = { tenantId: "21", objectId: "pMain:greeting", profileId: "pMain", promptSlot: "greeting", promptRef: "custom/new-greeting" };
function approvedRow(params: any, id = "act1") {
  return { id, capabilityId: "pbx.M5", tenantId: "21", params, status: "EXECUTING", approvalConsumedAt: new Date(), paramsHash: computeParamsHash("pbx.M5", "21", params), resultSnapshot: null };
}

test("schema: objectId must be '<profileId>:<slot>'; slot enum enforced", () => {
  assert.equal(M5_SCHEMA.safeParse(SET).success, true);
  assert.equal(M5_SCHEMA.safeParse({ ...SET, objectId: "wrong" }).success, false);
  assert.equal(M5_SCHEMA.safeParse({ ...SET, promptSlot: "banner", objectId: "pMain:banner" }).success, false);
  assert.equal(M5_SCHEMA.safeParse({ tenantId: "21", objectId: "pMain:greeting", profileId: "pMain", promptSlot: "greeting", promptRef: null }).success, true); // clear
});

test("catalog: M5 present, contract holds", () => {
  const cat = buildModifyCatalog({ prisma, mohApi: { call: async () => ({}) }, ivrApi });
  assert.ok(cat["pbx.M5"]);
  assert.equal(catalogOpsHonorModifyContract(cat), true);
});

test("SIM full chain: passes, snapshot captures the prior ref, ivrApi never called", async () => {
  const res = await makeExec().execute({ capabilityId: "pbx.M5", params: SET, requestedBy: "customer:u1", requestedRole: "customer" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(res.verified, true);
  assert.equal(ivrApi.calls.length, 0);
  assert.equal((prisma.snaps[0].stateJson as any).promptRef, "custom/old-greeting");
});

test("G3: foreign profile refused", async () => {
  prisma.profiles.set("pForeign", { id: "pForeign", tenantId: "ct9", pbxPromptRef: null });
  const res = await makeExec().execute({ capabilityId: "pbx.M5", params: { ...SET, objectId: "pForeign:greeting", profileId: "pForeign" }, requestedBy: "customer:u1", requestedRole: "customer" });
  assert.equal(res.gate, "G3");
});

test("LIVE happy path: greeting set with attribution, verify passes", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M5", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(ivrApi.calls[0].action, "set_prompt");
  assert.equal(ivrApi.calls[0].promptSlot, "greeting");
  assert.equal(prisma.profiles.get("pMain").pbxPromptRef, "custom/new-greeting");
});

test("LIVE all 4 slots work", async () => {
  for (const slot of ["greeting", "invalid", "timeout", "retry"]) {
    const params = { tenantId: "21", objectId: `pMain:${slot}`, profileId: "pMain", promptSlot: slot, promptRef: `custom/${slot}-rec` };
    const exec = makeExec();
    prisma.actions.push(approvedRow(params, `act-${slot}`));
    const res = await exec.execute({ capabilityId: "pbx.M5", params, requestedBy: "owner:izzy", requestedRole: "owner", actionId: `act-${slot}`, mode: "live" });
    assert.equal(res.ok, true, `${slot}: ${res.refusedReason}`);
  }
});

test("LIVE revert restores the previous recording", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M5", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true);
  prisma.actions[0].resultSnapshot = { written: res.written };
  const r = await exec.revert("act1", "owner:izzy");
  assert.equal(r.ok, true, r.refusedReason);
  assert.equal(prisma.profiles.get("pMain").pbxPromptRef, "custom/old-greeting");
});

test("LIVE publish failure ⇒ verify fails ⇒ auto-revert", async () => {
  ivrApi = new SpyIvrApi(prisma, { publishSucceeds: false });
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M5", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, false);
  assert.equal(res.gate, "G11");
  assert.equal(res.autoReverted, true);
});

test("LIVE: api timeout ⇒ G10, zero retries", async () => {
  ivrApi.failWith = "timeout";
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M5", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.gate, "G10");
  assert.equal(ivrApi.calls.length, 1);
});

test("RED-TEAM: approve-then-mutate promptRef blocked at G8", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M5", params: { ...SET, promptRef: "custom/evil" }, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.gate, "G8");
  assert.equal(ivrApi.calls.length, 0);
});

test("SUPER-STRESS: 240 rapid prompt swaps across all 4 slots (sim) — all verified, zero api", async () => {
  const exec = makeExec();
  const slots = ["greeting", "invalid", "timeout", "retry"];
  let ok = 0;
  for (let i = 0; i < 240; i++) {
    const slot = slots[i % 4];
    const params = { tenantId: "21", objectId: `pMain:${slot}`, profileId: "pMain", promptSlot: slot, promptRef: i % 5 === 0 ? null : `custom/rec-${i}` };
    const res = await exec.execute({ capabilityId: "pbx.M5", params, requestedBy: "owner:izzy", requestedRole: "owner" });
    if (res.ok) ok++;
  }
  assert.equal(ok, 240);
  assert.equal(ivrApi.calls.length, 0);
  assert.equal(prisma.snaps.length, 240);
});
