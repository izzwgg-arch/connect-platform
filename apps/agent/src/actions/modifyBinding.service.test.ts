/**
 * X1: ActionService behavior for BOUND (modify/repair) capabilities —
 * auto-approve disabled, pending cap, bound email tokens, single-use CAS
 * consumption, and longest-prefix backend routing.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ActionService, type ExecuteBackend } from "./service";
import { computeParamsHash, makeBoundApprovalToken, verifyBoundApprovalToken } from "./bindings";
import { makeApprovalToken } from "./tokens";
import { AuditLog, FileAuditSink } from "../audit/audit";

process.env.AGENT_APPROVAL_SECRET = "test-approval-secret";

class FakeActions {
  rows: any[] = [];
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
      this.rows.filter((r) => r.tenantId === where.tenantId && r.status === where.status && (where.paramsHash?.not === null ? r.paramsHash !== null : true)).length,
    update: async ({ where, data }: any) => {
      const row = this.rows.find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      const rows = this.rows.filter(
        (r) => r.id === where.id && (where.status === undefined || r.status === where.status) && (where.approvalConsumedAt === undefined || r.approvalConsumedAt === where.approvalConsumedAt),
      );
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
  };
}

const notifierStub: any = { sent: [] as any[], ownerRecipients: () => ["izzy@test"], async send(m: any) { this.sent.push(m); return { sent: true }; } };

let prisma: FakeActions;
let audit: AuditLog;
let pbxBackend: ExecuteBackend & { calls: any[] };
let modifyBackend: ExecuteBackend & { calls: any[] };

beforeEach(async () => {
  prisma = new FakeActions();
  const dir = await mkdtemp(path.join(tmpdir(), "modact-"));
  audit = new AuditLog([new FileAuditSink(dir)]);
  (notifierStub as any).sent = [];
  pbxBackend = { calls: [], async execute(a: any, o: any) { this.calls.push({ a, o }); return { ok: true }; } };
  modifyBackend = { calls: [], async execute(a: any, o: any) { this.calls.push({ a, o }); return { ok: true, snapshot: { via: "modify" } }; } };
});

function svc() {
  return new ActionService(
    prisma as any,
    audit,
    notifierStub,
    { "pbx.": pbxBackend, "pbx.M": modifyBackend, "pbx.E": modifyBackend, "repair.": modifyBackend },
    { approvalBaseUrl: "https://app.test" },
  );
}

const P = { tenantId: "21", objectId: "moh1", classId: "jazz" };

// pbx.M2 is the exemplar BOUND, NON-MANDATED capability for the generic-flow
// tests below (pbx.M1 auto-executes under the 2026-07-26 MOH owner mandate).
test("AUTO-APPROVE DISABLED: owner-requested pbx.M2 still goes to PENDING_APPROVAL", async () => {
  const a = await svc().create({ tenantId: "21", capabilityId: "pbx.M2", params: P, summary: "ext MOH switch", requestedBy: "izzy", requestedRole: "owner", autoApprove: true });
  assert.equal(a.status, "PENDING_APPROVAL");
  assert.equal(a.paramsHash, computeParamsHash("pbx.M2", "21", P));
  assert.ok((notifierStub as any).sent.some((m: any) => m.kind === "approval_request"));
  assert.equal(modifyBackend.calls.length, 0);
});

const DND_PARAMS = { tenantId: "21", objectId: "102", feature: "DND", enable: "yes" };

test("OWNER MANDATE: DND (pbx.M11 feature=DND) executes without approval, binding intact", async () => {
  const a = await svc().create({ tenantId: "21", capabilityId: "pbx.M11", params: DND_PARAMS, summary: "enable DND on ext 102", requestedBy: "u1", requestedRole: "customer" });
  assert.equal(a.status, "EXECUTED");
  assert.equal(modifyBackend.calls.length, 1);
  // Binding contract still holds: params-hash frozen, approval consumed single-use.
  assert.equal(a.paramsHash, computeParamsHash("pbx.M11", "21", DND_PARAMS));
  assert.ok(a.approvalConsumedAt);
  assert.equal(a.approvedBy, "owner-mandate:dnd-2026-07-26");
  // No approval email; the result email still goes out.
  assert.ok(!(notifierStub as any).sent.some((m: any) => m.kind === "approval_request"));
  assert.ok((notifierStub as any).sent.some((m: any) => m.kind === "action_executed"));
});

test("OWNER MANDATE scope: pbx.M11 call-forward (CFU) still requires approval", async () => {
  const p = { tenantId: "21", objectId: "102", feature: "CFU", enable: "yes", destination: "13055550100" };
  const a = await svc().create({ tenantId: "21", capabilityId: "pbx.M11", params: p, summary: "CFU", requestedBy: "u1", requestedRole: "customer" });
  assert.equal(a.status, "PENDING_APPROVAL");
  assert.equal(modifyBackend.calls.length, 0);
  assert.ok((notifierStub as any).sent.some((m: any) => m.kind === "approval_request"));
});

test("OWNER MANDATE kill switch: AGENT_DND_AUTO_APPROVE=0 restores the approval flow", async () => {
  process.env.AGENT_DND_AUTO_APPROVE = "0";
  try {
    const a = await svc().create({ tenantId: "21", capabilityId: "pbx.M11", params: DND_PARAMS, summary: "DND", requestedBy: "u1", requestedRole: "customer" });
    assert.equal(a.status, "PENDING_APPROVAL");
    assert.equal(modifyBackend.calls.length, 0);
  } finally {
    delete process.env.AGENT_DND_AUTO_APPROVE;
  }
});

const M1_PARAMS = { tenantId: "21", objectId: "21", action: "activate", profileId: "prof1", reason: "chat request" };

test("OWNER MANDATE: MOH (pbx.M1) executes without approval, binding intact", async () => {
  const a = await svc().create({ tenantId: "21", capabilityId: "pbx.M1", params: M1_PARAMS, summary: "switch hold music", requestedBy: "u1", requestedRole: "customer" });
  assert.equal(a.status, "EXECUTED");
  assert.equal(modifyBackend.calls.length, 1);
  assert.equal(a.paramsHash, computeParamsHash("pbx.M1", "21", M1_PARAMS));
  assert.ok(a.approvalConsumedAt);
  assert.equal(a.approvedBy, "owner-mandate:moh-2026-07-26");
  assert.ok(!(notifierStub as any).sent.some((m: any) => m.kind === "approval_request"));
});

test("OWNER MANDATE kill switch: AGENT_MOH_AUTO_APPROVE=0 restores the M1 approval flow", async () => {
  process.env.AGENT_MOH_AUTO_APPROVE = "0";
  try {
    const a = await svc().create({ tenantId: "21", capabilityId: "pbx.M1", params: M1_PARAMS, summary: "switch hold music", requestedBy: "u1", requestedRole: "customer" });
    assert.equal(a.status, "PENDING_APPROVAL");
    assert.equal(modifyBackend.calls.length, 0);
  } finally {
    delete process.env.AGENT_MOH_AUTO_APPROVE;
  }
});

test("legacy P-series capability keeps auto-approve (no regression)", async () => {
  const a = await svc().create({ tenantId: "21", capabilityId: "pbx.P1", params: { name: "T" }, summary: "t", requestedBy: "izzy", requestedRole: "owner", autoApprove: true });
  assert.equal(a.status, "EXECUTED");
  assert.equal(pbxBackend.calls.length, 1);
  assert.equal(a.paramsHash ?? null, null);
});

test("PENDING CAP: 4th concurrent modify request for a tenant is denied", async () => {
  const s = svc();
  for (let i = 0; i < 3; i++) {
    await s.create({ tenantId: "21", capabilityId: "pbx.M2", params: { ...P, classId: `c${i}` }, summary: `m${i}`, requestedBy: "u", requestedRole: "customer" });
  }
  const fourth = await s.create({ tenantId: "21", capabilityId: "pbx.M2", params: { ...P, classId: "c3" }, summary: "m3", requestedBy: "u", requestedRole: "customer" });
  assert.equal(fourth.status, "DENIED");
  assert.match(fourth.deniedReason, /modify_pending_cap/);
  // other tenants unaffected
  const other = await s.create({ tenantId: "8", capabilityId: "pbx.M2", params: { ...P, tenantId: "8" }, summary: "m", requestedBy: "u", requestedRole: "customer" });
  assert.equal(other.status, "PENDING_APPROVAL");
});

test("ROUTING: pbx.M2 goes to the modify backend, pbx.P1 to the legacy backend", async () => {
  const s = svc();
  const m = await s.create({ tenantId: "21", capabilityId: "pbx.M2", params: P, summary: "m", requestedBy: "u", requestedRole: "customer" });
  await s.approve(m.id, "owner:izzy");
  assert.equal(modifyBackend.calls.length, 1);
  assert.equal(pbxBackend.calls.length, 0);
  const p = await s.create({ tenantId: "21", capabilityId: "pbx.P11", params: { tenantId: "21", name: "Q" }, summary: "q", requestedBy: "u", requestedRole: "customer" });
  await s.approve(p.id, "owner:izzy");
  assert.equal(pbxBackend.calls.length, 1);
});

test("SINGLE-USE: approving a bound action consumes it; second execute attempt is blocked", async () => {
  const s = svc();
  const a = await s.create({ tenantId: "21", capabilityId: "pbx.M2", params: P, summary: "m", requestedBy: "u", requestedRole: "customer" });
  const done = await s.approve(a.id, "owner:izzy");
  assert.equal(done.status, "EXECUTED");
  assert.ok(prisma.rows[0].approvalConsumedAt);
  assert.equal(modifyBackend.calls.length, 1);
  // replayed approve: status is no longer PENDING_APPROVAL ⇒ idempotent no-op
  await s.approve(a.id, "owner:izzy");
  assert.equal(modifyBackend.calls.length, 1);
});

test("EMAIL REDEMPTION: bound action requires a bound token with the matching hash", async () => {
  const s = svc();
  const a = await s.create({ tenantId: "21", capabilityId: "pbx.M2", params: P, summary: "m", requestedBy: "u", requestedRole: "customer" });

  // legacy unbound token for the same action id → rejected
  const legacy = makeApprovalToken(a.id, "approve");
  const r1 = await s.redeemEmailDecision(legacy);
  assert.equal(r1.ok, false);
  assert.equal(r1.error, "bound_token_required");

  // bound token with a DIFFERENT hash (approval for another change) → rejected
  const wrongHash = computeParamsHash("pbx.M2", "21", { ...P, classId: "other" });
  const r2 = await s.redeemEmailDecision(makeBoundApprovalToken(a.id, "approve", wrongHash));
  assert.equal(r2.ok, false);
  assert.equal(r2.error, "token_binding_mismatch");
  assert.equal(modifyBackend.calls.length, 0);

  // correct bound token → approves and executes
  const r3 = await s.redeemEmailDecision(makeBoundApprovalToken(a.id, "approve", a.paramsHash));
  assert.equal(r3.ok, true);
  assert.equal(modifyBackend.calls.length, 1);
});

test("EMAIL REDEMPTION: legacy actions still redeem with legacy tokens (no regression)", async () => {
  const s = svc();
  const a = await s.create({ tenantId: "21", capabilityId: "pbx.P11", params: { tenantId: "21", name: "Q" }, summary: "q", requestedBy: "u", requestedRole: "customer" });
  const r = await s.redeemEmailDecision(makeApprovalToken(a.id, "approve"));
  assert.equal(r.ok, true);
  assert.equal(pbxBackend.calls.length, 1);
});

test("approval email for bound actions carries a BOUND token", async () => {
  const s = svc();
  const a = await s.create({ tenantId: "21", capabilityId: "pbx.M2", params: P, summary: "m", requestedBy: "u", requestedRole: "customer" });
  const mail = (notifierStub as any).sent.find((m: any) => m.kind === "approval_request");
  const tok = /token=([^\s&]+)/.exec(mail.text)?.[1];
  assert.ok(tok);
  const v = verifyBoundApprovalToken(decodeURIComponent(tok!));
  assert.ok(v, "email token must verify as a bound token");
  assert.equal(v!.paramsHash, a.paramsHash);
});
