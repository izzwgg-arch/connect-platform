/**
 * The routes that were missing, driven through real Fastify against a faked database:
 * writing a phone's provisioning record the moment somebody says whose it is, arming
 * the standing listener for the phones in a LIVE run, and letting a person try a stuck
 * phone again.
 *
 * ⛔ These are wiring tests on purpose. The DECISIONS are proven pure in
 * `@connect/shared` and in `provisioningRecordWriter.test.ts`; what could not be proven
 * there is that the routes actually CALL them — and every defect this repo has shipped
 * in this area has been a caller that did not.
 *
 * Run with: node --experimental-test-module-mocks --import tsx --test
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

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

function table(bucket: string, defaults: () => any) {
  return {
    findFirst: async ({ where }: any = {}) => state[bucket].find((r: any) => matches(r, where)) ?? null,
    findMany: async ({ where }: any = {}) => state[bucket].filter((r: any) => matches(r, where)),
    create: async ({ data }: any) => { const row = { ...defaults(), ...data }; state[bucket].push(row); return row; },
    update: async ({ where, data }: any) => {
      const row = state[bucket].find((r: any) => r.id === where.id);
      Object.assign(row, data); return row;
    },
    updateMany: async ({ where, data }: any = {}) => {
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
        customerNote: null, technicalNote: null, resetRequestedAt: null, registeredAt: null,
        haltedReason: null, skippedAt: null,
      })),
      extension: table("extensions", () => ({ id: nextId("ext"), status: "ACTIVE" })),
      tenant: table("tenants", () => ({ id: nextId("t") })),
    },
  },
});

let allowSetup = true;
mock.module("../permissionGates", {
  namedExports: {
    userHasActionPermission: async (_u: any, key: string) => (key === "can_setup_desk_phones" ? allowSetup : false),
  },
});

let routesModule: any = null;
function routes() {
  if (!routesModule) routesModule = require("./deskPhoneRoutes");
  return routesModule.registerDeskPhoneSetupRoutes;
}

const CUSTOMER = { sub: "u_1", tenantId: "t_abc", email: "dina@abc.example", role: "TENANT_ADMIN" };
const OTHER = { sub: "u_9", tenantId: "t_other", email: "someone@other.example", role: "TENANT_ADMIN" };

let registered = new Set<string>();

async function makeApp(user: any, extraDeps: Record<string, unknown> = {}) {
  const app = Fastify();
  app.addHook("preHandler", async (req: any) => { req.user = user; });
  await routes()(app as any, {
    audit: async (p: any) => { state.audits.push(p); },
    ourProvisioningHosts: () => ["loopcom.net", "m.connectcomunications.com"],
    isRegistered: async (_t: string, ext: string) => registered.has(ext),
    // ⛔ Default to "the phone system is unreachable" so a test that forgets to say
    // otherwise never silently reaches the real PBX resolver.
    ensureRecord: async () => ({ kind: "unavailable", detail: "not wired in this test" }),
    ...extraDeps,
  });
  return app;
}

function reset() {
  state.runs.length = 0; state.phones.length = 0; state.extensions.length = 0;
  state.tenants.length = 0; state.audits.length = 0;
  allowSetup = true; registered = new Set();
  state.tenants.push({ id: "t_abc", name: "ABC Company" });
  state.extensions.push({ id: "e1", tenantId: "t_abc", extNumber: "101", displayName: "Reception", status: "ACTIVE" });
}

const body = (r: any) => JSON.parse(r.body);

async function startRun(app: any) {
  const r = await app.inject({ method: "POST", url: "/desk-phones/runs", payload: {} });
  return body(r).run.id;
}

async function assignedPhone(app: any, runId: string, device: any) {
  await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/discovered`,
    payload: { subnet: "192.168.6.0/22", phones: [device] },
  });
  const phone = state.phones[state.phones.length - 1];
  await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/assign`,
    payload: { extensionId: "e1" },
  });
  return phone;
}

const YEALINK = { mac: "80:5E:C0:B3:B2:D0", ip: "192.168.6.170", vendor: "yealink", model: "T53W" };

/* ── writing the record ──────────────────────────────────────────────────── */

test("assigning a phone writes its record — the chicken and egg", async () => {
  reset();
  const calls: any[] = [];
  const app = await makeApp(CUSTOMER, {
    ensureRecord: async (a: any) => {
      calls.push(a);
      return { kind: "written", phoneId: 77, rehomedFromTenant: null, rebound: false, explain: "created" };
    },
  });
  const runId = await startRun(app);
  const phone = await assignedPhone(app, runId, YEALINK);
  assert.equal(calls.length, 1, "the record must be written the moment the person chooses");
  assert.deepEqual(calls[0], {
    tenantId: "t_abc", mac: "805ec0b3b2d0", vendor: "yealink", model: "T53W", extNumber: "101",
  });
  assert.equal(phone.state, "ASSIGNED");
});

test("un-assigning writes nothing to the phone system", async () => {
  reset();
  const calls: any[] = [];
  const app = await makeApp(CUSTOMER, {
    ensureRecord: async (a: any) => {
      calls.push(a);
      return { kind: "written", phoneId: 1, rehomedFromTenant: null, rebound: false, explain: "" };
    },
  });
  const runId = await startRun(app);
  const phone = await assignedPhone(app, runId, YEALINK);
  calls.length = 0;
  await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/assign`, payload: { extensionId: null },
  });
  assert.equal(calls.length, 0);
});

test("a record we cannot write says what is missing and KEEPS the assignment", async () => {
  reset();
  const app = await makeApp(CUSTOMER, {
    ensureRecord: async () => ({
      kind: "refused", reason: "no_settings_profile",
      explain: "no template for model id 154 on tenant 21",
      customerMessage: "Loopcom needs to add a settings profile for this model of phone.",
    }),
  });
  const runId = await startRun(app);
  const phone = await assignedPhone(app, runId, YEALINK);
  // ⛔ The person's choice survives. Only the record is missing.
  assert.equal(phone.state, "ASSIGNED");
  assert.equal(phone.extensionId, "e1");
  assert.match(phone.customerNote, /settings profile/);
  // ⛔ And the technical detail never reaches the customer's sentence.
  assert.ok(!/template|tenant 21|model id/i.test(phone.customerNote), phone.customerNote);
});

test("an unreachable phone system never loses the assignment", async () => {
  reset();
  const app = await makeApp(CUSTOMER, { ensureRecord: async () => { throw new Error("helper timeout"); } });
  const runId = await startRun(app);
  const phone = await assignedPhone(app, runId, YEALINK);
  assert.equal(phone.state, "ASSIGNED");
  assert.equal(phone.extensionId, "e1");
  assert.equal(phone.customerNote, null, "a slow phone system is not the customer's problem to read about");
});

test("moving a phone off another customer is audited — it is the one branch that changes their data", async () => {
  reset();
  const app = await makeApp(CUSTOMER, {
    ensureRecord: async () => ({ kind: "written", phoneId: 24, rehomedFromTenant: 7, rebound: true, explain: "moved" }),
  });
  const runId = await startRun(app);
  await assignedPhone(app, runId, { mac: "C0:74:AD:8C:65:4E", ip: "192.168.6.171", vendor: "grandstream", model: "GXP2170" });
  const row = state.audits.find((a: any) => a.action === "DESK_PHONE_RECORD_REHOMED");
  assert.ok(row, "a move must be recorded or it cannot be undone");
  assert.equal(row.metadata.fromTenant, 7);
});

test("a successful write CLEARS a stale note", async () => {
  reset();
  const app = await makeApp(CUSTOMER, {
    ensureRecord: async () => ({ kind: "adopted", phoneId: 52, explain: "already correct" }),
  });
  const runId = await startRun(app);
  await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/discovered`,
    payload: { subnet: "192.168.6.0/22", phones: [YEALINK] },
  });
  const phone = state.phones[0];
  phone.customerNote = "Loopcom Support can finish this one with you.";
  await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/assign`, payload: { extensionId: "e1" },
  });
  assert.equal(phone.customerNote, null, "a sentence left over from a fixed problem is what made the second run read like the first");
});

/* ── un-sticking ─────────────────────────────────────────────────────────── */

test("a halted phone can be tried again — nothing may be permanently stuck", async () => {
  reset();
  const app = await makeApp(CUSTOMER, {
    ensureRecord: async () => ({ kind: "written", phoneId: 1, rehomedFromTenant: null, rebound: false, explain: "created" }),
  });
  const runId = await startRun(app);
  const phone = await assignedPhone(app, runId, YEALINK);
  // ⛔ Izzy's own row, exactly as the database held it: halted to support, zero
  // attempts, with the stale sentence still on it.
  Object.assign(phone, {
    state: "NEEDS_ATTENTION", haltedReason: "support", attempts: 2,
    customerNote: "Loopcom Support can finish this one with you.",
  });

  const r = await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/retry`, payload: {} });
  assert.equal(r.statusCode, 200);
  assert.equal(phone.state, "ASSIGNED");
  assert.equal(phone.attempts, 0);
  assert.equal(phone.haltedReason, null);
  assert.equal(phone.customerNote, null);
});

test("a retry re-attempts the RECORD, because that is usually why it halted", async () => {
  reset();
  const calls: any[] = [];
  const app = await makeApp(CUSTOMER, {
    ensureRecord: async (a: any) => {
      calls.push(a);
      return { kind: "written", phoneId: 1, rehomedFromTenant: null, rebound: false, explain: "created" };
    },
  });
  const runId = await startRun(app);
  const phone = await assignedPhone(app, runId, YEALINK);
  calls.length = 0;
  Object.assign(phone, { state: "NEEDS_ATTENTION" });
  await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/retry`, payload: {} });
  assert.equal(calls.length, 1, "sending it round the ladder with the same missing record gives the same halt");
});

test("a retry NEVER forgives a reset", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  const phone = await assignedPhone(app, runId, YEALINK);
  const when = new Date("2026-09-10T12:00:00Z");
  Object.assign(phone, { state: "FAILED", resetCount: 1, resetRequestedAt: when });

  await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/retry`, payload: {} });
  assert.equal(phone.resetCount, 1, "the record of a wipe survives everything");
  assert.equal(phone.resetRequestedAt, when);
  const audit = state.audits.find((a: any) => a.action === "DESK_PHONE_RETRY");
  assert.equal(audit.metadata.resetCount, 1, "and the audit says so plainly");
});

test("a WORKING phone refuses a retry — it would restart somebody mid-call", async () => {
  reset(); registered = new Set(["101"]);
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  const phone = await assignedPhone(app, runId, YEALINK);
  Object.assign(phone, { state: "REGISTERED" });

  const r = await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/retry`, payload: {} });
  // ⛔ 409, not 400 — the request was perfectly well formed and the phone is simply
  // working. A 400 reads like the app is broken.
  assert.equal(r.statusCode, 409);
  assert.equal(body(r).error, "already_working");
  assert.equal(phone.state, "REGISTERED", "nothing may move");
});

test("another customer cannot retry a phone in this run", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  const phone = await assignedPhone(app, runId, YEALINK);

  const other = await makeApp(OTHER);
  const r = await other.inject({ method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/retry`, payload: {} });
  // ⛔ 404, never 403: another customer's run must be indistinguishable from one that
  // never existed.
  assert.equal(r.statusCode, 404);
});

test("somebody without the permission cannot retry", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  const phone = await assignedPhone(app, runId, YEALINK);
  allowSetup = false;
  const r = await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/retry`, payload: {} });
  assert.equal(r.statusCode, 403);
});

/* ── arming the standing listener ────────────────────────────────────────── */

test("the listener is armed for the phones in the CURRENT run, not just the ones the PBX knows", async () => {
  reset();
  const app = await makeApp(CUSTOMER, {
    provisioningUrlFor: async () => "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/",
    provisionedPhones: async () => [{
      mac: "ec74d7201fea", macRaw: "EC:74:D7:20:1F:EA", pbxTenant: 21,
      description: "101", model: "HT801", brand: "Grandstream",
    }],
  });
  const runId = await startRun(app);
  await assignedPhone(app, runId, YEALINK);

  const cfg = body(await app.inject({ method: "GET", url: "/desk-phones/pnp-config" }));
  // ⛔⛔ The PBX list is what the phone system ALREADY knows — precisely the set that
  // excludes the phone somebody is setting up right now. Arming from it alone is what
  // left a factory-reset Yealink asking into silence.
  assert.ok(cfg.macs.includes("805ec0b3b2d0"), "the phone being set up must be answered");
  assert.ok(cfg.macs.includes("ec74d7201fea"), "and the ones already recorded still are");
});

test("a phone the person unticked is never armed", async () => {
  reset();
  const app = await makeApp(CUSTOMER, {
    provisioningUrlFor: async () => "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/",
    provisionedPhones: async () => [],
  });
  const runId = await startRun(app);
  const phone = await assignedPhone(app, runId, YEALINK);
  phone.skippedAt = new Date();

  const cfg = body(await app.inject({ method: "GET", url: "/desk-phones/pnp-config" }));
  // ⛔ Answering it would point a handset the person deliberately left alone at us.
  assert.deepEqual(cfg.macs, []);
});

test("a phone nobody has been assigned to is never armed", async () => {
  reset();
  const app = await makeApp(CUSTOMER, {
    provisioningUrlFor: async () => "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/",
    provisionedPhones: async () => [],
  });
  const runId = await startRun(app);
  await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/discovered`,
    payload: { subnet: "192.168.6.0/22", phones: [YEALINK] },
  });
  const cfg = body(await app.inject({ method: "GET", url: "/desk-phones/pnp-config" }));
  // There is nothing to point it at yet.
  assert.deepEqual(cfg.macs, []);
});

test("a PBX that cannot be read still arms the run's own phones", async () => {
  reset();
  const app = await makeApp(CUSTOMER, {
    provisioningUrlFor: async () => "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/",
    provisionedPhones: async () => { throw new Error("pbx down"); },
  });
  const runId = await startRun(app);
  await assignedPhone(app, runId, YEALINK);
  const cfg = body(await app.inject({ method: "GET", url: "/desk-phones/pnp-config" }));
  assert.deepEqual(cfg.macs, ["805ec0b3b2d0"]);
});
