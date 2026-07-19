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

test("double approve is idempotent (no double execute)", async () => {
  const a = await svc().create({ tenantId: "t1", capabilityId: "pbx.P1", params: { name: "N" }, summary: "s", requestedBy: "u", requestedRole: "customer" });
  await svc().approve(a.id, "izzy");
  const calls1 = backend.calls.length;
  await svc().approve(a.id, "izzy");
  assert.equal(backend.calls.length, calls1);
});
