/**
 * Remote support under load (mandate Phases 33 and 34).
 *
 * ⛔ WHAT THIS CAN AND CANNOT PROVE, STATED UP FRONT SO THE RESULTS ARE NOT
 * OVERSOLD.
 *
 * The screen and every input event ride a peer connection between two browsers
 * and never touch this server — so what scales here is NOT video. It is the
 * broker: the requests, the consents, the heartbeats and the signalling that
 * introduce two peers to each other. That is the thing this file loads, because
 * that is the thing Loopcom actually runs.
 *
 * ⛔ Encoder throughput, GPU cost, frame rate and relay bandwidth CANNOT be
 * measured from here. They need two real machines, and until that has been done
 * nobody may claim a concurrent-session capacity for them. This file measures
 * what it can measure and says so.
 *
 * ⛔ It also does NOT prove production capacity in absolute terms: the fake
 * database is an in-memory Map, so the numbers below are a CEILING on the
 * application layer with the database removed. What they establish is the shape:
 * that nothing is quadratic, that concurrency does not corrupt state, and that
 * repeated cycles do not leak.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

type Row = Record<string, any>;

const state = {
  users: new Map<string, Row>(),
  sessions: new Map<string, Row>(),
  signals: [] as Row[],
  events: [] as Row[],
  control: null as Row | null,
  revocations: [] as Row[],
  perms: new Map<string, Set<string>>(),
  seq: 0,
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
  invalidate?.();
}
let invalidate: (() => void) | null = null;

const id = (p: string) => `${p}_${++state.seq}`;
const copy = <T>(v: T): T => (v == null ? v : (JSON.parse(JSON.stringify(v), revive) as T));
function revive(_k: string, v: any) {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v)) return new Date(v);
  return v;
}

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
      throw new Error(`fake db: unsupported condition on ${k}`);
    }
    if (v !== cond) return false;
  }
  return true;
}

function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "increment" in v) row[k] = (row[k] || 0) + (v as any).increment;
    else row[k] = v;
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
    // ⛔ A REAL delete, because the soak test's whole question is whether the one
    // table this feature writes to drains itself.
    deleteMany: async ({ where }: any) => {
      const before = state.signals.length;
      state.signals = state.signals.filter((s) => !matches(s, where));
      return { count: before - state.signals.length };
    },
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
    findUnique: async () => copy(state.control),
    upsert: async ({ create, update }: any) => {
      state.control = state.control ? { ...state.control, ...update } : { id: "global", ...create };
      return copy(state.control);
    },
  },
  remoteSupportRevocation: {
    findMany: async ({ where, take }: any) => {
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

let registerRemoteSupportRoutes: any = null;

/**
 * ⛔ Each simulated participant carries its OWN identity through the request,
 * rather than a module-level "current user" the way the attack suite does. That
 * matters here and only here: with hundreds of requests genuinely in flight, a
 * shared mutable actor would let one participant's identity be read by another's
 * handler — which would silently turn a concurrency test into a test of nothing.
 */
async function buildApp() {
  if (!registerRemoteSupportRoutes) {
    ({ registerRemoteSupportRoutes } = await import("../remoteSupportRoutes"));
    ({ invalidateRemoteSupportControls: invalidate } = await import("./controlStore"));
  }
  const app = Fastify();
  app.addHook("preHandler", async (req: any) => {
    const uid = String(req.headers["x-test-user"] || "");
    const u = state.users.get(uid);
    req.user = u ? { sub: u.id, tenantId: u.tenantId, role: u.role, email: u.email } : null;
  });
  await registerRemoteSupportRoutes(app as any, { audit: async () => {} });
  await app.ready();
  return app;
}

function call(app: any, who: string, method: string, url: string, payload?: any) {
  return app.inject({
    method,
    url,
    headers: { "x-test-user": who },
    ...(payload !== undefined ? { payload } : {}),
  });
}

function seedUser(id: string, tenantId: string, role = "USER", keys: string[] = []) {
  state.users.set(id, { id, tenantId, role, firstName: id, lastName: null, email: `${id}@t.test` });
  state.perms.set(id, new Set(keys));
}

/** One full session, start to finish, as a real pair would drive it. */
async function fullSession(app: any, tech: string, target: string) {
  const created = await call(app, tech, "POST", "/remote-support/sessions", {
    targetUserId: target,
    reason: "Load test session for capacity measurement.",
    requestControl: true,
    capabilities: ["control"],
  });
  if (created.statusCode !== 200) return { ok: false as const, stage: "request", code: created.statusCode };
  const sid = JSON.parse(created.body).session.id;

  const consented = await call(app, target, "POST", `/remote-support/sessions/${sid}/consent`, {
    allow: true,
    allowControl: true,
    allowCapabilities: ["control"],
    deviceId: `dev_${target}`,
  });
  if (consented.statusCode !== 200) return { ok: false as const, stage: "consent", code: consented.statusCode };

  await call(app, target, "POST", `/remote-support/sessions/${sid}/heartbeat`, {});
  await call(app, tech, "POST", `/remote-support/sessions/${sid}/heartbeat`, {});

  // A realistic negotiation: an offer, an answer, a handful of candidates.
  await call(app, tech, "POST", `/remote-support/sessions/${sid}/signal`, { kind: "offer", payload: { sdp: "v=0" } });
  await call(app, target, "GET", `/remote-support/sessions/${sid}/signal`);
  await call(app, target, "POST", `/remote-support/sessions/${sid}/signal`, { kind: "answer", payload: { sdp: "v=0" } });
  for (let i = 0; i < 4; i++) {
    await call(app, tech, "POST", `/remote-support/sessions/${sid}/signal`, {
      kind: "ice",
      payload: { candidate: `c${i}` },
    });
  }
  // ⛔ BOTH sides drain at the END, because both sides poll continuously in the
  // real clients. The first draft of this helper drained the customer BEFORE the
  // technician's ICE batch, so four candidates per cycle were left unconsumed —
  // 1760 rows over the soak, which read as a leak and was the simulation being
  // unrealistic. A negotiation that nobody finishes reading is not a negotiation.
  await call(app, tech, "GET", `/remote-support/sessions/${sid}/signal`);
  await call(app, target, "GET", `/remote-support/sessions/${sid}/signal`);

  await call(app, tech, "POST", `/remote-support/sessions/${sid}/input`, { count: 25 });
  const ended = await call(app, target, "POST", `/remote-support/sessions/${sid}/end`, {});
  if (ended.statusCode !== 200) return { ok: false as const, stage: "end", code: ended.statusCode };

  return { ok: true as const, sid };
}

const ms = (t: bigint) => Number(t) / 1e6;

/* ═══════════════════════ CONCURRENCY ══════════════════════════════ */

test("STRESS: 1 session end to end", async () => {
  reset();
  seedUser("tech", "T1", "USER", ["can_remote_support", "can_control_remote_support"]);
  seedUser("cust", "T1");
  const app = await buildApp();

  const t0 = process.hrtime.bigint();
  const r = await fullSession(app, "tech", "cust");
  const took = ms(process.hrtime.bigint() - t0);

  assert.equal(r.ok, true, `single session failed at ${(r as any).stage} with ${(r as any).code}`);
  console.log(`    [stress] 1 session, full lifecycle: ${took.toFixed(1)} ms`);
  assert.equal(state.sessions.size, 1);
  assert.equal([...state.sessions.values()][0].status, "ENDED");
  assert.equal([...state.sessions.values()][0].inputEventCount, 25);
});

for (const N of [10, 50, 120]) {
  test(`STRESS: ${N} simultaneous sessions across ${N} tenants`, async () => {
    reset();
    // ⛔ One tenant per pair. Deliberate: it puts the tenant-isolation code on
    // the hot path under concurrency, which is where a cross-tenant leak would
    // actually appear.
    for (let i = 0; i < N; i++) {
      seedUser(`tech${i}`, `T${i}`, "USER", ["can_remote_support", "can_control_remote_support"]);
      seedUser(`cust${i}`, `T${i}`);
    }
    const app = await buildApp();

    const t0 = process.hrtime.bigint();
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => fullSession(app, `tech${i}`, `cust${i}`)),
    );
    const took = ms(process.hrtime.bigint() - t0);

    const failed = results.filter((r) => !r.ok);
    assert.equal(failed.length, 0, `${failed.length} of ${N} failed: ${JSON.stringify(failed.slice(0, 3))}`);
    assert.equal(state.sessions.size, N);

    // ⛔⛔ THE CHECK THAT MATTERS UNDER CONCURRENCY: no session may have ended up
    // attributed to the wrong tenant, and every one must have exactly its own
    // input count. A race in the store would show as either.
    for (let i = 0; i < N; i++) {
      const mine = [...state.sessions.values()].filter((s) => s.targetUserId === `cust${i}`);
      assert.equal(mine.length, 1, `cust${i} has ${mine.length} sessions`);
      assert.equal(mine[0].tenantId, `T${i}`, "a session was filed under the wrong tenant");
      assert.equal(mine[0].requestedByUserId, `tech${i}`, "a session was attributed to the wrong technician");
      assert.equal(mine[0].inputEventCount, 25, "input counts were lost or double-counted");
      assert.equal(mine[0].status, "ENDED");
    }

    console.log(
      `    [stress] ${N} concurrent sessions: ${took.toFixed(0)} ms total, ` +
        `${(took / N).toFixed(1)} ms/session, ${((N / took) * 1000).toFixed(0)} sessions/sec`,
    );
  });
}

test("⛔ throughput does not collapse as concurrency rises (nothing is quadratic)", async () => {
  const perSession: Record<number, number> = {};
  for (const N of [20, 80]) {
    reset();
    for (let i = 0; i < N; i++) {
      seedUser(`t${i}`, `T${i}`, "USER", ["can_remote_support", "can_control_remote_support"]);
      seedUser(`c${i}`, `T${i}`);
    }
    const app = await buildApp();
    const t0 = process.hrtime.bigint();
    await Promise.all(Array.from({ length: N }, (_, i) => fullSession(app, `t${i}`, `c${i}`)));
    perSession[N] = ms(process.hrtime.bigint() - t0) / N;
  }
  const ratio = perSession[80] / perSession[20];
  console.log(
    `    [stress] per-session cost: ${perSession[20].toFixed(2)} ms @20 -> ` +
      `${perSession[80].toFixed(2)} ms @80 (x${ratio.toFixed(2)})`,
  );
  // 4x the load must not cost anywhere near 4x per session. A quadratic path
  // would show as a ratio near 4; a linear one sits near 1.
  assert.ok(ratio < 2.5, `per-session cost grew ${ratio.toFixed(2)}x — something is superlinear`);
});

/* ═════════════════════ HAMMERING ONE SESSION ═════════════════════ */

test("⛔ 200 concurrent heartbeats on one session cannot corrupt it", async () => {
  reset();
  seedUser("tech", "T1", "USER", ["can_remote_support", "can_control_remote_support"]);
  seedUser("cust", "T1");
  const app = await buildApp();

  const created = await call(app, "tech", "POST", "/remote-support/sessions", {
    targetUserId: "cust",
    reason: "Hammering the heartbeat endpoint.",
    requestControl: true,
  });
  const sid = JSON.parse(created.body).session.id;
  await call(app, "cust", "POST", `/remote-support/sessions/${sid}/consent`, { allow: true, allowControl: true });

  const beats = await Promise.all(
    Array.from({ length: 200 }, (_, i) =>
      call(app, i % 2 === 0 ? "tech" : "cust", "POST", `/remote-support/sessions/${sid}/heartbeat`, {}),
    ),
  );
  assert.ok(beats.every((b) => b.statusCode === 200), "a heartbeat was refused under load");

  const row = state.sessions.get(sid)!;
  assert.equal(row.status, "ACTIVE");
  assert.ok(row.lastSeenAdminAt, "the admin beat was lost");
  assert.ok(row.lastSeenClientAt, "the client beat was lost");
  // ⛔ Exactly one session, still. A create-under-load bug would show here.
  assert.equal(state.sessions.size, 1);
});

test("⛔ 100 concurrent input reports are counted exactly once each", async () => {
  reset();
  seedUser("tech", "T1", "USER", ["can_remote_support", "can_control_remote_support"]);
  seedUser("cust", "T1");
  const app = await buildApp();
  const created = await call(app, "tech", "POST", "/remote-support/sessions", {
    targetUserId: "cust",
    reason: "Counting input under concurrency.",
    requestControl: true,
  });
  const sid = JSON.parse(created.body).session.id;
  await call(app, "cust", "POST", `/remote-support/sessions/${sid}/consent`, { allow: true, allowControl: true });
  await call(app, "cust", "POST", `/remote-support/sessions/${sid}/heartbeat`, {});
  await call(app, "tech", "POST", `/remote-support/sessions/${sid}/heartbeat`, {});

  await Promise.all(
    Array.from({ length: 100 }, () => call(app, "tech", "POST", `/remote-support/sessions/${sid}/input`, { count: 3 })),
  );
  // ⛔ 300 exactly. A lost update would read low; a double-apply would read high.
  assert.equal(state.sessions.get(sid)!.inputEventCount, 300);
});

test("⛔ ending while 50 requests are in flight is still a clean stop", async () => {
  reset();
  seedUser("tech", "T1", "USER", ["can_remote_support", "can_control_remote_support"]);
  seedUser("cust", "T1");
  const app = await buildApp();
  const created = await call(app, "tech", "POST", "/remote-support/sessions", {
    targetUserId: "cust",
    reason: "Ending mid-flight.",
    requestControl: true,
  });
  const sid = JSON.parse(created.body).session.id;
  await call(app, "cust", "POST", `/remote-support/sessions/${sid}/consent`, { allow: true, allowControl: true });
  await call(app, "cust", "POST", `/remote-support/sessions/${sid}/heartbeat`, {});
  await call(app, "tech", "POST", `/remote-support/sessions/${sid}/heartbeat`, {});

  // The customer hangs up while the technician is mid-stream.
  await Promise.all([
    ...Array.from({ length: 50 }, () => call(app, "tech", "POST", `/remote-support/sessions/${sid}/input`, { count: 1 })),
    call(app, "cust", "POST", `/remote-support/sessions/${sid}/end`, {}),
  ]);

  const row = state.sessions.get(sid)!;
  assert.equal(row.status, "ENDED", "the session survived the customer pressing stop");
  assert.equal(row.endedBy, "customer");

  // ⛔ And nothing may be accepted afterwards, however many were queued.
  const after = await call(app, "tech", "POST", `/remote-support/sessions/${sid}/input`, { count: 1 });
  assert.equal(after.statusCode, 403);
});

/* ═════════════════════════ THE KILL SWITCH AT SCALE ═══════════════ */

test("⛔⛔ one kill switch ends 100 live sessions across 100 tenants", async () => {
  reset();
  seedUser("root", "T_ADMIN", "SUPER_ADMIN");
  for (let i = 0; i < 100; i++) {
    seedUser(`t${i}`, `T${i}`, "USER", ["can_remote_support", "can_control_remote_support"]);
    seedUser(`c${i}`, `T${i}`);
  }
  const app = await buildApp();

  await Promise.all(
    Array.from({ length: 100 }, async (_, i) => {
      const created = await call(app, `t${i}`, "POST", "/remote-support/sessions", {
        targetUserId: `c${i}`,
        reason: "A live session for the kill-switch test.",
      });
      const sid = JSON.parse(created.body).session.id;
      await call(app, `c${i}`, "POST", `/remote-support/sessions/${sid}/consent`, { allow: true });
      await call(app, `c${i}`, "POST", `/remote-support/sessions/${sid}/heartbeat`, {});
      await call(app, `t${i}`, "POST", `/remote-support/sessions/${sid}/heartbeat`, {});
    }),
  );
  const live = [...state.sessions.values()].filter((s) => s.status === "ACTIVE").length;
  assert.equal(live, 100, `only ${live} sessions went live`);

  const t0 = process.hrtime.bigint();
  const off = await call(app, "root", "POST", "/admin/remote-support/controls", {
    enabled: false,
    reason: "incident drill",
  });
  const took = ms(process.hrtime.bigint() - t0);

  assert.equal(off.statusCode, 200);
  assert.equal(JSON.parse(off.body).sessionsEnded, 100);
  const stillLive = [...state.sessions.values()].filter((s) => s.status !== "ENDED").length;
  assert.equal(stillLive, 0, `${stillLive} sessions survived the kill switch`);
  console.log(`    [stress] kill switch ended 100 live sessions in ${took.toFixed(0)} ms`);
});

/* ═════════════════════════ SOAK ═══════════════════════════════════ */

test("SOAK: 400 sequential session cycles leak nothing", async () => {
  reset();
  /**
   * ⛔ A POOL OF TECHNICIANS, NOT ONE — AND THE FIRST DRAFT OF THIS TEST FAILING
   * IS ITSELF A RESULT WORTH KEEPING.
   *
   * Driving 440 cycles through a single technician failed at cycle 0, refused by
   * the abuse protection: ten sessions per five minutes per actor. That is the
   * rate limiter being right, and it means a one-technician soak is not a shape
   * this product permits. A real support desk is many people over a long period,
   * so the soak is many people — which is also the only version that exercises
   * the per-actor rate-limit query at depth.
   */
  const POOL = 60;
  for (let i = 0; i < POOL; i++) {
    seedUser(`tech${i}`, "T1", "USER", ["can_remote_support", "can_control_remote_support"]);
  }
  seedUser("cust", "T1");
  const app = await buildApp();
  const techFor = (n: number) => `tech${n % POOL}`;

  // Warm up, then measure, so JIT is not read as a leak.
  for (let i = 0; i < 40; i++) await fullSession(app, techFor(i), "cust");
  if (global.gc) global.gc();
  const heapStart = process.memoryUsage().heapUsed;
  const signalsAfterWarmup = state.signals.length;

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 400; i++) {
    const r = await fullSession(app, techFor(40 + i), "cust");
    assert.equal(r.ok, true, `cycle ${i} failed at ${(r as any).stage} (${(r as any).code})`);
  }
  const took = ms(process.hrtime.bigint() - t0);
  if (global.gc) global.gc();
  const heapEnd = process.memoryUsage().heapUsed;

  const grewMb = (heapEnd - heapStart) / 1024 / 1024;
  console.log(
    `    [soak] 440 cycles, ${took.toFixed(0)} ms for the measured 400 ` +
      `(${(took / 400).toFixed(2)} ms/cycle), heap ${grewMb >= 0 ? "+" : ""}${grewMb.toFixed(1)} MB`,
  );

  // ⛔ The rows themselves ARE expected to grow — they are the audit trail, and a
  // support session that vanished from history would be the bug. What must not
  // grow without bound is the SIGNALLING table, which is scratch space.
  assert.equal(state.sessions.size, 440, "sessions were lost from history");

  // ⛔ Every signalling row must have been consumed. An un-drained backlog is the
  // leak that would eventually refuse real negotiations.
  const unconsumed = state.signals.filter((s) => !s.consumedAt).length;
  assert.equal(unconsumed, 0, `${unconsumed} signalling rows were never drained`);
  assert.ok(
    state.signals.length >= signalsAfterWarmup,
    "signalling rows went backwards, which means the purge is deleting live rows",
  );

  // ⛔ A generous ceiling on its own: what is being asserted is "no runaway",
  // not a precise number, because a heap figure in a test process is noisy.
  assert.ok(grewMb < 80, `heap grew ${grewMb.toFixed(1)} MB over 400 cycles — investigate before shipping`);
});

test("SOAK: a long-lived session survives 500 heartbeat rounds", async () => {
  reset();
  seedUser("tech", "T1", "USER", ["can_remote_support", "can_control_remote_support"]);
  seedUser("cust", "T1");
  const app = await buildApp();

  const created = await call(app, "tech", "POST", "/remote-support/sessions", {
    targetUserId: "cust",
    reason: "A long session, beating for a long time.",
    requestControl: true,
  });
  const sid = JSON.parse(created.body).session.id;
  await call(app, "cust", "POST", `/remote-support/sessions/${sid}/consent`, { allow: true, allowControl: true });

  for (let i = 0; i < 500; i++) {
    const a = await call(app, "cust", "POST", `/remote-support/sessions/${sid}/heartbeat`, {});
    const b = await call(app, "tech", "POST", `/remote-support/sessions/${sid}/heartbeat`, {});
    assert.equal(a.statusCode, 200, `client beat ${i} refused`);
    assert.equal(b.statusCode, 200, `admin beat ${i} refused`);
  }
  assert.equal(state.sessions.get(sid)!.status, "ACTIVE");
  // ⛔ 1000 beats must not have produced 1000 rows anywhere.
  assert.equal(state.sessions.size, 1);
  assert.ok(state.events.length < 20, `${state.events.length} events from heartbeats alone`);
});

test("⛔ the signalling table drains rather than growing with the session", async () => {
  reset();
  seedUser("tech", "T1", "USER", ["can_remote_support", "can_control_remote_support"]);
  seedUser("cust", "T1");
  const app = await buildApp();
  const created = await call(app, "tech", "POST", "/remote-support/sessions", {
    targetUserId: "cust",
    reason: "Draining the signal table.",
  });
  const sid = JSON.parse(created.body).session.id;
  await call(app, "cust", "POST", `/remote-support/sessions/${sid}/consent`, { allow: true });
  await call(app, "cust", "POST", `/remote-support/sessions/${sid}/heartbeat`, {});
  await call(app, "tech", "POST", `/remote-support/sessions/${sid}/heartbeat`, {});

  // A very chatty ICE negotiation, drained as it goes, exactly as the clients do.
  for (let round = 0; round < 40; round++) {
    for (let i = 0; i < 5; i++) {
      await call(app, "tech", "POST", `/remote-support/sessions/${sid}/signal`, {
        kind: "ice",
        payload: { candidate: `r${round}c${i}` },
      });
    }
    const drained = await call(app, "cust", "GET", `/remote-support/sessions/${sid}/signal`);
    assert.equal(drained.statusCode, 200);
  }
  const pending = state.signals.filter((s) => !s.consumedAt).length;
  assert.equal(pending, 0, `${pending} signals left undelivered after 200 candidates`);
});

test("⛔⛔ ABANDONED signalling rows are purged by age — the real leak guard", async () => {
  reset();
  seedUser("tech", "T1", "USER", ["can_remote_support", "can_control_remote_support"]);
  seedUser("cust", "T1");
  const app = await buildApp();

  const created = await call(app, "tech", "POST", "/remote-support/sessions", {
    targetUserId: "cust",
    reason: "A negotiation that is abandoned half way.",
  });
  const sid = JSON.parse(created.body).session.id;
  await call(app, "cust", "POST", `/remote-support/sessions/${sid}/consent`, { allow: true });
  await call(app, "cust", "POST", `/remote-support/sessions/${sid}/heartbeat`, {});
  await call(app, "tech", "POST", `/remote-support/sessions/${sid}/heartbeat`, {});

  // The technician offers and posts candidates; the customer's app is then
  // closed and never reads them. This is the shape that would accumulate.
  for (let i = 0; i < 30; i++) {
    await call(app, "tech", "POST", `/remote-support/sessions/${sid}/signal`, {
      kind: "ice",
      payload: { candidate: `abandoned${i}` },
    });
  }
  assert.equal(state.signals.filter((s) => !s.consumedAt).length, 30);

  // ⛔ Age them past SIGNAL_TTL_MS. The purge runs opportunistically on the drain
  // route, so a session that is still being used cleans up after abandoned ones.
  const old = new Date(Date.now() - 10 * 60 * 1000);
  for (const s of state.signals) s.createdAt = old;

  await call(app, "cust", "GET", `/remote-support/sessions/${sid}/signal`);
  // The purge is fire-and-forget inside the handler; let it settle.
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(
    state.signals.length,
    0,
    `${state.signals.length} stale signalling rows survived the purge — this is the unbounded-growth path`,
  );
});
