/**
 * The stress test.
 *
 * Izzy, 2026-08-21: "Stress test everything that is working." Every scenario from
 * his list is here, driven through the REAL Fastify routes and the REAL escalation
 * ladder against a faked database — a clean phone, a phone that belongs to somebody
 * else, a phone that moves, a phone that lies, twenty phones at once, and every way
 * the thing running the wizard can die halfway through.
 *
 * ⛔ Nothing here is a happy path with the failure branch commented out. The point
 * is the answers we give when it goes wrong, because that is what a customer with a
 * dead phone actually experiences.
 *
 * Run with: node --experimental-test-module-mocks --import tsx --test
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

// ─── fake db (deliberately strict) ───────────────────────────────────────────

const state: any = { runs: [], phones: [], extensions: [], tenants: [], audits: [] };
let seq = 0;
const nextId = (p: string) => `${p}_${++seq}`;

/**
 * ⛔ A fake that accepts anything is how a green suite sits on a query that could
 * never succeed — the TURN watcher shipped blind that way. Unknown columns throw.
 */
const RUN_COLUMNS = new Set([
  "id", "tenantId", "startedByUserId", "deviceLabel", "subnet", "origin", "requestedByUserId",
  "status", "startedAt", "finishedAt", "resetAuthorizedAt", "resetAuthorizedByUserId",
  "resetAuthorizedPhoneIds", "createdAt", "updatedAt",
]);
const PHONE_COLUMNS = new Set([
  "id", "tenantId", "runId", "macAddress", "ipAddress", "previousIp", "vendor", "model",
  "firmware", "provisioningUrl", "extensionId", "extNumber", "displayName", "state",
  "customerNote", "technicalNote", "attempts", "resetCount", "resetRequestedAt",
  "registeredAt", "haltedReason", "createdAt", "updatedAt",
]);

function checkColumns(cols: Set<string>, obj: any, where: string) {
  for (const k of Object.keys(obj ?? {})) {
    if (!cols.has(k)) throw new Error(`Unknown argument \`${k}\` in ${where}`);
  }
}

const matches = (row: any, where: any): boolean =>
  Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return (v as any).in.includes(row[k]);
      if ("not" in v) return row[k] !== (v as any).not;
      return true;
    }
    return row[k] === v;
  });

function table(bucket: string, cols: Set<string>, defaults: () => any) {
  return {
    findFirst: async ({ where }: any = {}) => {
      checkColumns(cols, where, `${bucket}.findFirst`);
      return state[bucket].find((r: any) => matches(r, where)) ?? null;
    },
    findMany: async ({ where }: any = {}) => {
      checkColumns(cols, where, `${bucket}.findMany`);
      return state[bucket].filter((r: any) => matches(r, where));
    },
    create: async ({ data }: any) => {
      checkColumns(cols, data, `${bucket}.create`);
      const row = { ...defaults(), ...data }; state[bucket].push(row); return row;
    },
    update: async ({ where, data }: any) => {
      checkColumns(cols, data, `${bucket}.update`);
      const row = state[bucket].find((r: any) => r.id === where.id);
      if (!row) throw new Error("record not found");
      Object.assign(row, data); return row;
    },
  };
}

mock.module("@connect/db", {
  namedExports: {
    db: {
      deskPhoneSetupRun: table("runs", RUN_COLUMNS, () => ({
        id: nextId("run"), status: "running", origin: "customer", startedAt: new Date(),
        subnet: null, resetAuthorizedAt: null, resetAuthorizedByUserId: null, resetAuthorizedPhoneIds: null,
      })),
      deskPhoneSetupPhone: table("phones", PHONE_COLUMNS, () => ({
        id: nextId("ph"), state: "DISCOVERED", attempts: 0, resetCount: 0, createdAt: new Date(),
        ipAddress: null, previousIp: null, vendor: null, model: null, firmware: null,
        provisioningUrl: null, extensionId: null, extNumber: null, displayName: null,
        customerNote: null, technicalNote: null, resetRequestedAt: null, registeredAt: null, haltedReason: null,
      })),
      extension: table("extensions", new Set(["id", "tenantId", "extNumber", "displayName", "status"]),
        () => ({ id: nextId("ext"), status: "ACTIVE" })),
      tenant: table("tenants", new Set(["id", "name"]), () => ({ id: nextId("t") })),
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

// ─── harness ─────────────────────────────────────────────────────────────────

let registered = new Set<string>();
/** Set to simulate the PBX being unreachable. */
let registrationThrows = false;

const CUSTOMER = { sub: "u_1", tenantId: "t_abc", email: "dina@abc.example", role: "TENANT_ADMIN" };
const OTHER = { sub: "u_9", tenantId: "t_evil", email: "x@evil.example", role: "TENANT_ADMIN" };
const STAFF = { sub: "u_s", tenantId: "t_lc", email: "izzy@loopcom.net", role: "SUPER_ADMIN" };

async function app(user: any = CUSTOMER) {
  const a = Fastify();
  a.addHook("preHandler", async (req: any) => { req.user = user; });
  await routes()(a as any, {
    audit: async (p: any) => { state.audits.push(p); },
    ourProvisioningHosts: () => ["loopcom.net", "m.connectcomunications.com"],
    isRegistered: async (_t: string, ext: string) => {
      if (registrationThrows) throw new Error("PBX unreachable");
      return registered.has(ext);
    },
  });
  return a;
}

function reset() {
  state.runs.length = 0; state.phones.length = 0; state.extensions.length = 0;
  state.tenants.length = 0; state.audits.length = 0;
  allowSetup = true; allowReset = true; registered = new Set(); registrationThrows = false;
  state.tenants.push({ id: "t_abc", name: "ABC Company" });
  for (let i = 0; i < 25; i += 1) {
    state.extensions.push({
      id: `e${i}`, tenantId: "t_abc", extNumber: String(101 + i),
      displayName: `Person ${i}`, status: "ACTIVE",
    });
  }
}

const B = (r: any) => JSON.parse(r.body);
const mac = (n: number) => `80:5E:0C:BD:${(n >> 8 & 255).toString(16).padStart(2, "0")}:${(n & 255).toString(16).padStart(2, "0")}`;

async function run(a: any) { return B(await a.inject({ method: "POST", url: "/desk-phones/runs", payload: {} })).run.id; }
async function found(a: any, id: string, phones: any[], subnet = "192.168.1.0/24") {
  return B(await a.inject({ method: "POST", url: `/desk-phones/runs/${id}/discovered`, payload: { subnet, phones } }));
}
async function advance(a: any, id: string, phoneId: string, observed: any = {}) {
  return B(await a.inject({ method: "POST", url: `/desk-phones/runs/${id}/phones/${phoneId}/advance`, payload: observed }));
}
async function authorize(a: any, id: string, phoneIds: string[]) {
  return await a.inject({ method: "POST", url: `/desk-phones/runs/${id}/authorize-reset`, payload: { phoneIds } });
}

/* ═══ 1. the phones themselves ═══════════════════════════════════════════════ */

test("STRESS: a clean factory phone, pointed nowhere, is simply redirected", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{ mac: mac(1), model: "T54W", firmware: "96.86.0.15" }]);
  const p = state.phones[0];
  await a.inject({ method: "POST", url: `/desk-phones/runs/${id}/phones/${p.id}/assign`, payload: { extensionId: "e0" } });
  const out = await advance(a, id, p.id);
  assert.equal(out.action, "set_provisioning", "a clean phone needs no wipe and no password");
  assert.equal(state.phones[0].resetCount, 0);
});

test("STRESS: a phone already on Loopcom and registered is left completely alone", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{ mac: mac(2), model: "T54W", provisioningUrl: "https://pbx.loopcom.net/phoneprov/x/" }]);
  const p = state.phones[0];
  await a.inject({ method: "POST", url: `/desk-phones/runs/${id}/phones/${p.id}/assign`, payload: { extensionId: "e0" } });
  registered.add("101");
  const out = await advance(a, id, p.id);
  assert.equal(out.action, "do_nothing");
  assert.equal(out.phone.status, "Ready");
});

test("STRESS: a phone on another provider is never wiped without a person saying so", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{ mac: mac(3), model: "T42S", provisioningUrl: "https://prov.oldprovider.net/cfg/" }]);
  const p = state.phones[0];
  const out = await advance(a, id, p.id);
  assert.equal(out.action, "request_reset_authorization");
  assert.equal(state.phones[0].resetCount, 0);
});

test("STRESS: a stale Loopcom address gets the cheapest fix there is", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{ mac: mac(4), model: "T54W", provisioningUrl: "https://prov.oldprovider.net/x" }]);
  const p = state.phones[0];
  await a.inject({ method: "POST", url: `/desk-phones/runs/${id}/phones/${p.id}/assign`, payload: { extensionId: "e0" } });
  registered.add("101");
  const out = await advance(a, id, p.id);
  assert.equal(out.action, "check_sync", "registered to us: no restart, no office access, nobody notices");
});

test("STRESS: a phone that is simply off is refused honestly, not retried forever", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{ mac: mac(5) }]);
  const p = state.phones[0];
  const out = await advance(a, id, p.id, { reachableOnLan: false });
  assert.equal(out.halted, true);
  assert.match(out.customerMessage, /switched on/i);
});

/* ═══ 2. credentials ═════════════════════════════════════════════════════════ */

test("STRESS: a locked phone gets one documented default attempt and then asks a person", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{ mac: mac(6), model: "T29G" }]);
  const p = state.phones[0];
  assert.equal((await advance(a, id, p.id, { locked: true })).action, "try_default_credentials");
  const second = await advance(a, id, p.id, { locked: true, defaultCredentialsTried: true });
  assert.equal(second.action, "ask_for_password", "never a second guess");
  assert.match(second.customerMessage, /password/i);
});

test("STRESS: a wrong password never becomes a third, fourth or hundredth guess", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{ mac: mac(7) }]);
  const p = state.phones[0];
  const actions = new Set<string>();
  for (let i = 0; i < 10; i += 1) {
    actions.add((await advance(a, id, p.id, { locked: true, defaultCredentialsTried: true })).action);
  }
  assert.deepEqual([...actions], ["ask_for_password"], "a loop of guesses locks phones out");
});

/* ═══ 3. the reset, and never doing it twice ════════════════════════════════ */

test("STRESS: a phone that changes address after a reset is followed, not re-reset", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{ mac: mac(8), ip: "192.168.1.41", provisioningUrl: "https://prov.old.net/x" }]);
  const p = state.phones[0];
  await authorize(a, id, [p.id]);
  assert.equal((await advance(a, id, p.id)).action, "reset_over_lan");

  // it comes back somewhere else entirely
  await found(a, id, [{ mac: mac(8).toLowerCase().replace(/:/g, "-"), ip: "192.168.1.87" }]);
  assert.equal(state.phones.length, 1, "the address is not the identity");
  assert.equal(state.phones[0].previousIp, "192.168.1.41");
  assert.equal(state.phones[0].resetCount, 1, "and it is NOT reset a second time");
});

test("STRESS: losing our place mid-reset cannot wipe a phone twice", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{ mac: mac(9), provisioningUrl: "https://prov.old.net/x" }]);
  const p = state.phones[0];
  await authorize(a, id, [p.id]);
  await advance(a, id, p.id);

  // the app closes, Windows restarts, a brand-new Fastify comes up — the record is
  // the memory, and it survives all of it
  const fresh = await app();
  const out = await advance(fresh, id, p.id);
  assert.notEqual(out.action, "reset_over_lan");
  assert.equal(state.phones[0].resetCount, 1);
});

test("STRESS: twenty concurrent advance calls on one phone still reset it once", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{ mac: mac(10), provisioningUrl: "https://prov.old.net/x" }]);
  const p = state.phones[0];
  await authorize(a, id, [p.id]);
  await Promise.all(Array.from({ length: 20 }, () => advance(a, id, p.id)));
  assert.equal(state.phones[0].resetCount, 1, "a race must not become twenty wipes");
});

/* ═══ 4. the two unfixable problems ═════════════════════════════════════════ */

test("STRESS: a manufacturer redirect stops after two attempts and never loops", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{ mac: mac(11), provisioningUrl: "https://prov.old.net/x" }]);
  const p = state.phones[0];
  await authorize(a, id, [p.id]);
  await advance(a, id, p.id);
  for (let i = 0; i < 8; i += 1) await advance(a, id, p.id);
  assert.equal(state.phones[0].resetCount, 1, "resetting all day never produces a different answer");
  assert.equal(state.phones[0].state, "NEEDS_ATTENTION");
  assert.equal(state.phones[0].haltedReason, "previous_provider");
});

test("STRESS: a router handing back the old provider is a different message entirely", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{ mac: mac(12), provisioningUrl: "https://prov.old.net/x" }]);
  const p = state.phones[0];
  await authorize(a, id, [p.id]);
  await advance(a, id, p.id);
  const out = await advance(a, id, p.id, { networkSuppliesOldProvisioning: true });
  assert.equal(out.handOff, "customer_network");
  assert.match(out.customerMessage, /will not change your router/i);
});

/* ═══ 5. everything around it falling over ══════════════════════════════════ */

test("STRESS: the PBX being unreachable never turns a phone green", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{ mac: mac(13), provisioningUrl: "https://pbx.loopcom.net/x" }]);
  const p = state.phones[0];
  await a.inject({ method: "POST", url: `/desk-phones/runs/${id}/phones/${p.id}/assign`, payload: { extensionId: "e0" } });
  registered.add("101");
  registrationThrows = true;
  const out = await advance(a, id, p.id);
  assert.notEqual(out.phone.status, "Ready", "unknown must never be optimistic");
});

test("STRESS: a run survives the wizard being closed and reopened", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{ mac: mac(14) }, { mac: mac(15) }]);
  const again = await app();
  const resumed = B(await again.inject({ method: "POST", url: "/desk-phones/runs", payload: {} }));
  assert.equal(resumed.run.id, id);
  assert.equal(resumed.run.resumed, true);
  const view = B(await again.inject({ method: "GET", url: `/desk-phones/runs/${id}` }));
  assert.equal(view.phones.length, 2, "the work already done is still there");
});

test("STRESS: an interrupted discovery does not lose the phones already found", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{ mac: mac(16) }, { mac: mac(17) }]);
  await found(a, id, []);           // the network dropped mid-sweep
  assert.equal(state.phones.length, 2, "an empty sweep must not erase an inventory");
});

/* ═══ 6. scale ══════════════════════════════════════════════════════════════ */

test("STRESS: twenty phones at once, one of them broken, and the other nineteen finish", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, Array.from({ length: 20 }, (_, i) => ({ mac: mac(100 + i), model: "T54W" })));
  assert.equal(state.phones.length, 20);
  for (let i = 0; i < 20; i += 1) {
    await a.inject({
      method: "POST", url: `/desk-phones/runs/${id}/phones/${state.phones[i].id}/assign`,
      payload: { extensionId: `e${i}` },
    });
    if (i !== 7) registered.add(String(101 + i));
  }
  state.phones.forEach((p: any) => { p.provisioningUrl = "https://pbx.loopcom.net/x"; });
  await Promise.all(state.phones.map((p: any) => advance(a, id, p.id)));
  const view = B(await a.inject({ method: "GET", url: `/desk-phones/runs/${id}` }));
  assert.equal(view.summary.ready, 19, "one failure must not stop the other nineteen");
  assert.match(view.summary.headline, /19 of 20|19 of your 20/);
});

test("STRESS: fifteen identical phones stay fifteen distinct phones", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, Array.from({ length: 15 }, (_, i) => ({ mac: mac(200 + i), model: "T54W", vendor: "yealink" })));
  assert.equal(state.phones.length, 15);
  assert.equal(new Set(state.phones.map((p: any) => p.macAddress)).size, 15);
});

test("STRESS: the same phone discovered five times is one phone", async () => {
  reset(); const a = await app(); const id = await run(a);
  for (const form of ["80:5E:0C:BD:13:5A", "80-5e-0c-bd-13-5a", "805e0cbd135a", "80:5e:0C:bD:13:5a", "80 5e 0c bd 13 5a"]) {
    await found(a, id, [{ mac: form }]);
  }
  assert.equal(state.phones.length, 1, "however it is written, it is the same handset");
});

test("STRESS: five hundred discovered devices do not blow past the schema cap", async () => {
  reset(); const a = await app(); const id = await run(a);
  const r = await a.inject({
    method: "POST", url: `/desk-phones/runs/${id}/discovered`,
    payload: { phones: Array.from({ length: 501 }, (_, i) => ({ mac: mac(1000 + i) })) },
  });
  assert.equal(r.statusCode, 400, "an unbounded report is a way to fill a customer's inventory");
});

/* ═══ 7. wrong answers from the person ══════════════════════════════════════ */

test("STRESS: assigning the wrong person is undoable and leaves nothing behind", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{ mac: mac(300) }]);
  const p = state.phones[0];
  await a.inject({ method: "POST", url: `/desk-phones/runs/${id}/phones/${p.id}/assign`, payload: { extensionId: "e3" } });
  assert.equal(state.phones[0].extNumber, "104");
  await a.inject({ method: "POST", url: `/desk-phones/runs/${id}/phones/${p.id}/assign`, payload: { extensionId: null } });
  assert.equal(state.phones[0].extNumber, null);
  assert.equal(state.phones[0].state, "IDENTIFIED");
});

test("STRESS: a blank row is skipped, never failed", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{ mac: mac(301) }, { mac: mac(302) }]);
  await a.inject({
    method: "POST", url: `/desk-phones/runs/${id}/phones/${state.phones[0].id}/assign`, payload: { extensionId: "e0" },
  });
  registered.add("101");
  state.phones[0].provisioningUrl = "https://pbx.loopcom.net/x";
  await advance(a, id, state.phones[0].id);
  const view = B(await a.inject({ method: "GET", url: `/desk-phones/runs/${id}` }));
  assert.equal(view.summary.ready, 1);
  assert.equal(view.summary.needsAttention, 0, "an unassigned phone is not a failure");
});

/* ═══ 8. attacks ════════════════════════════════════════════════════════════ */

test("STRESS: another customer cannot read, feed or authorise anything on this run", async () => {
  reset(); const mine = await app(); const id = await run(mine);
  await found(mine, id, [{ mac: mac(400) }]);
  const phoneId = state.phones[0].id;
  const evil = await app(OTHER);

  const attempts: Array<[string, string, any]> = [
    ["GET", `/desk-phones/runs/${id}`, undefined],
    ["GET", `/desk-phones/runs/${id}?view=diagnostics`, undefined],
    ["POST", `/desk-phones/runs/${id}/discovered`, { phones: [{ mac: mac(999) }] }],
    ["POST", `/desk-phones/runs/${id}/authorize-reset`, { phoneIds: [phoneId] }],
    ["POST", `/desk-phones/runs/${id}/phones/${phoneId}/advance`, {}],
    ["POST", `/desk-phones/runs/${id}/phones/${phoneId}/assign`, { extensionId: "e0" }],
    ["GET", `/desk-phones/runs/${id}/phones/${phoneId}/buttons`, undefined],
  ];
  for (const [method, url, payload] of attempts) {
    const r = await evil.inject({ method, url, payload } as any);
    assert.equal(r.statusCode, 404, `${method} ${url} leaked`);
  }
  assert.equal(state.phones.length, 1, "nothing was written");
  assert.equal(state.runs[0].resetAuthorizedAt, null, "and nothing was authorised");
});

test("STRESS: a forged tenant in the body changes nothing", async () => {
  reset(); const a = await app(); const id = await run(a);
  await a.inject({
    method: "POST", url: `/desk-phones/runs/${id}/discovered`,
    payload: { tenantId: "t_evil", phones: [{ mac: mac(401) }] },
  });
  assert.equal(state.phones[0].tenantId, "t_abc", "a tenant that arrives in a request is a claim, not a fact");
});

test("STRESS: a customer cannot send themselves a Loopcom setup request", async () => {
  reset(); const a = await app();
  const r = await a.inject({ method: "POST", url: "/admin/desk-phones/send-setup", payload: { tenantId: "t_abc" } });
  assert.equal(r.statusCode, 403);
});

test("STRESS: a Loopcom request does not carry approval to erase anything", async () => {
  reset();
  const staff = await app(STAFF);
  const sent = B(await staff.inject({ method: "POST", url: "/admin/desk-phones/send-setup", payload: { tenantId: "t_abc" } }));
  const a = await app();
  await found(a, sent.run.id, [{ mac: mac(402), provisioningUrl: "https://prov.old.net/x" }]);
  const out = await advance(a, sent.run.id, state.phones[0].id);
  assert.equal(out.action, "request_reset_authorization", "sending is not consenting");
  assert.equal(state.phones[0].resetCount, 0);
});

test("STRESS: losing the reset permission mid-run stops the next authorisation", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{ mac: mac(403) }, { mac: mac(404) }]);
  assert.equal((await authorize(a, id, [state.phones[0].id])).statusCode, 200);
  allowReset = false;   // revoked while they were working
  const second = await authorize(a, id, [state.phones[1].id]);
  assert.equal(second.statusCode, 403, "permission is re-read, never cached onto the run");
});

test("STRESS: a device cannot inject anything into a diagnostics line", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{
    mac: mac(405),
    model: "T54W\u202eEVIL\u202c",
    firmware: "1.0\nrm -rf /",
    provisioningUrl: "https://x/" + "A".repeat(400),
  }]);
  const row = state.phones[0];
  assert.ok(row, "a hostile but well-formed report is still stored, sanitised");
  assert.ok(!/[\u0000-\u001f]/.test(row.model), "control characters break log lines");
  assert.ok(!/[\u202a-\u202e]/.test(row.model), "bidi overrides reorder what a reviewer reads");
  assert.ok(!row.firmware.includes(String.fromCharCode(10)), "no newline into a log line");
});

// ⛔ And the field that CANNOT be sanitised into safety - one long enough to be a
// prompt in its own right - is refused outright rather than trimmed.
test("STRESS: an over-long field from a device is refused, not quietly trimmed", async () => {
  reset(); const a = await app(); const id = await run(a);
  const r = await a.inject({
    method: "POST", url: `/desk-phones/runs/${id}/discovered`,
    payload: { phones: [{ mac: mac(406), provisioningUrl: "https://x/" + "A".repeat(600) }] },
  });
  assert.equal(r.statusCode, 400);
  assert.equal(state.phones.length, 0, "nothing half stored");
});

test("STRESS: an over-long or malformed report is refused rather than half stored", async () => {
  reset(); const a = await app(); const id = await run(a);
  for (const payload of [
    { phones: [{ ip: "192.168.1.5" }] },                  // no hardware id at all
    { phones: "not an array" },
    { phones: [{ mac: "x".repeat(1000) }] },
  ]) {
    const r = await a.inject({ method: "POST", url: `/desk-phones/runs/${id}/discovered`, payload: payload as any });
    assert.ok(r.statusCode === 400 || B(r).stored === 0, JSON.stringify(payload));
  }
  assert.equal(state.phones.length, 0);
});

/* ═══ 9. what the customer is left looking at ═══════════════════════════════ */

test("STRESS: no failure path ever shows a customer a status code", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{ mac: mac(500), provisioningUrl: "https://prov.old.net/x" }]);
  const p = state.phones[0];
  const messages: string[] = [];
  const collect = (o: any) => { if (o?.customerMessage) messages.push(o.customerMessage); };

  collect(await advance(a, id, p.id));
  collect(await advance(a, id, p.id, { locked: true }));
  collect(await advance(a, id, p.id, { reachableOnLan: false }));
  await authorize(a, id, [p.id]);
  collect(await advance(a, id, p.id));
  collect(await advance(a, id, p.id));
  collect(await advance(a, id, p.id, { networkSuppliesOldProvisioning: true }));

  assert.ok(messages.length >= 3, "these paths should be talking to the customer");
  const banned = /\b(HTTP|401|403|404|500|SIP|DHCP|Option\s*66|RPS|TFTP|MAC|subnet|provisioning)\b/i;
  for (const m of messages) assert.ok(!banned.test(m), `jargon leaked: ${m}`);
});

test("STRESS: every customer view of every state stays inside the six words", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, [{ mac: mac(501) }]);
  const allowed = new Set(["Finding", "Preparing", "Restarting", "Connecting", "Ready", "Needs attention"]);
  for (const s of [
    "DISCOVERED", "IDENTIFIED", "AUTHENTICATED", "ASSIGNED", "PREPARING", "RESET_AUTHORIZED",
    "RESET_REQUESTED", "WAITING_FOR_REBOOT", "REDISCOVERING", "REDISCOVERED",
    "PROVISIONING_CONFIGURED", "PROVISIONING", "WAITING_FOR_REGISTRATION", "REGISTERED",
    "NEEDS_ATTENTION", "FAILED",
  ]) {
    state.phones[0].state = s;
    const view = B(await a.inject({ method: "GET", url: `/desk-phones/runs/${id}` }));
    assert.ok(allowed.has(view.phones[0].status), `${s} leaked as ${view.phones[0].status}`);
  }
});

test("STRESS: the whole run, start to finish, on eight phones", async () => {
  reset(); const a = await app(); const id = await run(a);
  await found(a, id, Array.from({ length: 8 }, (_, i) => ({
    mac: mac(600 + i), model: "T54W", vendor: "yealink",
    provisioningUrl: i < 6 ? "https://pbx.loopcom.net/x" : "https://prov.old.net/x",
  })));
  for (let i = 0; i < 8; i += 1) {
    await a.inject({
      method: "POST", url: `/desk-phones/runs/${id}/phones/${state.phones[i].id}/assign`,
      payload: { extensionId: `e${i}` },
    });
  }
  // the six already ours come up; the two on the old provider need a person
  for (let i = 0; i < 6; i += 1) registered.add(String(101 + i));
  for (const p of state.phones) await advance(a, id, p.id);

  const view = B(await a.inject({ method: "GET", url: `/desk-phones/runs/${id}` }));
  assert.equal(view.summary.ready, 6);
  assert.equal(view.phones.filter((p: any) => p.status === "Ready").length, 6);
  // and the customer is told what is left, in their words
  const remaining = view.phones.filter((p: any) => p.status !== "Ready");
  assert.equal(remaining.length, 2);
  assert.ok(!/fail/i.test(JSON.stringify(view.summary)));
});
