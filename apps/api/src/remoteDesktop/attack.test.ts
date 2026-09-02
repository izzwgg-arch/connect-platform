/**
 * Remote Desktop, ATTACKED THROUGH THE REAL ROUTES.
 *
 * ⛔ Every test drives the SHIPPED `registerRemoteDesktopRoutes` on a real Fastify
 * instance against a faithful fake database (evaluates `where`, honours guarded
 * `updateMany`, hands back SNAPSHOT copies). The policy has its own tests; this
 * file proves the handlers ASK it, because every defect of this shape in this
 * repo was a caller.
 *
 * The properties under attack:
 *   - the machine is its KEY, never its user (own-computer sessions have the same
 *     person on both ends);
 *   - a wrong Connect ID and a wrong password are indistinguishable, and the
 *     server never learns a machine's login;
 *   - nothing is granted that the owner did not allow;
 *   - one-time passwords die under a race;
 *   - the kill switch ends desktop sessions too;
 *   - the machine's own poll refuses without its key;
 *   - a computer that is not yours reads like one that does not exist.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createHash } from "node:crypto";

/* ───────────────────────── the fake database ─────────────────────── */

type Row = Record<string, any>;

const state = {
  users: new Map<string, Row>(),
  machines: new Map<string, Row>(),
  shares: new Map<string, Row>(),
  sessions: new Map<string, Row>(),
  signals: [] as Row[],
  events: [] as Row[],
  control: null as Row | null,
  revocations: [] as Row[],
  perms: new Map<string, Set<string>>(),
  seq: 0,
  audits: [] as Row[],
};

let invalidate: (() => void) | null = null;

function reset() {
  for (const m of [state.users, state.machines, state.shares, state.sessions, state.perms]) m.clear();
  state.signals = []; state.events = []; state.control = null; state.revocations = []; state.seq = 0; state.audits = [];
  invalidate?.();
}

const id = (p: string) => `${p}_${++state.seq}`;
const copy = <T>(v: T): T => (v == null ? v : (JSON.parse(JSON.stringify(v), reviveDates) as T));
function reviveDates(_k: string, v: any) {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v)) return new Date(v);
  return v;
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === "AND") { if (!(cond as Row[]).every((c) => matches(row, c))) return false; continue; }
    if (k === "OR") { if (!(cond as Row[]).some((c) => matches(row, c))) return false; continue; }
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ("in" in cond) { if (!(cond.in as any[]).includes(v)) return false; continue; }
      if ("not" in cond) { const n = (cond as any).not; if (n === null) { if (v === null || v === undefined) return false; } else if (v === n) return false; continue; }
      if ("gte" in cond) { if (!(v instanceof Date) || v.getTime() < (cond.gte as Date).getTime()) return false; continue; }
      if ("gt" in cond) { if (!(v instanceof Date) || v.getTime() <= (cond.gt as Date).getTime()) return false; continue; }
      if ("lt" in cond) { if (!(v instanceof Date) || v.getTime() >= (cond.lt as Date).getTime()) return false; continue; }
      throw new Error(`fake db: unsupported condition ${JSON.stringify(cond)} on ${k}`);
    }
    if (v !== cond) return false;
  }
  return true;
}

function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && !(v instanceof Date) && "increment" in v) row[k] = (row[k] || 0) + (v as any).increment;
    else row[k] = v;
  }
}

function table(store: Map<string, Row>, prefix: string, defaults: () => Row) {
  return {
    create: async ({ data }: any) => {
      const row: Row = { id: id(prefix), createdAt: new Date(), updatedAt: new Date(), ...defaults(), ...data };
      // Unique constraints the schema declares.
      if (prefix === "m") {
        for (const r of store.values()) {
          if (r.deviceId === row.deviceId) throw Object.assign(new Error("Unique constraint failed on deviceId"), { code: "P2002" });
          if (r.connectId === row.connectId) throw Object.assign(new Error("Unique constraint failed on connectId"), { code: "P2002" });
        }
      }
      store.set(row.id, row);
      return copy(row);
    },
    findUnique: async ({ where }: any) => {
      const [k, v] = Object.entries(where)[0] as [string, any];
      return copy([...store.values()].find((r) => r[k] === v) ?? null);
    },
    findFirst: async ({ where }: any) => copy([...store.values()].find((r) => matches(r, where)) ?? null),
    findMany: async ({ where, take, orderBy }: any) => {
      let out = [...store.values()].filter((r) => matches(r, where));
      if (orderBy?.createdAt === "desc") out = out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return copy(take ? out.slice(0, take) : out);
    },
    update: async ({ where, data }: any) => {
      const [k, v] = Object.entries(where)[0] as [string, any];
      const row = [...store.values()].find((r) => r[k] === v);
      if (!row) throw new Error("not found");
      applyData(row, data);
      return copy(row);
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of store.values()) { if (!matches(row, where)) continue; applyData(row, data); count++; }
      return { count };
    },
  };
}

const db = {
  user: {
    findFirst: async ({ where }: any) => copy([...state.users.values()].find((u) => matches(u, where)) ?? null),
    findUnique: async ({ where }: any) => copy(state.users.get(where.id) ?? null),
    findMany: async ({ where }: any) => copy([...state.users.values()].filter((u) => matches(u, where))),
  },
  remoteDesktopMachine: table(state.machines, "m", () => ({ osLabel: null, monitors: 1, appVersion: null, unattendedEnabled: false, hasAccessLogin: false, locked: false, lastSeenAt: null, shareFailCount: 0, shareLockedUntil: null, revokedAt: null })),
  remoteDesktopShare: table(state.shares, "sh", () => ({ scope: "company", oneTime: false, expiresAt: null, allowControl: true, allowSound: true, allowMic: false, allowClipboard: false, usedCount: 0, lastUsedAt: null, lastUsedById: null, revokedAt: null, revokedByUserId: null })),
  remoteSupportSession: table(state.sessions, "s", () => ({
    status: "REQUESTED", kind: "support", controlRequested: false, controlGranted: false, capabilitiesRequested: [], capabilitiesGranted: [], clientOnCall: false,
    deviceId: null, deviceLabel: null, inputEventCount: 0, consentAt: null, declinedAt: null, startedAt: null, endedAt: null, endedReason: null, endedBy: null,
    lastSeenAdminAt: null, lastSeenClientAt: null, machineId: null, shareId: null, clientAuthenticated: false, requestReason: null,
  })),
  remoteSupportSignal: {
    create: async ({ data }: any) => { const row = { id: id("sig"), createdAt: new Date(), consumedAt: null, ...data }; state.signals.push(row); return copy(row); },
    count: async ({ where }: any) => state.signals.filter((s) => matches(s, where)).length,
    findMany: async ({ where, take }: any) => { const out = state.signals.filter((s) => matches(s, where)); return copy(take ? out.slice(0, take) : out); },
    updateMany: async ({ where, data }: any) => { let count = 0; for (const s of state.signals) { if (where?.id?.in && !where.id.in.includes(s.id)) continue; applyData(s, data); count++; } return { count }; },
    deleteMany: async () => ({ count: 0 }),
  },
  remoteSupportEvent: {
    create: async ({ data }: any) => { const row = { id: id("ev"), at: new Date(), ...data }; state.events.push(row); return copy(row); },
    findMany: async ({ where, take }: any) => { const out = state.events.filter((e) => matches(e, where)); return copy(take ? out.slice(0, take) : out); },
  },
  remoteSupportControl: {
    findUnique: async () => copy(state.control),
    upsert: async ({ create, update }: any) => { state.control = state.control ? { ...state.control, ...update } : { id: "global", ...create }; return copy(state.control); },
  },
  remoteSupportRevocation: {
    findMany: async ({ where, take }: any) => { const out = state.revocations.filter((r) => matches(r, where)); return copy(take ? out.slice(0, take) : out); },
    create: async ({ data }: any) => { const row = { id: id("rev"), createdAt: new Date(), liftedAt: null, liftedByUserId: null, ...data }; state.revocations.push(row); return copy(row); },
    updateMany: async ({ where, data }: any) => { let count = 0; for (const r of state.revocations) { if (!matches(r, where)) continue; applyData(r, data); count++; } return { count }; },
  },
};

mock.module("@connect/db", { namedExports: { db } });
mock.module("../permissionGates", {
  namedExports: {
    userHasActionPermission: async (user: any, key: string) => {
      if (String(user?.role).toUpperCase() === "SUPER_ADMIN") return true;
      return state.perms.get(user?.sub)?.has(key) === true;
    },
  },
});

let registerRemoteDesktopRoutes: any = null;

/* ─────────────────────────── the harness ─────────────────────────── */

function seedUser(input: { id: string; tenantId: string; role?: string; keys?: string[] }) {
  state.users.set(input.id, { id: input.id, tenantId: input.tenantId, role: input.role || "USER", firstName: input.id, lastName: null, email: `${input.id}@example.test` });
  state.perms.set(input.id, new Set(input.keys || []));
}

let currentUser: Row | null = null;
/** The desktop app's user agent, or a browser's. Set per request. */
let currentUa = "Loopcom/0.1.17 Electron/41";

async function buildApp() {
  if (!registerRemoteDesktopRoutes) {
    ({ registerRemoteDesktopRoutes } = await import("../remoteDesktopRoutes"));
    ({ invalidateRemoteSupportControls: invalidate } = await import("../remoteSupport/controlStore"));
    invalidate?.();
  }
  const app = Fastify();
  app.addHook("preHandler", async (req: any) => { req.user = currentUser; });
  await registerRemoteDesktopRoutes(app as any, { audit: async (p: any) => { state.audits.push(p as Row); } });
  await app.ready();
  return app;
}

const as = (userId: string) => {
  const u = state.users.get(userId);
  if (!u) throw new Error(`no such seeded user ${userId}`);
  currentUser = { sub: u.id, tenantId: u.tenantId, role: u.role, email: u.email };
};

async function req(app: any, method: string, url: string, payload?: any, headers: Record<string, string> = {}) {
  return app.inject({ method, url, headers: { "user-agent": currentUa, ...headers }, ...(payload !== undefined ? { payload } : {}) });
}
const body = (r: any) => JSON.parse(r.body);

const ALL = ["can_use_remote_desktop", "can_connect_by_id", "can_share_own_computer"];
function seedCast() {
  seedUser({ id: "izzy", tenantId: "T_A", keys: ALL });
  seedUser({ id: "colleague", tenantId: "T_A", keys: ALL });
  seedUser({ id: "viewer_only", tenantId: "T_A", keys: ["can_use_remote_desktop"] });
  seedUser({ id: "outsider", tenantId: "T_B", keys: ALL });
  seedUser({ id: "nobody", tenantId: "T_A" });
  seedUser({ id: "root", tenantId: "T_ADMIN", role: "SUPER_ADMIN" });
}

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const DEV_A = "win-aaaaaaaaaaaaaaaaaaaaaaaa";
const withKey = (key: string) => ({ "x-machine-key": key });

/** The Windows app on `owner`'s desk registers itself, switched on, login set. */
async function enrollMachine(app: any, owner: string, opts: { key?: string; deviceId?: string; name?: string; unattended?: boolean; login?: boolean } = {}) {
  as(owner);
  const r = await req(app, "POST", "/remote-desktop/machines/register", {
    deviceId: opts.deviceId ?? DEV_A, name: opts.name ?? "Office PC", osLabel: "Windows 11", monitors: 2, appVersion: "0.1.17",
    unattendedEnabled: opts.unattended ?? true, hasAccessLogin: opts.login ?? true, locked: false,
  }, withKey(opts.key ?? KEY_A));
  assert.equal(r.statusCode, 200, `enroll failed: ${r.body}`);
  return body(r).machine;
}

async function ownConnect(app: any, user: string, machineId: string, caps = ["control", "sound", "mic", "clipboard"]) {
  as(user);
  return req(app, "POST", `/remote-desktop/machines/${machineId}/connect`, { capabilities: caps, fromLabel: "Home laptop" });
}

async function hostAccept(app: any, owner: string, sessionId: string, key = KEY_A) {
  as(owner);
  return req(app, "POST", `/remote-desktop/sessions/${sessionId}/accept`, {}, withKey(key));
}

/* ═══════════════════════════ the attacks ══════════════════════════ */

test("a machine registers with its key, the server keeps only the hash, and the same key on another install is another machine", async () => {
  reset(); seedCast();
  const app = await buildApp();
  const m = await enrollMachine(app, "izzy");
  assert.match(m.connectId, /^[1-9]\d{8}$/);
  const stored = state.machines.get(m.id)!;
  assert.equal("machineKey" in stored, false);
  assert.equal(stored.machineKeyHash, createHash("sha256").update(`${DEV_A}\u0000${KEY_A}`).digest("hex"));
  assert.equal(JSON.stringify(body(await req(app, "GET", "/remote-desktop/machines"))).includes(KEY_A), false, "the raw key never appears in a response");
  assert.equal(JSON.stringify(body(await req(app, "GET", "/remote-desktop/machines"))).includes(stored.machineKeyHash), false, "nor its hash");

  // Re-registering with the SAME deviceId but a DIFFERENT key is refused — a stolen install id gets nothing.
  as("outsider");
  const stolen = await req(app, "POST", "/remote-desktop/machines/register", { deviceId: DEV_A, name: "Office PC", unattendedEnabled: true, hasAccessLogin: true }, withKey(KEY_B));
  assert.equal(stolen.statusCode, 403);
  assert.equal(body(stolen).error, "machine_key_mismatch");
  assert.equal(state.machines.get(m.id)!.ownerUserId, "izzy", "ownership did not move");

  // No key at all: refused before anything is read.
  const bare = await req(app, "POST", "/remote-desktop/machines/register", { deviceId: DEV_A, name: "x", unattendedEnabled: true, hasAccessLogin: true });
  assert.equal(bare.statusCode, 400);
  await app.close();
});

test("the machine's poll needs its key; the wrong key is 403, a removed machine is 410", async () => {
  reset(); seedCast();
  const app = await buildApp();
  const m = await enrollMachine(app, "izzy");
  as("izzy");
  assert.equal((await req(app, "POST", "/remote-desktop/machines/poll", { deviceId: DEV_A })).statusCode, 400, "no key");
  assert.equal((await req(app, "POST", "/remote-desktop/machines/poll", { deviceId: DEV_A }, withKey(KEY_B))).statusCode, 403, "wrong key");
  const ok = await req(app, "POST", "/remote-desktop/machines/poll", { deviceId: DEV_A, locked: true }, withKey(KEY_A));
  assert.equal(ok.statusCode, 200);
  assert.equal(body(ok).connectId, m.connectId);
  assert.equal(state.machines.get(m.id)!.locked, true, "the poll carries the lock state");
  // The owner removes it; the install keeps polling and is told, honestly, to stop.
  assert.equal((await req(app, "DELETE", `/remote-desktop/machines/${m.id}`)).statusCode, 200);
  assert.equal((await req(app, "POST", "/remote-desktop/machines/poll", { deviceId: DEV_A }, withKey(KEY_A))).statusCode, 410);
  await app.close();
});

test("a computer that is not yours reads like one that does not exist — connect, rename, remove, shares", async () => {
  reset(); seedCast();
  const app = await buildApp();
  const m = await enrollMachine(app, "izzy");
  for (const who of ["colleague", "outsider", "root"]) {
    as(who);
    assert.equal((await req(app, "POST", `/remote-desktop/machines/${m.id}/connect`, { capabilities: ["control"] })).statusCode, 404, `${who} connect`);
    assert.equal((await req(app, "PATCH", `/remote-desktop/machines/${m.id}`, { name: "Pwned" })).statusCode, 404, `${who} rename`);
    assert.equal((await req(app, "DELETE", `/remote-desktop/machines/${m.id}`)).statusCode, 404, `${who} remove`);
    assert.equal((await req(app, "GET", `/remote-desktop/machines/${m.id}/shares`)).statusCode, 404, `${who} shares`);
    assert.equal((await req(app, "POST", `/remote-desktop/machines/${m.id}/shares`, { expiry: "24h", scope: "company" })).statusCode, 404, `${who} share`);
    const missing = await req(app, "POST", `/remote-desktop/machines/does-not-exist/connect`, { capabilities: ["control"] });
    assert.equal(missing.statusCode, 404);
  }
  as("izzy");
  const mine = body(await req(app, "GET", "/remote-desktop/machines")).machines;
  assert.equal(mine.length, 1);
  as("colleague");
  assert.equal(body(await req(app, "GET", "/remote-desktop/machines")).machines.length, 0, "a colleague's list does not show my computer");
  assert.equal(state.machines.get(m.id)!.name, "Office PC");
  await app.close();
});

test("own computer: switched off, no login, or offline → a specific refusal, never a session", async () => {
  reset(); seedCast();
  const app = await buildApp();
  const off = await enrollMachine(app, "izzy", { unattended: false, deviceId: "win-off0000000000000000000000", key: KEY_B });
  let r = await ownConnect(app, "izzy", off.id);
  assert.equal(r.statusCode, 409); assert.equal(body(r).error, "unattended_off");
  const noLogin = await enrollMachine(app, "izzy", { login: false, deviceId: "win-nol0000000000000000000000", key: "c".repeat(64) });
  r = await ownConnect(app, "izzy", noLogin.id);
  assert.equal(r.statusCode, 409); assert.equal(body(r).error, "no_access_login");
  const on = await enrollMachine(app, "izzy");
  state.machines.get(on.id)!.lastSeenAt = new Date(Date.now() - 10 * 60_000);
  r = await ownConnect(app, "izzy", on.id);
  assert.equal(r.statusCode, 409); assert.equal(body(r).error, "machine_offline");
  as("nobody");
  state.machines.get(on.id)!.lastSeenAt = new Date();
  state.machines.get(on.id)!.ownerUserId = "nobody";
  r = await req(app, "POST", `/remote-desktop/machines/${on.id}/connect`, { capabilities: ["control"] });
  assert.equal(r.statusCode, 403); assert.equal(body(r).error, "missing_permission");
  assert.equal([...state.sessions.values()].length, 0, "no session was written by any refusal");
  await app.close();
});

test("⛔ own computer, same person on BOTH ends: the key tells them apart, and nothing is shown before the login verdict", async () => {
  reset(); seedCast();
  const app = await buildApp();
  const m = await enrollMachine(app, "izzy");
  const opened = await ownConnect(app, "izzy", m.id);
  assert.equal(opened.statusCode, 200, opened.body);
  const s = body(opened).session;
  assert.equal(s.kind, "desktop");
  assert.equal(s.authRequired, true);
  assert.equal(s.clientAuthenticated, false);
  assert.deepEqual(s.capabilitiesGranted, ["view", "control", "sound", "mic", "clipboard"], "own computer: everything asked for");

  // The viewer (izzy, no key) cannot ACCEPT — only the machine can.
  as("izzy");
  const viewerAccept = await req(app, "POST", `/remote-desktop/sessions/${s.id}/accept`, {});
  assert.equal(viewerAccept.statusCode, 403);
  // A colleague's key, or a wrong key, is nobody.
  assert.equal((await req(app, "POST", `/remote-desktop/sessions/${s.id}/accept`, {}, withKey(KEY_B))).statusCode, 403);
  // The machine accepts.
  const acc = await hostAccept(app, "izzy", s.id);
  assert.equal(acc.statusCode, 200, acc.body);
  assert.equal(body(acc).session.status, "CONSENTED");

  // Heartbeats: role is decided by the key, not the user.
  const hbViewer = body(await req(app, "POST", `/remote-desktop/sessions/${s.id}/heartbeat`, {}));
  assert.equal(hbViewer.role, "VIEWER");
  assert.equal(hbViewer.canControl, false, "no control before the login");
  const hbMachine = body(await req(app, "POST", `/remote-desktop/sessions/${s.id}/heartbeat`, { callInProgress: true }, withKey(KEY_A)));
  assert.equal(hbMachine.role, "MACHINE");
  assert.equal(hbMachine.callInProgress, true);
  // ⛔ Rule 15: only the machine may say a call is up.
  const hbViewerLies = body(await req(app, "POST", `/remote-desktop/sessions/${s.id}/heartbeat`, { callInProgress: false }));
  assert.equal(hbViewerLies.callInProgress, true, "the viewer cannot clear the machine's call state");

  // The VIEWER cannot report a login verdict — only the machine.
  assert.equal((await req(app, "POST", `/remote-desktop/sessions/${s.id}/login-result`, { ok: true })).statusCode, 403);
  // Two wrong tries, reported by the machine, become COUNTS in the transcript — never a username.
  await req(app, "POST", `/remote-desktop/sessions/${s.id}/login-result`, { ok: false, attemptsLeft: 4, username: "leak-me", password: "leak-me-too" }, withKey(KEY_A));
  const transcript = JSON.stringify(state.events);
  assert.equal(transcript.includes("leak-me"), false, "the transcript must never carry a typed credential");
  assert.match(transcript, /4 tries left/);
  // The verdict flips clientAuthenticated; control becomes possible.
  assert.equal((await req(app, "POST", `/remote-desktop/sessions/${s.id}/login-result`, { ok: true }, withKey(KEY_A))).statusCode, 200);
  const hbAfter = body(await req(app, "POST", `/remote-desktop/sessions/${s.id}/heartbeat`, {}));
  assert.equal(hbAfter.clientAuthenticated, true);
  assert.equal(hbAfter.canControl, true);
  assert.equal(hbAfter.status, "ACTIVE");
  await app.close();
});

test("five wrong logins, reported by the machine, end the session with login_locked", async () => {
  reset(); seedCast();
  const app = await buildApp();
  const m = await enrollMachine(app, "izzy");
  const s = body(await ownConnect(app, "izzy", m.id)).session;
  await hostAccept(app, "izzy", s.id);
  const r = await req(app, "POST", `/remote-desktop/sessions/${s.id}/login-result`, { ok: false, attemptsLeft: 0, locked: true }, withKey(KEY_A));
  assert.equal(r.statusCode, 200);
  assert.equal(body(r).ended, true);
  const row = state.sessions.get(s.id)!;
  assert.equal(row.status, "ENDED");
  assert.equal(row.endedReason, "login_locked");
  assert.ok(state.audits.some((a) => a.action === "REMOTE_DESKTOP_LOGIN_LOCKED"));
  // Nothing more can happen on it.
  assert.equal((await req(app, "POST", `/remote-desktop/sessions/${s.id}/heartbeat`, {})).statusCode, 409);
  await app.close();
});

test("⛔ connect by ID: wrong id, wrong password, other company, expired, used, revoked — ONE answer; and only from the app", async () => {
  reset(); seedCast();
  const app = await buildApp();
  const m = await enrollMachine(app, "izzy");
  as("izzy");
  const made = body(await req(app, "POST", `/remote-desktop/machines/${m.id}/shares`, { expiry: "24h", scope: "company", allowControl: true, allowSound: true, allowMic: false, allowClipboard: false }));
  assert.match(made.password, /^[a-z2-9]{4}-[a-z2-9]{4}$/i);
  assert.equal(made.connectId, m.connectId);
  // The password is shown once: the share row holds only a hash, the list never returns it.
  assert.equal(JSON.stringify([...state.shares.values()]).includes(made.password), false);
  assert.equal(JSON.stringify(body(await req(app, "GET", `/remote-desktop/machines/${m.id}/shares`))).includes(made.password), false);

  const attempt = (who: string, connectId: string, password: string, ua = "Loopcom/0.1.17 Electron/41") => {
    as(who); currentUa = ua;
    return req(app, "POST", "/remote-desktop/connect-by-id", { connectId, password, capabilities: ["control", "sound", "mic", "clipboard"], fromLabel: "their laptop" });
  };
  const answers = await Promise.all([
    attempt("colleague", "123456789", made.password),          // no such id
    attempt("colleague", m.connectId, "wrong-pass"),            // wrong password
    attempt("outsider", m.connectId, made.password),            // other company, company-only password
  ]);
  currentUa = "Loopcom/0.1.17 Electron/41";
  for (const a of answers) {
    assert.equal(a.statusCode, 401, a.body);
    assert.equal(body(a).error, "invalid_id_or_password");
  }
  const texts = new Set(answers.map((a) => body(a).message));
  assert.equal(texts.size, 1, "every mismatch must read identically");
  // A browser holding the RIGHT pair is refused for being a browser — a fact about the caller, so it is specific.
  const browser = await attempt("colleague", m.connectId, made.password, "Mozilla/5.0 Chrome/128");
  assert.equal(browser.statusCode, 403);
  assert.equal(body(browser).error, "desktop_app_required");
  currentUa = "Loopcom/0.1.17 Electron/41";
  // No permission: specific too.
  const noPerm = await attempt("viewer_only", m.connectId, made.password);
  assert.equal(noPerm.statusCode, 403);
  assert.equal(body(noPerm).error, "missing_connect_permission");

  // The RIGHT pair, from the right company, in the app: a session with ONLY what the owner allowed.
  const ok = await attempt("colleague", m.connectId, made.password);
  assert.equal(ok.statusCode, 200, ok.body);
  const s = body(ok).session;
  assert.equal(s.authRequired, false, "a share session is authenticated by the password");
  assert.equal(s.clientAuthenticated, true);
  assert.deepEqual(s.capabilitiesGranted, ["view", "control", "sound"], "mic and clipboard were not allowed by the owner");
  assert.equal(s.shareId, made.share.id);
  assert.match(JSON.stringify(state.events), /share_used/);
  await app.close();
});

test("guessing passwords against a real Connect ID locks it for 15 minutes — and the right password is refused during the lockout", async () => {
  reset(); seedCast();
  const app = await buildApp();
  const m = await enrollMachine(app, "izzy");
  as("izzy");
  const made = body(await req(app, "POST", `/remote-desktop/machines/${m.id}/shares`, { expiry: "standing", scope: "company" }));
  as("colleague");
  for (let i = 0; i < 5; i++) {
    const r = await req(app, "POST", "/remote-desktop/connect-by-id", { connectId: m.connectId, password: `guess-${i}xx`, capabilities: [] });
    assert.equal(r.statusCode, 401);
  }
  const row = state.machines.get(m.id)!;
  assert.ok(row.shareLockedUntil && row.shareLockedUntil.getTime() > Date.now() + 14 * 60_000);
  const right = await req(app, "POST", "/remote-desktop/connect-by-id", { connectId: m.connectId, password: made.password, capabilities: [] });
  assert.equal(right.statusCode, 429);
  assert.equal(body(right).error, "locked_out");
  // Guesses at an id that is NOBODY's computer lock nothing (there is nothing to protect).
  for (let i = 0; i < 6; i++) await req(app, "POST", "/remote-desktop/connect-by-id", { connectId: "999999999", password: "xxxx-xxxx", capabilities: [] });
  assert.equal([...state.machines.values()].filter((x) => x.shareLockedUntil && x.id !== m.id).length, 0);
  await app.close();
});

test("⛔ a one-time password opens exactly ONE session under a 20-way race", async () => {
  reset(); seedCast();
  const app = await buildApp();
  const m = await enrollMachine(app, "izzy");
  as("izzy");
  const made = body(await req(app, "POST", `/remote-desktop/machines/${m.id}/shares`, { expiry: "once", scope: "anyone" }));
  const racers = [...Array(20)].map((_, i) => {
    seedUser({ id: `racer${i}`, tenantId: i % 2 ? "T_A" : "T_B", keys: ALL });
    return i;
  });
  const results = await Promise.all(racers.map((i) => {
    // Each racer signs in and fires without awaiting the others.
    currentUser = { sub: `racer${i}`, tenantId: i % 2 ? "T_A" : "T_B", role: "USER", email: "x" };
    return req(app, "POST", "/remote-desktop/connect-by-id", { connectId: m.connectId, password: made.password, capabilities: ["control"] });
  }));
  const wins = results.filter((r) => r.statusCode === 200);
  assert.equal(wins.length, 1, `one-time password opened ${wins.length} sessions`);
  assert.equal(state.shares.get(made.share.id)!.usedCount, 1);
  const live = [...state.sessions.values()].filter((s) => s.kind === "desktop" && s.status !== "ENDED");
  assert.equal(live.length, 1, "one live session for one machine");
  await app.close();
});

test("a second connection to the same machine supersedes the first — never two viewers on one mouse", async () => {
  reset(); seedCast();
  const app = await buildApp();
  const m = await enrollMachine(app, "izzy");
  const first = body(await ownConnect(app, "izzy", m.id)).session;
  await hostAccept(app, "izzy", first.id);
  const second = body(await ownConnect(app, "izzy", m.id)).session;
  assert.equal(state.sessions.get(first.id)!.status, "ENDED");
  assert.equal(state.sessions.get(first.id)!.endedReason, "superseded");
  assert.equal(state.sessions.get(second.id)!.status, "REQUESTED");
  await app.close();
});

test("⛔ the kill switch ends desktop sessions: a live one dies at its next heartbeat, a new one is refused", async () => {
  reset(); seedCast();
  const app = await buildApp();
  const m = await enrollMachine(app, "izzy");
  const s = body(await ownConnect(app, "izzy", m.id)).session;
  await hostAccept(app, "izzy", s.id);
  state.control = { id: "global", enabled: false, disabledByUserId: "root", disabledAt: new Date(), reason: "emergency" };
  invalidate?.();
  const hb = await req(app, "POST", `/remote-desktop/sessions/${s.id}/heartbeat`, {}, withKey(KEY_A));
  assert.equal(hb.statusCode, 409);
  assert.equal(state.sessions.get(s.id)!.status, "ENDED");
  const again = await ownConnect(app, "izzy", m.id);
  assert.equal(again.statusCode, 403);
  // ⛔ END still works while the switch is off — nothing may refuse a stop.
  const s2 = { id: id("s") };
  state.sessions.set(s2.id, { ...state.sessions.get(s.id)!, id: s2.id, status: "ACTIVE", endedAt: null, endedReason: null });
  const end = await req(app, "POST", `/remote-desktop/sessions/${s2.id}/end`, {}, withKey(KEY_A));
  assert.equal(end.statusCode, 200, end.body);
  assert.equal(state.sessions.get(s2.id)!.status, "ENDED");
  await app.close();
});

test("signals: each side only ever reads the OTHER side's, and a stranger reads nothing", async () => {
  reset(); seedCast();
  const app = await buildApp();
  const m = await enrollMachine(app, "izzy");
  const s = body(await ownConnect(app, "izzy", m.id)).session;
  await hostAccept(app, "izzy", s.id);
  as("izzy");
  // Machine offers, viewer answers.
  assert.equal((await req(app, "POST", `/remote-desktop/sessions/${s.id}/signal`, { kind: "offer", payload: { type: "offer", sdp: "v=0 machine" } }, withKey(KEY_A))).statusCode, 200);
  assert.equal((await req(app, "POST", `/remote-desktop/sessions/${s.id}/signal`, { kind: "answer", payload: { type: "answer", sdp: "v=0 viewer" } })).statusCode, 200);
  const viewerSees = body(await req(app, "GET", `/remote-desktop/sessions/${s.id}/signal`));
  assert.deepEqual(viewerSees.signals.map((x: any) => x.kind), ["offer"], "the viewer sees the machine's offer, not its own answer");
  const machineSees = body(await req(app, "GET", `/remote-desktop/sessions/${s.id}/signal`, undefined, withKey(KEY_A)));
  assert.deepEqual(machineSees.signals.map((x: any) => x.kind), ["answer"]);
  // Consumed: a second read is empty.
  assert.deepEqual(body(await req(app, "GET", `/remote-desktop/sessions/${s.id}/signal`)).signals, []);
  // A colleague, signed in as someone else, is nobody.
  as("colleague");
  assert.equal((await req(app, "GET", `/remote-desktop/sessions/${s.id}/signal`)).statusCode, 403);
  assert.equal((await req(app, "POST", `/remote-desktop/sessions/${s.id}/signal`, { kind: "offer", payload: { type: "offer", sdp: "evil" } })).statusCode, 403);
  assert.equal((await req(app, "GET", `/remote-desktop/sessions/${s.id}`)).statusCode, 404, "a session that is not yours does not exist");
  // Support sessions do not answer on desktop routes.
  const supportId = id("s");
  state.sessions.set(supportId, { ...state.sessions.get(s.id)!, id: supportId, kind: "support" });
  as("izzy");
  assert.equal((await req(app, "GET", `/remote-desktop/sessions/${supportId}`)).statusCode, 404);
  assert.equal((await req(app, "POST", `/remote-desktop/sessions/${supportId}/heartbeat`, {})).statusCode, 409);
  await app.close();
});

test("hostile bodies: forged tenant/user fields are ignored, junk is 400, nothing is written", async () => {
  reset(); seedCast();
  const app = await buildApp();
  const m = await enrollMachine(app, "izzy");
  as("colleague");
  const before = JSON.stringify([...state.sessions.values()]);
  const junk = [
    ["/remote-desktop/connect-by-id", { connectId: { $gt: "" }, password: "x" }],
    ["/remote-desktop/connect-by-id", { connectId: "1".repeat(9), password: "x".repeat(500) }],
    ["/remote-desktop/connect-by-id", { connectId: "482913057", password: "x", tenantId: "T_A", requestedByUserId: "izzy", role: "SUPER_ADMIN" }],
    [`/remote-desktop/machines/${m.id}/connect`, { capabilities: "control" }],
    [`/remote-desktop/machines/${m.id}/shares`, { expiry: "forever", scope: "company" }],
    ["/remote-desktop/machines/register", { deviceId: "../../etc", name: "x", unattendedEnabled: true, hasAccessLogin: true }],
  ] as const;
  for (const [url, payload] of junk) {
    const r = await req(app, "POST", url, payload, url.endsWith("register") ? withKey(KEY_B) : {});
    assert.ok([400, 401, 403, 404].includes(r.statusCode), `${url} → ${r.statusCode} ${r.body}`);
  }
  assert.equal(JSON.stringify([...state.sessions.values()]), before, "no session row from any hostile body");
  assert.equal(state.machines.size, 1);
  // Prototype pollution did not happen.
  assert.equal(({} as any).admin, undefined);
  await app.close();
});

test("/me answers per person, and the history shows a person every session that touched their computers — support included", async () => {
  reset(); seedCast();
  const app = await buildApp();
  const m = await enrollMachine(app, "izzy");
  as("viewer_only");
  const me = body(await req(app, "GET", "/remote-desktop/me"));
  assert.deepEqual([me.canUseRemoteDesktop, me.canConnectById, me.canShareOwnComputer, me.fromDesktopApp], [true, false, false, true]);
  currentUa = "Mozilla/5.0";
  assert.equal(body(await req(app, "GET", "/remote-desktop/me")).fromDesktopApp, false);
  currentUa = "Loopcom/0.1.17 Electron/41";
  as("nobody");
  assert.equal((await req(app, "GET", "/remote-desktop/machines")).statusCode, 403);
  // A support session on izzy's account and a desktop session to izzy's machine both appear in izzy's history.
  state.sessions.set("sup1", { id: "sup1", kind: "support", status: "ENDED", tenantId: "T_A", requestedByUserId: "root", targetUserId: "izzy", capabilitiesGranted: ["view"], createdAt: new Date(Date.now() - 1000), startedAt: new Date(Date.now() - 1000), endedAt: new Date(), endedBy: "client", endedReason: null, machineId: null, shareId: null, clientAuthenticated: false, requestReason: "support", deviceLabel: "Office PC", expiresAt: new Date(), lastSeenAdminAt: null, lastSeenClientAt: null, inputEventCount: 0, clientOnCall: false, updatedAt: new Date() });
  const s = body(await ownConnect(app, "izzy", m.id)).session;
  as("izzy");
  const hist = body(await req(app, "GET", "/remote-desktop/history")).sessions;
  assert.deepEqual(hist.map((h: any) => h.kind).sort(), ["desktop", "support"]);
  assert.equal(hist.find((h: any) => h.id === s.id).connectedFrom, "Home laptop");
  as("colleague");
  assert.equal(body(await req(app, "GET", "/remote-desktop/history")).sessions.length, 0, "another person's history is theirs alone");
  await app.close();
});

test("a new owner signing in on the same install takes the computer, and every password the old owner issued dies", async () => {
  reset(); seedCast();
  const app = await buildApp();
  const m = await enrollMachine(app, "izzy");
  as("izzy");
  await req(app, "POST", `/remote-desktop/machines/${m.id}/shares`, { expiry: "standing", scope: "anyone" });
  assert.equal([...state.shares.values()].filter((s) => !s.revokedAt).length, 1);
  await enrollMachine(app, "colleague");
  assert.equal(state.machines.get(m.id)!.ownerUserId, "colleague");
  assert.equal([...state.shares.values()].filter((s) => !s.revokedAt).length, 0, "a password is a promise made by a person, not a machine");
  assert.ok(state.audits.some((a) => a.action === "REMOTE_DESKTOP_MACHINE_OWNER_CHANGED"));
  await app.close();
});
