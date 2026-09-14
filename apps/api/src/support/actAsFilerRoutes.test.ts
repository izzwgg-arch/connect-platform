/**
 * Acting as the person who filed a support ticket.
 *
 * ⛔ What these defend: the agent reaching another company (tenant leakage),
 * running with more authority than the filer's own role, reaching a platform
 * door, changing anything before writes are switched on, and one company taking
 * more than its daily allowance of unattended changes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import {
  registerActAsFilerRoutes,
  checkActPath,
  BLOCKED_PREFIXES,
  ACT_WRITE_TICKETS_PER_TENANT_PER_DAY,
  ACT_TICKET_MAX_AGE_MS,
} from "./actAsFilerRoutes";
import { supportReportReference } from "@connect/shared";

const NOW = Date.parse("2026-09-14T20:00:00Z");
const ESC_ID = "cmu1p94cd0iv7ke130gt1h90m";
const REF = supportReportReference(ESC_ID);

type Opts = {
  esc?: Record<string, any> | null;
  user?: Record<string, any> | null;
  writes?: boolean;
  audits?: Array<Record<string, any>>;
  superOk?: boolean;
};

async function build(o: Opts = {}) {
  const esc = o.esc === undefined
    ? { id: ESC_ID, tenantId: "tenant-trust", clientUserId: "user-vigdor", createdAt: new Date(NOW - 60_000) }
    : o.esc;
  const user = o.user === undefined
    ? { id: "user-vigdor", tenantId: "tenant-trust", email: "v@trust.test", role: "USER", status: "ACTIVE" }
    : o.user;
  const audits = o.audits ?? [];
  const injected: Array<{ method: string; url: string; token: string; body?: unknown }> = [];
  const signed: Array<Record<string, string>> = [];
  const db = {
    agentEscalation: {
      findMany: async () => (esc ? [{ id: esc.id }] : []),
      findUnique: async ({ where }: any) => (esc && where.id === esc.id ? esc : null),
    },
    user: { findUnique: async ({ where }: any) => (user && where.id === user.id ? user : null) },
    auditLog: {
      findMany: async ({ where }: any) =>
        audits.filter((a) => a.tenantId === where.tenantId && a.action === where.action && a.createdAt >= where.createdAt.gte),
    },
  };
  const app = Fastify();
  registerActAsFilerRoutes(app, {
    db,
    requireSuper: (_req, reply) => (o.superOk === false ? (reply.status(403).send({ error: "forbidden" }), null) : { sub: "izzy" }),
    signFilerToken: (claims) => {
      signed.push(claims);
      return "tok-" + claims.sub;
    },
    inject: async (input) => {
      injected.push(input);
      return { statusCode: 200, body: { echoed: input.url } };
    },
    audit: async (p) => {
      audits.push({ ...p, createdAt: new Date(NOW) });
    },
    writesEnabled: () => o.writes === true,
    now: () => NOW,
  });
  const act = (payload: any, ref = REF) =>
    app.inject({ method: "POST", url: `/admin/support/escalations/${ref}/act`, payload });
  return { app, act, injected, signed, audits };
}

describe("the path check", () => {
  test("⛔ every platform door is refused, including under /api and in any case", () => {
    for (const p of BLOCKED_PREFIXES) {
      for (const variant of [p, p + "/x", "/api" + p + "/x", p.toUpperCase() + "/x"]) {
        const r = checkActPath(variant);
        assert.equal(r.ok, false, variant);
      }
    }
  });

  test("⛔ URLs, traversal, encoded traversal and backslashes are refused", () => {
    for (const bad of ["https://evil.test/voice", "//evil.test/x", "/voice/../admin/tenants", "/voice/%2e%2e/admin", "/voice\\x", "voice/x", ""]) {
      assert.equal(checkActPath(bad).ok, false, bad);
    }
  });

  test("⛔ token and tenantContext query parameters cannot change who it runs as", () => {
    assert.equal(checkActPath("/voice/extensions?token=abc").ok, false);
    assert.equal(checkActPath("/voice/extensions?tenantContext=vpbx:other").ok, false);
  });

  test("an ordinary tenant path passes, with the nginx /api prefix stripped", () => {
    const r = checkActPath("/api/voice/extensions/me/control-panel?x=1");
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.path, "/voice/extensions/me/control-panel");
      assert.equal(r.query, "x=1");
    }
  });
});

describe("who it may act as", () => {
  test("⛔ only SUPER_ADMIN may call it", async () => {
    const { act, injected } = await build({ superOk: false });
    const res = await act({ method: "GET", path: "/voice/extensions" });
    assert.equal(res.statusCode, 403);
    assert.equal(injected.length, 0);
  });

  test("⛔ the token carries the DB user's identity, never anything from the request", async () => {
    const { act, signed, injected } = await build();
    const res = await act({ method: "GET", path: "/voice/extensions", sub: "someone-else", tenantId: "tenant-other" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(signed[0], { sub: "user-vigdor", tenantId: "tenant-trust", email: "v@trust.test", role: "USER" });
    assert.equal(injected[0].token, "tok-user-vigdor");
  });

  test("⛔ a filer whose tenant is not the ticket's tenant is refused (no leakage)", async () => {
    const { act, injected } = await build({
      user: { id: "user-vigdor", tenantId: "tenant-other", email: "v@x", role: "USER", status: "ACTIVE" },
    });
    const res = await act({ method: "GET", path: "/voice/extensions" });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, "tenant_mismatch");
    assert.equal(injected.length, 0);
  });

  test("⛔ a platform-staff filer is refused", async () => {
    const { act, injected } = await build({
      user: { id: "user-vigdor", tenantId: "tenant-trust", email: "v@x", role: "SUPER_ADMIN", status: "ACTIVE" },
    });
    assert.equal((await act({ method: "GET", path: "/voice/extensions" })).json().error, "platform_role");
    assert.equal(injected.length, 0);
  });

  test("⛔ a platform alarm, a stale ticket, an inactive filer and an unknown ref are all refused", async () => {
    assert.equal((await (await build({ esc: { id: ESC_ID, tenantId: "t", clientUserId: null, createdAt: new Date(NOW) } })).act({ method: "GET", path: "/x" })).statusCode, 409);
    assert.equal((await (await build({ esc: { id: ESC_ID, tenantId: "tenant-trust", clientUserId: "user-vigdor", createdAt: new Date(NOW - ACT_TICKET_MAX_AGE_MS - 1) } })).act({ method: "GET", path: "/x" })).statusCode, 410);
    assert.equal((await (await build({ user: { id: "user-vigdor", tenantId: "tenant-trust", email: "e", role: "USER", status: "DISABLED" } })).act({ method: "GET", path: "/x" })).statusCode, 403);
    assert.equal((await (await build()).act({ method: "GET", path: "/x" }, "ZZZZZZ")).statusCode, 404);
  });
});

describe("reads and writes", () => {
  test("a read is replayed and audited as a READ", async () => {
    const { act, injected, audits } = await build();
    const res = await act({ method: "GET", path: "/voice/extensions/me/control-panel" });
    assert.equal(res.json().statusCode, 200);
    assert.equal(injected[0].body, undefined);
    assert.equal(audits.at(-1)!.action, "SUPPORT_AGENT_ACT_READ");
    assert.equal(audits.at(-1)!.entityId, ESC_ID);
  });

  test("⛔ a write is refused while writes are switched off, and nothing is replayed", async () => {
    const { act, injected } = await build({ writes: false });
    const res = await act({ method: "POST", path: "/voicemail/greeting/reset", body: {} });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, "writes_disabled");
    assert.equal(injected.length, 0);
  });

  test("with writes on, a write is replayed with its body and audited as a WRITE", async () => {
    const { act, injected, audits } = await build({ writes: true });
    const res = await act({ method: "POST", path: "/voicemail/greeting/reset", body: { greetingType: "busy" } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(injected[0].body, { greetingType: "busy" });
    assert.equal(audits.at(-1)!.action, "SUPPORT_AGENT_ACT_WRITE");
  });

  test("⛔ the per-tenant cap counts distinct tickets, and a ticket already in today's set may continue", async () => {
    const full = Array.from({ length: ACT_WRITE_TICKETS_PER_TENANT_PER_DAY }, (_, i) => ({
      tenantId: "tenant-trust", action: "SUPPORT_AGENT_ACT_WRITE", entityId: "other-" + i, createdAt: new Date(NOW - 1000),
    }));
    const blocked = await build({ writes: true, audits: [...full] });
    const res = await blocked.act({ method: "POST", path: "/voicemail/greeting/reset", body: {} });
    assert.equal(res.statusCode, 429);
    assert.equal(blocked.injected.length, 0);

    const continuing = await build({
      writes: true,
      audits: [...full.slice(1), { tenantId: "tenant-trust", action: "SUPPORT_AGENT_ACT_WRITE", entityId: ESC_ID, createdAt: new Date(NOW - 1000) }],
    });
    assert.equal((await continuing.act({ method: "POST", path: "/voicemail/greeting/reset", body: {} })).statusCode, 200);

    // Another company's changes never count against this one.
    const otherTenant = await build({ writes: true, audits: full.map((a) => ({ ...a, tenantId: "tenant-other" })) });
    assert.equal((await otherTenant.act({ method: "POST", path: "/voicemail/greeting/reset", body: {} })).statusCode, 200);
  });

  test("⛔ a blocked path never reaches the ticket lookup or the replay", async () => {
    const { act, injected, signed } = await build({ writes: true });
    const res = await act({ method: "GET", path: "/admin/tenants" });
    assert.equal(res.statusCode, 403);
    assert.equal(injected.length + signed.length, 0);
  });
});

describe("source guards", () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8").replace(/\r\n/g, "\n");

  test("⛔ server.ts registers it SUPER_ADMIN-gated, with a short-lived token and the env write switch", () => {
    const server = read("../server.ts");
    const at = server.indexOf("registerActAsFilerRoutes(app,");
    assert.ok(at > 0, "registerActAsFilerRoutes must be registered");
    const block = server.slice(at, at + 1400);
    assert.match(block, /requireSuperAdmin\(req, reply\)/);
    assert.match(block, /expiresIn: "2m"/);
    assert.match(block, /SUPPORT_AGENT_WRITES_ENABLED === "1"/);
  });

  test("⛔ the route never forwards the tenant-context header", () => {
    assert.doesNotMatch(read("actAsFilerRoutes.ts"), /x-tenant-context/i);
  });
});
