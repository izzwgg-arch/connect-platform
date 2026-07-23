import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { ModifyPbxExecutor, type ScopeCheck } from "./modifyExecutor";
import { MODIFY_CATALOG, catalogOpsHonorModifyContract, type ModifyOp, type ModifyClientLike } from "./modifyCatalog";
import { SnapshotStore, snapshotChecksum } from "./snapshotStore";
import { computeParamsHash } from "../actions/bindings";
import { AuditLog, FileAuditSink } from "../audit/audit";

/** In-memory prisma stand-in for agentAction + agentPbxSnapshot. */
class FakePrisma {
  actions: any[] = [];
  snaps: any[] = [];
  private seq = 0;
  agentAction = {
    findUnique: async ({ where }: any) => this.actions.find((r) => r.id === where.id) ?? null,
  };
  agentPbxSnapshot = {
    create: async ({ data }: any) => {
      const row = { id: `snap${++this.seq}`, capturedAt: new Date(), restoredAt: null, ...data };
      this.snaps.push(row);
      return row;
    },
    findUnique: async ({ where }: any) => this.snaps.find((r) => r.actionId === where.actionId) ?? null,
    update: async ({ where, data }: any) => {
      const row = this.snaps.find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    },
  };
}

/**
 * Test fixture "object store" — a fake single MOH-like object the fixture op
 * reads/writes, so snapshot/dispatch/verify/revert have real semantics.
 */
class FixtureWorld {
  state: Record<string, any> = { moh1: { classId: "default" } };
  snapshotFails = false;
  dispatchFails = false;
  verifyLies = false; // simulates a write that silently didn't take
}

function fixtureOp(world: FixtureWorld): ModifyOp {
  return {
    id: "M0",
    capabilityId: "pbx.M0",
    kind: "moh_tenant",
    title: "TEST fixture op",
    schema: z.object({ tenantId: z.string().min(1), objectId: z.string().min(1), classId: z.string().min(1), extension: z.string().optional() }),
    feasibility: "astdb",
    risk: "low",
    async snapshot(_c: ModifyClientLike, p) {
      if (world.snapshotFails) throw new Error("astdb read failed");
      const cur = world.state[p.objectId];
      return cur ? { state: { ...cur } } : null;
    },
    async dispatch(_c, p) {
      if (world.dispatchFails) throw new Error("astdb write failed");
      world.state[p.objectId] = { classId: p.classId };
      return { written: { classId: p.classId } };
    },
    async verify(_c, p, written: any) {
      if (world.verifyLies) return { ok: false, detail: "post-write state differs", observed: world.state[p.objectId] };
      const want = written?.written?.classId ?? (written as any)?.classId;
      const ok = world.state[p.objectId]?.classId === want;
      return ok ? { ok } : { ok, detail: "class mismatch", observed: world.state[p.objectId] };
    },
    async revert(_c, p, snapState: any) {
      world.state[p.objectId] = { ...snapState };
      return { restored: snapState };
    },
  };
}

let prisma: FakePrisma;
let audit: AuditLog;
let world: FixtureWorld;

const ENV_OK = {
  AGENT_MODIFY_ENABLED: "1",
  AGENT_PBX_LIVE_TENANTS: "21",
  AGENT_PBX_PROTECTED_EXTS: "101",
  AGENT_PBX_LIVE_WRITES_PER_HOUR: "10",
  AGENT_MODIFY_REVERT_DAYS: "7",
};

const scopeYes: ScopeCheck = async () => true;

beforeEach(async () => {
  prisma = new FakePrisma();
  const dir = await mkdtemp(path.join(tmpdir(), "modify-exec-"));
  audit = new AuditLog([new FileAuditSink(dir)]);
  world = new FixtureWorld();
});

function makeExec(opts: { catalog?: Record<string, ModifyOp>; scope?: ScopeCheck; kill?: boolean; env?: Record<string, string | undefined>; now?: () => number } = {}) {
  return new ModifyPbxExecutor(
    prisma as any,
    audit,
    new SnapshotStore(prisma),
    () => ({ callEndpointRaw: async () => ({ simulated: true }) }),
    {
      catalog: opts.catalog ?? { "pbx.M0": fixtureOp(world) },
      scopeCheck: opts.scope,
      killSwitch: () => opts.kill ?? false,
      env: opts.env ?? ENV_OK,
      now: opts.now,
    },
  );
}

const GOOD = { tenantId: "21", objectId: "moh1", classId: "jazz" };

function input(over: Partial<any> = {}) {
  return { capabilityId: "pbx.M0", params: GOOD, requestedBy: "owner:izzy", requestedRole: "owner" as const, ...over };
}

// ---------- shipping-state guards ----------

test("SHIPPING STATE: the real MODIFY_CATALOG is EMPTY in X1", () => {
  assert.equal(Object.keys(MODIFY_CATALOG).length, 0);
  assert.equal(catalogOpsHonorModifyContract(), true);
});

test("SHIPPING STATE: with the real (empty) catalog everything refuses at G1", async () => {
  const exec = new ModifyPbxExecutor(prisma as any, audit, new SnapshotStore(prisma), () => ({ callEndpointRaw: async () => ({}) }), { env: ENV_OK, killSwitch: () => false });
  const res = await exec.execute(input());
  assert.equal(res.ok, false);
  assert.equal(res.gate, "G1");
});

test("static guard rejects a catalog op that accepts empty params", () => {
  const bad = { ...fixtureOp(world), schema: z.object({}).passthrough() } as ModifyOp;
  assert.equal(catalogOpsHonorModifyContract({ "pbx.MX": { ...bad, id: "M9" } }), false);
});

// ---------- gate refusals ----------

test("G0: kill switch halts everything", async () => {
  const res = await makeExec({ kill: true, scope: scopeYes }).execute(input());
  assert.equal(res.gate, "G0");
});

test("G0b: master switch off (default) refuses even simulate", async () => {
  const res = await makeExec({ scope: scopeYes, env: { ...ENV_OK, AGENT_MODIFY_ENABLED: undefined } }).execute(input());
  assert.equal(res.gate, "G0b");
});

test("G2: schema violations refuse", async () => {
  const res = await makeExec({ scope: scopeYes }).execute(input({ params: { tenantId: "21" } }));
  assert.equal(res.gate, "G2");
});

test("G3: DEFAULT scope resolver is fail-closed — refuses even valid requests", async () => {
  const res = await makeExec({}).execute(input()); // no scopeCheck wired
  assert.equal(res.gate, "G3");
});

test("G3: scope resolver saying 'not yours' refuses", async () => {
  const res = await makeExec({ scope: async () => false }).execute(input());
  assert.equal(res.gate, "G3");
});

test("G5: protected extension refused", async () => {
  const res = await makeExec({ scope: scopeYes }).execute(input({ params: { ...GOOD, extension: "101" } }));
  assert.equal(res.gate, "G5");
});

test("G6: live write to non-allow-listed tenant refused (fail-closed when unset)", async () => {
  prisma.actions.push(approvedRow());
  const r1 = await makeExec({ scope: scopeYes }).execute(input({ mode: "live", actionId: "act1", params: { ...GOOD, tenantId: "8", objectId: "moh1" } }));
  assert.equal(r1.gate, "G6");
  const r2 = await makeExec({ scope: scopeYes, env: { ...ENV_OK, AGENT_PBX_LIVE_TENANTS: undefined } }).execute(input({ mode: "live", actionId: "act1" }));
  assert.equal(r2.gate, "G6");
});

function approvedRow(over: Partial<any> = {}) {
  return {
    id: "act1",
    capabilityId: "pbx.M0",
    tenantId: "21",
    params: GOOD,
    status: "EXECUTING",
    approvalConsumedAt: new Date(),
    paramsHash: computeParamsHash("pbx.M0", "21", GOOD),
    resultSnapshot: null,
    ...over,
  };
}

test("G8: live without an action row refused", async () => {
  const res = await makeExec({ scope: scopeYes }).execute(input({ mode: "live" }));
  assert.equal(res.gate, "G8");
});

test("G8: unconsumed approval refused (single-use contract)", async () => {
  prisma.actions.push(approvedRow({ status: "APPROVED", approvalConsumedAt: null }));
  const res = await makeExec({ scope: scopeYes }).execute(input({ mode: "live", actionId: "act1" }));
  assert.equal(res.gate, "G8");
});

test("G8: APPROVE-THEN-MUTATE BLOCKED — params differing from the approved hash refused", async () => {
  prisma.actions.push(approvedRow());
  const res = await makeExec({ scope: scopeYes }).execute(
    input({ mode: "live", actionId: "act1", params: { ...GOOD, classId: "attack-different-class" } }),
  );
  assert.equal(res.gate, "G8");
  assert.match(res.refusedReason!, /not the exact change/);
  assert.equal(world.state.moh1.classId, "default"); // nothing written
});

test("G9: snapshot failure means NOTHING is written", async () => {
  world.snapshotFails = true;
  const res = await makeExec({ scope: scopeYes }).execute(input());
  assert.equal(res.gate, "G9");
  assert.equal(world.state.moh1.classId, "default");
  assert.equal(prisma.snaps.length, 0);
});

test("G9: missing object (snapshot null) refused", async () => {
  const res = await makeExec({ scope: scopeYes }).execute(input({ params: { ...GOOD, objectId: "ghost" } }));
  assert.equal(res.gate, "G9");
});

// ---------- happy path + verify/auto-revert ----------

test("happy path (simulate): snapshot stored w/ checksum, write lands, verified", async () => {
  const res = await makeExec({ scope: scopeYes }).execute(input());
  assert.equal(res.ok, true);
  assert.equal(res.verified, true);
  assert.equal(world.state.moh1.classId, "jazz");
  assert.equal(prisma.snaps.length, 1);
  assert.equal(prisma.snaps[0].simulated, true);
  assert.equal(prisma.snaps[0].checksum, snapshotChecksum({ classId: "default" }));
});

test("G11: verify mismatch triggers AUTOMATIC revert from snapshot", async () => {
  world.verifyLies = true;
  const res = await makeExec({ scope: scopeYes }).execute(input());
  assert.equal(res.ok, false);
  assert.equal(res.gate, "G11");
  assert.equal(res.autoReverted, true);
  assert.equal(world.state.moh1.classId, "default"); // restored
});

test("G10: dispatch failure records outcome, never retries blind", async () => {
  world.dispatchFails = true;
  const res = await makeExec({ scope: scopeYes }).execute(input());
  assert.equal(res.gate, "G10");
  assert.match(res.refusedReason!, /No retry/);
});

// ---------- live budget ----------

test("G4: global live-write budget exhausts and refuses", async () => {
  prisma.actions.push(approvedRow());
  let t = 1_000_000;
  const exec = makeExec({ scope: scopeYes, env: { ...ENV_OK, AGENT_PBX_LIVE_WRITES_PER_HOUR: "1" }, now: () => t });
  const first = await exec.execute(input({ mode: "live", actionId: "act1" }));
  assert.equal(first.ok, true);
  const second = await exec.execute(input({ mode: "live", actionId: "act1" }));
  assert.equal(second.gate, "G4");
  t += 3600_001; // window rolls
  const third = await exec.execute(input({ mode: "live", actionId: "act1" }));
  assert.equal(third.ok, true);
});

// ---------- revert ----------

async function executedAction(exec = makeExec({ scope: scopeYes })) {
  prisma.actions.push(approvedRow());
  const res = await exec.execute(input({ actionId: "act1" }));
  assert.equal(res.ok, true);
  prisma.actions[0].resultSnapshot = { written: res.written };
  return exec;
}

test("revert: one-click restore from snapshot", async () => {
  const exec = await executedAction();
  assert.equal(world.state.moh1.classId, "jazz");
  const r = await exec.revert("act1", "owner:izzy");
  assert.equal(r.ok, true);
  assert.equal(world.state.moh1.classId, "default");
  assert.ok(prisma.snaps[0].restoredAt);
});

test("revert: THREE-WAY DIFF — refuses if someone changed the object since our write", async () => {
  const exec = await executedAction();
  world.state.moh1 = { classId: "gui-edited-by-human" };
  const r = await exec.revert("act1", "owner:izzy");
  assert.equal(r.ok, false);
  assert.match(r.refusedReason!, /changed by someone else/);
  assert.equal(world.state.moh1.classId, "gui-edited-by-human"); // untouched
});

test("revert: corrupted snapshot is detected and refused", async () => {
  const exec = await executedAction();
  prisma.snaps[0].stateJson = { classId: "tampered" }; // checksum now stale
  const r = await exec.revert("act1", "owner:izzy");
  assert.equal(r.ok, false);
  assert.match(r.refusedReason!, /integrity/);
});

test("revert: window expiry refuses one-click restore", async () => {
  const exec = await executedAction();
  prisma.snaps[0].expiresAt = new Date(Date.now() - 1000);
  const r = await exec.revert("act1", "owner:izzy");
  assert.equal(r.ok, false);
  assert.match(r.refusedReason!, /window expired/);
});
