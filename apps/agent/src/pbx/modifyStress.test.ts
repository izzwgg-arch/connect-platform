/**
 * X1 STRESS suite (spec §5): concurrency, races, and cap behavior under load.
 * Uses the same in-memory fakes as the unit suites — the invariants under test
 * (single-winner CAS, cap enforcement, snapshot integrity under parallel
 * captures) are pure logic, independent of a real DB's latency.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ActionService, type ExecuteBackend } from "../actions/service";
import { SnapshotStore, snapshotChecksum } from "./snapshotStore";
import { AuditLog, FileAuditSink } from "../audit/audit";

process.env.AGENT_APPROVAL_SECRET = "test-approval-secret";

class FakeActions {
  rows: any[] = [];
  snaps: any[] = [];
  private seq = 0;
  agentAction = {
    create: async ({ data }: any) => {
      const row = { id: `act${++this.seq}`, createdAt: new Date(), revertedAt: null, executedAt: null, approvalConsumedAt: null, paramsHash: null, ...data };
      this.rows.push(row);
      return row;
    },
    findUnique: async ({ where }: any) => this.rows.find((r) => r.id === where.id) ?? null,
    findMany: async () => [],
    count: async ({ where }: any) =>
      this.rows.filter((r) => r.tenantId === where.tenantId && r.status === where.status && r.paramsHash !== null).length,
    update: async ({ where, data }: any) => {
      const row = this.rows.find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      // Mimic a DB's atomic conditional update: check+set in one synchronous step.
      const rows = this.rows.filter(
        (r) => r.id === where.id && (where.status === undefined || r.status === where.status) && (where.approvalConsumedAt === undefined || r.approvalConsumedAt === where.approvalConsumedAt),
      );
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
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

const notifierStub: any = { sent: [] as any[], ownerRecipients: () => ["izzy@test"], async send(m: any) { this.sent.push(m); return { sent: true }; } };

let prisma: FakeActions;
let audit: AuditLog;

beforeEach(async () => {
  prisma = new FakeActions();
  const dir = await mkdtemp(path.join(tmpdir(), "modstress-"));
  audit = new AuditLog([new FileAuditSink(dir)]);
  (notifierStub as any).sent = [];
});

test("STRESS: 200 concurrent modify creations — pending cap holds, rest denied, no throws", async () => {
  const backend: ExecuteBackend = { async execute() { return { ok: true }; } };
  const s = new ActionService(prisma as any, audit, notifierStub, { "pbx.M": backend }, {});
  const results = await Promise.all(
    Array.from({ length: 200 }, (_, i) =>
      s.create({ tenantId: "21", capabilityId: "pbx.M1", params: { tenantId: "21", objectId: "o1", classId: `c${i}` }, summary: `m${i}`, requestedBy: "u", requestedRole: "customer" }),
    ),
  );
  const pending = results.filter((r) => r.status === "PENDING_APPROVAL").length;
  const denied = results.filter((r) => r.status === "DENIED").length;
  assert.equal(pending + denied, 200);
  // Hard invariant (post-create self-demotion): pending can NEVER settle above
  // the cap, no matter how the 200 creations interleave.
  assert.ok(pending <= 3, `pending=${pending} must never exceed the cap of 3`);
  assert.ok(denied >= 197);
});

test("STRESS: double-execute race on ONE approval — exactly one winner (CAS)", async () => {
  let executions = 0;
  const backend: ExecuteBackend = {
    async execute() {
      executions++;
      await new Promise((r) => setTimeout(r, 5)); // hold the "work" open
      return { ok: true };
    },
  };
  const s = new ActionService(prisma as any, audit, notifierStub, { "pbx.M": backend }, {});
  const a = await s.create({ tenantId: "21", capabilityId: "pbx.M1", params: { tenantId: "21", objectId: "o1", classId: "x" }, summary: "m", requestedBy: "u", requestedRole: "customer" });
  // Force the row APPROVED, then two workers race executeApproved via approve():
  // approve() itself is idempotent on status; simulate the worst case by calling
  // the private path through two parallel approves from PENDING_APPROVAL.
  const [r1, r2] = await Promise.all([s.approve(a.id, "owner:izzy"), s.approve(a.id, "owner:izzy")]);
  assert.equal(executions, 1, "one approval must never execute twice");
  assert.ok([r1.status, r2.status].includes("EXECUTED"));
});

test("STRESS: 50 concurrent snapshot captures — every checksum verifies", async () => {
  const store = new SnapshotStore(prisma);
  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      store.capture({
        actionId: `a${i}`,
        capabilityId: "pbx.M1",
        tenantId: "21",
        objectType: "moh_tenant",
        objectId: `obj${i}`,
        state: { classId: `c${i}`, nested: { arr: [i, i + 1], flag: i % 2 === 0 } },
        source: "astdb",
        simulated: true,
      }),
    ),
  );
  assert.equal(prisma.snaps.length, 50);
  for (const row of prisma.snaps) {
    assert.equal(snapshotChecksum(row.stateJson), row.checksum, `snapshot ${row.id} checksum must verify`);
  }
});

test("STRESS: DB latency injection — slow prisma never corrupts the state machine", async () => {
  const slow = new Proxy(prisma.agentAction, {
    get(target: any, prop: string) {
      const fn = target[prop];
      if (typeof fn !== "function") return fn;
      return async (...args: any[]) => {
        await new Promise((r) => setTimeout(r, 20));
        return fn(...args);
      };
    },
  });
  const slowPrisma: any = { agentAction: slow, agentPbxSnapshot: prisma.agentPbxSnapshot };
  const backend: ExecuteBackend = { async execute() { return { ok: true }; } };
  const s = new ActionService(slowPrisma, audit, notifierStub, { "pbx.M": backend }, {});
  const a = await s.create({ tenantId: "21", capabilityId: "pbx.M1", params: { tenantId: "21", objectId: "o1", classId: "x" }, summary: "m", requestedBy: "u", requestedRole: "customer" });
  const done = await s.approve(a.id, "owner:izzy");
  assert.equal(done.status, "EXECUTED");
  assert.ok(prisma.rows[0].approvalConsumedAt);
});
