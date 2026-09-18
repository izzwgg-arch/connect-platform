/**
 * Yealink's own MAC-removal ticket door (round 23, 2026-09-17): the client's fences
 * (hardcoded origin, the local cap floor, a session-expired read, a mismatch that is
 * never retried), the hook's dedupe (a phone already filed is never filed twice; two
 * concurrent calls for the same fresh phone file exactly once), and the staff-only
 * routes (403 for anyone else, a save that never echoes the cookie, a read-only verify).
 *
 * Run with: node --experimental-test-module-mocks --import tsx --test
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

process.env.CREDENTIALS_MASTER_KEY ||= "ab".repeat(32); // ephemeral test key, never a deployed secret

// ⛔ `yealinkMacRemoval.ts` imports `db` from `@connect/db` at module load only as a
// default-parameter fallback — every test here passes its own fake `db` explicitly.
mock.module("@connect/db", { namedExports: { db: {} } });

const {
  assertYealinkTicketOrigin,
  fetchMacRemovalUsage,
  fileMacRemoval,
  maybeFileYealinkRelease,
  describeYealinkTicketSession,
  resolveYealinkTicketSession,
  storeYealinkTicketSession,
  validateYealinkTicketSession,
  clearYealinkTicketSessionCache,
} = require("./yealinkMacRemoval");
const { registerYealinkMacRemovalRoutes } = require("./yealinkMacRemovalRoutes");

/* ── fakes ─────────────────────────────────────────────────────────────────── */

const SESSION = { cookie: "JSESSIONID=abc123; ucenter_token=xyz789" };

function fakeAgentSecretTable() {
  const rows: any[] = [];
  return {
    rows,
    findUnique: async ({ where }: any) => rows.find((r) => r.key === where.key) ?? null,
    upsert: async ({ where, update, create }: any) => {
      const idx = rows.findIndex((r) => r.key === where.key);
      if (idx >= 0) { Object.assign(rows[idx], update, { updatedAt: new Date() }); return rows[idx]; }
      const row = { ...create, updatedAt: new Date(), createdAt: new Date() };
      rows.push(row);
      return row;
    },
    deleteMany: async ({ where }: any) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].key === where.key) rows.splice(i, 1);
      return { count: before - rows.length };
    },
  };
}

function fakeDb(over: { managedPhones?: any[]; setupPhones?: any[] } = {}) {
  const managedPhones = over.managedPhones ?? [];
  const setupPhones = over.setupPhones ?? [];
  return {
    agentSecret: fakeAgentSecretTable(),
    managedDeskPhone: {
      rows: managedPhones,
      findUnique: async ({ where }: any) => managedPhones.find((r) => r.macAddress === where.macAddress) ?? null,
      update: async ({ where, data }: any) => {
        const row = managedPhones.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    deskPhoneSetupPhone: {
      rows: setupPhones,
      findUnique: async ({ where }: any) => setupPhones.find((r) => r.id === where.id) ?? null,
      update: async ({ where, data }: any) => {
        const row = setupPhones.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
  };
}

/** A fake `fetch`: `responder(url, init, callNumber)` decides each call's response. */
function fakeFetch(responder: (url: string, init: any, callNumber: number) => any) {
  const calls: Array<{ url: string; init: any }> = [];
  const fn = async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init, calls.length);
  };
  (fn as any).calls = calls;
  return fn;
}

function jsonResponse(status: number, json: any, type = "basic") {
  return { status, type, json: async () => json };
}
function redirectResponse(status = 302) {
  return { status, type: "opaqueredirect", json: async () => { throw new Error("no body"); } };
}

async function saveSession(db: any, cookie = SESSION.cookie) {
  await storeYealinkTicketSession(db, { cookie }, "tester@loopcom.net");
  clearYealinkTicketSessionCache();
}

/* ── the client's fences ──────────────────────────────────────────────────── */

test("origin: the ticket host is hardcoded and never widened", () => {
  assertYealinkTicketOrigin("https://ticket.yealink.com/ticket-common/getMacRemoveInfo");
  assert.throws(() => assertYealinkTicketOrigin("https://evil.example.com/ticket-common/getMacRemoveInfo"));
  assert.throws(() => assertYealinkTicketOrigin("http://ticket.yealink.com/ticket-common/getMacRemoveInfo"), "http, not https");
  assert.throws(() => assertYealinkTicketOrigin("not a url"));
});

test("origin: every request the client sends lands on ticket.yealink.com", async () => {
  const fetch = fakeFetch(() => jsonResponse(200, { data: { removedCount: 0, errorCount: 0 } }));
  const out = await fetchMacRemovalUsage(SESSION, fetch as any);
  assert.equal(out.ok, true);
  const calls = (fetch as any).calls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://ticket.yealink.com/ticket-common/getMacRemoveInfo");
});

test("cap floor: refuses locally at 15 removed, strictly under Yealink's own 20", async () => {
  const fetch = fakeFetch(() => jsonResponse(200, { data: { removedCount: 15, errorCount: 0 } }));
  const out = await fileMacRemoval({ mac: "805ec0112233", serial: "SN1234567" }, { session: SESSION, request: fetch as any });
  assert.deepEqual(out, { ok: false, code: "yealink_cap_reached" });
  assert.equal((fetch as any).calls.length, 1, "never even attempts the filing POST once the floor is hit");
});

test("cap floor: refuses locally at 4 mismatch errors, strictly under Yealink's own 5", async () => {
  const fetch = fakeFetch(() => jsonResponse(200, { data: { removedCount: 0, errorCount: 4 } }));
  const out = await fileMacRemoval({ mac: "805ec0112233", serial: "SN1234567" }, { session: SESSION, request: fetch as any });
  assert.deepEqual(out, { ok: false, code: "yealink_cap_reached" });
  assert.equal((fetch as any).calls.length, 1);
});

test("cap floor: under both floors, the filing proceeds", async () => {
  const fetch = fakeFetch((_url, _init, n) =>
    n === 1 ? jsonResponse(200, { data: { removedCount: 14, errorCount: 3 } }) : jsonResponse(200, { data: { ticketId: "TCK-1" } }));
  const out = await fileMacRemoval({ mac: "805ec0112233", serial: "SN1234567" }, { session: SESSION, request: fetch as any });
  assert.deepEqual(out, { ok: true, ticketId: "TCK-1" });
  assert.equal((fetch as any).calls.length, 2);
});

test("session expired: a redirect on the usage read is reported honestly, never followed", async () => {
  const fetch = fakeFetch(() => redirectResponse());
  const usage = await fetchMacRemovalUsage(SESSION, fetch as any);
  assert.deepEqual(usage, { ok: false, code: "yealink_session_expired" });
  const filed = await fileMacRemoval({ mac: "805ec0112233", serial: "SN1234567" }, { session: SESSION, request: fetch as any });
  assert.deepEqual(filed, { ok: false, code: "yealink_session_expired" });
});

test("session expired: a 401 on the filing POST itself is reported honestly", async () => {
  const fetch = fakeFetch((_url, _init, n) =>
    n === 1 ? jsonResponse(200, { data: { removedCount: 0, errorCount: 0 } }) : jsonResponse(401, null));
  const out = await fileMacRemoval({ mac: "805ec0112233", serial: "SN1234567" }, { session: SESSION, request: fetch as any });
  assert.deepEqual(out, { ok: false, code: "yealink_session_expired" });
});

test("mismatch: status 2 + lockMacMap reads as a serial mismatch, and is never retried", async () => {
  const fetch = fakeFetch((_url, _init, n) =>
    n === 1 ? jsonResponse(200, { data: { removedCount: 0, errorCount: 0 } }) : jsonResponse(200, { status: 2, lockMacMap: { "805ec0112233": true } }));
  const out = await fileMacRemoval({ mac: "805ec0112233", serial: "SN1234567" }, { session: SESSION, request: fetch as any });
  assert.deepEqual(out, { ok: false, code: "mac_serial_mismatch" });
  assert.equal((fetch as any).calls.length, 2, "exactly one GET + one POST — no automatic second attempt");
});

test("invalid input never reaches the network", async () => {
  const fetch = fakeFetch(() => jsonResponse(200, { data: { removedCount: 0, errorCount: 0 } }));
  const out = await fileMacRemoval({ mac: "not-a-mac", serial: "SN1234567" }, { session: SESSION, request: fetch as any });
  assert.deepEqual(out, { ok: false, code: "invalid_input" });
  const short = await fileMacRemoval({ mac: "805ec0112233", serial: "abc" }, { session: SESSION, request: fetch as any });
  assert.deepEqual(short, { ok: false, code: "invalid_input" });
  assert.equal((fetch as any).calls.length, 0);
});

test("not configured: no saved session means no attempt at all", async () => {
  const fetch = fakeFetch(() => jsonResponse(200, { data: { removedCount: 0, errorCount: 0 } }));
  const out = await fileMacRemoval({ mac: "805ec0112233", serial: "SN1234567" }, { session: null, request: fetch as any });
  assert.deepEqual(out, { ok: false, code: "not_configured" });
  assert.equal((fetch as any).calls.length, 0);
});

/* ── session storage: mirrors gdmsCredentials.ts, write-only ────────────────── */

test("session storage: save, describe (never the cookie), clear", async () => {
  const db = fakeDb();
  assert.deepEqual(await describeYealinkTicketSession(db), { configured: false, savedAt: null, note: null });

  const check = validateYealinkTicketSession({ cookie: "" });
  assert.equal(check.ok, false);

  await saveSession(db);
  const described = await describeYealinkTicketSession(db);
  assert.equal(described.configured, true);
  assert.ok(described.savedAt);
  assert.ok(!JSON.stringify(described).includes("JSESSIONID"), "the describe response never carries the cookie");

  const resolved = await resolveYealinkTicketSession(db);
  assert.equal(resolved?.cookie, SESSION.cookie);

  await storeYealinkTicketSession(db, null, "tester@loopcom.net");
  clearYealinkTicketSessionCache();
  assert.deepEqual(await describeYealinkTicketSession(db), { configured: false, savedAt: null, note: null });
});

/* ── the hook: dedupe ─────────────────────────────────────────────────────── */

test("hook dedupe: a phone with a release already on file is skipped, no network call", async () => {
  const db = fakeDb({
    managedPhones: [{ id: "mdp-1", macAddress: "805ec0112233", options: { releaseTicket: { ticketId: "TCK-OLD", filedAt: "2026-01-01T00:00:00.000Z", serialTail: "…1234" } } }],
  });
  await saveSession(db);
  const audits: any[] = [];
  const audit = async (p: any) => { audits.push(p); };
  // No fetch injected at all: if the hook tried to file, it would throw for lack of one.
  await maybeFileYealinkRelease(db, audit, { tenantId: "t1", phoneId: "phone-1", mac: "805ec0112233", serial: "SN1234567" });
  const skip = audits.find((a) => a.action === "DESK_PHONE_RPS_RELEASE_SKIPPED");
  assert.ok(skip, "a skip was audited");
  assert.equal(skip.metadata.reason, "already_filed");
  assert.equal(skip.metadata.ticketId, "TCK-OLD");
  assert.equal(db.managedDeskPhone.rows[0].options.releaseTicket.ticketId, "TCK-OLD", "never overwritten");
});

test("hook dedupe: a fresh phone called twice concurrently files exactly once", async () => {
  const managedPhones = [{ id: "mdp-1", macAddress: "805ec0223344", options: {} }];
  const setupPhones = [{ id: "phone-2", technicalNote: null }];
  const db = fakeDb({ managedPhones, setupPhones });
  await saveSession(db);
  let postCalls = 0;
  const realFetch = fakeFetch((_url, _init, n) => {
    if (String(_url).endsWith("getMacRemoveInfo")) return jsonResponse(200, { data: { removedCount: 0, errorCount: 0 } });
    postCalls++;
    return jsonResponse(200, { data: { ticketId: "TCK-NEW" } });
  });
  // The hook resolves its session and fetch from `db`/module defaults — inject fetch by
  // monkey-patching the global just for this test, since `maybeFileYealinkRelease` does not
  // take a fetch override (it calls `fileMacRemoval({mac, serial}, { db })`, which falls back
  // to the global `fetch`).
  const originalFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = realFetch;
  const audits: any[] = [];
  const audit = async (p: any) => { audits.push(p); };
  try {
    await Promise.all([
      maybeFileYealinkRelease(db, audit, { tenantId: "t1", phoneId: "phone-2", mac: "805ec0223344", serial: "SN9876543" }),
      maybeFileYealinkRelease(db, audit, { tenantId: "t1", phoneId: "phone-2", mac: "805ec0223344", serial: "SN9876543" }),
    ]);
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
  assert.equal(postCalls, 1, "filed exactly once even though called twice concurrently");
  const filed = audits.filter((a) => a.action === "DESK_PHONE_RPS_RELEASE_FILED");
  assert.equal(filed.length, 1);
  assert.equal((managedPhones[0].options as any).releaseTicket?.ticketId, "TCK-NEW");
  assert.match(setupPhones[0].technicalNote || "", /release ticket TCK-NEW filed/);
  assert.ok(!JSON.stringify(setupPhones[0]).includes("SN9876543"), "the full serial never lands in the note");
});

test("hook dedupe: no managed row yet is a clean skip, never a throw", async () => {
  const db = fakeDb();
  await saveSession(db);
  const audits: any[] = [];
  await maybeFileYealinkRelease(db, async (p: any) => { audits.push(p); }, { tenantId: "t1", phoneId: "phone-3", mac: "805ec0334455", serial: "SN1112223" });
  const skip = audits.find((a) => a.action === "DESK_PHONE_RPS_RELEASE_SKIPPED");
  assert.equal(skip?.metadata.reason, "no_managed_row");
});

test("hook: a throwing audit function never breaks the caller", async () => {
  const db = fakeDb({ managedPhones: [{ id: "mdp-1", macAddress: "805ec0445566", options: { releaseTicket: { ticketId: "T", filedAt: "x", serialTail: "…0001" } } }] });
  await assert.doesNotReject(maybeFileYealinkRelease(db, async () => { throw new Error("audit sink is down"); }, { tenantId: "t1", phoneId: "phone-4", mac: "805ec0445566", serial: "SN0000001" }));
});

/* ── routes: SUPER_ADMIN only, never echo, verify is read-only ───────────────── */

const CUSTOMER = { sub: "u1", tenantId: "t1", email: "dina@abc.example", role: "TENANT_ADMIN" };
const STAFF = { sub: "u2", tenantId: "t_loopcom", email: "izzy@loopcom.net", role: "SUPER_ADMIN" };
const isSuper = (u: any) => String(u?.role || "").toUpperCase() === "SUPER_ADMIN";

async function makeRouteApp(user: any, db: any, requestFetch?: any) {
  const app = Fastify();
  app.addHook("preHandler", async (req: any) => { req.user = user; });
  const audits: any[] = [];
  registerYealinkMacRemovalRoutes(app as any, {
    db, getUser: (req: any) => req.user, isSuper, audit: async (p: any) => { audits.push(p); }, request: requestFetch,
  });
  await app.ready();
  return { app, audits };
}

const body = (r: any) => JSON.parse(r.body);

test("routes: every screen refuses anyone who isn't SUPER_ADMIN", async () => {
  const db = fakeDb();
  const { app } = await makeRouteApp(CUSTOMER, db);
  for (const [method, url] of [
    ["GET", "/admin/desk-phones/yealink-ticket-session"],
    ["POST", "/admin/desk-phones/yealink-ticket-session"],
    ["DELETE", "/admin/desk-phones/yealink-ticket-session"],
    ["POST", "/admin/desk-phones/yealink-ticket-session/verify"],
    ["POST", "/admin/desk-phones/yealink-ticket-session/file"],
  ] as const) {
    const r = await app.inject({ method, url, payload: method === "GET" || method === "DELETE" ? undefined : {} });
    assert.equal(r.statusCode, 403, `${method} ${url}`);
  }
});

test("routes: save never echoes the cookie, describe never carries it, verify is read-only, clear works", async () => {
  const db = fakeDb();
  const fetch = fakeFetch(() => jsonResponse(200, { data: { removedCount: 3, errorCount: 1 } }));
  const { app, audits } = await makeRouteApp(STAFF, db, fetch);

  const before = await app.inject({ method: "GET", url: "/admin/desk-phones/yealink-ticket-session" });
  assert.equal(body(before).session.configured, false);

  const invalid = await app.inject({ method: "POST", url: "/admin/desk-phones/yealink-ticket-session", payload: { cookie: "" } });
  assert.equal(invalid.statusCode, 400);

  const saved = await app.inject({ method: "POST", url: "/admin/desk-phones/yealink-ticket-session", payload: { cookie: SESSION.cookie } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.ok(!saved.body.includes("JSESSIONID"), "the save response never echoes the cookie");
  assert.equal(body(saved).session.configured, true);
  assert.ok(audits.some((a) => a.action === "YEALINK_TICKET_SESSION_SAVED"));
  assert.ok(!JSON.stringify(audits).includes("JSESSIONID"), "the audit trail never carries the cookie");

  const verified = await app.inject({ method: "POST", url: "/admin/desk-phones/yealink-ticket-session/verify", payload: {} });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.deepEqual(body(verified), { ok: true, removedCount: 3, errorCount: 1 });
  assert.equal((fetch as any).calls.length, 1, "verify reads once and changes nothing at Yealink");

  const cleared = await app.inject({ method: "DELETE", url: "/admin/desk-phones/yealink-ticket-session" });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(body(cleared).session.configured, false);
});

test("routes: the manual file door mirrors the client's fences", async () => {
  const db = fakeDb();
  await saveSession(db);
  const fetch = fakeFetch((_url, _init, n) =>
    n === 1 ? jsonResponse(200, { data: { removedCount: 0, errorCount: 0 } }) : jsonResponse(200, { data: { ticketId: "TCK-STAFF" } }));
  const { app } = await makeRouteApp(STAFF, db, fetch);

  const badMac = await app.inject({ method: "POST", url: "/admin/desk-phones/yealink-ticket-session/file", payload: { mac: "nope", serial: "SN1234567" } });
  assert.equal(badMac.statusCode, 400);

  const filed = await app.inject({ method: "POST", url: "/admin/desk-phones/yealink-ticket-session/file", payload: { mac: "80:5e:c0:11:22:33", serial: "SN1234567" } });
  assert.equal(filed.statusCode, 200, filed.body);
  assert.equal(body(filed).ticketId, "TCK-STAFF");
});
