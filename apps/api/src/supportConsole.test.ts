/**
 * The escalation desk API (supportConsole.ts) — Phase 1 of the support console.
 *
 * Route behavior is driven against a fake db; the WIRING is pinned by source
 * guards on server.ts, because both halves of every past miss in this repo were
 * callers: a module that exists but is never registered, or a prefix that
 * matches no PORTAL_API_PERMISSION_RULES entry and silently skips the global
 * permission gate (the /admin/wake-health class). Both guards fail when
 * replayed against the pre-change server.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { registerSupportConsoleRoutes, escalationListRow } from "./supportConsole";
import { supportReportReference } from "@connect/shared";

// ---------------------------------------------------------------- fakes

type Handler = (req: any, reply: any) => Promise<unknown>;

function fakeApp() {
  const routes = new Map<string, Handler>();
  return {
    get(p: string, h: Handler) {
      routes.set(p, h);
    },
    post(p: string, h: Handler) {
      routes.set("POST " + p, h);
    },
    routes,
  };
}

function fakeReply() {
  const r: any = {
    statusCode: 200,
    body: undefined,
    code(c: number) {
      r.statusCode = c;
      return r;
    },
    send(b: unknown) {
      r.body = b;
      return r;
    },
  };
  return r;
}

const NOW = new Date("2026-08-20T15:00:00Z");

function esc(overrides: Record<string, unknown> = {}) {
  return {
    id: "esc_" + Math.random().toString(36).slice(2, 10),
    conversationId: null,
    tenantId: "t1",
    tenantName: "Gesheft",
    clientUserId: "u1",
    userName: "Joel Landau",
    userEmail: "joel@example.com",
    requestSummary: "Voicemails stopped emailing ext 112",
    smsBody: "sms",
    report: "ISSUE: x\nFINDINGS: y\nPROPOSED FIX: z\nAPPROVAL: reply FIX",
    proposedFix: "add the address back",
    researchDegraded: false,
    status: "SENT",
    attempts: 1,
    lastError: null,
    smsSentAt: NOW,
    emailQueuedAt: NOW,
    fixActionId: null,
    fixCodeHash: "SECRET_HASH_MUST_NEVER_LEAVE",
    fixCodeExpiresAt: null,
    fixCodeUsedAt: null,
    fixApprovedFrom: null,
    fixStatus: null,
    fixResult: null,
    fixAttempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function fakeDb(rows: any[], opts: { action?: any; messages?: any[] } = {}) {
  const calls: any[] = [];
  return {
    calls,
    agentEscalation: {
      async findMany(args: any) {
        calls.push(["findMany", args]);
        let out = [...rows];
        const w = args?.where ?? {};
        if (w.status) out = out.filter((r) => r.status === w.status);
        if (w.tenantId) out = out.filter((r) => r.tenantId === w.tenantId);
        if (w.createdAt?.lt) out = out.filter((r) => r.createdAt < w.createdAt.lt);
        out.sort((a, b) => +b.createdAt - +a.createdAt);
        return out.slice(0, args?.take ?? out.length);
      },
      async findUnique(args: any) {
        calls.push(["findUnique", args]);
        return rows.find((r) => r.id === args?.where?.id) ?? null;
      },
    },
    agentAction: {
      async findUnique(args: any) {
        calls.push(["action.findUnique", args]);
        return opts.action ?? null;
      },
    },
    agentMessage: {
      async findMany(args: any) {
        calls.push(["message.findMany", args]);
        return [...(opts.messages ?? [])];
      },
    },
  };
}

function customerDb(overrides: Record<string, any> = {}) {
  return {
    tenant: {
      async findUnique(args: any) {
        return args?.where?.id === "t1"
          ? { id: "t1", name: "Gesheft", createdAt: NOW, pbxRemovedAt: null }
          : null;
      },
      async findMany(args: any) {
        const all = [
          { id: "t1", name: "Gesheft" },
          { id: "t2", name: "Trust Bookkeepings" },
        ];
        const ids: string[] = args?.where?.id?.in ?? [];
        return all.filter((t) => ids.includes(t.id));
      },
    },
    extension: {
      async findMany() {
        return [
          { extNumber: "101", displayName: "Front Desk", status: "ACTIVE" },
          { extNumber: "112", displayName: "Orders", status: "ACTIVE" },
          { extNumber: "199", displayName: "Old line", status: "REMOVED" },
        ];
      },
    },
    user: { async count() { return 7; } },
    pbxTenantInboundDid: { async findMany() { return [{ e164: "8455551234" }]; } },
    tenantSmsNumber: { async findMany() { return [{ phoneE164: "+18455551234", isTenantDefault: true }]; } },
    tenantBillingSettings: {
      async findUnique() { return { autoBillingEnabled: true, billingDayOfMonth: 3 }; },
    },
    billingInvoice: { async count(args: any) { return args?.where?.status === "OPEN" ? 1 : 2; } },
    connectCdr: {
      async findMany() {
        return [{ direction: "incoming", fromNumber: "9175550100", toNumber: "8455551234", disposition: "answered", talkSec: 62, startedAt: NOW }];
      },
    },
    ...overrides,
  };
}

function inboxDb(overrides: Record<string, any> = {}) {
  const threads = [
    {
      id: "th_sms",
      tenantId: "t1",
      type: "SMS",
      title: null,
      tenantSmsE164: "+18455551234",
      externalSmsE164: "+19175550100",
      smsInboxOwnerUserId: "",
      lastMessageAt: new Date("2026-08-20T14:00:00Z"),
      active: true,
    },
    {
      id: "th_dm",
      tenantId: "t2",
      type: "DM",
      title: "Office chat",
      tenantSmsE164: null,
      externalSmsE164: null,
      smsInboxOwnerUserId: "u9",
      lastMessageAt: new Date("2026-08-20T13:00:00Z"),
      active: true,
    },
  ];
  const messages = [
    { id: "m1", threadId: "th_sms", direction: "INBOUND", type: "TEXT", body: "hello there", senderUserId: null, createdAt: new Date("2026-08-20T13:59:00Z"), deliveryStatus: null, deliveryError: null, deletedForEveryoneAt: null },
    { id: "m2", threadId: "th_sms", direction: "OUTBOUND", type: "TEXT", body: "hi!", senderUserId: "u1", createdAt: new Date("2026-08-20T14:00:00Z"), deliveryStatus: "SENT", deliveryError: null, deletedForEveryoneAt: null },
    { id: "m3", threadId: "th_sms", direction: "OUTBOUND", type: "TEXT", body: "oops", senderUserId: "u1", createdAt: new Date("2026-08-20T14:01:00Z"), deliveryStatus: null, deliveryError: null, deletedForEveryoneAt: new Date() },
  ];
  return {
    connectChatThread: {
      async findMany(args: any) {
        let out = threads.filter((t) => t.active);
        // ⛔ The fake MUST honour the tenant filter. A fake that ignores the
        // very where-clause under test is how a scoping bug ships green — this
        // repo has already paid for that exact shape (the service-interruption
        // sweep passed 102 tests against a query Prisma was rejecting).
        if (args?.where?.tenantId) out = out.filter((t) => t.tenantId === args.where.tenantId);
        if (args?.where?.type) out = out.filter((t) => t.type === args.where.type);
        out.sort((a, b) => +b.lastMessageAt - +a.lastMessageAt);
        return out.slice(0, args?.take ?? out.length);
      },
      async findUnique(args: any) {
        return threads.find((t) => t.id === args?.where?.id) ?? null;
      },
    },
    connectChatMessage: {
      async findFirst(args: any) {
        const forThread = messages
          .filter((m) => m.threadId === args?.where?.threadId && (!("deletedForEveryoneAt" in (args?.where ?? {})) || m.deletedForEveryoneAt === null))
          .sort((a, b) => +b.createdAt - +a.createdAt);
        return forThread[0] ?? null;
      },
      async findMany(args: any) {
        return messages
          .filter((m) => m.threadId === args?.where?.threadId)
          .sort((a, b) => +b.createdAt - +a.createdAt)
          .slice(0, args?.take ?? messages.length);
      },
    },
    ...overrides,
  };
}

function register(
  rows: any[],
  opts: { allow?: boolean; action?: any; messages?: any[]; customer?: Record<string, any>; sendSms?: any; inbox?: Record<string, any>; workspaceRoot?: string; watchmanOk?: boolean } = {},
) {
  const app = fakeApp();
  const db = {
    ...customerDb({}),
    ...inboxDb(opts.inbox ?? {}),
    user: {
      async count() {
        return 7;
      },
      async findMany() {
        return [{ id: "u1", firstName: null, lastName: null, email: "shloime@loopcom.net" }];
      },
    },
    ...fakeDb(rows, opts),
    // Test-specific overrides win over every default fake.
    ...(opts.customer ?? {}),
  };
  // Capture audit rows so a test can prove a reading was RECORDED, not just
  // permitted. ⛔ Wraps whatever fake is already in place rather than replacing
  // it, so the tests that assert on their own agentAuditLog still see theirs.
  const audits: any[] = [];
  const innerAudit = (db as any).agentAuditLog;
  (db as any).agentAuditLog = {
    ...(innerAudit ?? {}),
    async create(arg: any) {
      audits.push(arg?.data ?? arg);
      return innerAudit?.create ? innerAudit.create(arg) : { id: "a1" };
    },
  };
  registerSupportConsoleRoutes({
    app,
    db,
    requireSuper: async (_req: any, reply: any) => {
      if (opts.allow === false) {
        reply.code(403).send({ error: "forbidden" });
        return null;
      }
      return { sub: "super", role: "SUPER_ADMIN", tenantId: "admin" };
    },
    sendSms: opts.sendSms,
    smsQueue: { fake: true },
    ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}),
    // ⛔ Gate order is WATCHMAN first, so a workbench test without healthy
    // probes is refused "not safe to work" before it ever reaches the rule it
    // meant to exercise — and would pass for entirely the wrong reason.
    ...(opts.watchmanOk
      ? {
          watchmanProbes: {
            rules: async () => ({ found: 2, missing: [] }),
            server: async () => ({ healthy: 2, unhealthy: [] }),
            pbx: async () => ({ reachable: true, readOnly: true }),
          },
        }
      : {}),
  });
  return { app, db, audits };
}

async function call(app: any, route: string, req: any = {}) {
  const reply = fakeReply();
  const out = await app.routes.get(route)!(req, reply);
  return { reply, out: reply.body !== undefined ? reply.body : out };
}

// ---------------------------------------------------------------- behavior

test("list: newest first, list-row shape, reference derived from id", async () => {
  const a = esc({ id: "esc_a", createdAt: new Date("2026-08-20T10:00:00Z") });
  const b = esc({ id: "esc_b", createdAt: new Date("2026-08-20T12:00:00Z") });
  const { app } = register([a, b]);
  const { out } = await call(app, "/admin/support/escalations", { query: {} });
  assert.equal(out.escalations.length, 2);
  assert.equal(out.escalations[0].id, "esc_b");
  assert.equal(out.escalations[0].reference, supportReportReference("esc_b"));
  assert.equal(out.escalations[0].tenantName, "Gesheft");
  assert.equal(out.counts.returned, 2);
});

test("list: status filter maps to the enum spelling; fixReady counts offered fixes", async () => {
  const rows = [
    esc({ id: "e1", status: "QUEUED" }),
    esc({ id: "e2", status: "SENT", fixStatus: "offered", fixActionId: "act1" }),
  ];
  const { app } = register(rows);
  const { out } = await call(app, "/admin/support/escalations", { query: { status: "queued" } });
  assert.equal(out.escalations.length, 1);
  assert.equal(out.escalations[0].id, "e1");
  const all = await call(app, "/admin/support/escalations", { query: {} });
  assert.equal(all.out.counts.fixReady, 1);
  assert.equal(all.out.escalations.find((e: any) => e.id === "e2").hasFixAction, true);
});

test("detail: carries the report, the DRAFT action and the conversation tail (oldest first)", async () => {
  const row = esc({ id: "esc_d", conversationId: "conv1", fixActionId: "act1", fixStatus: "offered" });
  const { app } = register([row], {
    action: { id: "act1", status: "DRAFT", summary: "Add the address", capabilityId: "enable_sms", createdAt: NOW, approvalConsumedAt: null },
    messages: [
      { role: "assistant", content: "second", contentEn: null, createdAt: new Date("2026-08-20T14:59:00Z"), model: "gpt-5" },
      { role: "user", content: "first", contentEn: null, createdAt: new Date("2026-08-20T14:58:00Z"), model: null },
    ],
  });
  const { out } = await call(app, "/admin/support/escalations/:id", { params: { id: "esc_d" } });
  assert.equal(out.escalation.report.includes("PROPOSED FIX"), true);
  assert.equal(out.fixAction.status, "DRAFT");
  // The fake returns newest-first (as the query asks); the route must reverse.
  assert.equal(out.messages[0].content, "first");
});

test("detail: unknown id is a clean 404", async () => {
  const { app } = register([esc({ id: "esc_x" })]);
  const { reply } = await call(app, "/admin/support/escalations/:id", { params: { id: "nope" } });
  assert.equal(reply.statusCode, 404);
});

test("⛔ fixCodeHash never leaves the server, on either route", async () => {
  const row = esc({ id: "esc_s", conversationId: "conv1", fixActionId: "act1" });
  const { app } = register([row], { action: { id: "act1", status: "DRAFT" }, messages: [] });
  const list = await call(app, "/admin/support/escalations", { query: {} });
  const detail = await call(app, "/admin/support/escalations/:id", { params: { id: "esc_s" } });
  assert.ok(!JSON.stringify(list.out).includes("SECRET_HASH_MUST_NEVER_LEAVE"));
  assert.ok(!JSON.stringify(detail.out).includes("SECRET_HASH_MUST_NEVER_LEAVE"));
  assert.ok(!JSON.stringify(detail.out).includes("fixCodeHash"));
});

test("gate refused → no database read happens", async () => {
  const { app, db } = register([esc()], { allow: false });
  await call(app, "/admin/support/escalations", { query: {} });
  await call(app, "/admin/support/escalations/:id", { params: { id: "x" } });
  assert.equal(db.calls.length, 0);
});

// ---------------------------------------------------------------- customer panel

test("customer panel: aggregates counts, numbers, billing, calls and past escalations", async () => {
  const past = esc({ id: "esc_p", tenantId: "t1", createdAt: NOW });
  const { app } = register([past]);
  const { out } = await call(app, "/admin/support/customers/:tenantId", { params: { tenantId: "t1" } });
  assert.equal(out.tenant.name, "Gesheft");
  assert.equal(out.counts.extensions, 2); // REMOVED extension not counted
  assert.equal(out.counts.users, 7);
  assert.equal(out.numbers[0], "8455551234");
  assert.equal(out.billing.autopay, true);
  assert.equal(out.billing.invoicesNeedingAttention, 2);
  assert.equal(out.billing.openInvoices, 1);
  assert.equal(out.recentCalls[0].disposition, "answered");
  assert.equal(out.pastEscalations[0].reference, supportReportReference("esc_p"));
  assert.ok(!JSON.stringify(out).includes("fixCodeHash"));
});

test("customer panel: unknown tenant is a clean 404", async () => {
  const { app } = register([]);
  const { reply } = await call(app, "/admin/support/customers/:tenantId", { params: { tenantId: "nope" } });
  assert.equal(reply.statusCode, 404);
});

test("⛔ customer panel: one failing source empties its card, never a 500", async () => {
  const { app } = register([], {
    customer: {
      connectCdr: { async findMany() { throw new Error("cdr db down"); } },
      tenantBillingSettings: { async findUnique() { throw new Error("billing down"); } },
    },
  });
  const { reply, out } = await call(app, "/admin/support/customers/:tenantId", { params: { tenantId: "t1" } });
  assert.equal(reply.statusCode, 200);
  assert.deepEqual(out.recentCalls, []);
  assert.equal(out.billing, null);
  assert.equal(out.counts.users, 7); // the healthy sources still answered
});

test("customer panel: gate refused → nothing touched", async () => {
  const { app } = register([], { allow: false });
  const { reply } = await call(app, "/admin/support/customers/:tenantId", { params: { tenantId: "t1" } });
  assert.equal(reply.statusCode, 403);
});

// ------------------------------------------- one customer's threads (2026-08-24)

/**
 * ⛔⛔ THIS TEST USED TO ASSERT THE OPPOSITE, AND THAT IS THE POINT.
 * It read "threads across companies, newest activity first" — the browse
 * surface. Measured 2026-08-24 that route answered with 679 threads and 2,477
 * messages belonging to every company on the platform, reachable with no case
 * attached to the reading. Izzy: "I don't want to see everybody's text
 * messages. I don't know why it's there."
 *
 * The capability is kept (support does sometimes have to read the thread to
 * answer the question); BROWSING is what was removed. So the assertion is now
 * that a request without a company is REFUSED, and the refusal explains itself.
 */
test("⛔ a request with no company is refused — there is no way to browse the platform", async () => {
  const { app } = register([]);
  const { reply } = await call(app, "/admin/support/threads", { query: {} });
  assert.equal(reply.statusCode, 400);
  assert.equal(reply.body.error, "tenant_required");
  assert.match(String(reply.body.message), /from their case/i);
});

test("threads: scoped to one company, newest activity first, tenant names joined", async () => {
  const { app } = register([]);
  const { out } = await call(app, "/admin/support/threads", { query: { tenantId: "t1", caseRef: "Q2FJRK" } });
  // t2's DM is absent: the scope is the fence, not a filter the screen applies.
  assert.ok(out.threads.every((t: any) => t.tenantId === "t1"), "a scoped read returned another company's thread");
  assert.equal(out.threads[0].id, "th_sms");
  assert.equal(out.threads[0].tenantName, "Gesheft"); // joined via tenant table
  assert.equal(out.threads[0].sharedInbox, true);
  assert.equal(out.threads[0].last.preview, "hi!"); // deleted m3 is not the preview
});

test("⛔ opening a customer's threads is recorded against the case it was opened for", async () => {
  const { app, audits } = register([]);
  await call(app, "/admin/support/threads", { query: { tenantId: "t1", caseRef: "Q2FJRK" } });
  const row = audits.find((a: any) => a.event === "support.customer_threads_opened");
  assert.ok(row, "no audit row — a reading with no record is the browse surface again");
  assert.equal(row.tenantId, "t1");
  assert.equal(row.payload.caseRef, "Q2FJRK");
});

test("inbox: transcript is oldest-first, deleted messages masked, sender named by the shared rule", async () => {
  const { app } = register([]);
  const { out } = await call(app, "/admin/support/threads/:id", { params: { id: "th_sms" } });
  assert.equal(out.thread.tenantName, "Gesheft");
  assert.equal(out.messages[0].body, "hello there");
  assert.equal(out.messages[0].senderName, null); // inbound: the customer, never a guessed name
  assert.equal(out.messages[1].senderName, "Shloime"); // email local part, capitalised
  const deleted = out.messages.find((m: any) => m.deleted);
  assert.equal(deleted.body, ""); // a deleted message's text never ships
});

test("inbox reply: delegates to the ONE injected sender with the THREAD's tenant", async () => {
  const calls: any[] = [];
  const { app } = register([], {
    sendSms: async (input: any) => {
      calls.push(input);
      return { ok: true, message: { id: "new" } };
    },
  });
  const { out } = await call(app, "POST /admin/support/threads/:id/reply", {
    params: { id: "th_sms" },
    body: { body: "On it — fixing now." },
  });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tenantId, "t1"); // the thread's tenant, never the caller's
  assert.equal(calls[0].threadId, "th_sms");
});

test("inbox reply: a non-SMS thread is refused in plain English, sender never called", async () => {
  const calls: any[] = [];
  const { app } = register([], { sendSms: async (i: any) => (calls.push(i), { ok: true }) });
  const { reply } = await call(app, "POST /admin/support/threads/:id/reply", {
    params: { id: "th_dm" },
    body: { body: "hello" },
  });
  assert.equal(reply.statusCode, 400);
  assert.equal(reply.body.error, "not_sms_thread");
  assert.equal(calls.length, 0);
});

test("inbox reply: a failed send maps the helper's status and error through", async () => {
  const { app } = register([], { sendSms: async () => ({ ok: false, status: 403, error: "FORBIDDEN" }) });
  const { reply } = await call(app, "POST /admin/support/threads/:id/reply", {
    params: { id: "th_sms" },
    body: { body: "hello" },
  });
  assert.equal(reply.statusCode, 403);
});

test("inbox reply: without the injected sender it answers 503, never invents its own", async () => {
  const { app } = register([], { sendSms: undefined });
  const { reply } = await call(app, "POST /admin/support/threads/:id/reply", {
    params: { id: "th_sms" },
    body: { body: "hello" },
  });
  assert.equal(reply.statusCode, 503);
});

// ---------------------------------------------------------------- take-over (Phase 4)

function takeoverDb() {
  const conv = {
    id: "conv1",
    tenantId: "t1",
    clientUserId: "cu1",
    role: "customer",
    status: "OPEN",
    language: "en",
    startedAt: NOW,
    humanTakeoverAt: null as Date | null,
    humanTakeoverBy: null as string | null,
  };
  const created: any[] = [];
  const audits: any[] = [];
  return {
    conv,
    created,
    audits,
    agentConversation: {
      async findMany() {
        return [conv];
      },
      async findUnique(args: any) {
        return args?.where?.id === conv.id ? { ...conv } : null;
      },
      async update(args: any) {
        Object.assign(conv, args.data);
        return { ...conv };
      },
    },
    agentMessage: {
      async findFirst() {
        return { role: "user", content: "hold music is wrong", createdAt: NOW };
      },
      async findMany() {
        return [];
      },
      async create(args: any) {
        created.push(args.data);
        return { id: "sm1", createdAt: NOW, ...args.data };
      },
    },
    agentAuditLog: {
      async create(args: any) {
        audits.push(args.data);
        return args.data;
      },
    },
  };
}

test("take-over: flips the flag, notes it in the transcript, audits with a real hash", async () => {
  const tdb = takeoverDb();
  const { app } = register([], { inbox: {}, customer: { agentConversation: tdb.agentConversation, agentMessage: tdb.agentMessage, agentAuditLog: tdb.agentAuditLog } });
  const on = await call(app, "POST /admin/support/conversations/:id/takeover", { params: { id: "conv1" }, body: { on: true } });
  assert.equal(on.out.takenOver, true);
  assert.ok(tdb.conv.humanTakeoverAt instanceof Date);
  assert.equal(tdb.conv.humanTakeoverBy, "super");
  assert.equal(tdb.created[0].role, "staff"); // the transcript note
  assert.equal(tdb.audits[0].event, "support.takeover_on");
  assert.equal(typeof tdb.audits[0].hash, "string");
  assert.equal(tdb.audits[0].hash.length, 64); // real sha256, never a stub
  const off = await call(app, "POST /admin/support/conversations/:id/takeover", { params: { id: "conv1" }, body: { on: false } });
  assert.equal(off.out.takenOver, false);
  assert.equal(tdb.conv.humanTakeoverAt, null);
});

test("⛔ a staff message REQUIRES an active take-over — two voices in one mouth is refused", async () => {
  const tdb = takeoverDb();
  const { app } = register([], { customer: { agentConversation: tdb.agentConversation, agentMessage: tdb.agentMessage, agentAuditLog: tdb.agentAuditLog } });
  const refused = await call(app, "POST /admin/support/conversations/:id/message", { params: { id: "conv1" }, body: { body: "hello" } });
  assert.equal(refused.reply.statusCode, 409);
  assert.equal(tdb.created.length, 0);
  tdb.conv.humanTakeoverAt = new Date();
  const ok = await call(app, "POST /admin/support/conversations/:id/message", { params: { id: "conv1" }, body: { body: "Hi Baila — real person here." } });
  assert.equal(ok.out.ok, true);
  assert.equal(tdb.created[0].role, "staff");
  assert.equal(tdb.audits.at(-1).event, "support.staff_message");
});

test("conversations list: cross-tenant rows with names and the takeover chip", async () => {
  const tdb = takeoverDb();
  tdb.conv.humanTakeoverAt = new Date();
  const { app } = register([], { customer: { agentConversation: tdb.agentConversation, agentMessage: tdb.agentMessage, agentAuditLog: tdb.agentAuditLog } });
  const { out } = await call(app, "/admin/support/conversations", { query: {} });
  assert.equal(out.conversations.length, 1);
  assert.equal(out.conversations[0].tenantName, "Gesheft");
  assert.equal(out.conversations[0].takenOver, true);
  assert.equal(out.conversations[0].last.preview, "hold music is wrong");
});

// ---------------------------------------------------------------- ground rules + watchman (Phase 5a/5b)

function rulesDb() {
  const rows: any[] = [];
  const audits: any[] = [];
  return {
    rows,
    audits,
    supportGroundRule: {
      async findFirst() {
        return [...rows].sort((a, b) => b.version - a.version)[0] ?? null;
      },
      async findMany(args: any) {
        return [...rows].sort((a, b) => b.version - a.version).slice(0, args?.take ?? rows.length);
      },
      async create(args: any) {
        const row = { id: "r" + rows.length, createdAt: NOW, ...args.data };
        rows.push(row);
        return row;
      },
    },
    agentAuditLog: {
      async create(args: any) {
        audits.push(args.data);
        return args.data;
      },
    },
  };
}

test("ground rules: falls back to the safe defaults until the owner saves one", async () => {
  const rdb = rulesDb();
  const { app } = register([], { customer: { supportGroundRule: rdb.supportGroundRule, agentAuditLog: rdb.agentAuditLog } });
  const { out } = await call(app, "/admin/support/ground-rules", {});
  assert.equal(out.isDefault, true);
  assert.equal(out.version, 0);
  assert.match(out.rules.never, /Payments/);
  assert.match(out.renderedForAgent, /enforced in code/);
});

test("ground rules: every save is a NEW version — the history is the audit trail", async () => {
  const rdb = rulesDb();
  const { app } = register([], { customer: { supportGroundRule: rdb.supportGroundRule, agentAuditLog: rdb.agentAuditLog } });
  const first = await call(app, "POST /admin/support/ground-rules", {
    body: { allowed: "Read files", never: "Payments", askFirst: "Delete anything", note: "first" },
  });
  assert.equal(first.out.version, 1);
  const second = await call(app, "POST /admin/support/ground-rules", {
    body: { allowed: "Read files and logs", never: "Payments", askFirst: "Delete anything" },
  });
  assert.equal(second.out.version, 2);
  assert.equal(rdb.rows.length, 2, "the earlier version must still exist");
  assert.equal(rdb.rows[0].allowed, "Read files", "history is never rewritten");
  assert.equal(rdb.audits.at(-1).event, "support.ground_rules_saved");
  assert.equal(rdb.audits.at(-1).hash.length, 64);
  const now = await call(app, "/admin/support/ground-rules", {});
  assert.equal(now.out.version, 2);
  assert.equal(now.out.isDefault, false);
});

test("⛔ an EMPTY never-list is refused — an unguarded rulebook is a bug, not a choice", async () => {
  const rdb = rulesDb();
  const { app } = register([], { customer: { supportGroundRule: rdb.supportGroundRule, agentAuditLog: rdb.agentAuditLog } });
  const { reply } = await call(app, "POST /admin/support/ground-rules", {
    body: { allowed: "Read files", never: "   ", askFirst: "Delete anything" },
  });
  assert.equal(reply.statusCode, 400);
  assert.equal(reply.body.error, "never_list_required");
  assert.equal(rdb.rows.length, 0);
});

test("ground-rules check answers what would happen, against the saved rulebook", async () => {
  const rdb = rulesDb();
  const { app } = register([], { customer: { supportGroundRule: rdb.supportGroundRule, agentAuditLog: rdb.agentAuditLog } });
  await call(app, "POST /admin/support/ground-rules", {
    body: { allowed: "Read files", never: "Write to the PBX", askFirst: "Restart any container" },
  });
  const never = await call(app, "POST /admin/support/ground-rules/check", { body: { action: "write a new extension to the PBX" } });
  assert.equal(never.out.verdict.decision, "never");
  assert.equal(never.out.version, 1);
  const ask = await call(app, "POST /admin/support/ground-rules/check", { body: { action: "restart the api container" } });
  assert.equal(ask.out.verdict.decision, "ask_first");
});

test("⛔ watchman with NO probes wired reports unknown and refuses to say it is safe", async () => {
  const { app } = register([]);
  const { out } = await call(app, "/admin/support/watchman", {});
  assert.equal(out.safeToWork, false);
  assert.equal(out.checks.length, 3);
  assert.ok(out.checks.every((c: any) => c.status === "unknown"));
});

test("watchman reports the injected probes", async () => {
  const app = fakeApp();
  registerSupportConsoleRoutes({
    app,
    db: { ...customerDb({}), ...inboxDb({}), ...fakeDb([], {}) },
    requireSuper: async () => ({ sub: "super", role: "SUPER_ADMIN", tenantId: "admin" }),
    watchmanProbes: {
      rules: async () => ({ found: 2, missing: [] }),
      server: async () => ({ healthy: 2, unhealthy: [] }),
      pbx: async () => ({ reachable: true, readOnly: true }),
    },
  });
  const { out } = await call(app, "/admin/support/watchman", {});
  assert.equal(out.safeToWork, true);
});

// ---------------------------------------------------------------- workbench (Phase 5c)

test("⛔ with no workspace root the workbench is OFF (503) — never a fallback to cwd", async () => {
  const { app } = register([]);
  for (const route of ["/admin/support/workbench/files", "/admin/support/workbench/file"]) {
    const { reply } = await call(app, route, { query: { path: "x" } });
    assert.equal(reply.statusCode, 503, route);
  }
  const run = await call(app, "POST /admin/support/workbench/run", { body: { command: "ls" } });
  assert.equal(run.reply.statusCode, 503);
});

test("⛔ the workbench refuses to run while the Watchman says stop, and audits the refusal", async () => {
  const rdb = rulesDb();
  const app = fakeApp();
  registerSupportConsoleRoutes({
    app,
    db: { ...customerDb({}), ...inboxDb({}), ...fakeDb([], {}), supportGroundRule: rdb.supportGroundRule, agentAuditLog: rdb.agentAuditLog },
    requireSuper: async () => ({ sub: "super", role: "SUPER_ADMIN", tenantId: "admin" }),
    workspaceRoot: "/tmp",
    watchmanProbes: {
      rules: async () => { throw new Error("cannot read rules"); },
      server: async () => ({ healthy: 2, unhealthy: [] }),
      pbx: async () => ({ reachable: true, readOnly: true }),
    },
  });
  const { reply } = await call(app, "POST /admin/support/workbench/run", { body: { command: "git status" } });
  assert.equal(reply.statusCode, 409);
  assert.equal(reply.body.error, "not_safe_to_work");
  assert.equal(rdb.audits.at(-1).event, "workbench.command_refused", "a refusal must be audited too");
  assert.equal(rdb.audits.at(-1).hash.length, 64);
});

test("capabilities says what the workbench may run, and admits when it is off", async () => {
  const off = register([]);
  const a = await call(off.app, "/admin/support/workbench/capabilities", {});
  assert.equal(a.out.available, false);

  const app = fakeApp();
  registerSupportConsoleRoutes({
    app,
    db: { ...customerDb({}), ...inboxDb({}), ...fakeDb([], {}) },
    requireSuper: async () => ({ sub: "super", role: "SUPER_ADMIN", tenantId: "admin" }),
    workspaceRoot: "/tmp",
  });
  const b = await call(app, "/admin/support/workbench/capabilities", {});
  assert.equal(b.out.available, true);
  // ⛔ TWO lists with different meanings: `permitted` is the policy (what the
  // allowlist admits), `allowed` is reality (what this container can actually
  // run). Offering a command the box lacks is how a tool teaches people not to
  // trust it — the api image has no git, so it must not appear in `allowed`.
  assert.ok(b.out.permittedBinaries.includes("git"), "git is permitted by policy");
  assert.ok(!b.out.permittedBinaries.includes("rm"), "rm must never be permitted");
  assert.ok(Array.isArray(b.out.allowedBinaries));
  for (const bin of b.out.allowedBinaries) {
    assert.ok(b.out.permittedBinaries.includes(bin), `${bin} is offered but not permitted`);
  }
  assert.match(b.out.note, /Read-only/);
});

test("⛔ the deployed commit stands in for a branch — the api image is a copy, not a clone", async () => {
  const app = fakeApp();
  registerSupportConsoleRoutes({
    app,
    db: { ...customerDb({}), ...inboxDb({}), ...fakeDb([], {}) },
    requireSuper: async () => ({ sub: "super", role: "SUPER_ADMIN", tenantId: "admin" }),
    workspaceRoot: "/tmp",
  });
  const { out } = await call(app, "/admin/support/workbench/capabilities", {});
  // Either a real branch or a commit — but the field must EXIST, so the status
  // bar never invents one.
  assert.ok("branch" in out && "deployedCommit" in out);
});

// ---------------------------------------------------------------- wiring guards

function readSource(rel: string): string {
  return readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n");
}

test("server.ts registers the module (source guard — fails against pre-change tree)", () => {
  const src = readSource("server.ts");
  assert.ok(src.includes('from "./supportConsole"'), "supportConsole is not imported by server.ts");
  assert.ok(src.includes("registerSupportConsoleRoutes("), "registerSupportConsoleRoutes is never called");
});

test("the /admin/support prefix is inside the global permission gate (the /admin/wake-health class)", () => {
  const src = readSource("server.ts");
  assert.ok(
    /prefix:\s*"\/admin\/support"/.test(src),
    "PORTAL_API_PERMISSION_RULES has no /admin/support entry — the global permission gate silently skips the whole console",
  );
});

test("⛔ the module's writes are exactly reply/takeover/staff-message, and SMS only ever DELEGATES", () => {
  const src = readSource("supportConsole.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const posts = code.match(/app\.post\("([^"]+)"/g) ?? [];
  assert.deepEqual(
    posts.map((p) => p.replace(/app\.post\("/, "").replace(/"$/, "")).sort(),
    [
      "/admin/support/conversations/:id/message",
      "/admin/support/conversations/:id/takeover",
      "/admin/support/ground-rules",
      "/admin/support/ground-rules/check",
      // ⛔ `speak` is a POST because it carries a body, NOT because it mutates
      // anything: it returns mp3 bytes and stores nothing at all. Its own
      // guards live in supportNarration.test.ts (no retry, no storage, no PBX).
      "/admin/support/speak",
      "/admin/support/threads/:id/reply",
      "/admin/support/workbench/run",
      // ⛔ The AGENT's workbench door. It is registered in THIS module, inside
      // the same closure as the human workbench routes, ON PURPOSE: it must
      // ride the identical Watchman verdict, command allowlist, secret-path
      // refusal and rulebook. A module of its own would be a second gate
      // implementation, and the day those two drift the agent is running under
      // rules nobody wrote down. Auth is the only difference (shared secret,
      // fail-closed) because the agent has no JWT.
      "/internal/agent/workbench",
    ],
    "supportConsole.ts grew an unexpected write route",
  );
  assert.ok(!code.includes("applyConfirmedAction"), "supportConsole.ts must not grow its own apply path");
  assert.ok(code.includes("deps.sendSms("), "the SMS reply must delegate to the injected sendConnectChatSmsMessage");
  for (const forbidden of ["smsQueue.add", "sendSMS(", "voipMs", "connectChatMessage.create"]) {
    assert.ok(!code.includes(forbidden), `supportConsole.ts must never send or write chat/SMS messages itself (found ${forbidden})`);
  }
});

// ─────────────── the agent's workbench door (2026-08-24) ───────────────

/**
 * These prove the ONE property the whole design rests on: the agent is held to
 * exactly the gates a person at the desk is held to, because it goes through
 * the same closure. Auth is the only thing that differs.
 */

const SECRET = "test-internal-secret-value";

function withSecret<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.env.AGENT_INTERNAL_SECRET;
  process.env.AGENT_INTERNAL_SECRET = SECRET;
  return fn().finally(() => {
    if (before === undefined) delete process.env.AGENT_INTERNAL_SECRET;
    else process.env.AGENT_INTERNAL_SECRET = before;
  });
}

test("⛔ the agent's door FAILS CLOSED with no secret configured", async () => {
  const before = process.env.AGENT_INTERNAL_SECRET;
  delete process.env.AGENT_INTERNAL_SECRET;
  try {
    const { app } = register([]);
    const { reply } = await call(app, "POST /internal/agent/workbench", {
      headers: {},
      body: { action: "list_files" },
    });
    assert.equal(reply.statusCode, 403);
  } finally {
    if (before !== undefined) process.env.AGENT_INTERNAL_SECRET = before;
  }
});

test("⛔ a wrong secret is refused 403 — never 401, which would mean the route was never reached", async () => {
  await withSecret(async () => {
    const { app } = register([]);
    const { reply } = await call(app, "POST /internal/agent/workbench", {
      headers: { "x-agent-internal-secret": "not-the-secret" },
      body: { action: "list_files" },
    });
    assert.equal(reply.statusCode, 403);
  });
});

test("⛔⛔ an ask-first command is a REFUSAL for the agent — it cannot confirm on its own behalf", async () => {
  await withSecret(async () => {
    // A rulebook whose ask-first list names docker; the human route would offer
    // a confirm button, and the agent must instead be told to go and ask.
    const rdb = {
      supportGroundRule: {
        async findFirst() {
          return {
            version: 3,
            allowed: "Read files, logs and code.",
            never: "Touch payments, billing or pension.",
            askFirst: "Anything about docker.",
            createdAt: new Date(),
          };
        },
      },
    };
    const { app, audits } = register([], { customer: rdb as any, workspaceRoot: "/tmp", watchmanOk: true });
    const { out } = await call(app, "POST /internal/agent/workbench", {
      headers: { "x-agent-internal-secret": SECRET },
      body: { action: "run_command", command: "docker ps" },
    });
    assert.equal(out.ok, false);
    assert.equal(out.refused, true);
    assert.match(String(out.message), /ask the person at the desk/i);
    // ⛔ And it is audited: a door that records only its successes is not an
    // audit trail.
    assert.ok(audits.some((a: any) => a.event === "workbench.agent_refused"), "the refusal was not audited");
  });
});

test("⛔ the agent cannot read a credentials file, even though `cat` is read-only", async () => {
  await withSecret(async () => {
    const { app, audits } = register([], { workspaceRoot: "/tmp", watchmanOk: true });
    const { out } = await call(app, "POST /internal/agent/workbench", {
      headers: { "x-agent-internal-secret": SECRET },
      body: { action: "read_file", path: "../../opt/connectcomms/env/.env.platform" },
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, "refused_secrets");
    assert.ok(audits.some((a: any) => a.event === "workbench.agent_refused"));
  });
});

test("⛔ browsing off Loopcom is refused through the agent's door too", async () => {
  await withSecret(async () => {
    const { app } = register([]);
    const { out } = await call(app, "POST /internal/agent/workbench", {
      headers: { "x-agent-internal-secret": SECRET },
      body: { action: "browse", url: "http://169.254.169.254/latest/meta-data/" },
    });
    assert.equal(out.ok, false);
    assert.equal(out.refused, true);
  });
});

test("⛔ a refusal comes back as DATA (200 ok:false), never a thrown error", async () => {
  await withSecret(async () => {
    const { app } = register([], { workspaceRoot: "/tmp", watchmanOk: true });
    const { reply, out } = await call(app, "POST /internal/agent/workbench", {
      headers: { "x-agent-internal-secret": SECRET },
      body: { action: "run_command", command: "rm -rf /" },
    });
    // A thrown error would hide "your rules say never" behind a generic
    // failure, and the model would simply try again.
    assert.notEqual(reply.statusCode, 500);
    assert.equal(out.ok, false);
    assert.ok(String(out.message).length > 10, "the model must be told WHY so it can adjust");
  });
});

test("⛔ the agent's door is on the JWT bypass list (source guard — a miss answers 401 forever)", () => {
  const src = readSource("jwtPublicRouteBypass.ts");
  assert.ok(
    src.includes("/internal/agent/workbench"),
    "the workbench door is not in jwtPublicRouteBypass.ts — the global JWT hook will 401 it before its own secret check ever runs",
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(code.includes("isInternalAgentWorkbenchPath"), "the bypass const exists but is never used in the chain");
});

test("⛔⛔ the agent and the human share ONE gate implementation (source guard)", () => {
  const src = readSource("supportConsole.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // Both the human route and the agent door must call the SAME decider. If the
  // agent's door ever grows its own allowlist or its own rules read, the two
  // can be given different rules — which is the whole thing this prevents.
  const decideCalls = (code.match(/decideCommandRun\(/g) ?? []).length;
  assert.ok(decideCalls >= 2, "the agent door does not go through decideCommandRun");
  assert.ok(
    !/const\s+AGENT_ALLOWED/.test(code) && !/agentAllowedBinaries/.test(code),
    "supportConsole.ts grew a second, agent-specific allowlist",
  );
  // ⛔ And the agent must never be able to pass `confirmed` — a person is
  // accountable for a confirmation; the agent is not.
  const agentBlock = code.slice(code.indexOf('"/internal/agent/workbench"'));
  const agentBody = agentBlock.slice(0, agentBlock.indexOf("app.post(", 10) + 1 || agentBlock.length);
  assert.ok(
    agentBody.includes("confirmed: false"),
    "the agent's door must pass confirmed:false — it cannot confirm on its own behalf",
  );
});

test("server.ts injects the real sendConnectChatSmsMessage (source guard on the caller)", () => {
  const src = readSource("server.ts");
  const reg = src.slice(src.indexOf("registerSupportConsoleRoutes({"));
  const block = reg.slice(0, reg.indexOf("});") + 3);
  assert.ok(block.includes("sendConnectChatSmsMessage"), "the desk reply is not wired to the one real chat sender");
  assert.ok(block.includes("smsQueue"), "the sender's queue dependency is not passed");
});
