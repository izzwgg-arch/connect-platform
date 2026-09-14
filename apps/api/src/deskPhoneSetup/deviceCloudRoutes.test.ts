/**
 * The maker-cloud routes, driven through the EXISTING wizard registration against a
 * faked database and the GDMS simulator: identification on the card, registering a device
 * with its maker, the label fallback, "Prepare Device", and every way one customer must
 * not reach another's device or wipe a phone without being allowed to.
 *
 * Run with: node --experimental-test-module-mocks --import tsx --test
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

// ─── fake db ─────────────────────────────────────────────────────────────────

const state: any = { runs: [], phones: [], extensions: [], tenants: [], audits: [], managed: [] };
let seq = 0;
const nextId = (p: string) => `${p}_${++seq}`;

const same = (a: any, b: any) => (a ?? null) === (b ?? null);
const matches = (row: any, where: any): boolean =>
  Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return (v as any).in.includes(row[k]);
      if ("not" in v) return !same(row[k], (v as any).not);
      return true;
    }
    return same(row[k], v);
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

const fakeDb: any = {
  deskPhoneSetupRun: table("runs", () => ({
    id: nextId("run"), status: "running", origin: "customer", startedAt: new Date(),
    subnet: null, resetAuthorizedAt: null, resetAuthorizedByUserId: null, resetAuthorizedPhoneIds: null,
  })),
  deskPhoneSetupPhone: table("phones", () => ({
    id: nextId("ph"), state: "DISCOVERED", attempts: 0, resetCount: 0, createdAt: new Date(),
    ipAddress: null, previousIp: null, vendor: null, model: null, firmware: null,
    provisioningUrl: null, extensionId: null, extNumber: null, displayName: null,
    customerNote: null, technicalNote: null, resetRequestedAt: null, registeredAt: null, haltedReason: null,
    skippedAt: null, deviceType: null, serialNumber: null, identityConfidence: null, identityEvidence: null,
    vendorCloudState: null, vendorCloudCheckedAt: null,
  })),
  extension: table("extensions", () => ({ id: nextId("ext"), status: "ACTIVE" })),
  tenant: table("tenants", () => ({ id: nextId("t") })),
  managedDeskPhone: table("managed", () => ({ id: nextId("mdp"), retiredAt: null })),
  agentSecret: {
    findUnique: async () => null,
    upsert: async () => ({}),
    deleteMany: async () => ({ count: 0 }),
  },
};

mock.module("@connect/db", { namedExports: { db: fakeDb } });

let allowSetup = true;
let allowReset = true;
mock.module("../permissionGates", {
  namedExports: {
    userHasActionPermission: async (_u: any, key: string) =>
      key === "can_setup_desk_phones" ? allowSetup : key === "can_authorize_phone_reset" ? allowReset : false,
  },
});

// ⛔ Loaded lazily, AFTER the mocks: apps/api compiles to CommonJS.
function load() {
  return {
    routes: require("./deskPhoneRoutes").registerDeskPhoneSetupRoutes,
    GdmsSimulator: require("./gdmsSimulator").GdmsSimulator,
    GrandstreamProvider: require("./grandstreamProvider").GrandstreamProvider,
    createDeviceProviderRegistry: require("./deviceProviderRegistry").createDeviceProviderRegistry,
    clearGdmsCredentialsCache: require("./gdmsCredentials").clearGdmsCredentialsCache,
  };
}

// ─── harness ─────────────────────────────────────────────────────────────────

const CUSTOMER = { sub: "u_1", tenantId: "t_abc", email: "dina@abc.example", role: "TENANT_ADMIN" };
const OTHER = { sub: "u_9", tenantId: "t_other", email: "someone@other.example", role: "TENANT_ADMIN" };
const STAFF = { sub: "u_s", tenantId: "t_loopcom", email: "izzy@loopcom.net", role: "SUPER_ADMIN" };

const MAC = "C0:74:AD:8C:60:5F";
const MAC12 = "c074ad8c605f";
const SN = "20EZ115N308C605F";

let sim: any;
let registered = new Set<string>();
let lockKeys: string[] = [];

function makeLock() {
  let chain: Promise<unknown> = Promise.resolve();
  return async <T>(key: string, fn: (tx: any) => Promise<T>): Promise<T> => {
    lockKeys.push(key);
    const run = chain.then(() => fn(fakeDb));
    chain = run.then(() => undefined, () => undefined);
    return run as Promise<T>;
  };
}
let sharedLock = makeLock();

function reset() {
  for (const k of Object.keys(state)) state[k].length = 0;
  allowSetup = true; allowReset = true; registered = new Set(); lockKeys = []; sharedLock = makeLock();
  const L = load();
  sim = new L.GdmsSimulator();
  L.clearGdmsCredentialsCache();
  state.tenants.push({ id: "t_abc", name: "ABC Company" }, { id: "t_other", name: "Other Co" }, { id: "t_loopcom", name: "Loopcom" });
  state.extensions.push({ id: "e1", tenantId: "t_abc", extNumber: "101", displayName: "Reception", status: "ACTIVE" });
}

function registry(opts: { unconfigured?: boolean; provider?: any } = {}) {
  const L = load();
  const grandstream = opts.provider ?? new L.GrandstreamProvider({
    resolveCredentials: async () => (opts.unconfigured ? null : sim.creds),
    request: sim.fetch,
    env: {},
  });
  return L.createDeviceProviderRegistry({ db: fakeDb, env: {}, overrides: { grandstream } });
}

async function makeApp(user: any, opts: { registry?: any } = {}) {
  const app = Fastify();
  app.addHook("preHandler", async (req: any) => { req.user = user; });
  await load().routes(app as any, {
    audit: async (p: any) => { state.audits.push(p); },
    ourProvisioningHosts: () => ["loopcom.net", "m.connectcomunications.com"],
    isRegistered: async (_t: string, ext: string) => registered.has(ext),
    deviceProviders: opts.registry ?? registry(),
    withMacLock: sharedLock,
    gdmsRequest: sim.fetch,
  });
  return app;
}

const body = (r: any) => JSON.parse(r.body);

async function runWithPhone(app: any, phone: Record<string, unknown> = {}) {
  const started = await app.inject({ method: "POST", url: "/desk-phones/runs", payload: {} });
  const runId = body(started).run.id;
  const d = await app.inject({
    method: "POST",
    url: `/desk-phones/runs/${runId}/discovered`,
    payload: {
      subnet: "192.168.1.0/24",
      phones: [{ mac: MAC, ip: "192.168.1.50", vendor: "Grandstream", model: "GXP2170", firmware: "1.0.11.64", identitySource: "http_banner", ...phone }],
    },
  });
  assert.equal(d.statusCode, 200, d.body);
  const row = state.phones.find((p: any) => p.runId === runId);
  assert.ok(row, "the discovered device was stored");
  return { runId, row, base: `/desk-phones/runs/${runId}/phones/${row.id}` };
}

function noLeak(value: unknown, needles: string[]) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const n of needles) assert.ok(!text.includes(n), `leaked "${n}"`);
}

function withEnv(values: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(values)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
}

/* ── what the card says ──────────────────────────────────────────────────── */

test("the card says what was DETECTED — kind, address, how sure — and nothing technical", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { runId, row } = await runWithPhone(app, { serialNumber: SN });
  const out = body(await app.inject({ method: "GET", url: `/desk-phones/runs/${runId}` }));
  const p = out.phones[0];
  assert.equal(p.ip, "192.168.1.50");
  assert.equal(p.deviceType, "desk_phone");
  assert.ok(p.deviceTypeLabel);
  assert.equal(typeof p.identityConfidence, "string");
  assert.ok(p.provisioningStatus);
  assert.ok(p.provisioningStatusLabel);
  for (const k of ["firmware", "identityEvidence", "serialNumber", "identification", "vendorCloudState"]) {
    assert.equal(k in p, false, `${k} is technician-only`);
  }
  // …while the row itself carries the evidence trail.
  assert.equal(row.serialNumber, SN);
  assert.ok(Array.isArray(row.identityEvidence));
  assert.ok(row.identityEvidence.some((e: any) => e.source === "http_banner"));
});

test("a rescan that cannot read the model does not erase the one already known", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { runId, row } = await runWithPhone(app);
  await app.inject({
    method: "POST", url: `/desk-phones/runs/${runId}/discovered`,
    payload: { phones: [{ mac: MAC, ip: "192.168.1.51" }] },
  });
  assert.equal(row.model, "GXP2170");
  assert.equal(row.ipAddress, "192.168.1.51");
  assert.equal(state.phones.filter((p: any) => p.runId === runId).length, 1, "one row per hardware address");
});

test("the maker list says what each cloud can do, in words; platform names are staff-only", async () => {
  reset();
  const customer = body(await (await makeApp(CUSTOMER)).inject({ method: "GET", url: "/desk-phones/providers" }));
  const gs = customer.providers.find((p: any) => p.manufacturer === "grandstream");
  assert.equal(gs.canRegisterDevices, true);
  assert.equal(gs.needsSerialToRegister, true);
  assert.equal("platform" in gs, false);
  const fanvil = customer.providers.find((p: any) => p.manufacturer === "fanvil");
  assert.equal(fanvil.cloudConnected, false);

  const staff = body(await (await makeApp(STAFF)).inject({ method: "GET", url: "/desk-phones/providers" }));
  assert.equal(staff.providers.find((p: any) => p.manufacturer === "grandstream").platform, "gdms");

  allowSetup = false;
  const denied = await (await makeApp(CUSTOMER)).inject({ method: "GET", url: "/desk-phones/providers" });
  assert.equal(denied.statusCode, 403);
});

/* ── isolation ───────────────────────────────────────────────────────────── */

test("another customer's device is indistinguishable from one that does not exist", async () => {
  reset();
  const mine = await makeApp(CUSTOMER);
  const { base } = await runWithPhone(mine, { serialNumber: SN });
  const theirs = await makeApp(OTHER);
  const calls: Array<[string, string, any]> = [
    ["GET", `${base}/identification`, undefined],
    ["POST", `${base}/vendor-lookup`, {}],
    ["POST", `${base}/claim`, { serialNumber: SN }],
    ["POST", `${base}/scan-label`, { text: `S/N: ${SN}` }],
    ["POST", `${base}/prepare`, {}],
  ];
  for (const [method, url, payload] of calls) {
    const r = await theirs.inject({ method: method as any, url, payload });
    assert.equal(r.statusCode, 404, url);
  }
  assert.equal(sim.apiCalls.length, 0, "nothing reached the maker");
  assert.equal(sim.addCalls, 0);
});

test("the identification view hides sources and the serial from a customer, and shows them to staff", async () => {
  reset();
  const customer = await makeApp(CUSTOMER);
  const c = await runWithPhone(customer, { serialNumber: SN });
  const cv = body(await customer.inject({ method: "GET", url: `${c.base}/identification` })).identification;
  assert.equal(cv.manufacturer, "grandstream");
  assert.equal(cv.model, "GXP2170");
  assert.equal(cv.serialOnFile, true);
  assert.equal("sources" in cv, false);
  assert.equal("serialNumber" in cv, false);
  noLeak(cv, [SN]);

  const staff = await makeApp(STAFF);
  const s = await runWithPhone(staff, { serialNumber: SN });
  const sv = body(await staff.inject({ method: "GET", url: `${s.base}/identification` })).identification;
  assert.ok(Array.isArray(sv.sources) && sv.sources.length > 0);
  assert.equal(sv.serialNumber, SN);
  assert.equal(typeof sv.confidenceScore, "number");
});

/* ── the maker's cloud ───────────────────────────────────────────────────── */

test("a lookup records what the maker knows as evidence and marks the device managed", async () => {
  reset();
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1.0.11.70", status: "online", owner: "ours" });
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app);
  const out = body(await app.inject({ method: "POST", url: `${base}/vendor-lookup`, payload: {} }));
  assert.equal(out.ok, true);
  assert.equal(out.checked, true);
  assert.equal(out.cloud.managedByUs, true);
  assert.equal(row.vendorCloudState, "managed");
  assert.ok(row.vendorCloudCheckedAt instanceof Date);
  assert.equal(row.serialNumber, SN);
  assert.ok(row.identityEvidence.some((e: any) => e.source === "vendor_cloud"));
  assert.ok(state.audits.some((a: any) => a.action === "DESK_PHONE_VENDOR_LOOKUP"));
});

test("a failed lookup proves nothing: a managed device stays managed and no vendor text reaches the screen", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app);
  row.vendorCloudState = "managed";
  sim.failNext = "500";
  const r = await app.inject({ method: "POST", url: `${base}/vendor-lookup`, payload: {} });
  const out = body(r);
  assert.equal(out.ok, false);
  assert.equal(out.error, "gdms_service_unavailable");
  assert.equal(out.retryable, true);
  assert.equal("staffMessage" in out, false, "a customer never sees the staff wording");
  assert.equal(row.vendorCloudState, "managed");
  noLeak(r.body, ["internal error", "retCode"]);
});

test("registering needs the serial number, and a malformed one is refused before anything is sent", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { base } = await runWithPhone(app);
  const missing = await app.inject({ method: "POST", url: `${base}/claim`, payload: {} });
  assert.equal(missing.statusCode, 400);
  assert.equal(body(missing).needsSerial, true);
  const bad = await app.inject({ method: "POST", url: `${base}/claim`, payload: { serialNumber: "ab" } });
  assert.equal(bad.statusCode, 400);
  assert.equal(body(bad).error, "serial_number_invalid");
  assert.equal(sim.addCalls, 0);
});

test("registering a device verifies it by read-back, stores the serial, and audits only its tail", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app);
  const r = await app.inject({ method: "POST", url: `${base}/claim`, payload: { serialNumber: SN } });
  assert.equal(r.statusCode, 200, r.body);
  const out = body(r);
  assert.equal(out.outcome, "verified");
  assert.equal(row.vendorCloudState, "managed");
  assert.equal(row.serialNumber, SN);
  assert.equal(sim.addCalls, 1);
  const audit = state.audits.find((a: any) => a.action === "DESK_PHONE_CLAIMED");
  assert.ok(audit);
  assert.equal(audit.metadata.serialTail, "…605F");
  noLeak(state.audits, [SN, sim.creds.secretKey, sim.creds.password]);
  assert.ok(lockKeys.includes(`desk-phone-claim:${MAC12}`), "the claim ran under the hardware-address lock");
});

test("a device another Loopcom customer manages is a conflict and is never re-registered", async () => {
  reset();
  state.managed.push({ id: "m1", macAddress: MAC12, tenantId: "t_other", retiredAt: null });
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app);
  const r = await app.inject({ method: "POST", url: `${base}/claim`, payload: { serialNumber: SN } });
  assert.equal(r.statusCode, 409);
  const out = body(r);
  assert.equal(out.error, "device_ownership_conflict");
  noLeak(out, ["Other Co", "t_other"]);
  assert.equal(row.vendorCloudState, "conflict");
  assert.equal(sim.addCalls, 0);
});

test("a retired managed phone elsewhere does not block the claim", async () => {
  reset();
  state.managed.push({ id: "m1", macAddress: MAC12, tenantId: "t_other", retiredAt: new Date() });
  const app = await makeApp(CUSTOMER);
  const { base } = await runWithPhone(app);
  const r = await app.inject({ method: "POST", url: `${base}/claim`, payload: { serialNumber: SN } });
  assert.equal(r.statusCode, 200, r.body);
});

test("the maker refusing the add is a POSSIBLE conflict, and the device is not marked managed", async () => {
  reset();
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "online", owner: "other" });
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app);
  const r = await app.inject({ method: "POST", url: `${base}/claim`, payload: { serialNumber: SN } });
  assert.equal(r.statusCode, 409);
  const out = body(r);
  assert.equal(out.error, "gdms_request_rejected");
  assert.equal(out.possibleOwnershipConflict, true);
  assert.notEqual(row.vendorCloudState, "managed");
  assert.notEqual(row.vendorCloudState, "claiming");
  assert.ok(state.audits.some((a: any) => a.action === "DESK_PHONE_CLAIM_REFUSED"));
});

test("a claim already in flight is refused; an abandoned one is not", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app);
  row.vendorCloudState = "claiming";
  row.vendorCloudCheckedAt = new Date();
  const busy = await app.inject({ method: "POST", url: `${base}/claim`, payload: { serialNumber: SN } });
  assert.equal(busy.statusCode, 409);
  assert.equal(body(busy).error, "claim_in_progress");
  assert.equal(sim.addCalls, 0);

  row.vendorCloudCheckedAt = new Date(Date.now() - 11 * 60_000);
  const stale = await app.inject({ method: "POST", url: `${base}/claim`, payload: { serialNumber: SN } });
  assert.equal(stale.statusCode, 200, stale.body);
  assert.equal(sim.addCalls, 1);
});

test("two customers registering the same device at the same moment: exactly one wins", async () => {
  reset();
  const a = await makeApp(CUSTOMER);
  const b = await makeApp(OTHER);
  const ra = await runWithPhone(a);
  const rb = await runWithPhone(b);
  const [x, y] = await Promise.all([
    a.inject({ method: "POST", url: `${ra.base}/claim`, payload: { serialNumber: SN } }),
    b.inject({ method: "POST", url: `${rb.base}/claim`, payload: { serialNumber: SN } }),
  ]);
  const codes = [x.statusCode, y.statusCode].sort();
  assert.deepEqual(codes, [200, 409], `${x.body} | ${y.body}`);
  const loser = x.statusCode === 409 ? body(x) : body(y);
  assert.ok(["device_ownership_conflict", "claim_in_progress"].includes(loser.error), loser.error);
  assert.equal(sim.addCalls, 1, "the maker was asked once");
  assert.equal(state.phones.filter((p: any) => p.vendorCloudState === "managed").length, 1);
});

test("with the maker's cloud not connected, registering refuses honestly and contacts nobody", async () => {
  reset();
  const customer = await makeApp(CUSTOMER, { registry: registry({ unconfigured: true }) });
  const c = await runWithPhone(customer, { serialNumber: SN });
  const r = await customer.inject({ method: "POST", url: `${c.base}/claim`, payload: {} });
  assert.equal(r.statusCode, 409);
  const out = body(r);
  assert.equal(out.error, "cloud_not_configured");
  assert.equal("staffMessage" in out, false);
  assert.equal(sim.apiCalls.length + sim.tokenCalls, 0);

  const staff = await makeApp(STAFF, { registry: registry({ unconfigured: true }) });
  const s = await runWithPhone(staff, { serialNumber: SN });
  const so = body(await staff.inject({ method: "POST", url: `${s.base}/claim`, payload: {} }));
  assert.ok(so.staffMessage);
});

/* ── the label fallback ──────────────────────────────────────────────────── */

test("a scanned label names an unnamed device and stores its serial; another device's label is refused", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app, { model: undefined, identitySource: "none" });
  assert.equal(row.model, null);

  const other = await app.inject({ method: "POST", url: `${base}/scan-label`, payload: { text: "MAC: 805E0CBD135A S/N: ABCDE12345" } });
  assert.equal(other.statusCode, 409);
  assert.equal(body(other).error, "label_for_different_device");
  assert.equal(row.serialNumber, null);

  const junk = await app.inject({ method: "POST", url: `${base}/scan-label`, payload: { text: "hello there" } });
  assert.equal(junk.statusCode, 400);
  assert.equal(body(junk).error, "label_unreadable");

  const ok = await app.inject({
    method: "POST", url: `${base}/scan-label`,
    payload: { text: `Grandstream GXP2170 MAC: C074AD8C605F S/N: ${SN}` },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.match(String(row.model), /GXP2170/i);
  assert.equal(row.serialNumber, SN);
  assert.ok(row.identityEvidence.some((e: any) => e.source === "barcode_label"));
  const audit = state.audits.find((a: any) => a.action === "DESK_PHONE_LABEL_SCANNED");
  assert.ok(audit);
  noLeak(audit, [SN]);
});

/* ── Prepare Device ──────────────────────────────────────────────────────── */

test("a dry run plans without changing anything at the maker", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { base } = await runWithPhone(app, { serialNumber: SN });
  const r = await app.inject({ method: "POST", url: `${base}/prepare`, payload: { dryRun: true } });
  assert.equal(r.statusCode, 200, r.body);
  const out = body(r);
  assert.ok(out.plan.steps.some((s: any) => s.step === "claim"), JSON.stringify(out.plan));
  assert.deepEqual(out.ran, []);
  assert.equal(sim.addCalls, 0);
  assert.equal(sim.tasks.length, 0);
});

test("prepare registers the device, then refuses to restart one nobody has been assigned to", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app, { serialNumber: SN });
  const r = await app.inject({ method: "POST", url: `${base}/prepare`, payload: {} });
  assert.equal(r.statusCode, 200, r.body);
  const out = body(r);
  assert.equal(out.ran[0].step, "claim");
  assert.equal(out.ran[0].ok, true);
  const restart = out.ran.find((x: any) => x.step === "reboot");
  assert.ok(restart, JSON.stringify(out));
  assert.equal(restart.error, "needs_assignment");
  assert.equal(out.stoppedAt, "reboot");
  assert.equal(row.vendorCloudState, "managed");
  assert.equal(sim.tasks.length, 0, "no restart was sent");
});

test("prepare restarts an assigned, managed device through the maker's cloud and never calls it online", async () => {
  reset();
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "online", owner: "ours" });
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app);
  row.extNumber = "101"; row.extensionId = "e1";
  const out = body(await app.inject({ method: "POST", url: `${base}/prepare`, payload: {} }));
  const restart = out.ran.find((x: any) => x.step === "reboot");
  assert.ok(restart, JSON.stringify(out));
  assert.equal(restart.ok, true);
  assert.equal(restart.outcome, "accepted");
  assert.equal(sim.tasks.length, 1);
  assert.equal(sim.tasks[0].type, 1);
  assert.notEqual(out.phone.provisioningStatus, "online", "an accepted task is not a registration");
  assert.ok(state.audits.some((a: any) => a.action === "DESK_PHONE_PREPARE_STEP" && a.metadata.step === "reboot"));
});

test("prepare on a run that is no longer running reads 404", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { base, runId } = await runWithPhone(app, { serialNumber: SN });
  state.runs.find((r: any) => r.id === runId).status = "finished";
  const r = await app.inject({ method: "POST", url: `${base}/prepare`, payload: {} });
  assert.equal(r.statusCode, 404);
  assert.equal(sim.apiCalls.length, 0);
});

test("a device still locked to another provider that the cloud cannot re-point asks for hands, and nothing is sent", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { base } = await runWithPhone(app, { serialNumber: SN, provisioningUrl: "https://oldprovider.example/cfg/" });
  const out = body(await app.inject({ method: "POST", url: `${base}/prepare`, payload: {} }));
  assert.ok(out.plan.manualAction, JSON.stringify(out.plan));
  assert.equal(out.plan.resetNeeded, true);
  assert.deepEqual(out.ran, []);
  assert.equal(sim.addCalls, 0);
  assert.equal(sim.tasks.length, 0);
});

/* ── factory reset through the maker's cloud ─────────────────────────────── */

/** A maker cloud that can wipe but not restart — the only shape that plans a cloud reset. */
function resetOnlyRegistry() {
  const L = load();
  class ResetOnlyProvider extends L.GrandstreamProvider {
    async readiness() {
      const r = await super.readiness();
      return { ...r, supportedActions: r.supportedActions.filter((a: string) => a !== "reboot") };
    }
  }
  const Provider = ResetOnlyProvider as any;
  return registry({ provider: new Provider({ resolveCredentials: async () => sim.creds, request: sim.fetch, env: {} }) });
}

async function lockedManagedAssigned(app: any, approve: boolean) {
  const ctx = await runWithPhone(app, { provisioningUrl: "https://oldprovider.example/cfg/" });
  ctx.row.extNumber = "101"; ctx.row.extensionId = "e1";
  if (approve) {
    const a = await app.inject({ method: "POST", url: `/desk-phones/runs/${ctx.runId}/authorize-reset`, payload: { phoneIds: [ctx.row.id] } });
    assert.equal(a.statusCode, 200, a.body);
  }
  return ctx;
}

test("without the person's approval for THIS device, prepare plans no wipe and sends nothing", async () => {
  reset();
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "online", owner: "ours" });
  const app = await makeApp(CUSTOMER, { registry: resetOnlyRegistry() });
  const { base, row } = await lockedManagedAssigned(app, false);
  const out = body(await app.inject({ method: "POST", url: `${base}/prepare`, payload: {} }));
  assert.equal(out.plan.manualAction?.code, "reset_authorization_required", JSON.stringify(out.plan));
  assert.equal(sim.tasks.length, 0);
  assert.equal(row.resetCount, 0);
});

test("an approved wipe runs once, is counted, and the one reset is then spent", async () => {
  reset();
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "online", owner: "ours" });
  const app = await makeApp(CUSTOMER, { registry: resetOnlyRegistry() });
  const { base, row } = await lockedManagedAssigned(app, true);
  const out = body(await app.inject({ method: "POST", url: `${base}/prepare`, payload: {} }));
  const wipe = out.ran.find((x: any) => x.step === "factory_reset");
  assert.ok(wipe, JSON.stringify(out));
  assert.equal(wipe.ok, true);
  assert.equal(sim.tasks.length, 1);
  assert.equal(sim.tasks[0].type, 2);
  assert.equal(row.resetCount, 1);
  assert.equal(row.state, "WAITING_FOR_REBOOT");
  assert.equal(row.provisioningUrl, null);
  assert.ok(state.audits.some((a: any) => a.action === "DESK_PHONE_RESET_REQUESTED"));

  // The previous provider grabs it again: the one reset is already used.
  row.provisioningUrl = "https://oldprovider.example/cfg/";
  row.state = "RESET_AUTHORIZED";
  const again = body(await app.inject({ method: "POST", url: `${base}/prepare`, payload: {} }));
  const refused = again.ran.find((x: any) => x.step === "factory_reset");
  assert.ok(refused, JSON.stringify(again));
  assert.equal(refused.error, "reset_already_used");
  assert.equal(sim.tasks.length, 1, "never wiped twice");
});

test("two prepares racing on one approved device wipe it exactly once", async () => {
  reset();
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "online", owner: "ours" });
  const app = await makeApp(CUSTOMER, { registry: resetOnlyRegistry() });
  const { base, row } = await lockedManagedAssigned(app, true);
  await Promise.all([
    app.inject({ method: "POST", url: `${base}/prepare`, payload: {} }),
    app.inject({ method: "POST", url: `${base}/prepare`, payload: {} }),
    app.inject({ method: "POST", url: `${base}/prepare`, payload: {} }),
  ]);
  assert.equal(sim.tasks.filter((t: any) => t.type === 2).length, 1);
  assert.equal(row.resetCount, 1);
});

test("a wipe the maker refuses gives the reset back; no reset permission means nothing is touched", async () => {
  reset();
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "offline", owner: "ours" });
  const app = await makeApp(CUSTOMER, { registry: resetOnlyRegistry() });
  const { base, row } = await lockedManagedAssigned(app, true);
  const out = body(await app.inject({ method: "POST", url: `${base}/prepare`, payload: {} }));
  const wipe = out.ran.find((x: any) => x.step === "factory_reset");
  assert.equal(wipe?.error, "device_offline", JSON.stringify(out));
  assert.equal(row.resetCount, 0, "nothing reached the device, so the reset is not spent");
  assert.equal(sim.tasks.length, 0);

  allowReset = false;
  const denied = await app.inject({ method: "POST", url: `${base}/prepare`, payload: {} });
  assert.equal(denied.statusCode, 403);
  assert.equal(sim.tasks.length, 0);
});

/* ── Loopcom staff: GDMS credentials ─────────────────────────────────────── */

test("the GDMS credential screens are staff-only and never hand a value back", async () => {
  reset();
  const restore = withEnv({
    CREDENTIALS_MASTER_KEY: undefined, GDMS_MODE: undefined,
    GDMS_REGION: "us", GDMS_API_ID: sim.creds.apiId, GDMS_SECRET_KEY: sim.creds.secretKey,
    GDMS_USERNAME: sim.creds.username, GDMS_PASSWORD: sim.creds.password,
  });
  try {
    load().clearGdmsCredentialsCache();
    const customer = await makeApp(CUSTOMER);
    for (const [method, url] of [
      ["GET", "/admin/desk-phones/gdms-credentials"],
      ["POST", "/admin/desk-phones/gdms-credentials"],
      ["POST", "/admin/desk-phones/gdms-credentials/verify"],
    ]) {
      const r = await customer.inject({ method: method as any, url, payload: method === "POST" ? {} : undefined });
      assert.equal(r.statusCode, 403, url);
    }

    const staff = await makeApp(STAFF);
    const secrets = [sim.creds.apiId, sim.creds.secretKey, sim.creds.password];
    const described = await staff.inject({ method: "GET", url: "/admin/desk-phones/gdms-credentials" });
    assert.equal(described.statusCode, 200);
    assert.equal(body(described).credentials.configured, true);
    noLeak(described.body, secrets);

    const invalid = await staff.inject({ method: "POST", url: "/admin/desk-phones/gdms-credentials", payload: { region: "us", apiId: "abcd1234", secretKey: "secretkey-12345678", username: "ops@loopcom.net" } });
    assert.equal(invalid.statusCode, 400);
    assert.match(body(invalid).message, /password/i);

    const saved = await staff.inject({
      method: "POST", url: "/admin/desk-phones/gdms-credentials",
      payload: { region: "us", apiId: "abcd1234", secretKey: "secretkey-12345678", username: "ops@loopcom.net", password: "hunter2-not-real" },
    });
    assert.ok([200, 503].includes(saved.statusCode), saved.body);
    if (saved.statusCode === 503) assert.equal(body(saved).error, "credentials_master_key_missing");
    noLeak(saved.body, ["hunter2-not-real", "secretkey-12345678"]);

    load().clearGdmsCredentialsCache();
    const verified = await staff.inject({ method: "POST", url: "/admin/desk-phones/gdms-credentials/verify", payload: {} });
    assert.equal(verified.statusCode, 200, verified.body);
    assert.equal(body(verified).organizations, 1);
    noLeak(verified.body, secrets);
    assert.ok(state.audits.some((a: any) => a.action === "GDMS_CREDENTIALS_VERIFIED"));
    noLeak(state.audits, [...secrets, "hunter2-not-real", "secretkey-12345678"]);
  } finally {
    restore();
    load().clearGdmsCredentialsCache();
  }
});

test("verifying refuses a simulated GDMS selected at runtime", async () => {
  reset();
  const restore = withEnv({ GDMS_MODE: "test" });
  try {
    const staff = await makeApp(STAFF);
    const r = await staff.inject({ method: "POST", url: "/admin/desk-phones/gdms-credentials/verify", payload: {} });
    assert.equal(r.statusCode, 409);
    assert.equal(body(r).error, "gdms_mock_not_allowed_in_runtime");
  } finally {
    restore();
  }
});
