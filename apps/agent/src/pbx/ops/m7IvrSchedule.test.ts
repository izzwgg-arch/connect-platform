/**
 * M7 — IVR schedule edit: op unit + executor chain (sim + live), red-team,
 * super-stress. NO network, NO real DB.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeM7Op, M7_SCHEMA } from "./m7IvrSchedule";
import { buildModifyCatalog, catalogOpsHonorModifyContract } from "../modifyCatalog";
import { ModifyPbxExecutor } from "../modifyExecutor";
import { makeScopeCheck } from "../scopeCheck";
import { SnapshotStore } from "../snapshotStore";
import { computeParamsHash } from "../../actions/bindings";
import { AuditLog, FileAuditSink } from "../../audit/audit";

class FakePrisma {
  schedules = new Map<string, any>([["ct1", { tenantId: "ct1", timezone: "America/New_York", businessHoursRules: [{ day: 1, open: "09:00", close: "17:00" }], holidayDates: [], defaultProfileId: "pMain", afterHoursProfileId: null, holidayProfileId: null, isActive: true }]]);
  actions: any[] = [];
  snaps: any[] = [];
  private seq = 0;
  tenantPbxLink = {
    findFirst: async ({ where }: any) => ({ "21": { tenantId: "ct1" }, "8": { tenantId: "ct9" } })[String(where.pbxTenantId)] ?? null,
    findUnique: async ({ where }: any) => ({ ct1: { pbxTenantId: "21" }, ct9: { pbxTenantId: "8" } })[where.tenantId as string] ?? null,
  };
  user = { findUnique: async ({ where }: any) => ({ u1: { tenantId: "ct1", status: "ACTIVE" } })[where.id as string] ?? null };
  ivrScheduleConfig = { findUnique: async ({ where }: any) => this.schedules.get(where.tenantId) ?? null };
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
  async call(body: any): Promise<any> {
    this.calls.push(body);
    if (this.failWith) throw new Error(this.failWith);
    const ct = String(body.tenantId) === "21" ? "ct1" : "ct9";
    this.prisma.schedules.set(ct, { tenantId: ct, ...body.schedule });
    return { ok: true, schedule: this.prisma.schedules.get(ct), publishResult: this.world.publishSucceeds ? { recordId: "pub", mode: "business", keysWritten: 5 } : null, publishError: this.world.publishSucceeds ? null : "publish blew up" };
  }
}

let prisma: FakePrisma;
let ivrApi: SpyIvrApi;
let audit: AuditLog;
const ENV = { AGENT_MODIFY_ENABLED: "1", AGENT_PBX_LIVE_TENANTS: "21", AGENT_PBX_PROTECTED_EXTS: "101", AGENT_PBX_LIVE_WRITES_PER_HOUR: "10", AGENT_MODIFY_REVERT_DAYS: "7" };

beforeEach(async () => {
  prisma = new FakePrisma();
  ivrApi = new SpyIvrApi(prisma, { publishSucceeds: true });
  const dir = await mkdtemp(path.join(tmpdir(), "m7-"));
  audit = new AuditLog([new FileAuditSink(dir)]);
});

function makeExec() {
  return new ModifyPbxExecutor(
    prisma as any, audit, new SnapshotStore(prisma),
    () => ({ callEndpointRaw: async () => { throw new Error("PBX client must never be used by M7"); } }),
    { catalog: buildModifyCatalog({ prisma, mohApi: { call: async () => ({}) }, ivrApi }), scopeCheck: makeScopeCheck(prisma), killSwitch: () => false, env: ENV },
  );
}

const NEW_SCHED = { timezone: "America/New_York", businessHoursRules: [{ day: 1, open: "08:00", close: "18:00" }, { day: 2, open: "08:00", close: "18:00" }], holidayDates: ["2026-12-25"], defaultProfileId: "pMain", afterHoursProfileId: null, holidayProfileId: null, isActive: true };
const SET = { tenantId: "21", objectId: "21", schedule: NEW_SCHED };
function approvedRow(params: any, id = "act1") {
  return { id, capabilityId: "pbx.M7", tenantId: "21", params, status: "EXECUTING", approvalConsumedAt: new Date(), paramsHash: computeParamsHash("pbx.M7", "21", params), resultSnapshot: null };
}

test("schema: objectId must equal tenantId; bad weekday/time refused", () => {
  assert.equal(M7_SCHEMA.safeParse(SET).success, true);
  assert.equal(M7_SCHEMA.safeParse({ ...SET, objectId: "8" }).success, false);
  assert.equal(M7_SCHEMA.safeParse({ ...SET, schedule: { ...NEW_SCHED, businessHoursRules: [{ day: 9, open: "08:00", close: "18:00" }] } }).success, false);
  assert.equal(M7_SCHEMA.safeParse({ ...SET, schedule: { ...NEW_SCHED, businessHoursRules: [{ day: 1, open: "8am", close: "18:00" }] } }).success, false);
  assert.equal(M7_SCHEMA.safeParse({ ...SET, schedule: { ...NEW_SCHED, holidayDates: ["Dec 25"] } }).success, false);
});

test("catalog: M7 present, contract holds", () => {
  const cat = buildModifyCatalog({ prisma, mohApi: { call: async () => ({}) }, ivrApi });
  assert.ok(cat["pbx.M7"]);
  assert.equal(catalogOpsHonorModifyContract(cat), true);
});

test("SIM full chain: passes, snapshot captures prior schedule, ivrApi never called", async () => {
  const res = await makeExec().execute({ capabilityId: "pbx.M7", params: SET, requestedBy: "customer:u1", requestedRole: "customer" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(res.verified, true);
  assert.equal(ivrApi.calls.length, 0);
  assert.equal(((prisma.snaps[0].stateJson as any).schedule.businessHoursRules[0].close), "17:00");
});

test("G3: foreign tenant refused", async () => {
  const res = await makeExec().execute({ capabilityId: "pbx.M7", params: { tenantId: "8", objectId: "8", schedule: NEW_SCHED }, requestedBy: "customer:u1", requestedRole: "customer" });
  assert.equal(res.gate, "G3");
});

test("LIVE happy path: schedule set + verify passes", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M7", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true, res.refusedReason);
  assert.equal(ivrApi.calls[0].action, "set_schedule");
  assert.equal(prisma.schedules.get("ct1").businessHoursRules[0].close, "18:00");
});

test("LIVE revert restores the prior schedule", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M7", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, true);
  prisma.actions[0].resultSnapshot = { written: res.written };
  const r = await exec.revert("act1", "owner:izzy");
  assert.equal(r.ok, true, r.refusedReason);
  assert.equal(prisma.schedules.get("ct1").businessHoursRules[0].close, "17:00");
});

test("LIVE publish failure ⇒ verify fails ⇒ auto-revert", async () => {
  ivrApi = new SpyIvrApi(prisma, { publishSucceeds: false });
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M7", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.ok, false);
  assert.equal(res.gate, "G11");
  assert.equal(res.autoReverted, true);
});

test("LIVE: api timeout ⇒ G10, zero retries", async () => {
  ivrApi.failWith = "timeout";
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const res = await exec.execute({ capabilityId: "pbx.M7", params: SET, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.gate, "G10");
  assert.equal(ivrApi.calls.length, 1);
});

test("RED-TEAM: approve-then-mutate schedule blocked at G8", async () => {
  const exec = makeExec();
  prisma.actions.push(approvedRow(SET));
  const mutated = { ...SET, schedule: { ...NEW_SCHED, businessHoursRules: [{ day: 1, open: "00:00", close: "23:59" }] } };
  const res = await exec.execute({ capabilityId: "pbx.M7", params: mutated, requestedBy: "owner:izzy", requestedRole: "owner", actionId: "act1", mode: "live" });
  assert.equal(res.gate, "G8");
  assert.equal(ivrApi.calls.length, 0);
});

test("SUPER-STRESS: 200 rapid schedule edits (sim) — all verified, zero api", async () => {
  const exec = makeExec();
  let ok = 0;
  for (let i = 0; i < 200; i++) {
    const schedule = { ...NEW_SCHED, businessHoursRules: [{ day: (i % 6) + 1, open: "08:00", close: `1${i % 8}:00` }] };
    const res = await exec.execute({ capabilityId: "pbx.M7", params: { tenantId: "21", objectId: "21", schedule }, requestedBy: "owner:izzy", requestedRole: "owner" });
    if (res.ok) ok++;
  }
  assert.equal(ok, 200);
  assert.equal(ivrApi.calls.length, 0);
  assert.equal(prisma.snaps.length, 200);
});
