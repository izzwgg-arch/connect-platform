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
  opts: { allow?: boolean; action?: any; messages?: any[]; customer?: Record<string, any>; sendSms?: any; inbox?: Record<string, any> } = {},
) {
  const app = fakeApp();
  const db = {
    ...customerDb(opts.customer ?? {}),
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
  });
  return { app, db };
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

// ---------------------------------------------------------------- inbox (Phase 3)

test("inbox: threads across companies, newest activity first, tenant names joined", async () => {
  const { app } = register([]);
  const { out } = await call(app, "/admin/support/threads", { query: {} });
  assert.equal(out.threads.length, 2);
  assert.equal(out.threads[0].id, "th_sms");
  assert.equal(out.threads[0].tenantName, "Gesheft"); // t1 joined via tenant table
  assert.equal(out.threads[0].sharedInbox, true);
  assert.equal(out.threads[0].last.preview, "hi!"); // deleted m3 is not the preview
  assert.equal(out.threads[1].type, "DM");
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

test("⛔ the module's ONLY write is the reply, and it only DELEGATES — no second apply path, no second sender", () => {
  const src = readSource("supportConsole.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const posts = code.match(/app\.post\(/g) ?? [];
  assert.equal(posts.length, 1, "supportConsole.ts must have exactly one POST (the SMS reply)");
  assert.ok(!code.includes("applyConfirmedAction"), "supportConsole.ts must not grow its own apply path");
  assert.ok(code.includes("deps.sendSms("), "the reply must delegate to the injected sendConnectChatSmsMessage");
  for (const forbidden of ["smsQueue.add", "sendSMS(", "voipMs", "connectChatMessage.create"]) {
    assert.ok(!code.includes(forbidden), `supportConsole.ts must never send or write messages itself (found ${forbidden})`);
  }
});

test("server.ts injects the real sendConnectChatSmsMessage (source guard on the caller)", () => {
  const src = readSource("server.ts");
  const reg = src.slice(src.indexOf("registerSupportConsoleRoutes({"));
  const block = reg.slice(0, reg.indexOf("});") + 3);
  assert.ok(block.includes("sendConnectChatSmsMessage"), "the desk reply is not wired to the one real chat sender");
  assert.ok(block.includes("smsQueue"), "the sender's queue dependency is not passed");
});
