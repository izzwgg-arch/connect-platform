/**
 * Chaos: thousands of RANDOM operation sequences against the real routes, with the
 * invariants checked after every single step.
 *
 * ⛔⛔ THE STRESS TEST PROVES THE SCENARIOS SOMEBODY THOUGHT OF. THIS PROVES THE ONES
 * NOBODY DID. A setup run is a state machine driven by a customer clicking, an office
 * machine reporting, a network changing under it and a wizard being closed halfway —
 * in any order, repeated, interleaved and duplicated. The bugs that survive review
 * live in orderings, not in single calls.
 *
 * The generator is deterministic (a seeded PRNG) so a failure is reproducible: the
 * seed is printed with the assertion.
 *
 * Run with: node --experimental-test-module-mocks --import tsx --test
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

/* ── deterministic randomness ────────────────────────────────────────────── */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    // xorshift32 — deterministic, so any failure is reproducible from the seed
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length) % xs.length];

/* ── fake db ─────────────────────────────────────────────────────────────── */

const state: any = { runs: [], phones: [], extensions: [], tenants: [], audits: [] };
let seq = 0;
const nextId = (p: string) => `${p}_${++seq}`;
const matches = (row: any, where: any): boolean =>
  Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return (v as any).in.includes(row[k]);
      if ("not" in v) return row[k] !== (v as any).not;
      return true;
    }
    return row[k] === v;
  });

// ⛔⛔ READS RETURN A SNAPSHOT COPY, NOT THE LIVE ROW. This is what makes the fake
// model production faithfully: Prisma hands back a fresh object, so two concurrent
// callers that each read before either writes both see the OLD value — the exact
// race the atomic reset claim exists to defeat. A fake that returned the live shared
// row would let the second caller see the first's mutation and mask the race.
const snap = (r: any) => (r ? { ...r } : r);

/**
 * ⛔⛔ READS TAKE REAL WALL TIME WHEN THIS IS ON. Awaits alone do NOT interleave the
 * way a real database does — under the microtask queue, N concurrent handlers march
 * in lockstep and each write lands before the next read, so a check-then-act race
 * NEVER fires and a non-atomic claim looks safe. (Proven: the concurrency test below
 * passed against the pre-fix route until this delay existed.) A setImmediate per read
 * gives each read a genuine turn of the event loop, which is what lets two callers
 * both read the OLD row before either writes — production's actual shape.
 */
let readDelay = false;
const maybeDelay = async () => { if (readDelay) await new Promise((r) => setImmediate(r)); };

function table(bucket: string, defaults: () => any) {
  return {
    findFirst: async ({ where }: any = {}) => {
      await maybeDelay();
      return snap(state[bucket].find((r: any) => matches(r, where)) ?? null);
    },
    findMany: async ({ where }: any = {}) => state[bucket].filter((r: any) => matches(r, where)).map(snap),
    create: async ({ data }: any) => { const row = { ...defaults(), ...data }; state[bucket].push(row); return snap(row); },
    update: async ({ where, data }: any) => {
      // ⛔ The write is ALSO delayed — the race needs caller B's read to land in the
      // gap between caller A's read and A's write, and that gap only exists if the
      // write itself costs a turn of the event loop, as a real database write does.
      await maybeDelay();
      const row = state[bucket].find((r: any) => r.id === where.id);
      if (!row) throw new Error("record not found");
      Object.assign(row, data); return row;
    },
    // ⛔ Honours the WHERE clause, so the atomic reset claim is genuinely tested: a
    // second concurrent writer whose guard no longer matches updates zero rows.
    updateMany: async ({ where, data }: any = {}) => {
      await maybeDelay();
      const rows = state[bucket].filter((r: any) => matches(r, where));
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
  };
}

mock.module("@connect/db", {
  namedExports: {
    db: {
      deskPhoneSetupRun: table("runs", () => ({
        id: nextId("run"), status: "running", origin: "customer", startedAt: new Date(),
        subnet: null, resetAuthorizedAt: null, resetAuthorizedByUserId: null, resetAuthorizedPhoneIds: null,
      })),
      deskPhoneSetupPhone: table("phones", () => ({
        id: nextId("ph"), state: "DISCOVERED", attempts: 0, resetCount: 0, createdAt: new Date(),
        ipAddress: null, previousIp: null, vendor: null, model: null, firmware: null,
        provisioningUrl: null, extensionId: null, extNumber: null, displayName: null,
        customerNote: null, technicalNote: null, resetRequestedAt: null, registeredAt: null, haltedReason: null,
      })),
      extension: table("extensions", () => ({ id: nextId("ext"), status: "ACTIVE" })),
      tenant: table("tenants", () => ({ id: nextId("t") })),
    },
  },
});

let allowSetup = true, allowReset = true;
mock.module("../permissionGates", {
  namedExports: {
    userHasActionPermission: async (_u: any, key: string) =>
      key === "can_setup_desk_phones" ? allowSetup : key === "can_authorize_phone_reset" ? allowReset : false,
  },
});

let routesModule: any = null;
const routes = () => (routesModule ??= require("./deskPhoneRoutes")).registerDeskPhoneSetupRoutes;

/* ── harness ─────────────────────────────────────────────────────────────── */

let registered = new Set<string>();
let pbxDown = false;

const CUSTOMER = { sub: "u_1", tenantId: "t_abc", email: "a@b.example", role: "TENANT_ADMIN" };
const OTHER = { sub: "u_9", tenantId: "t_evil", email: "x@y.example", role: "TENANT_ADMIN" };

async function app(user: any = CUSTOMER) {
  const a = Fastify();
  a.addHook("preHandler", async (req: any) => { req.user = user; });
  await routes()(a as any, {
    audit: async (p: any) => { state.audits.push(p); },
    ourProvisioningHosts: () => ["loopcom.net"],
    isRegistered: async (_t: string, ext: string) => {
      if (pbxDown) throw new Error("PBX unreachable");
      return registered.has(ext);
    },
  });
  return a;
}

function reset() {
  state.runs.length = 0; state.phones.length = 0; state.extensions.length = 0;
  state.tenants.length = 0; state.audits.length = 0;
  allowSetup = true; allowReset = true; registered = new Set(); pbxDown = false;
  state.tenants.push({ id: "t_abc", name: "ABC" });
  for (let i = 0; i < 12; i += 1) {
    state.extensions.push({ id: `e${i}`, tenantId: "t_abc", extNumber: String(101 + i), displayName: `P${i}`, status: "ACTIVE" });
  }
}

const B = (r: any) => JSON.parse(r.body);
const macOf = (n: number) => `80:5E:0C:BD:${((n >> 8) & 255).toString(16).padStart(2, "0")}:${(n & 255).toString(16).padStart(2, "0")}`;

const CUSTOMER_WORDS = new Set(["Finding", "Preparing", "Restarting", "Connecting", "Ready", "Needs attention"]);
const JARGON = /\b(HTTP|HTTPS|401|403|404|500|SIP|DHCP|Option\s*66|RPS|TFTP|MAC|subnet|provisioning|firmware|endpoint)\b/i;

/** Everything that must be true after ANY step, in ANY order, forever. */
function checkInvariants(seed: number, step: number) {
  const why = (m: string) => `${m}  [seed=${seed} step=${step}]`;
  for (const p of state.phones) {
    assert.ok(p.resetCount <= 1, why(`a phone was reset ${p.resetCount} times`));
    assert.ok(p.attempts <= 3, why(`attempts ran to ${p.attempts}`));
    assert.equal(p.tenantId, "t_abc", why("a phone escaped its customer"));
    assert.ok(typeof p.macAddress === "string" && /^[0-9a-f]{12}$/.test(p.macAddress),
      why(`stored a bad hardware id: ${p.macAddress}`));
    if (p.resetCount > 0) {
      const run = state.runs.find((r: any) => r.id === p.runId);
      assert.ok(run?.resetAuthorizedAt, why("a phone was reset with no authorisation on its run"));
    }
    if (p.customerNote) assert.ok(!JARGON.test(p.customerNote), why(`jargon on a customer note: ${p.customerNote}`));
    if (p.registeredAt) assert.equal(p.state, "REGISTERED", why("registeredAt set on a phone that is not Ready"));
  }
  // one live run per customer, forever
  const live = state.runs.filter((r: any) => r.tenantId === "t_abc" && r.status === "running");
  assert.ok(live.length <= 1, why(`${live.length} live runs for one customer`));
}

/* ── the chaos itself ────────────────────────────────────────────────────── */

const OPS = [
  "start", "discover", "rediscover", "assign", "unassign", "authorize",
  "advance", "advance", "advance", "read", "readDiag", "buttons",
  "pbxUp", "pbxDown", "revokeReset", "grantReset", "reopen", "crossTenant",
] as const;

async function chaosRun(seed: number, steps: number) {
  const r = rng(seed);
  reset();
  let a = await app();
  const evil = await app(OTHER);
  let runId: string | null = null;

  for (let step = 0; step < steps; step += 1) {
    const op = pick(r, OPS as unknown as string[]);
    try {
      switch (op) {
        case "start": {
          const out = B(await a.inject({ method: "POST", url: "/desk-phones/runs", payload: {} }));
          if (out?.run?.id) runId = out.run.id;
          break;
        }
        case "reopen":
          a = await app();               // the wizard closed and came back
          break;
        case "discover":
        case "rediscover": {
          if (!runId) break;
          const n = Math.floor(r() * 6);
          const phones = Array.from({ length: n }, (_, i) => ({
            mac: macOf(Math.floor(r() * 8)),
            ip: `192.168.1.${10 + Math.floor(r() * 40)}`,
            model: pick(r, ["T54W", "T42S", "T29G", "", "T99Z"]),
            provisioningUrl: pick(r, [
              "", "https://pbx.loopcom.net/x", "https://prov.old.example/x", "not a url",
            ]),
          }));
          await a.inject({ method: "POST", url: `/desk-phones/runs/${runId}/discovered`, payload: { subnet: "192.168.1.0/24", phones } });
          break;
        }
        case "assign": {
          if (!runId || !state.phones.length) break;
          const p: any = pick(r, state.phones);
          await a.inject({
            method: "POST", url: `/desk-phones/runs/${runId}/phones/${p.id}/assign`,
            payload: { extensionId: pick(r, ["e0", "e1", "e2", "e_nope", "e3"]) },
          });
          break;
        }
        case "unassign": {
          if (!runId || !state.phones.length) break;
          const p: any = pick(r, state.phones);
          await a.inject({ method: "POST", url: `/desk-phones/runs/${runId}/phones/${p.id}/assign`, payload: { extensionId: null } });
          break;
        }
        case "authorize": {
          if (!runId || !state.phones.length) break;
          const count = 1 + Math.floor(r() * state.phones.length);
          const ids = state.phones.slice(0, count).map((p: any) => p.id);
          if (r() < 0.2) ids.push("ph_does_not_exist");
          await a.inject({ method: "POST", url: `/desk-phones/runs/${runId}/authorize-reset`, payload: { phoneIds: ids } });
          break;
        }
        case "advance": {
          if (!runId || !state.phones.length) break;
          const p: any = pick(r, state.phones);
          const out = B(await a.inject({
            method: "POST", url: `/desk-phones/runs/${runId}/phones/${p.id}/advance`,
            payload: {
              reachableOnLan: r() < 0.7, locked: r() < 0.3,
              defaultCredentialsTried: r() < 0.5, haveCustomerCredentials: r() < 0.3,
              onACall: r() < 0.15, awaitingReboot: r() < 0.2,
              networkSuppliesOldProvisioning: r() < 0.2,
              passwordUnavailable: r() < 0.15, resetDeclined: r() < 0.15,
            },
          }));
          if (out?.customerMessage) {
            assert.ok(!JARGON.test(out.customerMessage), `jargon: ${out.customerMessage} [seed=${seed} step=${step}]`);
          }
          if (out?.phone?.status) {
            assert.ok(CUSTOMER_WORDS.has(out.phone.status), `bad status ${out.phone.status} [seed=${seed} step=${step}]`);
          }
          break;
        }
        case "read":
        case "readDiag": {
          if (!runId) break;
          const url = op === "read" ? `/desk-phones/runs/${runId}` : `/desk-phones/runs/${runId}?view=diagnostics`;
          const out = B(await a.inject({ method: "GET", url }));
          if (out?.phones) {
            for (const p of out.phones) {
              assert.ok(CUSTOMER_WORDS.has(p.status), `bad status ${p.status} [seed=${seed} step=${step}]`);
              if (op === "read") {
                // ⛔ the customer view must never carry the technical fields
                assert.equal(p.mac, undefined, `mac leaked to the customer view [seed=${seed} step=${step}]`);
                assert.equal(p.ip, undefined, `ip leaked [seed=${seed} step=${step}]`);
                assert.equal(p.provisioningUrl, undefined, `provisioning url leaked [seed=${seed} step=${step}]`);
              }
            }
            assert.ok(out.summary.ready <= out.summary.total);
            assert.ok(!/fail/i.test(out.summary.headline), `headline said fail [seed=${seed} step=${step}]`);
          }
          break;
        }
        case "buttons": {
          if (!runId || !state.phones.length) break;
          const p: any = pick(r, state.phones);
          const out = B(await a.inject({ method: "GET", url: `/desk-phones/runs/${runId}/phones/${p.id}/buttons` }));
          if (out?.colleagues && p.extNumber) {
            assert.ok(!out.colleagues.some((c: any) => c.extension === p.extNumber),
              `a phone got a button for itself [seed=${seed} step=${step}]`);
          }
          break;
        }
        case "pbxUp": pbxDown = false; break;
        case "pbxDown": pbxDown = true; break;
        case "revokeReset": allowReset = false; break;
        case "grantReset": allowReset = true; break;
        case "crossTenant": {
          if (!runId) break;
          // ⛔ another customer poking at this run, at a random moment
          const probes: Array<[string, string, any]> = [
            ["GET", `/desk-phones/runs/${runId}`, undefined],
            ["POST", `/desk-phones/runs/${runId}/discovered`, { phones: [{ mac: macOf(999) }] }],
            ["POST", `/desk-phones/runs/${runId}/authorize-reset`, { phoneIds: state.phones.map((x: any) => x.id) }],
          ];
          for (const [m, u, pl] of probes) {
            const res: any = await evil.inject({ method: m, url: u, payload: pl } as any);
            assert.equal(res.statusCode, 404, `cross-tenant ${m} ${u} returned ${res.statusCode} [seed=${seed} step=${step}]`);
          }
          break;
        }
      }
    } catch (err: any) {
      // an assertion inside the switch is a real failure; anything else is a bug too
      throw new Error(`${op} threw at step ${step} [seed=${seed}]: ${err?.message}`);
    }
    checkInvariants(seed, step);
  }
}

test("CHAOS: 300 random runs of 40 steps hold every invariant", async () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    await chaosRun(seed * 2654435761, 40);
  }
});

test("CHAOS: a long single run of 500 steps never loses its mind", async () => {
  await chaosRun(0xC0FFEE, 500);
});

test("CHAOS: the reset counter survives any interleaving of authorise and advance", async () => {
  // the specific ordering worth hammering: approve, advance, approve again, advance
  for (let seed = 1; seed <= 60; seed += 1) {
    const r = rng(seed * 97);
    reset();
    const a = await app();
    const runId = B(await a.inject({ method: "POST", url: "/desk-phones/runs", payload: {} })).run.id;
    await a.inject({
      method: "POST", url: `/desk-phones/runs/${runId}/discovered`,
      payload: { phones: [{ mac: macOf(1), provisioningUrl: "https://prov.old.example/x" }] },
    });
    const p = state.phones[0];
    for (let i = 0; i < 25; i += 1) {
      if (r() < 0.5) {
        await a.inject({ method: "POST", url: `/desk-phones/runs/${runId}/authorize-reset`, payload: { phoneIds: [p.id] } });
      } else {
        await a.inject({ method: "POST", url: `/desk-phones/runs/${runId}/phones/${p.id}/advance`, payload: {} });
      }
      assert.ok(state.phones[0].resetCount <= 1,
        `re-authorising re-armed a wipe: resetCount=${state.phones[0].resetCount} [seed=${seed}]`);
    }
  }
});

test("CHAOS: concurrent everything on one phone still resets it at most once", async () => {
  // ⛔ Database latency ON for this test — without it the microtask queue marches the
  // concurrent handlers in lockstep, every write lands before the next read, and the
  // check-then-act race can never fire. With it, this test FAILS against the pre-fix
  // non-atomic route (two reset audits), which is what makes it a real guard.
  readDelay = true;
  try {
  for (let seed = 1; seed <= 25; seed += 1) {
    reset();
    const a = await app();
    const runId = B(await a.inject({ method: "POST", url: "/desk-phones/runs", payload: {} })).run.id;
    await a.inject({
      method: "POST", url: `/desk-phones/runs/${runId}/discovered`,
      payload: { phones: [{ mac: macOf(2), provisioningUrl: "https://prov.old.example/x" }] },
    });
    const p = state.phones[0];
    await a.inject({ method: "POST", url: `/desk-phones/runs/${runId}/authorize-reset`, payload: { phoneIds: [p.id] } });
    await Promise.all([
      ...Array.from({ length: 15 }, () =>
        a.inject({ method: "POST", url: `/desk-phones/runs/${runId}/phones/${p.id}/advance`, payload: {} })),
      ...Array.from({ length: 5 }, () =>
        a.inject({ method: "POST", url: `/desk-phones/runs/${runId}/authorize-reset`, payload: { phoneIds: [p.id] } })),
      ...Array.from({ length: 5 }, () =>
        a.inject({ method: "GET", url: `/desk-phones/runs/${runId}` })),
    ]);
    assert.ok(state.phones[0].resetCount <= 1,
      `concurrency produced ${state.phones[0].resetCount} resets [seed=${seed}]`);
    // ⛔⛔ THE PROPERTY THE ATOMIC CLAIM EXISTS FOR: not just that resetCount lands at
    // 1, but that only ONE reset was ever ISSUED. Before the claim, two concurrent
    // advances both read 0, both wrote 1, and both audited a reset — resetCount would
    // read 1 while two wipes went out. Count the audit rows, not the counter.
    const issued = state.audits.filter(
      (r: any) => r.action === "DESK_PHONE_RESET_REQUESTED" && r.entityId === state.phones[0].id,
    ).length;
    assert.ok(issued <= 1, `concurrency issued ${issued} reset instructions [seed=${seed}]`);
  }
  } finally { readDelay = false; }
});

test("CHAOS: no body shape on any route can produce a 500", async () => {
  reset();
  const a = await app();
  const runId = B(await a.inject({ method: "POST", url: "/desk-phones/runs", payload: {} })).run.id;
  await a.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/discovered`,
    payload: { phones: [{ mac: macOf(3) }] },
  });
  const phoneId = state.phones[0].id;

  const bodies: unknown[] = [
    undefined, null, {}, [], 0, "", "not json", true,
    { phones: null }, { phones: {} }, { phones: [null] }, { phones: [{}] },
    { phones: [{ mac: null }] }, { phones: [{ mac: 12345 }] },
    { extensionId: 0 }, { extensionId: [] }, { extensionId: {} },
    { phoneIds: [] }, { phoneIds: null }, { phoneIds: "x" }, { phoneIds: [null] },
    { phoneIds: Array.from({ length: 501 }, (_, i) => `p${i}`) },
    { reachableOnLan: "yes" }, { onACall: 1 }, { locked: null },
    { tenantId: "t_evil" }, { __proto__: { polluted: true } },
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ];
  const urls: Array<[string, string]> = [
    ["POST", "/desk-phones/runs"],
    ["POST", `/desk-phones/runs/${runId}/discovered`],
    ["POST", `/desk-phones/runs/${runId}/authorize-reset`],
    ["POST", `/desk-phones/runs/${runId}/phones/${phoneId}/assign`],
    ["POST", `/desk-phones/runs/${runId}/phones/${phoneId}/advance`],
  ];
  for (const [method, url] of urls) {
    for (const payload of bodies) {
      const res = await a.inject({ method, url, payload } as any);
      assert.ok(res.statusCode < 500, `${method} ${url} -> ${res.statusCode} for ${JSON.stringify(payload)?.slice(0, 50)}`);
    }
  }
  assert.equal(({} as any).polluted, undefined, "the prototype was polluted through a route body");
});

test("CHAOS: unknown ids on every route answer 404 rather than leaking or crashing", async () => {
  reset();
  const a = await app();
  const junkIds = ["", " ", "nope", "../../etc/passwd", "%2e%2e", "'; DROP TABLE x;--", "x".repeat(500)];
  for (const id of junkIds) {
    for (const [method, url, payload] of [
      ["GET", `/desk-phones/runs/${encodeURIComponent(id)}`, undefined],
      ["POST", `/desk-phones/runs/${encodeURIComponent(id)}/discovered`, { phones: [] }],
      ["POST", `/desk-phones/runs/${encodeURIComponent(id)}/authorize-reset`, { phoneIds: ["a"] }],
      ["GET", `/desk-phones/runs/${encodeURIComponent(id)}/phones/${encodeURIComponent(id)}/buttons`, undefined],
    ] as Array<[string, string, any]>) {
      const res = await a.inject({ method, url, payload } as any);
      assert.ok([400, 404].includes(res.statusCode), `${method} ${url} -> ${res.statusCode}`);
      assert.ok(!res.body.includes("prisma"), "an internal detail leaked");
      assert.ok(!res.body.includes("at Object."), "a stack trace leaked");
    }
  }
});
