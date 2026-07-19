import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeEmail, normalizePhone, IdentityResolver } from "./identity";
import { EmailChannel } from "./email";
import { AuditLog, FileAuditSink } from "../audit/audit";

test("email normalization strips display names + validates", () => {
  assert.equal(normalizeEmail("Sarah G <Sarah@Goldman.com>"), "sarah@goldman.com");
  assert.equal(normalizeEmail("plain@x.co"), "plain@x.co");
  assert.equal(normalizeEmail("not-an-email"), null);
});

test("phone normalization keeps digits/plus, rejects junk", () => {
  assert.equal(normalizePhone("+1 (845) 555-1212"), "+18455551212");
  assert.equal(normalizePhone("12"), null);
});

test("identity resolver maps SUPER_ADMIN→owner, others→customer, unknown→null", async () => {
  const prisma = {
    user: {
      findUnique: async ({ where }: any) =>
        where.email === "boss@x.com"
          ? { id: "u0", tenantId: "t1", role: "SUPER_ADMIN", email: "boss@x.com", status: "ACTIVE" }
          : where.email === "sarah@goldman.com"
            ? { id: "u1", tenantId: "t9", role: "USER", email: "sarah@goldman.com", status: "ACTIVE" }
            : null,
    },
  };
  const r = new IdentityResolver(prisma as any);
  assert.equal((await r.byEmail("boss@x.com"))?.role, "owner");
  assert.equal((await r.byEmail("sarah@goldman.com"))?.role, "customer");
  assert.equal((await r.byEmail("stranger@nowhere.com")), null);
});

test("inactive user does not resolve", async () => {
  const prisma = { user: { findUnique: async () => ({ id: "u", tenantId: "t", role: "USER", email: "x@y.z", status: "SUSPENDED" }) } };
  assert.equal(await new IdentityResolver(prisma as any).byEmail("x@y.z"), null);
});

let engineStub: any;
let audit: AuditLog;
let notifierStub: any;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "email-"));
  audit = new AuditLog([new FileAuditSink(dir)]);
  engineStub = { calls: [] as any[], async handleMessage(ctx: any, text: string) { this.calls.push({ ctx, text }); return { conversationId: "c1", reply: "Passed to the team.", language: "en", degraded: true }; } };
  notifierStub = { sent: [] as any[], ownerRecipients: () => ["izzy@t"], async send(m: any) { this.sent.push(m); return { sent: false }; } };
});

test("known sender → routed to engine with channel=email, reply built", async () => {
  const prisma = { user: { findUnique: async () => ({ id: "u1", tenantId: "t9", role: "USER", email: "sarah@goldman.com", status: "ACTIVE" }) } };
  const ch = new EmailChannel(engineStub, new IdentityResolver(prisma as any), notifierStub, audit);
  const res = await ch.handleInbound({ from: "Sarah <sarah@goldman.com>", subject: "phone issue", text: "my phone won't ring" });
  assert.equal(res.handled, true);
  assert.equal(engineStub.calls[0].ctx.channel, "email");
  assert.equal(engineStub.calls[0].ctx.tenantId, "t9");
  assert.match(res.reply!.subject, /^Re:/);
  assert.equal(notifierStub.sent.length, 1);
});

test("unknown sender → not handled, no engine call, no tenant guessed", async () => {
  const prisma = { user: { findUnique: async () => null } };
  const ch = new EmailChannel(engineStub, new IdentityResolver(prisma as any), notifierStub, audit);
  const res = await ch.handleInbound({ from: "stranger@nowhere.com", text: "hi" });
  assert.equal(res.handled, false);
  assert.equal(res.reason, "unknown_sender");
  assert.equal(engineStub.calls.length, 0);
});
