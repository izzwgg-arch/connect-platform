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

function register(rows: any[], opts: { allow?: boolean; action?: any; messages?: any[] } = {}) {
  const app = fakeApp();
  const db = fakeDb(rows, opts);
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

test("⛔ this module registers no write route — approving a fix stays on the ONE existing apply path", () => {
  const src = readSource("supportConsole.ts");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!code.includes("app.post"), "supportConsole.ts grew a POST — fixes must go through /admin/agent-confirmations/:id/apply");
  assert.ok(!code.includes("applyConfirmedAction"), "supportConsole.ts must not grow its own apply path");
});
