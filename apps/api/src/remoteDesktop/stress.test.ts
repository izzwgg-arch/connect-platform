/**
 * Remote Desktop under LOAD, through the real routes.
 *
 * What a stress run proves here is not throughput (the database is a fake) but
 * that the invariants hold when many things happen at once: one live session per
 * machine however many connects race it, a one-time password that dies exactly
 * once under a 50-way race, a guessing storm that locks the right machine and
 * only that machine, a signal flood that hits the backlog cap instead of the
 * heap, and a lapse sweep over hundreds of sessions that ends exactly the ones
 * that ran out of road.
 *
 * ⛔ The harness is deliberately a copy of attack.test.ts's, not a shared module:
 * a shared fake would let one file's convenience quietly loosen the other's.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

type Row = Record<string, any>;
const state = { users: new Map<string, Row>(), machines: new Map<string, Row>(), shares: new Map<string, Row>(), sessions: new Map<string, Row>(), signals: [] as Row[], events: [] as Row[], control: null as Row | null, revocations: [] as Row[], perms: new Map<string, Set<string>>(), seq: 0, audits: [] as Row[] };
let invalidate: (() => void) | null = null;
function reset() {
  for (const m of [state.users, state.machines, state.shares, state.sessions, state.perms]) m.clear();
  state.signals = []; state.events = []; state.control = null; state.revocations = []; state.seq = 0; state.audits = [];
  invalidate?.();
}
const id = (p: string) => `${p}_${++state.seq}`;
const copy = <T>(v: T): T => (v == null ? v : (JSON.parse(JSON.stringify(v), (_k, x) => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(x) ? new Date(x) : x)) as T));
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === "AND") { if (!(cond as Row[]).every((c) => matches(row, c))) return false; continue; }
    if (k === "OR") { if (!(cond as Row[]).some((c) => matches(row, c))) return false; continue; }
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ("in" in cond) { if (!(cond.in as any[]).includes(v)) return false; continue; }
      if ("not" in cond) { const n = (cond as any).not; if (n === null) { if (v == null) return false; } else if (v === n) return false; continue; }
      if ("gte" in cond) { if (!(v instanceof Date) || v.getTime() < (cond.gte as Date).getTime()) return false; continue; }
      if ("gt" in cond) { if (!(v instanceof Date) || v.getTime() <= (cond.gt as Date).getTime()) return false; continue; }
      if ("lt" in cond) { if (!(v instanceof Date) || v.getTime() >= (cond.lt as Date).getTime()) return false; continue; }
      throw new Error(`fake db: unsupported condition ${JSON.stringify(cond)} on ${k}`);
    }
    if (v !== cond) return false;
  }
  return true;
}
function applyData(row: Row, data: Row) { for (const [k, v] of Object.entries(data)) row[k] = v && typeof v === "object" && !(v instanceof Date) && "increment" in v ? (row[k] || 0) + (v as any).increment : v; }
function table(store: Map<string, Row>, prefix: string, defaults: () => Row) {
  return {
    create: async ({ data }: any) => { const row: Row = { id: id(prefix), createdAt: new Date(), updatedAt: new Date(), ...defaults(), ...data }; store.set(row.id, row); return copy(row); },
    findUnique: async ({ where }: any) => { const [k, v] = Object.entries(where)[0] as [string, any]; return copy([...store.values()].find((r) => r[k] === v) ?? null); },
    findFirst: async ({ where }: any) => copy([...store.values()].find((r) => matches(r, where)) ?? null),
    findMany: async ({ where, take, orderBy }: any) => { let out = [...store.values()].filter((r) => matches(r, where)); if (orderBy?.createdAt === "desc") out = out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()); return copy(take ? out.slice(0, take) : out); },
    update: async ({ where, data }: any) => { const [k, v] = Object.entries(where)[0] as [string, any]; const row = [...store.values()].find((r) => r[k] === v); if (!row) throw new Error("not found"); applyData(row, data); return copy(row); },
    updateMany: async ({ where, data }: any) => { let count = 0; for (const row of store.values()) { if (!matches(row, where)) continue; applyData(row, data); count++; } return { count }; },
  };
}
const db = {
  user: { findFirst: async ({ where }: any) => copy([...state.users.values()].find((u) => matches(u, where)) ?? null), findUnique: async ({ where }: any) => copy(state.users.get(where.id) ?? null), findMany: async ({ where }: any) => copy([...state.users.values()].filter((u) => matches(u, where))) },
  remoteDesktopMachine: table(state.machines, "m", () => ({ osLabel: null, monitors: 1, appVersion: null, unattendedEnabled: false, hasAccessLogin: false, locked: false, lastSeenAt: null, shareFailCount: 0, shareLockedUntil: null, revokedAt: null })),
  remoteDesktopShare: table(state.shares, "sh", () => ({ scope: "company", oneTime: false, expiresAt: null, allowControl: true, allowSound: true, allowMic: false, allowClipboard: false, usedCount: 0, lastUsedAt: null, lastUsedById: null, revokedAt: null, revokedByUserId: null })),
  remoteSupportSession: table(state.sessions, "s", () => ({ status: "REQUESTED", kind: "support", controlRequested: false, controlGranted: false, capabilitiesRequested: [], capabilitiesGranted: [], clientOnCall: false, deviceId: null, deviceLabel: null, inputEventCount: 0, consentAt: null, declinedAt: null, startedAt: null, endedAt: null, endedReason: null, endedBy: null, lastSeenAdminAt: null, lastSeenClientAt: null, machineId: null, shareId: null, clientAuthenticated: false, requestReason: null })),
  remoteSupportSignal: {
    create: async ({ data }: any) => { const row = { id: id("sig"), createdAt: new Date(), consumedAt: null, ...data }; state.signals.push(row); return copy(row); },
    count: async ({ where }: any) => state.signals.filter((s) => matches(s, where)).length,
    findMany: async ({ where, take }: any) => { const out = state.signals.filter((s) => matches(s, where)); return copy(take ? out.slice(0, take) : out); },
    updateMany: async ({ where, data }: any) => { let count = 0; for (const s of state.signals) { if (where?.id?.in && !where.id.in.includes(s.id)) continue; applyData(s, data); count++; } return { count }; },
    deleteMany: async ({ where }: any) => { const before = state.signals.length; state.signals = state.signals.filter((s) => !matches(s, where)); return { count: before - state.signals.length }; },
  },
  remoteSupportEvent: { create: async ({ data }: any) => { const row = { id: id("ev"), at: new Date(), ...data }; state.events.push(row); return copy(row); }, findMany: async ({ where, take }: any) => { const out = state.events.filter((e) => matches(e, where)); return copy(take ? out.slice(0, take) : out); } },
  remoteSupportControl: { findUnique: async () => copy(state.control), upsert: async ({ create, update }: any) => { state.control = state.control ? { ...state.control, ...update } : { id: "global", ...create }; return copy(state.control); } },
  remoteSupportRevocation: { findMany: async ({ where, take }: any) => { const out = state.revocations.filter((r) => matches(r, where)); return copy(take ? out.slice(0, take) : out); }, create: async ({ data }: any) => { const row = { id: id("rev"), createdAt: new Date(), liftedAt: null, liftedByUserId: null, ...data }; state.revocations.push(row); return copy(row); }, updateMany: async () => ({ count: 0 }) },
};
mock.module("@connect/db", { namedExports: { db } });
mock.module("../permissionGates", { namedExports: { userHasActionPermission: async (user: any, key: string) => String(user?.role).toUpperCase() === "SUPER_ADMIN" || state.perms.get(user?.sub)?.has(key) === true } });

let registerRemoteDesktopRoutes: any = null;
let sweepLapsedRemoteDesktopSessions: any = null;
let currentUser: Row | null = null;
const UA = "Loopcom/0.1.17 Electron/41";
const ALL = ["can_use_remote_desktop", "can_connect_by_id", "can_share_own_computer"];
function seedUser(input: { id: string; tenantId: string; keys?: string[] }) {
  state.users.set(input.id, { id: input.id, tenantId: input.tenantId, role: "USER", firstName: input.id, lastName: null, email: `${input.id}@x.test` });
  state.perms.set(input.id, new Set(input.keys ?? ALL));
}
async function buildApp() {
  if (!registerRemoteDesktopRoutes) {
    ({ registerRemoteDesktopRoutes, sweepLapsedRemoteDesktopSessions } = await import("../remoteDesktopRoutes"));
    ({ invalidateRemoteSupportControls: invalidate } = await import("../remoteSupport/controlStore"));
    invalidate?.();
  }
  const app = Fastify();
  app.addHook("preHandler", async (req: any) => { req.user = req.headers["x-test-user"] ? JSON.parse(String(req.headers["x-test-user"])) : currentUser; });
  await registerRemoteDesktopRoutes(app as any, { audit: async (p: any) => { state.audits.push(p); } });
  await app.ready();
  return app;
}
/** ⛔ Concurrency-safe identity: the user rides a header so racing requests cannot borrow each other's session. */
const asHeader = (userId: string) => { const u = state.users.get(userId)!; return { "x-test-user": JSON.stringify({ sub: u.id, tenantId: u.tenantId, role: u.role, email: u.email }) }; };
const req = (app: any, method: string, url: string, payload?: any, headers: Record<string, string> = {}) => app.inject({ method, url, headers: { "user-agent": UA, ...headers }, ...(payload !== undefined ? { payload } : {}) });
const body = (r: any) => JSON.parse(r.body);
const key = (i: number) => (i.toString(16).padStart(2, "0")).repeat(32);
const dev = (i: number) => `win-${i.toString(16).padStart(24, "0")}`;

async function enroll(app: any, owner: string, i: number) {
  const r = await req(app, "POST", "/remote-desktop/machines/register", { deviceId: dev(i), name: `PC ${i}`, unattendedEnabled: true, hasAccessLogin: true }, { ...asHeader(owner), "x-machine-key": key(i) });
  assert.equal(r.statusCode, 200, r.body);
  return body(r).machine;
}

test("100 machines enroll and poll at once: 100 distinct Connect IDs, every poll answered for its own machine only", async () => {
  reset();
  for (let i = 0; i < 100; i++) seedUser({ id: `owner${i}`, tenantId: `T_${i % 7}` });
  const app = await buildApp();
  const machines = await Promise.all([...Array(100)].map((_, i) => enroll(app, `owner${i}`, i)));
  assert.equal(new Set(machines.map((m) => m.connectId)).size, 100, "Connect IDs collided");
  const polls = await Promise.all(machines.map((m, i) => req(app, "POST", "/remote-desktop/machines/poll", { deviceId: dev(i) }, { ...asHeader(`owner${i}`), "x-machine-key": key(i) })));
  polls.forEach((p: any, i: number) => { assert.equal(p.statusCode, 200); assert.equal(body(p).connectId, machines[i].connectId); });
  // Cross-wired: machine i's key against machine j's deviceId is a mismatch, all 100 of them.
  const crossed = await Promise.all(machines.map((_, i) => req(app, "POST", "/remote-desktop/machines/poll", { deviceId: dev((i + 1) % 100) }, { ...asHeader(`owner${i}`), "x-machine-key": key(i) })));
  assert.ok(crossed.every((c: any) => c.statusCode === 403), "a key opened another machine's poll");
  await app.close();
});

test("50 simultaneous connects to ONE machine leave exactly one live session", async () => {
  reset(); seedUser({ id: "izzy", tenantId: "T_A" });
  const app = await buildApp();
  const m = await enroll(app, "izzy", 1);
  const results = await Promise.all([...Array(50)].map(() => req(app, "POST", `/remote-desktop/machines/${m.id}/connect`, { capabilities: ["control"] }, asHeader("izzy"))));
  const ok = results.filter((r: any) => r.statusCode === 200).length;
  const limited = results.filter((r: any) => r.statusCode === 429).length;
  assert.equal(ok + limited, 50, `unexpected statuses: ${[...new Set(results.map((r) => r.statusCode))]}`);
  assert.ok(ok >= 1);
  const live = [...state.sessions.values()].filter((s) => s.machineId === m.id && ["REQUESTED", "CONSENTED", "ACTIVE"].includes(s.status));
  assert.equal(live.length, 1, `${live.length} live sessions on one machine`);
  await app.close();
});

test("a one-time password under a 50-way race across two companies opens exactly one session", async () => {
  reset(); seedUser({ id: "izzy", tenantId: "T_A" });
  for (let i = 0; i < 50; i++) seedUser({ id: `r${i}`, tenantId: i % 2 ? "T_A" : "T_B" });
  const app = await buildApp();
  const m = await enroll(app, "izzy", 1);
  const made = body(await req(app, "POST", `/remote-desktop/machines/${m.id}/shares`, { expiry: "once", scope: "anyone" }, asHeader("izzy")));
  const results = await Promise.all([...Array(50)].map((_, i) => req(app, "POST", "/remote-desktop/connect-by-id", { connectId: m.connectId, password: made.password, capabilities: ["control"] }, asHeader(`r${i}`))));
  assert.equal(results.filter((r: any) => r.statusCode === 200).length, 1);
  assert.equal(state.shares.get(made.share.id)!.usedCount, 1);
  const dist = results.reduce((acc: Record<string, number>, r: any) => { const k = `${r.statusCode}:${JSON.parse(r.body).error ?? "ok"}`; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  assert.equal(results.filter((r: any) => r.statusCode === 401).length, 49, `every loser is told the pair did not open anything — no oracle about WHY: ${JSON.stringify(dist)}`);
  await app.close();
});

test("a guessing storm: 200 wrong passwords across 20 machines lock exactly those 20 and nothing else", async () => {
  reset(); seedUser({ id: "izzy", tenantId: "T_A" }); seedUser({ id: "guesser", tenantId: "T_A" });
  const app = await buildApp();
  const machines = await Promise.all([...Array(25)].map((_, i) => enroll(app, "izzy", i)));
  const targets = machines.slice(0, 20);
  await Promise.all(targets.flatMap((m) => [...Array(10)].map((_, g) => req(app, "POST", "/remote-desktop/connect-by-id", { connectId: m.connectId, password: `bad${g}bad${g}`, capabilities: [] }, asHeader("guesser")))));
  const locked = [...state.machines.values()].filter((x) => x.shareLockedUntil && x.shareLockedUntil.getTime() > Date.now());
  assert.equal(locked.length, 20);
  assert.ok(targets.every((t) => locked.some((l) => l.id === t.id)));
  assert.ok(machines.slice(20).every((m) => !state.machines.get(m.id)!.shareLockedUntil), "the untouched machines are untouched");
  // No session, no share, no transcript row came out of any of it.
  assert.equal(state.sessions.size, 0);
  assert.equal(state.events.length, 0);
  await app.close();
});

test("a signal flood hits the backlog cap, never the heap; the other side still drains what is real", async () => {
  reset(); seedUser({ id: "izzy", tenantId: "T_A" });
  const app = await buildApp();
  const m = await enroll(app, "izzy", 1);
  const s = body(await req(app, "POST", `/remote-desktop/machines/${m.id}/connect`, { capabilities: ["control"] }, asHeader("izzy"))).session;
  await req(app, "POST", `/remote-desktop/sessions/${s.id}/accept`, {}, { ...asHeader("izzy"), "x-machine-key": key(1) });
  const flood = await Promise.all([...Array(400)].map(() => req(app, "POST", `/remote-desktop/sessions/${s.id}/signal`, { kind: "ice", payload: { candidate: "candidate:1 1 udp 1 10.0.0.1 5000 typ host" } }, asHeader("izzy"))));
  const accepted = flood.filter((r: any) => r.statusCode === 200).length;
  const refused = flood.filter((r: any) => r.statusCode === 429).length;
  assert.equal(accepted + refused, 400);
  assert.ok(refused > 0, "the backlog cap never fired under a 400-message flood");
  assert.ok(accepted <= 260, `too many queued: ${accepted}`);
  // The machine drains at most 50 per read and is then handed the rest.
  const first = body(await req(app, "GET", `/remote-desktop/sessions/${s.id}/signal`, undefined, { ...asHeader("izzy"), "x-machine-key": key(1) }));
  assert.ok(first.signals.length <= 50);
  await app.close();
});

test("the lapse sweep over 600 sessions ends exactly the ones that ran out of road", async () => {
  reset(); seedUser({ id: "izzy", tenantId: "T_A" });
  const app = await buildApp();
  const now = Date.now();
  const mk = (over: Partial<Row>) => { const row = { id: id("s"), kind: "desktop", tenantId: "T_A", machineId: "m_x", requestedByUserId: "izzy", targetUserId: "izzy", status: "ACTIVE", startedAt: new Date(now - 60_000), lastSeenAdminAt: new Date(now - 1000), lastSeenClientAt: new Date(now - 1000), expiresAt: new Date(now + 45_000), clientAuthenticated: true, capabilitiesGranted: ["view"], createdAt: new Date(now - 60_000), ...over }; state.sessions.set(row.id, row); return row.id; };
  const healthy = [...Array(200)].map(() => mk({}));
  const viewerGone = [...Array(100)].map(() => mk({ lastSeenAdminAt: new Date(now - 60_000) }));
  const machineGone = [...Array(100)].map(() => mk({ lastSeenClientAt: new Date(now - 60_000) }));
  const tooLong = [...Array(100)].map(() => mk({ startedAt: new Date(now - 5 * 3_600_000) }));
  const neverAnswered = [...Array(50)].map(() => mk({ status: "REQUESTED", startedAt: null, lastSeenAdminAt: null, lastSeenClientAt: null, expiresAt: new Date(now - 1) }));
  const justAsked = [...Array(50)].map(() => mk({ status: "REQUESTED", startedAt: null, lastSeenAdminAt: null, lastSeenClientAt: null, expiresAt: new Date(now + 30_000) }));
  const closed = await sweepLapsedRemoteDesktopSessions(new Date(now));
  assert.equal(closed, 350);
  const st = (ids: string[]) => ids.map((i) => state.sessions.get(i)!.status);
  assert.ok(st(healthy).every((s) => s === "ACTIVE"));
  assert.ok(st(justAsked).every((s) => s === "REQUESTED"));
  assert.ok(st(neverAnswered).every((s) => s === "EXPIRED"));
  assert.ok(st(viewerGone).every((s) => s === "ENDED") && viewerGone.every((i) => state.sessions.get(i)!.endedReason === "viewer_disconnected"));
  assert.ok(st(machineGone).every((s) => s === "ENDED") && machineGone.every((i) => state.sessions.get(i)!.endedReason === "machine_disconnected"));
  assert.ok(st(tooLong).every((s) => s === "ENDED") && tooLong.every((i) => state.sessions.get(i)!.endedReason === "max_duration"));
  // Running it again ends nothing more — idempotent.
  assert.equal(await sweepLapsedRemoteDesktopSessions(new Date(now)), 0);
  await app.close();
});

test("a heartbeat storm from both ends of 40 sessions keeps every session in its own lane", async () => {
  reset();
  for (let i = 0; i < 40; i++) seedUser({ id: `o${i}`, tenantId: `T_${i % 3}` });
  const app = await buildApp();
  const machines = await Promise.all([...Array(40)].map((_, i) => enroll(app, `o${i}`, i)));
  const sessions = await Promise.all(machines.map((m, i) => req(app, "POST", `/remote-desktop/machines/${m.id}/connect`, { capabilities: ["control", "sound"] }, asHeader(`o${i}`)).then((r: any) => body(r).session)));
  await Promise.all(sessions.map((s, i) => req(app, "POST", `/remote-desktop/sessions/${s.id}/accept`, {}, { ...asHeader(`o${i}`), "x-machine-key": key(i) })));
  const beats = await Promise.all(sessions.flatMap((s, i) => [
    ...[...Array(5)].map(() => req(app, "POST", `/remote-desktop/sessions/${s.id}/heartbeat`, {}, asHeader(`o${i}`))),
    ...[...Array(5)].map(() => req(app, "POST", `/remote-desktop/sessions/${s.id}/heartbeat`, { callInProgress: i % 2 === 0 }, { ...asHeader(`o${i}`), "x-machine-key": key(i) })),
    // And a neighbour's key against this session: nobody, every time.
    req(app, "POST", `/remote-desktop/sessions/${s.id}/heartbeat`, {}, { ...asHeader(`o${(i + 1) % 40}`), "x-machine-key": key((i + 1) % 40) }),
  ]));
  const bodies = beats.filter((r: any) => r.statusCode === 200).map(body);
  assert.equal(beats.filter((r: any) => r.statusCode === 403).length, 40, "each neighbour's key must be refused exactly once per session");
  assert.equal(bodies.length, 400);
  sessions.forEach((s, i) => {
    const row = state.sessions.get(s.id)!;
    assert.equal(row.status, "ACTIVE");
    assert.equal(row.clientOnCall, i % 2 === 0, "the machine's call state landed on its own row");
  });
  // A media budget was handed out on every beat; on-call machines got the small one.
  const onCall = bodies.filter((b) => b.callInProgress);
  assert.ok(onCall.length > 0 && onCall.every((b: any) => b.mediaBudget && b.mediaBudget.maxBitrateKbps <= bodies.find((b2: any) => !b2.callInProgress)!.mediaBudget.maxBitrateKbps));
  await app.close();
});
