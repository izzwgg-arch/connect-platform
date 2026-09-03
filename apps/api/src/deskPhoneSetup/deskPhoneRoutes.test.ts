/**
 * Desk phone setup, end to end through the real Fastify routes against a faked
 * database — including every way a phone must NOT get wiped, and every way one
 * customer must not be able to reach another's run.
 *
 * Run with: node --experimental-test-module-mocks --import tsx --test
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── fake db ─────────────────────────────────────────────────────────────────

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
        customerNote: null, technicalNote: null, resetRequestedAt: null, registeredAt: null, haltedReason: null,
      })),
      extension: table("extensions", () => ({ id: nextId("ext"), status: "ACTIVE" })),
      tenant: table("tenants", () => ({ id: nextId("t") })),
    },
  },
});

// The permission gate, faked so each test can say who the person is.
let allowSetup = true;
let allowReset = true;
mock.module("../permissionGates", {
  namedExports: {
    userHasActionPermission: async (_u: any, key: string) =>
      key === "can_setup_desk_phones" ? allowSetup : key === "can_authorize_phone_reset" ? allowReset : false,
  },
});

// ⛔ Loaded lazily, AFTER the mocks above: apps/api compiles to CommonJS, so a
// top-level await is a build error and an eager import would bind the real db.
let routesModule: any = null;
function routes() {
  if (!routesModule) routesModule = require("./deskPhoneRoutes");
  return routesModule.registerDeskPhoneSetupRoutes;
}

// ─── harness ─────────────────────────────────────────────────────────────────

let registered = new Set<string>();

async function makeApp(user: any, extraDeps: Record<string, unknown> = {}) {
  const app = Fastify();
  app.addHook("preHandler", async (req: any) => { req.user = user; });
  await routes()(app as any, {
    audit: async (p: any) => { state.audits.push(p); },
    ourProvisioningHosts: () => ["loopcom.net", "m.connectcomunications.com"],
    isRegistered: async (_t: string, ext: string) => registered.has(ext),
    ...extraDeps,
  });
  return app;
}

const CUSTOMER = { sub: "u_1", tenantId: "t_abc", email: "dina@abc.example", role: "TENANT_ADMIN" };
const OTHER = { sub: "u_9", tenantId: "t_other", email: "someone@other.example", role: "TENANT_ADMIN" };
const STAFF = { sub: "u_s", tenantId: "t_loopcom", email: "izzy@loopcom.net", role: "SUPER_ADMIN" };

function reset() {
  state.runs.length = 0; state.phones.length = 0; state.extensions.length = 0;
  state.tenants.length = 0; state.audits.length = 0;
  allowSetup = true; allowReset = true; registered = new Set();
  state.tenants.push({ id: "t_abc", name: "ABC Company" });
  state.extensions.push({ id: "e1", tenantId: "t_abc", extNumber: "101", displayName: "Reception", status: "ACTIVE" });
  state.extensions.push({ id: "e2", tenantId: "t_abc", extNumber: "102", displayName: "David Klein", status: "ACTIVE" });
  state.extensions.push({ id: "e_other", tenantId: "t_other", extNumber: "900", displayName: "Nope", status: "ACTIVE" });
}

const body = (r: any) => JSON.parse(r.body);

async function startRun(app: any) {
  const r = await app.inject({ method: "POST", url: "/desk-phones/runs", payload: {} });
  return body(r).run.id;
}

async function discover(app: any, runId: string, phones: any[]) {
  const r = await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/discovered`,
    payload: { subnet: "192.168.1.0/24", phones },
  });
  return body(r);
}

/* ── permission ──────────────────────────────────────────────────────────── */

test("somebody without the key cannot start a run", async () => {
  reset(); allowSetup = false;
  const app = await makeApp(CUSTOMER);
  const r = await app.inject({ method: "POST", url: "/desk-phones/runs", payload: {} });
  assert.equal(r.statusCode, 403);
});

test("running the wizard does not carry permission to wipe a phone", async () => {
  reset(); allowReset = false;
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "80:5E:0C:BD:13:5A" }]);
  const phoneId = state.phones[0].id;
  const r = await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/authorize-reset`, payload: { phoneIds: [phoneId] },
  });
  assert.equal(r.statusCode, 403, "setting phones up and erasing them are two different grants");
  assert.match(body(r).message, /not allowed to clear a phone/i);
});

/* ── tenant isolation ────────────────────────────────────────────────────── */

test("another customer's run is indistinguishable from one that does not exist", async () => {
  reset();
  const mine = await makeApp(CUSTOMER);
  const runId = await startRun(mine);
  const theirs = await makeApp(OTHER);
  for (const url of [
    `/desk-phones/runs/${runId}`,
    `/desk-phones/runs/${runId}/discovered`,
  ]) {
    const r = await theirs.inject({ method: url.endsWith("discovered") ? "POST" : "GET", url, payload: { phones: [] } });
    // ⛔ 404 and not 403: a 403 confirms the run exists, which is an oracle.
    assert.equal(r.statusCode, 404, url);
  }
});

test("a phone cannot be pointed at another company's extension", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "80:5E:0C:BD:13:5A" }]);
  const phoneId = state.phones[0].id;
  const r = await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phoneId}/assign`,
    payload: { extensionId: "e_other" },
  });
  assert.equal(r.statusCode, 404);
  assert.equal(state.phones[0].extensionId, null);
});

/* ── discovery ───────────────────────────────────────────────────────────── */

test("a phone with an unreadable hardware id is counted, never stored", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  const out = await discover(app, runId, [
    { mac: "80:5E:0C:BD:13:5A" },
    { mac: "not-a-mac" },
    { mac: "01:00:5e:00:00:fb" },
  ]);
  assert.equal(out.stored, 1);
  assert.equal(out.dropped, 2, "a row that can never match a PBX record would look broken forever");
  assert.equal(state.phones.length, 1);
});

test("the customer's view carries no hardware id, address or firmware", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  const out = await discover(app, runId, [
    { mac: "80:5E:0C:BD:13:5A", ip: "192.168.1.41", model: "T54W", firmware: "96.86.0.15",
      provisioningUrl: "https://prov.oldprovider.net/x" },
  ]);
  const shown = JSON.stringify(out.phones);
  for (const leak of ["805e0c", "192.168", "96.86", "oldprovider"]) {
    assert.ok(!shown.includes(leak), `${leak} leaked to the customer's screen`);
  }
});

test("the network that was searched is always returned", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  const out = await discover(app, runId, [{ mac: "80:5E:0C:BD:13:5A" }]);
  // so a short list reads as "here is where we looked", never "you have one phone"
  assert.equal(out.subnet, "192.168.1.0/24");
});

test("a phone that comes back at a new address is the same phone", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "80:5E:0C:BD:13:5A", ip: "192.168.1.41" }]);
  await discover(app, runId, [{ mac: "80-5e-0c-bd-13-5a", ip: "192.168.1.87" }]);
  assert.equal(state.phones.length, 1, "a reset drops the lease; the address is not the identity");
  assert.equal(state.phones[0].ipAddress, "192.168.1.87");
  assert.equal(state.phones[0].previousIp, "192.168.1.41", "the move is recorded, not inferred");
});

/* ── the reset gate, which is the one that must not be wrong ─────────────── */

test("no reset happens without a person approving it", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "80:5E:0C:BD:13:5A", provisioningUrl: "https://prov.oldprovider.net/x" }]);
  const phoneId = state.phones[0].id;
  const r = await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phoneId}/advance`, payload: {},
  });
  assert.equal(body(r).action, "request_reset_authorization");
  assert.equal(state.phones[0].resetCount, 0);
});

test("an approved reset is issued once and then refused", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "80:5E:0C:BD:13:5A", provisioningUrl: "https://prov.oldprovider.net/x" }]);
  const phoneId = state.phones[0].id;
  await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/authorize-reset`, payload: { phoneIds: [phoneId] } });

  const first = body(await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phoneId}/advance`, payload: {},
  }));
  assert.equal(first.action, "reset_over_lan");
  assert.equal(state.phones[0].resetCount, 1);

  const second = body(await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phoneId}/advance`, payload: {},
  }));
  assert.equal(second.action, "halt");
  assert.equal(state.phones[0].resetCount, 1, "losing our place must never wipe a phone twice");
});

test("an approval covers exactly the phones the person was shown", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "80:5E:0C:BD:13:5A" }]);
  const r = await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/authorize-reset`,
    payload: { phoneIds: [state.phones[0].id, "ph_does_not_exist"] },
  });
  assert.equal(r.statusCode, 400);
  assert.equal(state.runs[0].resetAuthorizedAt, null, "a partial list is not consent");
});

test("approving a reset is written down with who, when and which phones", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "80:5E:0C:BD:13:5A" }]);
  await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/authorize-reset`, payload: { phoneIds: [state.phones[0].id] },
  });
  const row = state.audits.find((a: any) => a.action === "DESK_PHONE_RESET_AUTHORIZED");
  assert.ok(row);
  assert.equal(row.actorUserId, "u_1");
  assert.deepEqual(row.metadata.macs, ["805e0cbd135a"]);
});

/* ── ready means the PBX said so ─────────────────────────────────────────── */

test("a phone is only ever Ready because Asterisk says it is registered", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "80:5E:0C:BD:13:5A", provisioningUrl: "https://pbx.loopcom.net/phoneprov/a/" }]);
  const phoneId = state.phones[0].id;
  await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phoneId}/assign`, payload: { extensionId: "e2" },
  });

  // pointed at us, but the PBX has never seen it
  const before = body(await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phoneId}/advance`, payload: {},
  }));
  assert.notEqual(before.phone.status, "Ready", "accepting settings is not the same as working");

  registered.add("102");
  const after = body(await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phoneId}/advance`, payload: {},
  }));
  assert.equal(after.phone.status, "Ready");
  assert.ok(state.phones[0].registeredAt);
});

test("a lookalike provisioning host is not ours", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "80:5E:0C:BD:13:5A", provisioningUrl: "https://loopcom.net.evil.example/x" }]);
  const phoneId = state.phones[0].id;
  const out = body(await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phoneId}/advance`, payload: {},
  }));
  // treating it as ours would mark the phone connected and skip it entirely
  assert.notEqual(out.action, "do_nothing");
});

/* ── the two unfixable problems ──────────────────────────────────────────── */

test("a manufacturer redirect halts and hands off, rather than retrying", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "80:5E:0C:BD:13:5A", provisioningUrl: "https://prov.oldprovider.net/x" }]);
  const phoneId = state.phones[0].id;
  await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/authorize-reset`, payload: { phoneIds: [phoneId] } });
  await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/phones/${phoneId}/advance`, payload: {} });

  const out = body(await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phoneId}/advance`, payload: {},
  }));
  assert.equal(out.halted, true);
  assert.equal(out.handOff, "previous_provider");
  assert.equal(state.phones[0].state, "NEEDS_ATTENTION");
});

test("a router still advertising the old provider is a different answer", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "80:5E:0C:BD:13:5A", provisioningUrl: "https://prov.oldprovider.net/x" }]);
  const phoneId = state.phones[0].id;
  await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/authorize-reset`, payload: { phoneIds: [phoneId] } });
  await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/phones/${phoneId}/advance`, payload: {} });

  const out = body(await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phoneId}/advance`,
    payload: { networkSuppliesOldProvisioning: true },
  }));
  assert.equal(out.handOff, "customer_network");
  assert.match(out.customerMessage, /will not change your router/i);
});

/* ── progress and the disappearing card ──────────────────────────────────── */

test("seven of eight is reported as seven working, never one failed", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  await discover(app, runId, Array.from({ length: 8 }, (_, i) => ({ mac: `80:5E:0C:BD:13:${(10 + i).toString(16).padStart(2, "0")}` })));
  state.phones.forEach((p: any, i: number) => { p.state = i === 7 ? "NEEDS_ATTENTION" : "REGISTERED"; });
  const out = body(await app.inject({ method: "GET", url: `/desk-phones/runs/${runId}` }));
  assert.equal(out.summary.headline, "7 of your 8 phones are ready");
  assert.ok(!/fail/i.test(JSON.stringify(out.summary)));
});

test("the setup card disappears once nothing is left to do", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "80:5E:0C:BD:13:5A" }]);
  let s = body(await app.inject({ method: "GET", url: "/desk-phones/state" }));
  assert.equal(s.showSetupCard, true);
  state.phones[0].state = "REGISTERED";
  s = body(await app.inject({ method: "GET", url: "/desk-phones/state" }));
  assert.equal(s.showSetupCard, false, "the customer must never permanently see provisioning terminology");
});

test("diagnostics show everything the customer's view hides", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "80:5E:0C:BD:13:5A", ip: "192.168.1.41", firmware: "96.86.0.15" }]);
  const out = body(await app.inject({ method: "GET", url: `/desk-phones/runs/${runId}?view=diagnostics` }));
  assert.equal(out.phones[0].mac, "805e0cbd135a");
  assert.equal(out.phones[0].ip, "192.168.1.41");
  assert.equal(out.phones[0].firmware, "96.86.0.15");
});

/* ── one run per office ──────────────────────────────────────────────────── */

test("two wizards cannot race on the same office", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const first = await startRun(app);
  const second = body(await app.inject({ method: "POST", url: "/desk-phones/runs", payload: {} }));
  assert.equal(second.run.id, first);
  assert.equal(second.run.resumed, true, "two runs would each believe they owned the reset counters");
});

/* ── the Loopcom side ────────────────────────────────────────────────────── */

test("only Loopcom staff can send a setup request into somebody's office", async () => {
  reset();
  const customer = await makeApp(CUSTOMER);
  const r = await customer.inject({
    method: "POST", url: "/admin/desk-phones/send-setup", payload: { tenantId: "t_abc" },
  });
  assert.equal(r.statusCode, 403);
});

test("sending a request is an invitation and never an approval to wipe", async () => {
  reset();
  const staff = await makeApp(STAFF);
  const out = body(await staff.inject({
    method: "POST", url: "/admin/desk-phones/send-setup", payload: { tenantId: "t_abc" },
  }));
  const run = state.runs.find((r: any) => r.id === out.run.id);
  assert.equal(run.origin, "admin");
  assert.equal(run.resetAuthorizedAt, null, "sending is not consenting");
  assert.ok(state.audits.some((a: any) => a.action === "DESK_PHONE_SETUP_SENT"));
});

test("the customer is told the request came from Loopcom", async () => {
  reset();
  const staff = await makeApp(STAFF);
  await staff.inject({ method: "POST", url: "/admin/desk-phones/send-setup", payload: { tenantId: "t_abc" } });
  const customer = await makeApp(CUSTOMER);
  const s = body(await customer.inject({ method: "GET", url: "/desk-phones/state" }));
  assert.equal(s.invitedByLoopcom, true);
});

/* ── buttons ─────────────────────────────────────────────────────────────── */

test("the buttons are everybody except the phone's own extension", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "80:5E:0C:BD:13:5A", model: "T54W" }]);
  const phoneId = state.phones[0].id;
  await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phoneId}/assign`, payload: { extensionId: "e2" },
  });
  const out = body(await app.inject({ method: "GET", url: `/desk-phones/runs/${runId}/phones/${phoneId}/buttons` }));
  assert.deepEqual(out.colleagues.map((c: any) => c.extension), ["101"]);
  assert.ok(!JSON.stringify(out.colleagues).includes('"102"'), "nobody needs a key to call themselves");
  assert.ok(out.free > 0);
});

/* ── the wiring, where this class of defect actually lives ───────────────── */

const SERVER_SRC = readFileSync(join(__dirname, "..", "server.ts"), "utf8");

test("the routes are actually registered", () => {
  assert.match(SERVER_SRC, /registerDeskPhoneSetupRoutes\(app,/);
  assert.match(SERVER_SRC, /from "\.\/deskPhoneSetup\/deskPhoneRoutes"/);
});

test("the prefix has a permission rule, or the global gate never runs for it", () => {
  // ⛔ The /admin/wake-health class: a prefix matching no rule is a prefix with no
  // permission check at all.
  assert.match(
    SERVER_SRC,
    /\{ prefix: "\/desk-phones", permission: "can_setup_desk_phones" \}/,
    "no rule means the global permission preHandler silently skips the whole feature",
  );
  assert.match(SERVER_SRC, /\{ prefix: "\/admin\/desk-phones", permission: "can_manage_global_settings" \}/);
});

test("the route module never reads a tenant from a request body", () => {
  const SRC = readFileSync(join(__dirname, "deskPhoneRoutes.ts"), "utf8");
  const executable = SRC.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.doesNotMatch(executable, /req\.body[^\n]*tenantId/,
    "a tenant that arrives in a request is a claim, not a fact");
  // the one exception is the staff route, which takes a tenantId by design and is
  // role-gated; it reads it through a parsed schema rather than off req.body.
  assert.match(executable, /isSuper\(user\)/);
});

/* ── naming what was found (2026-08-25, the A plus center live run) ────────
 *
 * The first real customer run stored vendor "unknown" on all six devices — the
 * fingerprint only knows a vendor when the phone's locked web page admits one,
 * and nothing fell back to the hardware-address block that had ALREADY admitted
 * the device into the list. And nothing named the phones: the MAC→PBX-record
 * join did not exist. Izzy, live at the office: "it's not telling me the names
 * of the phones either. mac addresses should all be displayed."
 */

test("a locked phone is still identified by its hardware address block", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  // No fingerprint vendor at all, and an explicit "unknown" — both must fall
  // back to the OUI. A vendor the device itself admitted is never overridden.
  const out = await discover(app, runId, [
    { mac: "0C:38:3E:11:22:33" },
    { mac: "80:5E:C0:AA:BB:CC", vendor: "unknown" },
    { mac: "C0:74:AD:00:11:22", vendor: "grandstream" },
  ]);
  const vendors = out.phones.map((p: any) => p.vendor);
  assert.deepEqual(vendors, ["fanvil", "yealink", "grandstream"]);
});

test("the customer view shows the formatted hardware address", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  const out = await discover(app, runId, [{ mac: "80-5e-0c-bd-13-5a" }]);
  // ⛔ Deliberate since 2026-08-25 — the MAC is the sticker under the handset,
  // the one identifier a person can check two identical phones against.
  assert.equal(out.phones[0].mac, "80:5E:0C:BD:13:5A");
});

const APLUS_RECORDS = [
  { mac: "805ec0c89b86", macRaw: "80:5E:C0:C8:9B:86", pbxTenant: 2, description: "102", model: "T42S", brand: "Yealink", extension: "102", extensionName: "Mrs Weinstock" },
  { mac: "805ec0bf8c62", macRaw: "80:5E:C0:BF:8C:62", pbxTenant: 2, description: "101", model: "T53W", brand: "Yealink", extension: "101", extensionName: "Reception" },
];

test("the PBX's own record names the phone and fills the person", async () => {
  reset();
  const app = await makeApp(CUSTOMER, {
    provisionedPhones: async (tenantId: string) => {
      assert.equal(tenantId, "t_abc", "the lookup must be scoped to the caller's tenant");
      return APLUS_RECORDS;
    },
  });
  const runId = await startRun(app);
  const out = await discover(app, runId, [{ mac: "80:5E:C0:C8:9B:86" }]);
  const p = out.phones[0];
  assert.equal(p.model, "T42S");
  assert.equal(p.extNumber, "102");
  // The Connect extension row for 102 exists (David Klein), so the assignment is
  // made exactly as a human's click would make it — and the Connect display name
  // wins over the PBX one, because it is what every other screen calls him.
  assert.equal(p.displayName, "David Klein");
  const row = state.phones.find((r: any) => r.macAddress === "805ec0c89b86");
  assert.equal(row.extensionId, "e2");
});

test("a human's assignment is never overwritten by the record", async () => {
  reset();
  const app = await makeApp(CUSTOMER, { provisionedPhones: async () => APLUS_RECORDS });
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "80:5E:C0:C8:9B:86" }]);
  const row = state.phones.find((r: any) => r.macAddress === "805ec0c89b86");
  // The person re-points the phone at Reception…
  await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/phones/${row.id}/assign`, payload: { extensionId: "e1" } });
  // …and a re-scan must not drag it back to what the PBX record says.
  await discover(app, runId, [{ mac: "80:5E:C0:C8:9B:86" }]);
  assert.equal(row.extensionId, "e1");
  assert.equal(row.extNumber, "101");
});

test("phones the system already runs that the scan could not see are reported, never invented as rows", async () => {
  reset();
  const app = await makeApp(CUSTOMER, { provisionedPhones: async () => APLUS_RECORDS });
  const runId = await startRun(app);
  const out = await discover(app, runId, [{ mac: "80:5E:C0:C8:9B:86" }]);
  // ⛔ Context only: the six-phone result in a thirteen-phone office must read as
  // "here is where we looked", never as lost phones — and never as new work items.
  assert.equal(out.phones.length, 1);
  assert.equal(out.knownElsewhere.length, 1);
  assert.equal(out.knownElsewhere[0].mac, "80:5E:C0:BF:8C:62");
  assert.equal(out.knownElsewhere[0].name, "Reception");
  assert.equal(state.phones.length, 1, "an unseen record must not become a phone row");
});

test("a PBX that cannot be read costs the names, never the discovery", async () => {
  reset();
  const app = await makeApp(CUSTOMER, { provisionedPhones: async () => { throw new Error("pbx down"); } });
  const runId = await startRun(app);
  const out = await discover(app, runId, [{ mac: "80:5E:C0:C8:9B:86" }]);
  assert.equal(out.ok, true);
  assert.equal(out.phones.length, 1);
  assert.deepEqual(out.knownElsewhere, []);
});

test("a rescan that resubmits only part of the list still fills vendors on the older rows", async () => {
  reset();
  const app = await makeApp(CUSTOMER, { provisionedPhones: async () => [] });
  const runId = await startRun(app);
  // First pass finds two devices, before any vendor knowledge existed server-side.
  await discover(app, runId, [{ mac: "0C:38:3E:77:C5:36" }, { mac: "0C:38:3E:77:C5:43" }]);
  state.phones.forEach((r: any) => { r.vendor = null; }); // the pre-fix stored state
  // ⛔ ARP is ephemeral: the rescan sees only ONE of them. The other row's
  // hardware address has not changed — it must be named anyway (on the first
  // live run 4 of 6 rows kept vendor null exactly this way).
  const out = await discover(app, runId, [{ mac: "0C:38:3E:77:C5:36" }]);
  assert.deepEqual(out.phones.map((p: any) => p.vendor), ["fanvil", "fanvil"]);
});

test("the screen tells the live truth about a factory-reset phone, records notwithstanding", async () => {
  reset();
  // The record says this is Jacob's ext-103 phone; Asterisk says ext 103 is NOT
  // registered — the exact shape of Izzy's own reset test (2026-08-25).
  const records = [
    { mac: "805e0c4d796d", macRaw: "80:5E:0C:4D:79:6D", pbxTenant: 2, description: "103", model: "T53W", brand: "Yealink", extension: "103", extensionName: "Jacob Weinstock" },
    { mac: "805ec0bf8c62", macRaw: "80:5E:C0:BF:8C:62", pbxTenant: 2, description: "101", model: "T53W", brand: "Yealink", extension: "101", extensionName: "Reception" },
  ];
  state.extensions.push({ id: "e103", tenantId: "t_abc", extNumber: "103", displayName: "Jacob Weinstock", status: "ACTIVE" });
  registered = new Set(["101"]); // 101 is up; the reset 103 is not
  const app = await makeApp(CUSTOMER, { provisionedPhones: async () => records });
  const runId = await startRun(app);
  const out = await discover(app, runId, [{ mac: "80:5E:0C:4D:79:6D" }]);
  const p = out.phones[0];
  assert.equal(p.displayName, "Jacob Weinstock", "the record still names the phone");
  assert.equal(p.connectedNow, false, "and the live check says it is NOT connected");
  const known = out.knownElsewhere.find((k: any) => k.mac === "80:5E:C0:BF:8C:62");
  assert.equal(known.connectedNow, true, "a genuinely registered unseen phone reads connected");
});

/* ── which phones are in the setup at all (2026-09-02) ──────────────────── */

async function assignTo(app: any, runId: string, phoneId: string, extensionId: string) {
  const r = await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phoneId}/assign`, payload: { extensionId },
  });
  assert.equal(r.statusCode, 200);
}

test("the person's pick is stored on the rows: an unticked phone is never advanced and does not block done", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "80:5E:0C:BD:13:5A" }, { mac: "80:5E:0C:BD:13:5B" }]);
  const [inSetup, leftAlone] = state.phones;
  await assignTo(app, runId, inSetup.id, "e1");
  await assignTo(app, runId, leftAlone.id, "e2");

  // Izzy's exact case: nine phones on the list, ONE reset phone to set up.
  const pick = await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/selection`, payload: { phoneIds: [inSetup.id] },
  });
  assert.equal(pick.statusCode, 200);
  assert.equal(body(pick).selected, 1);
  assert.equal(body(pick).skipped, 1);
  assert.equal(inSetup.skippedAt, null);
  assert.ok(leftAlone.skippedAt instanceof Date, "the unticked phone is marked on its own row");
  // ⛔ Deselecting never fails a phone and never loses its identity.
  assert.equal(leftAlone.state, "ASSIGNED");
  assert.equal(leftAlone.extNumber, "102");

  const view = body(await app.inject({ method: "GET", url: `/desk-phones/runs/${runId}` }));
  assert.deepEqual(view.phones.map((p: any) => p.selected), [true, false]);
  assert.equal(view.summary.total, 1, "only the ticked phone counts");

  // The server refuses to touch the unticked phone whatever a driver sends.
  const adv = body(await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${leftAlone.id}/advance`, payload: {},
  }));
  assert.equal(adv.action, "do_nothing");
  assert.equal(adv.skipped, true);
  assert.equal(leftAlone.state, "ASSIGNED");
  assert.equal(leftAlone.attempts, 0);

  // The ticked phone registering is enough for the whole run to read finished —
  // before this, the eight untouched phones kept "finished" false forever.
  registered = new Set(["101"]);
  inSetup.provisioningUrl = "https://m.connectcomunications.com/phoneprov/x/x.cfg";
  await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/phones/${inSetup.id}/advance`, payload: {} });
  const done = body(await app.inject({ method: "GET", url: `/desk-phones/runs/${runId}` }));
  assert.equal(done.summary.ready, 1);
  assert.equal(done.summary.finished, true, "a phone left alone must not hold the run open");
  assert.equal(done.summary.headline, "Your phone is ready");
});

test("the pick REPLACES the previous pick, so a change of mind lands cleanly", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "80:5E:0C:BD:13:5A" }, { mac: "80:5E:0C:BD:13:5B" }]);
  const [a, b] = state.phones;
  await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/selection`, payload: { phoneIds: [a.id] } });
  assert.ok(b.skippedAt);
  await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/selection`, payload: { phoneIds: [a.id, b.id] } });
  assert.equal(a.skippedAt, null);
  assert.equal(b.skippedAt, null, "re-ticking a phone brings it back");
});

test("a pick naming a phone that is not in this run is refused, and another customer sees 404", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "80:5E:0C:BD:13:5A" }]);
  const r = await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/selection`, payload: { phoneIds: [state.phones[0].id, "ph_not_here"] },
  });
  assert.equal(r.statusCode, 400);
  assert.equal(body(r).error, "phone_list_mismatch");
  assert.equal(state.phones[0].skippedAt, undefined, "a refused pick changes nothing");

  const theirs = await makeApp(OTHER);
  const x = await theirs.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/selection`, payload: { phoneIds: [state.phones[0].id] },
  });
  assert.equal(x.statusCode, 404, "404 and not 403: a 403 confirms the run exists");
});

/* ── handing a reset phone its folder (2026-09-02) ──────────────────────── */

test("advance answers set_provisioning WITH the tenant's folder URL, and a failed hand-off halts kindly", async () => {
  reset();
  const app = await makeApp(CUSTOMER, {
    provisioningUrlFor: async (tenantId: string) => (tenantId === "t_abc" ? "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/" : null),
  });
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "80:5E:0C:4D:79:6D", ip: "192.168.0.121", vendor: "yealink", model: "T53W" }]);
  const phone = state.phones[0];
  await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/assign`, payload: { extensionId: "e1" } });
  // Izzy's reset T53W: reachable, unlocked, not registered, no folder yet.
  const adv = body(await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/advance`, payload: { reachableOnLan: true },
  }));
  assert.equal(adv.action, "set_provisioning");
  assert.equal(adv.provisioningUrl, "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/");
  assert.equal(phone.state, "ASSIGNED", "asking for the folder changes nothing on the row");

  // Any other instruction carries no URL at all.
  const other = body(await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/advance`, payload: { reachableOnLan: false },
  }));
  assert.ok(!("provisioningUrl" in other));

  // The office machine gave up: the phone ends at Needs attention with a hand-off,
  // never another restart.
  const halt = body(await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/advance`,
    payload: { reachableOnLan: true, provisioningHandoffFailed: true },
  }));
  assert.equal(halt.action, "halt");
  assert.equal(halt.handOff, "support");
  assert.match(halt.customerMessage, /Loopcom Support/);
  assert.equal(phone.state, "NEEDS_ATTENTION");
  assert.equal(phone.resetCount, 0);
});

test("a folder resolver that throws or knows nothing leaves the instruction without a URL", async () => {
  reset();
  const app = await makeApp(CUSTOMER, { provisioningUrlFor: async () => { throw new Error("pbx down"); } });
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "80:5E:0C:4D:79:6D", ip: "192.168.0.121" }]);
  const phone = state.phones[0];
  await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/assign`, payload: { extensionId: "e1" } });
  const adv = body(await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/advance`, payload: { reachableOnLan: true } }));
  assert.equal(adv.action, "set_provisioning");
  assert.equal(adv.provisioningUrl, null);
});

test("the folder URL is built only from the PBX's 16-hex tenant path, on the photos' origin", () => {
  routes();
  const { buildPhoneprovUrl, phoneprovBaseUrl } = routesModule;
  assert.equal(phoneprovBaseUrl({ PBX_PHONE_IMAGE_BASE: "https://m.connectcomunications.com/provisioning_resources" } as any), "https://m.connectcomunications.com/phoneprov");
  assert.equal(phoneprovBaseUrl({ PBX_PHONEPROV_BASE_URL: "https://pbx.loopcom.net/phoneprov/" } as any), "https://pbx.loopcom.net/phoneprov");
  assert.equal(phoneprovBaseUrl({} as any), null);
  assert.equal(buildPhoneprovUrl("https://m.connectcomunications.com/phoneprov", "f3df739ac62197cd"), "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/");
  assert.equal(buildPhoneprovUrl("https://m.connectcomunications.com/phoneprov", "F3DF739AC62197CD"), "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/");
  for (const bad of ["", null, "f3df739ac62197c", "../etc", "f3df739ac62197cd/x", "not-hex-not-hex!"]) {
    assert.equal(buildPhoneprovUrl("https://m.connectcomunications.com/phoneprov", bad), null, String(bad));
  }
  assert.equal(buildPhoneprovUrl(null, "f3df739ac62197cd"), null);
});

/* ── the standing listener's config (2026-09-02, same evening) ─────────── */

test("pnp-config hands the office app the tenant's folder and ITS phones' hardware addresses, and nothing else", async () => {
  reset();
  const app = await makeApp(CUSTOMER, {
    provisioningUrlFor: async (tenantId: string) => (tenantId === "t_abc" ? "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/" : null),
    provisionedPhones: async () => ([
      { mac: "805e0c4d796d", macRaw: "80:5E:0C:4D:79:6D", pbxTenant: 2, description: "103", model: "T53W", brand: "yealink" },
      { mac: "805E0CC89882", macRaw: "80:5E:0C:C8:98:82", pbxTenant: 2, description: "105", model: "T42S", brand: "yealink" },
      { mac: "805e0c4d796d", macRaw: "dup", pbxTenant: 2, description: "dup", model: null, brand: null },
      { mac: "not-a-mac", macRaw: "junk", pbxTenant: 2, description: null, model: null, brand: null },
    ] as any),
  });
  const out = body(await app.inject({ method: "GET", url: "/desk-phones/pnp-config" }));
  assert.equal(out.ok, true);
  assert.equal(out.url, "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/");
  assert.deepEqual(out.macs, ["805e0c4d796d", "805e0cc89882"], "normalised, de-duplicated, junk dropped");
});

test("pnp-config with no folder or a failing PBX read still answers — url null, macs empty — never a 500", async () => {
  reset();
  const app = await makeApp(CUSTOMER, {
    provisioningUrlFor: async () => { throw new Error("pbx down"); },
    provisionedPhones: async () => { throw new Error("pbx down"); },
  });
  const out = body(await app.inject({ method: "GET", url: "/desk-phones/pnp-config" }));
  assert.deepEqual(out, { ok: true, url: null, macs: [] });
});

/* ── Panasonic: shown honestly, never reset, registration wins (2026-09-03) ─ */

test("a Panasonic that is not registered goes to a person — never a reset, never a password prompt", async () => {
  reset();
  const app = await makeApp(CUSTOMER, {
    provisioningUrlFor: async () => "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/",
  });
  const runId = await startRun(app);
  // A KX-TGP500 as the scan reports it: Panasonic OUI, SIP banner named the model.
  await discover(app, runId, [{ mac: "00:80:F0:AA:BB:CC", ip: "192.168.1.60", vendor: "panasonic", model: "KXTGP500B04" }]);
  const phone = state.phones[0];
  assert.equal(phone.vendor, "panasonic");
  await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/assign`, payload: { extensionId: "e1" } });

  // Reachable and unlocked would be set_provisioning for a Yealink; for a vendor
  // the PBX has no template for, that instruction can structurally never finish —
  // and a reset would erase the hand-typed SIP account that is this phone's only
  // possible configuration. So: halt to support, in plain words, immediately.
  const adv = body(await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/advance`, payload: { reachableOnLan: true },
  }));
  assert.equal(adv.action, "halt");
  assert.equal(adv.handOff, "support");
  assert.match(adv.customerMessage, /can't set this model .* up automatically/i);
  assert.match(adv.customerMessage, /rest of your phones keep going/i);
  assert.equal(phone.state, "NEEDS_ATTENTION");
  assert.equal(phone.resetCount, 0, "a reset was spent on a phone we can never re-provision");
  assert.ok(!("provisioningUrl" in adv), "a folder URL for a vendor with no template is a lie");
});

test("a Panasonic that IS registered is simply Ready — registration is the whole test", async () => {
  reset(); registered = new Set(["101"]);
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  await discover(app, runId, [{ mac: "00:80:F0:AA:BB:CC", ip: "192.168.1.60", vendor: "panasonic", model: "KXTGP500B04" }]);
  const phone = state.phones[0];
  await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/assign`, payload: { extensionId: "e1" } });
  const adv = body(await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/advance`, payload: { reachableOnLan: true },
  }));
  // ⛔ A hand-configured Panasonic can never point at OUR provisioning, so
  // demanding provisioningIsOurs would leave a working phone amber forever.
  assert.equal(adv.action, "do_nothing");
  assert.equal(adv.halted, false);
  assert.equal(phone.state, "REGISTERED");
});

test("the Panasonic gate fires only on a POSITIVE identification — an unknown vendor keeps the full ladder", async () => {
  reset();
  const app = await makeApp(CUSTOMER, {
    provisioningUrlFor: async () => "https://m.connectcomunications.com/phoneprov/f3df739ac62197cd/",
  });
  const runId = await startRun(app);
  // Unknown OUI, no fingerprint: could be a locked Yealink. Giving up here would
  // be giving up on exactly the phone the wizard is for.
  await discover(app, runId, [{ mac: "AA:BB:CC:00:11:22", ip: "192.168.1.61" }]);
  const phone = state.phones[0];
  await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/assign`, payload: { extensionId: "e1" } });
  const adv = body(await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/phones/${phone.id}/advance`, payload: { reachableOnLan: true },
  }));
  assert.equal(adv.action, "set_provisioning", "an unidentified device still gets the ordinary ladder");
  assert.notEqual(phone.state, "NEEDS_ATTENTION");
});

test("a Panasonic OUI fills the vendor server-side when the scan could not say", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const runId = await startRun(app);
  const out = await discover(app, runId, [{ mac: "00:80:F0:AA:BB:CC", ip: "192.168.1.60" }]);
  assert.equal(out.phones[0].vendor, "panasonic", "the hardware block names the maker even when the device is silent");
});
