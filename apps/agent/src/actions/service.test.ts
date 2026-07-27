import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ActionService, type ExecuteBackend } from "./service";
import { makeApprovalToken, verifyApprovalToken } from "./tokens";
import { AuditLog, FileAuditSink } from "../audit/audit";
import type { Notifier } from "../notify/notifier";

class FakeActions {
  rows: any[] = [];
  private seq = 0;
  agentAction = {
    create: async ({ data }: any) => {
      const row = { id: `act${++this.seq}`, createdAt: new Date(), revertedAt: null, executedAt: null, ...data };
      this.rows.push(row);
      return row;
    },
    findUnique: async ({ where }: any) => this.rows.find((r) => r.id === where.id) ?? null,
    findMany: async ({ where }: any) =>
      this.rows.filter((r) => {
        if (where.status && r.status !== where.status) return false;
        if (where.tenantId && r.tenantId !== where.tenantId) return false;
        if (where.capabilityId && r.capabilityId !== where.capabilityId) return false;
        if (where.id?.not && r.id === where.id.not) return false;
        if (where.createdAt?.lt && !(r.createdAt < where.createdAt.lt)) return false;
        if (where.revertAt) {
          if (where.revertAt.not === null && r.revertAt === null) return false;
          if (where.revertAt.lte && !(r.revertAt && r.revertAt <= where.revertAt.lte)) return false;
        }
        return true;
      }),
    update: async ({ where, data }: any) => {
      const row = this.rows.find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      const rows = this.rows.filter(
        (r) =>
          (!where.id || r.id === where.id) &&
          (!where.status || r.status === where.status) &&
          (!("approvalConsumedAt" in where) || (r.approvalConsumedAt ?? null) === where.approvalConsumedAt),
      );
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
    count: async ({ where }: any) =>
      this.rows.filter(
        (r) =>
          (!where.tenantId || r.tenantId === where.tenantId) &&
          (!where.status || r.status === where.status) &&
          (!where.paramsHash?.not === undefined || true) &&
          (!where.paramsHash || (where.paramsHash.not === null ? r.paramsHash !== null : true)),
      ).length,
  };
}

const notifierStub: any = { sent: [] as any[], ownerRecipients: () => ["izzy@test"], async send(m: any) { this.sent.push(m); return { sent: true }; } };

let prisma: FakeActions;
let audit: AuditLog;
let backend: ExecuteBackend & { calls: any[]; reverts: any[] };

beforeEach(async () => {
  prisma = new FakeActions();
  const dir = await mkdtemp(path.join(tmpdir(), "act-"));
  audit = new AuditLog([new FileAuditSink(dir)]);
  (notifierStub as any).sent = [];
  backend = {
    calls: [],
    reverts: [],
    async execute(a: any, opts: any) { this.calls.push({ a, opts }); return { ok: true, snapshot: { did: "it" } }; },
    async revert(a: any) { this.reverts.push(a); return { ok: true }; },
  };
});

function svc(liveWrites = false) {
  return new ActionService(prisma as any, audit, notifierStub, { "pbx.": backend }, { liveWrites, approvalBaseUrl: "https://app.test" });
}

test("approval token round-trips and rejects tampering/expiry", () => {
  process.env.AGENT_APPROVAL_SECRET = "test-approval-secret";
  const tok = makeApprovalToken("act1", "approve");
  assert.deepEqual(verifyApprovalToken(tok), { actionId: "act1", decision: "approve" });
  assert.equal(verifyApprovalToken(tok + "x"), null);
  assert.equal(verifyApprovalToken(makeApprovalToken("act1", "approve", -1000)), null);
});

test("customer action goes to PENDING_APPROVAL and emails approver", async () => {
  const a = await svc().create({ tenantId: "t1", capabilityId: "pbx.P4", params: { tenantId: "t1", extension: "101", name: "R" }, summary: "Create ext 101", requestedBy: "u1", requestedRole: "customer" });
  assert.equal(a.status, "PENDING_APPROVAL");
  assert.ok((notifierStub as any).sent.some((m: any) => m.kind === "approval_request"));
});

test("owner auto-approve executes but still audits + emails confirmation", async () => {
  const a = await svc().create({ tenantId: "t1", capabilityId: "pbx.P1", params: { name: "New" }, summary: "Create tenant", requestedBy: "izzy", requestedRole: "owner", autoApprove: true });
  assert.equal(a.status, "EXECUTED");
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].opts.live, false); // sim by default
  assert.ok((notifierStub as any).sent.some((m: any) => m.kind === "action_executed"));
});

test("approve → execute; deny → DENIED (no execute)", async () => {
  const a = await svc().create({ tenantId: "t1", capabilityId: "pbx.P7", params: { tenantId: "t1", name: "IVR" }, summary: "Create IVR", requestedBy: "u1", requestedRole: "customer" });
  const denied = await svc().deny(a.id, "izzy", "not now");
  assert.equal(denied.status, "DENIED");
  assert.equal(backend.calls.length, 0);
});

test("liveWrites flag propagates to backend", async () => {
  await svc(true).create({ tenantId: "t1", capabilityId: "pbx.P1", params: { name: "N" }, summary: "s", requestedBy: "izzy", requestedRole: "owner", autoApprove: true });
  assert.equal(backend.calls[0].opts.live, true);
});

test("failed execution → FAILED + failure email, never EXECUTED", async () => {
  backend.execute = async () => ({ ok: false, error: "pbx boom" });
  const a = await svc().create({ tenantId: "t1", capabilityId: "pbx.P1", params: { name: "N" }, summary: "s", requestedBy: "izzy", requestedRole: "owner", autoApprove: true });
  assert.equal(a.status, "FAILED");
  assert.ok((notifierStub as any).sent.some((m: any) => m.kind === "action_failed"));
});

test("tick expires stale pending and auto-reverts due executed actions", async () => {
  // stale pending
  const stale = await svc().create({ tenantId: "t1", capabilityId: "pbx.P7", params: { tenantId: "t1", name: "x" }, summary: "s", requestedBy: "u", requestedRole: "customer" });
  stale.createdAt = new Date(Date.now() - 5 * 3600 * 1000);
  // executed with revertAt in the past
  const temp = await svc().create({ tenantId: "t1", capabilityId: "pbx.P1", params: { name: "N" }, summary: "temp", requestedBy: "izzy", requestedRole: "owner", autoApprove: true, revertAfterHours: 1 });
  temp.revertAt = new Date(Date.now() - 1000);
  const res = await svc().tick(new Date());
  assert.equal(res.expired, 1);
  assert.equal(res.reverted, 1);
  assert.equal(backend.reverts.length, 1);
});

test("a newer executed action on the SAME object cancels the older action's pending revert timer", async () => {
  // Live incident 2026-07-27: ext 101 "Main until 7:30" revert fired 51s
  // AFTER a newer "Main for 45 minutes" wrote the same override and wiped it.
  const first = await svc().create({ tenantId: "21", capabilityId: "pbx.M2", params: { tenantId: "21", objectId: "101", action: "set" }, summary: "old", requestedBy: "izzy", requestedRole: "owner", autoApprove: true, revertAfterMinutes: 20 });
  assert.equal(first.status, "EXECUTED");
  assert.ok(first.revertAt, "older action must start with a timer");
  const second = await svc().create({ tenantId: "21", capabilityId: "pbx.M2", params: { tenantId: "21", objectId: "101", action: "set" }, summary: "new", requestedBy: "izzy", requestedRole: "owner", autoApprove: true, revertAfterMinutes: 45 });
  assert.equal(second.status, "EXECUTED");
  assert.equal(prisma.rows.find((r) => r.id === first.id)!.revertAt, null, "older timer must be superseded");
  assert.ok(prisma.rows.find((r) => r.id === second.id)!.revertAt, "newer timer must survive");
  // Different object on the same capability is untouched.
  const other = await svc().create({ tenantId: "21", capabilityId: "pbx.M2", params: { tenantId: "21", objectId: "102", action: "set" }, summary: "other ext", requestedBy: "izzy", requestedRole: "owner", autoApprove: true, revertAfterMinutes: 10 });
  assert.ok(prisma.rows.find((r) => r.id === second.id)!.revertAt, "different objectId must not supersede");
  assert.ok(other.revertAt);
});

test("tick abandons a permanently-refused revert instead of retrying every minute", async () => {
  // Live incident 2026-07-27: a drift-refused revert retried every 60s forever.
  backend.revert = async (a: any) => { backend.reverts.push(a); return { ok: false, error: "drift", permanent: true }; };
  const temp = await svc().create({ tenantId: "t1", capabilityId: "pbx.P1", params: { objectId: "x" }, summary: "temp", requestedBy: "izzy", requestedRole: "owner", autoApprove: true, revertAfterHours: 1 });
  temp.revertAt = new Date(Date.now() - 1000);
  const res1 = await svc().tick(new Date());
  assert.equal(res1.reverted, 0);
  assert.equal(temp.status, "EXECUTED", "action stays EXECUTED — its write is no longer ours to undo");
  assert.equal(temp.revertAt, null, "timer must be dropped");
  const res2 = await svc().tick(new Date());
  assert.equal(backend.reverts.length, 1, "no second attempt after abandonment");
  assert.equal(res2.reverted, 0);
});

test("tick keeps retrying a transient (non-permanent) revert failure", async () => {
  backend.revert = async (a: any) => { backend.reverts.push(a); return { ok: false, error: "pbx unreachable" }; };
  const temp = await svc().create({ tenantId: "t1", capabilityId: "pbx.P1", params: { objectId: "x" }, summary: "temp", requestedBy: "izzy", requestedRole: "owner", autoApprove: true, revertAfterHours: 1 });
  temp.revertAt = new Date(Date.now() - 1000);
  await svc().tick(new Date());
  await svc().tick(new Date());
  assert.equal(backend.reverts.length, 2, "transient failures stay scheduled");
  assert.ok(temp.revertAt, "timer must be kept for retry");
});

test("double approve is idempotent (no double execute)", async () => {
  const a = await svc().create({ tenantId: "t1", capabilityId: "pbx.P1", params: { name: "N" }, summary: "s", requestedBy: "u", requestedRole: "customer" });
  await svc().approve(a.id, "izzy");
  const calls1 = backend.calls.length;
  await svc().approve(a.id, "izzy");
  assert.equal(backend.calls.length, calls1);
});
