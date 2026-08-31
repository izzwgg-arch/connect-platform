/**
 * Remote support, ATTACKED THROUGH THE REAL ROUTES (mandate Phases 25, 29, 35, 36).
 *
 * ⛔ Every test here drives the SHIPPED `registerRemoteSupportRoutes` on a real
 * Fastify instance. A unit test of a policy function proves the rule; it does not
 * prove the handler asks. This file exists because the defects that actually
 * shipped in this codebase were all in CALLERS — the two IVR publish paths, the
 * two invite paths, the tenant read in the query string. So the attacks go in
 * the front door.
 *
 * ⛔ THE FAKE DATABASE IS FAITHFUL ON PURPOSE. It evaluates `where` clauses,
 * honours guarded `updateMany`, and returns SNAPSHOT COPIES rather than live
 * references. The 2026-08-22 desk-phone race hid behind a fake that handed back
 * the shared row, and a fake that ignores its own `where` is how the supermarket
 * name-only search sat green under 104 tests.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

/* ───────────────────────── the fake database ─────────────────────── */

type Row = Record<string, any>;

const state = {
  users: new Map<string, Row>(),
  sessions: new Map<string, Row>(),
  signals: [] as Row[],
  events: [] as Row[],
  control: null as Row | null,
  revocations: [] as Row[],
  /** Keys each user id effectively holds. */
  perms: new Map<string, Set<string>>(),
  seq: 0,
  /** Every audit call, so "was this recorded" is testable. */
  audits: [] as Row[],
  /** Set to make the control read throw, for the fail-closed test. */
  controlReadThrows: false,
};

function reset() {
  state.users.clear();
  state.sessions.clear();
  state.signals = [];
  state.events = [];
  state.control = null;
  state.revocations = [];
  state.perms.clear();
  state.seq = 0;
  state.audits = [];
  state.controlReadThrows = false;
  // ⛔ The control state is CACHED in-process for five seconds, so clearing the
  // rows is not enough — a kill switch thrown in one test would otherwise still
  // be in force in the next. That five-second window is a real product property
  // (see controlStore.ts), not a test artefact; this only stops one test's
  // emergency leaking into another's.
  invalidate?.();
}
/** Bound once the module under test has been imported. */
let invalidate: (() => void) | null = null;

const id = (p: string) => `${p}_${++state.seq}`;
/** ⛔ Snapshot. A fake that returns the live object hides every race. */
const copy = <T>(v: T): T => (v == null ? v : (JSON.parse(JSON.stringify(v), reviveDates) as T));
function reviveDates(_k: string, v: any) {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v)) return new Date(v);
  return v;
}

/** Minimal but honest `where` evaluation — enough for every clause these routes use. */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === "AND") {
      if (!(cond as Row[]).every((c) => matches(row, c))) return false;
      continue;
    }
    if (k === "OR") {
      if (!(cond as Row[]).some((c) => matches(row, c))) return false;
      continue;
    }
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ("in" in cond) {
        if (!(cond.in as any[]).includes(v)) return false;
        continue;
      }
      if ("not" in cond) {
        const n = (cond as any).not;
        if (n === null) {
          if (v === null || v === undefined) return false;
        } else if (v === n) return false;
        continue;
      }
      if ("gte" in cond) {
        if (!(v instanceof Date) || v.getTime() < (cond.gte as Date).getTime()) return false;
        continue;
      }
      if ("gt" in cond) {
        if (!(v instanceof Date) || v.getTime() <= (cond.gt as Date).getTime()) return false;
        continue;
      }
      if ("lt" in cond) {
        if (!(v instanceof Date) || v.getTime() >= (cond.lt as Date).getTime()) return false;
        continue;
      }
      throw new Error(`fake db: unsupported condition ${JSON.stringify(cond)} on ${k}`);
    }
    if (v !== cond) return false;
  }
  return true;
}

function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "increment" in v) {
      row[k] = (row[k] || 0) + (v as any).increment;
    } else {
      row[k] = v;
    }
  }
}

const db = {
  user: {
    findFirst: async ({ where }: any) => copy([...state.users.values()].find((u) => matches(u, where)) ?? null),
    findUnique: async ({ where }: any) => copy(state.users.get(where.id) ?? null),
    findMany: async ({ where }: any) => copy([...state.users.values()].filter((u) => matches(u, where))),
  },
  remoteSupportSession: {
    create: async ({ data }: any) => {
      const row: Row = {
        id: id("s"),
        status: "REQUESTED",
        controlRequested: false,
        controlGranted: false,
        capabilitiesRequested: [],
        capabilitiesGranted: [],
        clientOnCall: false,
        deviceId: null,
        deviceLabel: null,
        inputEventCount: 0,
        consentAt: null,
        declinedAt: null,
        startedAt: null,
        endedAt: null,
        endedReason: null,
        endedBy: null,
        lastSeenAdminAt: null,
        lastSeenClientAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      state.sessions.set(row.id, row);
      return copy(row);
    },
    findUnique: async ({ where }: any) => copy(state.sessions.get(where.id) ?? null),
    findMany: async ({ where, take }: any) => {
      const out = [...state.sessions.values()].filter((s) => matches(s, where));
      return copy(take ? out.slice(0, take) : out);
    },
    update: async ({ where, data }: any) => {
      const row = state.sessions.get(where.id);
      if (!row) throw new Error("not found");
      applyData(row, data);
      return copy(row);
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of state.sessions.values()) {
        if (!matches(row, where)) continue;
        applyData(row, data);
        count++;
      }
      return { count };
    },
  },
  remoteSupportSignal: {
    create: async ({ data }: any) => {
      const row = { id: id("sig"), createdAt: new Date(), consumedAt: null, ...data };
      state.signals.push(row);
      return copy(row);
    },
    count: async ({ where }: any) => state.signals.filter((s) => matches(s, where)).length,
    findMany: async ({ where, take }: any) => {
      const out = state.signals.filter((s) => matches(s, where));
      return copy(take ? out.slice(0, take) : out);
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const s of state.signals) {
        if (where?.id?.in && !where.id.in.includes(s.id)) continue;
        applyData(s, data);
        count++;
      }
      return { count };
    },
    deleteMany: async () => ({ count: 0 }),
  },
  remoteSupportEvent: {
    create: async ({ data }: any) => {
      const row = { id: id("ev"), at: new Date(), ...data };
      state.events.push(row);
      return copy(row);
    },
    findMany: async ({ where, take }: any) => {
      const out = state.events.filter((e) => matches(e, where));
      return copy(take ? out.slice(0, take) : out);
    },
  },
  remoteSupportControl: {
    findUnique: async () => {
      if (state.controlReadThrows) throw new Error("db down");
      return copy(state.control);
    },
    upsert: async ({ create, update }: any) => {
      state.control = state.control ? { ...state.control, ...update } : { id: "global", ...create };
      return copy(state.control);
    },
  },
  remoteSupportRevocation: {
    findMany: async ({ where, take }: any) => {
      if (state.controlReadThrows) throw new Error("db down");
      const out = state.revocations.filter((r) => matches(r, where));
      return copy(take ? out.slice(0, take) : out);
    },
    create: async ({ data }: any) => {
      const row = { id: id("rev"), createdAt: new Date(), liftedAt: null, liftedByUserId: null, ...data };
      state.revocations.push(row);
      return copy(row);
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const r of state.revocations) {
        if (!matches(r, where)) continue;
        applyData(r, data);
        count++;
      }
      return { count };
    },
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

/**
 * ⛔ Imported lazily inside the harness, not at the top level: this file is
 * transformed to CJS, where a top-level `await` is a build error — and the
 * module must in any case load AFTER `mock.module` has replaced its
 * dependencies, or it captures the real `@connect/db`.
 */
let registerRemoteSupportRoutes: any = null;

/* ─────────────────────────── the harness ─────────────────────────── */

function seedUser(input: { id: string; tenantId: string; role?: string; keys?: string[] }) {
  state.users.set(input.id, {
    id: input.id,
    tenantId: input.tenantId,
    role: input.role || "USER",
    firstName: input.id,
    lastName: null,
    email: `${input.id}@example.test`,
  });
  state.perms.set(input.id, new Set(input.keys || []));
}

let currentUser: Row | null = null;

async function buildApp() {
  if (!registerRemoteSupportRoutes) {
    ({ registerRemoteSupportRoutes } = await import("../remoteSupportRoutes"));
    ({ invalidateRemoteSupportControls: invalidate } = await import("./controlStore"));
    invalidate?.();
  }
  const app = Fastify();
  app.addHook("preHandler", async (req: any) => {
    req.user = currentUser;
  });
  await registerRemoteSupportRoutes(app as any, {
    audit: async (p) => {
      state.audits.push(p as Row);
    },
  });
  await app.ready();
  return app;
}

const as = (userId: string) => {
  const u = state.users.get(userId);
  if (!u) throw new Error(`no such seeded user ${userId}`);
  currentUser = { sub: u.id, tenantId: u.tenantId, role: u.role, email: u.email };
};

async function req(app: any, method: string, url: string, payload?: any) {
  return app.inject({ method, url, ...(payload !== undefined ? { payload } : {}) });
}

/** The standard cast: two customers, two technicians, one platform admin. */
function seedCast() {
  seedUser({ id: "victim", tenantId: "T_A" });
  seedUser({ id: "colleague", tenantId: "T_A" });
  seedUser({ id: "techA", tenantId: "T_A", keys: ["can_remote_support", "can_control_remote_support"] });
  seedUser({ id: "viewerA", tenantId: "T_A", keys: ["can_remote_support"] });
  seedUser({ id: "outsider", tenantId: "T_B" });
  seedUser({ id: "techB", tenantId: "T_B", keys: ["can_remote_support", "can_control_remote_support"] });
  seedUser({ id: "nobody", tenantId: "T_A" });
  seedUser({ id: "root", tenantId: "T_ADMIN", role: "SUPER_ADMIN" });
}

async function openSession(app: any, opts: { tech: string; target: string; control?: boolean; caps?: string[] }) {
  as(opts.tech);
  const r = await req(app, "POST", "/remote-support/sessions", {
    targetUserId: opts.target,
    reason: "Investigating a call quality problem for you.",
    requestControl: opts.control ?? false,
    capabilities: opts.caps ?? [],
  });
  assert.equal(r.statusCode, 200, `could not open session: ${r.body}`);
  return JSON.parse(r.body).session.id;
}

async function consent(app: any, sessionId: string, targetId: string, opts: { control?: boolean; caps?: string[] } = {}) {
  as(targetId);
  const r = await req(app, "POST", `/remote-support/sessions/${sessionId}/consent`, {
    allow: true,
    allowControl: opts.control ?? false,
    allowCapabilities: opts.caps ?? [],
  });
  assert.equal(r.statusCode, 200, `consent failed: ${r.body}`);
  return JSON.parse(r.body);
}

/**
 * Bring a consented session all the way live.
 *
 * ⛔ BOTH SIDES MUST BEAT, and that is the product being right rather than the
 * harness being fussy. `sessionLapseReason` treats an ACTIVE session whose admin
 * has never checked in as `support_disconnected` — which is exactly the property
 * that stops a session outliving the window showing the customer's banner. A
 * test that beats only one side is testing a state that cannot persist.
 */
async function goLive(app: any, sessionId: string, tech: string, target: string) {
  as(target);
  assert.equal((await req(app, "POST", `/remote-support/sessions/${sessionId}/heartbeat`, {})).statusCode, 200);
  as(tech);
  assert.equal((await req(app, "POST", `/remote-support/sessions/${sessionId}/heartbeat`, {})).statusCode, 200);
}

/* ═════════════════ PHASE 25 — TENANT ISOLATION ═══════════════════ */

test("⛔⛔ a technician cannot open a session against another company", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  as("techA");
  const r = await req(app, "POST", "/remote-support/sessions", {
    targetUserId: "outsider",
    reason: "I would like to look at your machine.",
  });
  // ⛔ A foreign user must read exactly like a missing one — no existence oracle.
  assert.equal(r.statusCode, 404);
  assert.equal(JSON.parse(r.body).error, "user_not_found");
});

test("⛔⛔ a foreign user id and a nonexistent one are INDISTINGUISHABLE", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  as("techA");
  const foreign = await req(app, "POST", "/remote-support/sessions", {
    targetUserId: "outsider",
    reason: "A reason long enough to pass.",
  });
  const ghost = await req(app, "POST", "/remote-support/sessions", {
    targetUserId: "does_not_exist_at_all",
    reason: "A reason long enough to pass.",
  });
  assert.equal(foreign.statusCode, ghost.statusCode);
  assert.deepEqual(JSON.parse(foreign.body), JSON.parse(ghost.body));
});

test("⛔⛔ a forged tenantId in the BODY is ignored entirely", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  as("techA");
  const r = await req(app, "POST", "/remote-support/sessions", {
    targetUserId: "outsider",
    reason: "A reason long enough to pass.",
    // Every shape an attacker would try.
    tenantId: "T_B",
    tenant_id: "T_B",
    targetTenantId: "T_B",
    actor: { tenantId: "T_B", isSuperAdmin: true },
    role: "SUPER_ADMIN",
    isSuperAdmin: true,
  });
  assert.equal(r.statusCode, 404, "a forged tenant reached another company");
});

test("⛔⛔ a stranger cannot read, heartbeat, signal or type into someone else's session", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim", control: true });
  await consent(app, sid, "victim", { control: true });

  for (const intruder of ["outsider", "techB", "nobody", "colleague"]) {
    as(intruder);
    const status = await req(app, "GET", `/remote-support/sessions/${sid}`);
    assert.equal(status.statusCode, 403, `${intruder} read the session`);

    const beat = await req(app, "POST", `/remote-support/sessions/${sid}/heartbeat`, {});
    assert.equal(beat.statusCode, 409, `${intruder} heartbeat accepted`);

    const sig = await req(app, "POST", `/remote-support/sessions/${sid}/signal`, {
      kind: "offer",
      payload: { sdp: "x" },
    });
    assert.equal(sig.statusCode, 409, `${intruder} injected a signal`);

    const drain = await req(app, "GET", `/remote-support/sessions/${sid}/signal`);
    assert.equal(drain.statusCode, 409, `${intruder} drained signals`);

    const input = await req(app, "POST", `/remote-support/sessions/${sid}/input`, { count: 5 });
    assert.equal(input.statusCode, 403, `${intruder} injected input`);

    const chat = await req(app, "POST", `/remote-support/sessions/${sid}/chat`, { body: "hello" });
    assert.equal(chat.statusCode, 409, `${intruder} posted chat`);

    const events = await req(app, "GET", `/remote-support/sessions/${sid}/events`);
    assert.equal(events.statusCode, 403, `${intruder} read the transcript`);
  }
});

test("⛔⛔ a stranger cannot END someone else's session either", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim" });
  as("techB");
  const r = await req(app, "POST", `/remote-support/sessions/${sid}/end`, {});
  assert.equal(r.statusCode, 403);
  assert.equal(state.sessions.get(sid)!.status, "REQUESTED", "a stranger ended the session");
});

test("⛔ the history list never leaks another company's sessions", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  await openSession(app, { tech: "techA", target: "victim" });
  await openSession(app, { tech: "techB", target: "outsider" });

  as("techA");
  const r = await req(app, "GET", "/remote-support/sessions");
  assert.equal(r.statusCode, 200);
  const rows = JSON.parse(r.body).sessions;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenantId, "T_A");
});

test("⛔ /pending only ever returns sessions aimed at the caller", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  await openSession(app, { tech: "techA", target: "victim" });
  await openSession(app, { tech: "techA", target: "colleague" });

  as("colleague");
  const r = await req(app, "GET", "/remote-support/pending");
  const rows = JSON.parse(r.body).sessions;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].targetUserId, "colleague");
});

/* ═════════════════ PHASE 35 — CONSENT ATTACKS ════════════════════ */

test("⛔⛔ NOBODY but the target may consent — not a colleague, not a super admin", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim", control: true });

  for (const impostor of ["colleague", "techA", "root", "outsider"]) {
    as(impostor);
    const r = await req(app, "POST", `/remote-support/sessions/${sid}/consent`, {
      allow: true,
      allowControl: true,
    });
    assert.notEqual(r.statusCode, 200, `${impostor} consented on the victim's behalf`);
    assert.equal(state.sessions.get(sid)!.status, "REQUESTED");
    assert.equal(state.sessions.get(sid)!.controlGranted, false);
  }
});

test("⛔⛔ a technician CANNOT grant themselves control by any request shape", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  as("techA");
  const r = await req(app, "POST", "/remote-support/sessions", {
    targetUserId: "victim",
    reason: "A reason long enough to pass.",
    requestControl: true,
    // Every field an attacker would try to set directly.
    controlGranted: true,
    capabilitiesGranted: ["control", "clipboard", "files"],
    status: "ACTIVE",
    consentAt: new Date().toISOString(),
  });
  assert.equal(r.statusCode, 200);
  const row = state.sessions.get(JSON.parse(r.body).session.id)!;
  assert.equal(row.controlGranted, false, "control was self-granted");
  assert.deepEqual(row.capabilitiesGranted, [], "capabilities were self-granted");
  assert.equal(row.status, "REQUESTED", "status was forged");
  assert.equal(row.consentAt, null, "consent was forged");
});

test("⛔⛔ a VIEW-ONLY session can never be typed into, however it is asked", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim", control: true });
  // The customer allows watching but NOT control.
  await consent(app, sid, "victim", { control: false });
  await goLive(app, sid, "techA", "victim");

  as("techA");
  const r = await req(app, "POST", `/remote-support/sessions/${sid}/input`, { count: 1 });
  assert.equal(r.statusCode, 403);
  assert.equal(JSON.parse(r.body).error, "control_not_granted");
  assert.equal(state.sessions.get(sid)!.inputEventCount, 0);
});

test("⛔ a customer cannot grant a capability that was never requested", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim", control: true, caps: ["control"] });
  // Customer ticks clipboard and files, which were never asked for.
  await consent(app, sid, "victim", { control: true, caps: ["control", "clipboard", "files"] });

  const granted = state.sessions.get(sid)!.capabilitiesGranted;
  assert.deepEqual(granted, ["view", "control"], "an unrequested capability was granted");
});

test("⛔⛔ a technician WITHOUT the control key gets view-only even if the customer says yes", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  // viewerA holds can_remote_support but NOT can_control_remote_support.
  as("viewerA");
  const r = await req(app, "POST", "/remote-support/sessions", {
    targetUserId: "victim",
    reason: "A reason long enough to pass.",
    requestControl: true,
  });
  // ⛔ Refused at REQUEST time: the dialog must never offer what the requester
  // could not have.
  assert.equal(r.statusCode, 403);
  assert.equal(JSON.parse(r.body).error, "missing_control_permission");
});

test("⛔ revoking the control key mid-session stops the typing but not the watching", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim", control: true });
  await consent(app, sid, "victim", { control: true });
  await goLive(app, sid, "techA", "victim");

  as("techA");
  assert.equal((await req(app, "POST", `/remote-support/sessions/${sid}/input`, { count: 2 })).statusCode, 200);

  // The key is taken away.
  state.perms.get("techA")!.delete("can_control_remote_support");

  const typed = await req(app, "POST", `/remote-support/sessions/${sid}/input`, { count: 1 });
  assert.equal(typed.statusCode, 403);
  assert.equal(JSON.parse(typed.body).error, "control_permission_revoked");

  // Still able to watch.
  const beat = await req(app, "POST", `/remote-support/sessions/${sid}/heartbeat`, {});
  assert.equal(beat.statusCode, 200);
});

test("⛔ revoking remote support entirely mid-session ends participation", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim", control: true });
  await consent(app, sid, "victim", { control: true });

  state.perms.get("techA")!.delete("can_remote_support");
  as("techA");
  const beat = await req(app, "POST", `/remote-support/sessions/${sid}/heartbeat`, {});
  assert.equal(beat.statusCode, 409);
  assert.equal(JSON.parse(beat.body).error, "permission_revoked");
});

test("⛔⛔ THE CUSTOMER CAN ALWAYS END, with no permission of any kind", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim", control: true });
  await consent(app, sid, "victim", { control: true });

  // Strip every key the victim could conceivably have.
  state.perms.set("victim", new Set());
  as("victim");
  const r = await req(app, "POST", `/remote-support/sessions/${sid}/end`, {});
  assert.equal(r.statusCode, 200);
  assert.equal(state.sessions.get(sid)!.status, "ENDED");
  assert.equal(state.sessions.get(sid)!.endedBy, "customer");
});

test("⛔ a double consent cannot flip a declined session", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim", control: true });

  as("victim");
  const no = await req(app, "POST", `/remote-support/sessions/${sid}/consent`, { allow: false });
  assert.equal(no.statusCode, 200);

  const yes = await req(app, "POST", `/remote-support/sessions/${sid}/consent`, { allow: true, allowControl: true });
  assert.equal(yes.statusCode, 409);
  assert.equal(state.sessions.get(sid)!.status, "DECLINED");
  assert.equal(state.sessions.get(sid)!.controlGranted, false);
});

test("⛔ an ended session cannot be resumed by any route", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim", control: true });
  await consent(app, sid, "victim", { control: true });
  as("victim");
  await req(app, "POST", `/remote-support/sessions/${sid}/end`, {});

  as("techA");
  for (const [method, path, body] of [
    ["POST", "heartbeat", {}],
    ["POST", "signal", { kind: "offer", payload: { a: 1 } }],
    ["GET", "signal", undefined],
    ["POST", "input", { count: 1 }],
    ["POST", "chat", { body: "still here?" }],
  ] as const) {
    const r = await req(app, method, `/remote-support/sessions/${sid}/${path}`, body as any);
    assert.ok(r.statusCode >= 400, `${path} worked on an ended session`);
  }
});

/* ═════════════ PHASE 30 — THE KILL SWITCH, THROUGH ROUTES ═════════ */

test("⛔⛔ the kill switch stops NEW sessions", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  as("root");
  const off = await req(app, "POST", "/admin/remote-support/controls", {
    enabled: false,
    reason: "credential incident",
  });
  assert.equal(off.statusCode, 200);

  as("techA");
  const r = await req(app, "POST", "/remote-support/sessions", {
    targetUserId: "victim",
    reason: "A reason long enough to pass.",
  });
  assert.equal(r.statusCode, 403);
  assert.equal(JSON.parse(r.body).error, "remote_support_disabled");
  assert.match(JSON.parse(r.body).message, /credential incident/);
});

test("⛔⛔ the kill switch ENDS the session already running", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim", control: true });
  await consent(app, sid, "victim", { control: true });
  await goLive(app, sid, "techA", "victim");
  assert.equal(state.sessions.get(sid)!.status, "ACTIVE");

  as("root");
  const off = await req(app, "POST", "/admin/remote-support/controls", { enabled: false });
  assert.equal(off.statusCode, 200);
  assert.equal(JSON.parse(off.body).sessionsEnded, 1, "the live session survived the kill switch");
  assert.equal(state.sessions.get(sid)!.status, "ENDED");
});

test("⛔⛔ EVEN WITH THE SWITCH OFF, the customer can still press stop", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim" });

  as("root");
  await req(app, "POST", "/admin/remote-support/controls", { enabled: false });

  // The kill switch already ended it; ending again must still be a success
  // rather than an error, because the customer wanted it stopped and it is.
  as("victim");
  const r = await req(app, "POST", `/remote-support/sessions/${sid}/end`, {});
  assert.equal(r.statusCode, 200);
});

test("⛔ a revoked technician is stopped and their live session ends", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim", control: true });
  await consent(app, sid, "victim", { control: true });

  as("root");
  const rev = await req(app, "POST", "/admin/remote-support/revocations", {
    scope: "TECHNICIAN",
    subjectId: "techA",
    reason: "under investigation",
  });
  assert.equal(rev.statusCode, 200);
  assert.equal(JSON.parse(rev.body).sessionsEnded, 1);
  assert.equal(state.sessions.get(sid)!.status, "ENDED");

  as("techA");
  const again = await req(app, "POST", "/remote-support/sessions", {
    targetUserId: "victim",
    reason: "A reason long enough to pass.",
  });
  assert.equal(again.statusCode, 403);
  assert.equal(JSON.parse(again.body).error, "technician_revoked");
});

test("⛔ revoking a whole customer blocks every technician against them", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  as("root");
  await req(app, "POST", "/admin/remote-support/revocations", { scope: "TENANT", subjectId: "T_A" });

  as("techA");
  const r = await req(app, "POST", "/remote-support/sessions", {
    targetUserId: "victim",
    reason: "A reason long enough to pass.",
  });
  assert.equal(r.statusCode, 403);
  assert.equal(JSON.parse(r.body).error, "tenant_revoked");

  // ⛔ And a platform admin is blocked by it too — they have the most reach, so
  // a customer's "switch this off" must bind them above all.
  as("root");
  const rootTry = await req(app, "POST", "/remote-support/sessions", {
    targetUserId: "victim",
    reason: "A reason long enough to pass.",
  });
  assert.equal(rootTry.statusCode, 403);
});

test("⛔⛔ the emergency controls are SUPER ADMIN ONLY", async () => {
  reset();
  seedCast();
  // Give the technician every ordinary key, including the one the prefix rule
  // asks for. The handler check must still refuse.
  state.perms.get("techA")!.add("can_manage_global_settings");
  const app = await buildApp();

  for (const who of ["techA", "victim", "outsider"]) {
    as(who);
    for (const [method, path, body] of [
      ["GET", "/admin/remote-support/controls", undefined],
      ["POST", "/admin/remote-support/controls", { enabled: false }],
      ["POST", "/admin/remote-support/revocations", { scope: "TECHNICIAN", subjectId: "root" }],
      ["POST", "/admin/remote-support/terminate", { all: true }],
      ["DELETE", "/admin/remote-support/revocations/anything", undefined],
    ] as const) {
      const r = await req(app, method, path, body as any);
      assert.equal(r.statusCode, 403, `${who} reached ${method} ${path}`);
      assert.equal(JSON.parse(r.body).error, "super_admin_only");
    }
  }
  // Nothing was actually changed by any of that.
  assert.equal(state.control, null);
  assert.equal(state.revocations.length, 0);
});

test("⛔⛔ a database failure makes the gate fail CLOSED, not open", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  state.controlReadThrows = true;

  as("techA");
  const r = await req(app, "POST", "/remote-support/sessions", {
    targetUserId: "victim",
    reason: "A reason long enough to pass.",
  });
  assert.equal(r.statusCode, 403, "an unreadable gate let a session through");
  assert.equal(JSON.parse(r.body).error, "remote_support_disabled");
});

/* ═════════════ PHASE 29 — ABUSE, THROUGH THE ROUTES ══════════════ */

test("⛔ opening sessions in a burst is throttled with a retry-after", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  // Many targets in one tenant so the enumeration guard is not what fires.
  for (let i = 0; i < 15; i++) seedUser({ id: `victim${i}`, tenantId: "T_A" });

  as("techA");
  let refused: any = null;
  for (let i = 0; i < 15; i++) {
    const r = await req(app, "POST", "/remote-support/sessions", {
      targetUserId: "victim",
      reason: "A reason long enough to pass.",
    });
    if (r.statusCode === 429) {
      refused = r;
      break;
    }
  }
  assert.ok(refused, "the request cap never fired");
  assert.ok(refused.headers["retry-after"], "a 429 must say when to come back");
  assert.match(JSON.parse(refused.body).message, /[a-z] [a-z]/i);
});

test("⛔⛔ spraying across many DIFFERENT people is caught as enumeration", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  for (let i = 0; i < 12; i++) seedUser({ id: `person${i}`, tenantId: "T_A" });

  as("techA");
  let reason: string | null = null;
  for (let i = 0; i < 12; i++) {
    const r = await req(app, "POST", "/remote-support/sessions", {
      targetUserId: `person${i}`,
      reason: "A reason long enough to pass.",
    });
    if (r.statusCode === 429) {
      reason = JSON.parse(r.body).error;
      break;
    }
  }
  assert.equal(reason, "too_many_targets", "a directory walk was not caught");
});

/* ═════════════ PHASE 36 — FUZZING THE ROUTES ═════════════════════ */

const HOSTILE = [
  null,
  undefined,
  "",
  "   ",
  0,
  -1,
  1.5,
  NaN,
  true,
  false,
  [],
  {},
  { toString: null },
  { __proto__: { admin: true } },
  "../../etc/passwd",
  "'; DROP TABLE users;--",
  "<script>alert(1)</script>",
  "",
  "‮evil",
  "a".repeat(50_000),
  { nested: { deep: { deeper: "x".repeat(10_000) } } },
  [1, 2, 3],
  "SUPER_ADMIN",
];

test("⛔⛔ no hostile request body produces a 500 on any route", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim", control: true });
  await consent(app, sid, "victim", { control: true });

  const routes: Array<[string, string]> = [
    ["POST", "/remote-support/sessions"],
    ["POST", `/remote-support/sessions/${sid}/consent`],
    ["POST", `/remote-support/sessions/${sid}/heartbeat`],
    ["POST", `/remote-support/sessions/${sid}/signal`],
    ["POST", `/remote-support/sessions/${sid}/input`],
    ["POST", `/remote-support/sessions/${sid}/end`],
    ["POST", `/remote-support/sessions/${sid}/chat`],
    ["POST", `/remote-support/sessions/${sid}/request-capability`],
    ["POST", `/remote-support/sessions/${sid}/answer-capability`],
    ["POST", `/remote-support/sessions/${sid}/use-capability`],
  ];

  for (const who of ["techA", "victim", "outsider"]) {
    for (const [method, url] of routes) {
      for (const payload of HOSTILE) {
        as(who);
        let r: any;
        try {
          r = await req(app, method, url, payload as any);
        } catch (err) {
          assert.fail(`${method} ${url} threw for ${JSON.stringify(payload)?.slice(0, 60)}: ${err}`);
        }
        assert.notEqual(r.statusCode, 500, `${method} ${url} 500'd on ${JSON.stringify(payload)?.slice(0, 80)}`);
        assert.ok(r.statusCode < 500, `${method} ${url} -> ${r.statusCode}`);
      }
    }
  }
});

test("⛔ hostile field VALUES inside a well-shaped body are refused, never stored raw", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  as("techA");

  for (const junk of HOSTILE) {
    const r = await req(app, "POST", "/remote-support/sessions", {
      targetUserId: junk,
      reason: "A reason long enough to pass.",
    });
    assert.ok(r.statusCode >= 400, `targetUserId=${JSON.stringify(junk)?.slice(0, 40)} was accepted`);
  }
  for (const junk of HOSTILE) {
    const r = await req(app, "POST", "/remote-support/sessions", {
      targetUserId: "victim",
      reason: junk,
    });
    // A valid long string is the one case that should pass the schema and then
    // be refused by the policy for length.
    if (typeof junk === "string" && junk.length > 300) {
      assert.ok(r.statusCode >= 400, "an over-long reason was accepted");
    } else if (typeof junk === "string" && junk.trim().length >= 3) {
      assert.equal(r.statusCode, 200);
    } else {
      assert.ok(r.statusCode >= 400, `reason=${JSON.stringify(junk)?.slice(0, 40)} was accepted`);
    }
  }
});

test("⛔ an oversized signalling payload is refused rather than stored", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim" });
  await consent(app, sid, "victim");

  as("techA");
  const r = await req(app, "POST", `/remote-support/sessions/${sid}/signal`, {
    kind: "offer",
    payload: { sdp: "x".repeat(200_000) },
  });
  assert.equal(r.statusCode, 400);
  assert.equal(JSON.parse(r.body).error, "signal_too_large");
  assert.equal(state.signals.length, 0, "an oversized payload was stored");
});

test("⛔ a signal flood is refused once the other side stops reading", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim" });
  await consent(app, sid, "victim");

  as("techA");
  let refusedAt = -1;
  for (let i = 0; i < 200; i++) {
    const r = await req(app, "POST", `/remote-support/sessions/${sid}/signal`, {
      kind: "ice",
      payload: { candidate: `c${i}` },
    });
    if (r.statusCode === 429) {
      refusedAt = i;
      break;
    }
  }
  assert.ok(refusedAt > 0 && refusedAt < 200, `flood never refused (stopped at ${refusedAt})`);
  assert.ok(state.signals.length < 200, "every message was stored despite the cap");
});

test("⛔ signalling is one-directional: each side only ever reads the OTHER", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim" });
  await consent(app, sid, "victim");

  as("techA");
  await req(app, "POST", `/remote-support/sessions/${sid}/signal`, { kind: "offer", payload: { from: "admin" } });

  // The admin must not read back their own message.
  const own = await req(app, "GET", `/remote-support/sessions/${sid}/signal`);
  assert.equal(JSON.parse(own.body).signals.length, 0);

  as("victim");
  const theirs = await req(app, "GET", `/remote-support/sessions/${sid}/signal`);
  const got = JSON.parse(theirs.body).signals;
  assert.equal(got.length, 1);
  assert.equal(got[0].payload.from, "admin");

  // And it is delivered ONCE.
  const again = await req(app, "GET", `/remote-support/sessions/${sid}/signal`);
  assert.equal(JSON.parse(again.body).signals.length, 0);
});

/* ═════ MID-SESSION ESCALATION — the technician cannot self-grant ═══ */

test("⛔⛔ asking for a capability mid-session does NOT grant it", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim", control: true, caps: ["control"] });
  await consent(app, sid, "victim", { control: true, caps: ["control"] });
  await goLive(app, sid, "techA", "victim");

  as("techA");
  const ask = await req(app, "POST", `/remote-support/sessions/${sid}/request-capability`, {
    capability: "clipboard",
  });
  assert.equal(ask.statusCode, 200);
  // ⛔ Requested, NOT granted.
  assert.deepEqual(JSON.parse(ask.body).granted, ["view", "control"]);
  assert.ok(!state.sessions.get(sid)!.capabilitiesGranted.includes("clipboard"));

  // And using it is still refused.
  const use = await req(app, "POST", `/remote-support/sessions/${sid}/use-capability`, {
    capability: "clipboard",
    count: 10,
  });
  assert.equal(use.statusCode, 403);
  assert.equal(JSON.parse(use.body).error, "capability_not_granted");
});

test("⛔ only the customer can answer a mid-session capability request", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim", control: true, caps: ["control"] });
  await consent(app, sid, "victim", { control: true, caps: ["control"] });
  as("techA");
  await req(app, "POST", `/remote-support/sessions/${sid}/request-capability`, { capability: "clipboard" });

  for (const impostor of ["techA", "root", "colleague"]) {
    as(impostor);
    const r = await req(app, "POST", `/remote-support/sessions/${sid}/answer-capability`, {
      capability: "clipboard",
      allow: true,
    });
    assert.equal(r.statusCode, 403, `${impostor} answered for the customer`);
  }
  assert.ok(!state.sessions.get(sid)!.capabilitiesGranted.includes("clipboard"));

  // The customer can.
  as("victim");
  const ok = await req(app, "POST", `/remote-support/sessions/${sid}/answer-capability`, {
    capability: "clipboard",
    allow: true,
  });
  assert.equal(ok.statusCode, 200);
  assert.ok(state.sessions.get(sid)!.capabilitiesGranted.includes("clipboard"));
});

test("⛔ answering a capability nobody asked for is refused", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim", control: true });
  await consent(app, sid, "victim", { control: true });

  as("victim");
  const r = await req(app, "POST", `/remote-support/sessions/${sid}/answer-capability`, {
    capability: "files",
    allow: true,
  });
  assert.equal(r.statusCode, 409);
  assert.equal(JSON.parse(r.body).error, "not_requested");
});

/* ═════════ PHASE 37 — CALL PRIORITY THROUGH THE HEARTBEAT ════════ */

test("⛔⛔ a live call throttles the screen, and only the CUSTOMER can say so", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim", control: true });
  await consent(app, sid, "victim", { control: true });

  // Customer reports a call.
  as("victim");
  const onCall = await req(app, "POST", `/remote-support/sessions/${sid}/heartbeat`, { callInProgress: true });
  assert.equal(onCall.statusCode, 200);
  const budget = JSON.parse(onCall.body).mediaBudget;
  assert.equal(JSON.parse(onCall.body).callInProgress, true);
  assert.ok(budget.maxBitrateKbps <= 600, `not throttled: ${JSON.stringify(budget)}`);

  // ⛔ The technician claiming there is no call must NOT buy the bitrate back.
  as("techA");
  const admin = await req(app, "POST", `/remote-support/sessions/${sid}/heartbeat`, { callInProgress: false });
  assert.equal(admin.statusCode, 200);
  assert.equal(JSON.parse(admin.body).callInProgress, true, "an admin overrode the customer's call state");
  assert.ok(JSON.parse(admin.body).mediaBudget.maxBitrateKbps <= 600);
  assert.equal(state.sessions.get(sid)!.clientOnCall, true);
});

/* ═══════════════ PHASE 22 — THE TRANSCRIPT IS HONEST ═════════════ */

test("⛔ the transcript records the whole sequence and never a secret", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim", control: true, caps: ["control"] });
  await consent(app, sid, "victim", { control: true, caps: ["control"] });
  await goLive(app, sid, "techA", "victim");
  as("techA");
  await req(app, "POST", `/remote-support/sessions/${sid}/chat`, { body: "Looking at your network now." });
  as("victim");
  await req(app, "POST", `/remote-support/sessions/${sid}/end`, {});

  as("techA");
  const r = await req(app, "GET", `/remote-support/sessions/${sid}/events`);
  assert.equal(r.statusCode, 200);
  const events = JSON.parse(r.body).events;
  const codes = events.map((e: any) => e.code);
  assert.ok(codes.includes("requested"), codes.join(","));
  assert.ok(codes.includes("consented"), codes.join(","));
  assert.ok(codes.includes("ended"), codes.join(","));
  assert.ok(codes.includes("message"), codes.join(","));

  // ⛔ Nothing in the record carries anything secret-shaped.
  const blob = JSON.stringify(events);
  for (const forbidden of ["password", "keystroke", "clipboardText", "sdp", "candidate"]) {
    assert.ok(!blob.includes(forbidden), `transcript carried ${forbidden}`);
  }
  // Ordering is chronological.
  const times = events.map((e: any) => new Date(e.at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test("⛔ a chat message with a bidi override is neutered before it is stored", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim" });
  await consent(app, sid, "victim");
  await goLive(app, sid, "techA", "victim");

  as("techA");
  const rlo = String.fromCharCode(0x202e);
  await req(app, "POST", `/remote-support/sessions/${sid}/chat`, { body: `safe${rlo}txt.exe` });

  const stored = state.events.filter((e) => e.kind === "chat");
  assert.equal(stored.length, 1);
  assert.ok(!stored[0].body.includes(rlo), "a bidi override was stored");
});

/* ══════════════════ REPLAY / RACE / IDEMPOTENCY ══════════════════ */

test("⛔ two simultaneous consents cannot both succeed", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim", control: true });

  as("victim");
  const [a, b] = await Promise.all([
    req(app, "POST", `/remote-support/sessions/${sid}/consent`, { allow: true, allowControl: true }),
    req(app, "POST", `/remote-support/sessions/${sid}/consent`, { allow: false }),
  ]);
  const codes = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(codes, [200, 409], `both consents landed: ${a.statusCode}/${b.statusCode}`);
});

test("⛔ ending twice is a success, not an error — the caller wanted it stopped", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim" });
  as("victim");
  assert.equal((await req(app, "POST", `/remote-support/sessions/${sid}/end`, {})).statusCode, 200);
  const second = await req(app, "POST", `/remote-support/sessions/${sid}/end`, {});
  assert.equal(second.statusCode, 200);
  assert.equal(JSON.parse(second.body).alreadyEnded, true);
});

test("⛔ a session id that does not exist is a 404 for everyone, always", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  for (const who of ["techA", "victim", "root", "outsider"]) {
    as(who);
    for (const path of ["", "/heartbeat", "/signal", "/input", "/end", "/chat", "/events"]) {
      const r = await req(
        app,
        path === "" || path === "/events" || path === "/signal" ? "GET" : "POST",
        `/remote-support/sessions/does_not_exist${path}`,
        path === "" ? undefined : {},
      );
      assert.equal(r.statusCode, 404, `${who} ${path} -> ${r.statusCode}`);
    }
  }
});

test("⛔ an expired request cannot be consented to", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim" });
  // Wind the clock past the TTL.
  state.sessions.get(sid)!.expiresAt = new Date(Date.now() - 1000);

  as("victim");
  const r = await req(app, "POST", `/remote-support/sessions/${sid}/consent`, { allow: true });
  assert.ok(r.statusCode >= 400);
  assert.notEqual(state.sessions.get(sid)!.status, "CONSENTED");
});

test("⛔ every refusal across every route is a sentence, never a bare slug", async () => {
  reset();
  seedCast();
  const app = await buildApp();
  const sid = await openSession(app, { tech: "techA", target: "victim" });

  const probes: Array<[string, string, any, string]> = [
    ["POST", "/remote-support/sessions", { targetUserId: "outsider", reason: "long enough" }, "techA"],
    ["POST", `/remote-support/sessions/${sid}/consent`, { allow: true }, "colleague"],
    ["POST", `/remote-support/sessions/${sid}/input`, { count: 1 }, "techA"],
    ["GET", `/remote-support/sessions/${sid}`, undefined, "outsider"],
  ];
  for (const [method, url, body, who] of probes) {
    as(who);
    const r = await req(app, method, url, body);
    assert.ok(r.statusCode >= 400, `${url} unexpectedly succeeded`);
    const parsed = JSON.parse(r.body);
    assert.ok(parsed.message, `${url} returned no message`);
    assert.ok(/[a-z] [a-z]/i.test(parsed.message), `${url} message is a slug: ${parsed.message}`);
  }
});
