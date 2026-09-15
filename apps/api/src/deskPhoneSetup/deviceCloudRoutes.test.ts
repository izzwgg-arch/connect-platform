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

const state: any = {
  runs: [], phones: [], extensions: [], tenants: [], audits: [], managed: [],
  // The customer's scan links — one live per run; minting again revokes the last.
  scanTokens: [],
  // "Text me a photo of the label": the tenant's own texting numbers, and the chat a picture
  // arrives in. Seeded per test — empty means "this customer has no number that takes photos".
  smsNumbers: [], threads: [], messages: [],
};
let seq = 0;
const nextId = (p: string) => `${p}_${++seq}`;

const same = (a: any, b: any) => (a ?? null) === (b ?? null);
const matches = (row: any, where: any): boolean =>
  Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return (v as any).in.includes(row[k]);
      if ("not" in v) return !same(row[k], (v as any).not);
      // ⛔⛔ DATES MUST REALLY COMPARE. "Only a picture that arrived AFTER we asked" is a `gte`
      // filter, and it is the whole reason an older photo already sitting in a customer's thread
      // cannot be mistaken for the answer to this question. A fake that waved every object filter
      // through would pass that test while the real query did the opposite — the test would be
      // proving nothing and saying it proved something.
      if ("gte" in v || "gt" in v || "lte" in v || "lt" in v) {
        if (row[k] === null || row[k] === undefined) return false;
        const at = new Date(row[k]).getTime();
        if ("gte" in v && at < new Date((v as any).gte).getTime()) return false;
        if ("gt" in v && at <= new Date((v as any).gt).getTime()) return false;
        if ("lte" in v && at > new Date((v as any).lte).getTime()) return false;
        if ("lt" in v && at >= new Date((v as any).lt).getTime()) return false;
        return true;
      }
      return true;
    }
    return same(row[k], v);
  });

/**
 * Prisma's atomic number ops. ⛔ Without this a `{ increment: 1 }` write lands the
 * OBJECT in the column, so a counter silently becomes garbage and any assertion on it
 * tests the fake instead of the code.
 */
function applyAtomics(row: any, data: any): any {
  const out: any = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v && typeof v === "object" && !(v instanceof Date) && "increment" in (v as any)) {
      out[k] = Number(row?.[k] ?? 0) + Number((v as any).increment);
    } else out[k] = v;
  }
  return out;
}

function table(bucket: string, defaults: () => any) {
  return {
    findFirst: async ({ where }: any = {}) => state[bucket].find((r: any) => matches(r, where)) ?? null,
    // ⛔ The real client HAS findUnique on a unique column and production code uses it —
    // the scan link is looked up by its token HASH, which is the unique index. A fake
    // without it would throw in tests on a route that works in production, i.e. the fake
    // would be the only thing failing. The fake follows reality, never the other way.
    findUnique: async ({ where }: any = {}) => state[bucket].find((r: any) => matches(r, where)) ?? null,
    findMany: async ({ where }: any = {}) => state[bucket].filter((r: any) => matches(r, where)),
    create: async ({ data }: any) => { const row = { ...defaults(), ...data }; state[bucket].push(row); return row; },
    update: async ({ where, data }: any) => {
      const row = state[bucket].find((r: any) => r.id === where.id);
      Object.assign(row, applyAtomics(row, data)); return row;
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
    labelPhotoFromE164: null, labelPhotoAskedAt: null,
  })),
  extension: table("extensions", () => ({ id: nextId("ext"), status: "ACTIVE" })),
  tenant: table("tenants", () => ({ id: nextId("t") })),
  managedDeskPhone: table("managed", () => ({ id: nextId("mdp"), retiredAt: null })),
  deskPhoneScanToken: table("scanTokens", () => ({
    id: nextId("tok"), scanCount: 0, revokedAt: null, expiresAt: null,
    firstOpenedAt: null, lastUsedAt: null, createdAt: new Date(), updatedAt: new Date(),
  })),
  tenantSmsNumber: table("smsNumbers", () => ({
    id: nextId("num"), active: true, smsCapable: true, mmsCapable: true, isTenantDefault: false, createdAt: new Date(),
  })),
  connectChatThread: table("threads", () => ({ id: nextId("thr"), lastMessageAt: new Date() })),
  connectChatMessage: table("messages", () => ({ id: nextId("msg"), createdAt: new Date(), attachments: [] })),
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

/**
 * ⛔⛔ THE OCR ENGINE IS FAKED, ON PURPOSE. Two reasons, both about what is actually under test:
 * a WASM engine in a unit suite is slow, needs a language download, and turns a logic test into
 * an image-quality lottery — and "is this picture sharp enough to trust a serial from?" is OUR
 * decision, not Tesseract's. Faking what the engine SAW is what makes that decision testable.
 * `ocrEnabled` mirrors the CRM_OCR_ENABLED switch; `ocrNext` is what it "read" (null = it threw).
 */
class OcrLimitErrorStub extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = "OcrLimitError"; this.code = code; }
}
let ocrEnabled = true;
let ocrNext: { text: string; confidence: number } | null = { text: "", confidence: 92 };
/** Scripted multi-pass readings (one per rotation attempt; null = that pass threw). When unset,
 *  the adaptive reader sees the single `ocrNext` pass — old tests keep their exact behavior. */
let ocrPassList: Array<{ text: string; confidence: number } | null> | null = null;
mock.module("../crm/docOcrProvider", {
  namedExports: {
    OcrLimitError: OcrLimitErrorStub,
    loadOcrConfig: () => ({
      enabled: ocrEnabled, maxFileBytes: 10 * 1024 * 1024, provider: "tesseract_js", lang: "eng", langPath: undefined,
    }),
    getOcrProvider: (cfg: any) => (cfg?.enabled
      ? {
        name: "tesseract_js",
        supports: (m: string) => String(m ?? "").startsWith("image/"),
        extractText: async () => {
          if (!ocrNext) throw new Error("engine failed");
          return { text: ocrNext.text, confidence: ocrNext.confidence, pageCount: 1, metadata: {} };
        },
      }
      : null),
    // Mirrors the real semantics: first pass the caller approves wins; otherwise the
    // best-confidence pass is returned; a throwing pass is skipped; all-throw throws.
    extractTextAdaptive: async (_p: any, _i: any, _c: any, isAcceptable: (t: string, c: number) => boolean) => {
      const passes = ocrPassList ?? [ocrNext];
      let best: any = null;
      let lastErr: unknown = null;
      let ran = 0;
      for (const p of passes) {
        ran++;
        if (!p) { lastErr = new Error("engine failed"); continue; }
        if (isAcceptable(p.text, p.confidence)) return { text: p.text, confidence: p.confidence, pass: `p${ran}`, passesRun: ran };
        if (!best || p.confidence > best.confidence) best = { text: p.text, confidence: p.confidence, pass: `p${ran}` };
      }
      if (!best) throw lastErr ?? new Error("no pass");
      return { ...best, passesRun: ran };
    },
    assertOcrSizeLimit: (buf: Buffer, cfg: any) => {
      if (buf.length > cfg.maxFileBytes) throw new OcrLimitErrorStub("ocr_file_too_large", "too large");
    },
    resolveImageMime: (mime: string, fileName: string) => {
      const m = String(mime ?? "").toLowerCase();
      if (m.startsWith("image/")) return m;
      return /\.(jpe?g)$/i.test(String(fileName ?? "")) ? "image/jpeg" : "";
    },
  },
});

/** The bytes behind a texted picture. null = the file is gone from storage. */
let attachmentBytes: Buffer | null = Buffer.from("not-a-real-jpeg");
mock.module("../chatAttachmentStorage", {
  namedExports: { readChatAttachmentBuffer: async () => attachmentBytes },
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
const FOLDER = "https://m.connectcomunications.com/phoneprov/0123456789abcdef/";
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
  // ⛔ The faked engine is part of the fixture: a test that left OCR switched off, or left a
  // blurry reading behind, would silently change the meaning of every test after it.
  ocrEnabled = true; ocrNext = { text: "", confidence: 92 }; ocrPassList = null; attachmentBytes = Buffer.from("not-a-real-jpeg");
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

async function makeApp(user: any, opts: { registry?: any; renderConfig?: any } = {}) {
  const app = Fastify();
  // ⛔ Registered here because it is registered globally in server.ts — the photo door reads
  // `req.isMultipart()`, so a test app without it would answer "multipart_required" to a perfectly
  // good upload and the suite would be testing a server that does not exist.
  const multipart = require("@fastify/multipart");
  await app.register(multipart.default ?? multipart);
  app.addHook("preHandler", async (req: any) => { req.user = user; });
  await load().routes(app as any, {
    audit: async (p: any) => { state.audits.push(p); },
    ourProvisioningHosts: () => ["loopcom.net", "m.connectcomunications.com"],
    isRegistered: async (_t: string, ext: string) => registered.has(ext),
    deviceProviders: opts.registry ?? registry(),
    withMacLock: sharedLock,
    gdmsRequest: sim.fetch,
    provisioningUrlFor: async () => FOLDER,
    // The clean per-model template's rendered config (stubbed; the real one fetches cfg<mac>.xml).
    renderDeviceConfig: opts.renderConfig ?? (async () =>
      "<?xml version=\"1.0\"?><gs_provision version=\"1\"><config version=\"1\"><P47>209.145.60.79</P47></config></gs_provision>"),
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
    // ⛔ The three doors added 2026-09-14 are held to the SAME rule: a stranger who guessed the
    // run id reads 404, never a 400 about multipart or a 409 about which number to text from —
    // either of which would confirm the run exists. `ownRun` runs before every other check.
    ["POST", `${base}/label-photo`, {}],
    ["POST", `${base}/label-photo/expect`, { fromNumber: "845-555-0112" }],
    ["POST", `${base}/label-photo/check`, {}],
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

test("a refused serial whose embedded MAC tail names a DIFFERENT handset tells the customer they mixed up the labels", async () => {
  reset();
  // Izzy, 2026-09-15, after doing exactly this twice: "we need to let the user know that
  // they mixed up the serial numbers." GDMS's registry knows this phone's true serial; the
  // customer typed the OTHER unit's (tail 8C654E vs this phone's …8C605F). The maker
  // refuses the pair AND the tail points elsewhere — two agreeing signals.
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "online", owner: "unowned" });
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app);
  const r = await app.inject({ method: "POST", url: `${base}/claim`, payload: { serialNumber: "20EZ115N308C654E" } });
  assert.equal(r.statusCode, 409, r.body);
  const out = body(r);
  assert.equal(out.error, "serial_for_different_device");
  assert.ok(String(out.message ?? "").includes("different phone"), r.body);
  assert.ok(!("possibleOwnershipConflict" in out) || !out.possibleOwnershipConflict);
  assert.notEqual(row.vendorCloudState, "managed");
});

test("the tail heuristic never refuses on its own — when the maker accepts, a mismatched tail is nobody's business", async () => {
  reset();
  // The convention is observed, not documented: a phone whose serial breaks it must never
  // lock its own owner out. No seed = the sim's registry has no opinion; the add lands.
  const app = await makeApp(CUSTOMER);
  const { base } = await runWithPhone(app);
  const r = await app.inject({ method: "POST", url: `${base}/claim`, payload: { serialNumber: "20EZ115N30FFFFFF" } });
  assert.equal(r.statusCode, 200, r.body);
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

/** Ticking the phone on the pick screen — the consent to clear it (reset-first). */
async function tick(app: any, runId: string, phoneIds: string[]) {
  const r = await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/selection`, payload: { phoneIds } });
  assert.equal(r.statusCode, 200, r.body);
}

test("an UNTICKED phone is not touched at the maker at all — reset-first needs the tick", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { base } = await runWithPhone(app, { serialNumber: SN });
  const out = body(await app.inject({ method: "POST", url: `${base}/prepare`, payload: {} }));
  assert.equal(out.plan.manualAction?.code, "reset_authorization_required", JSON.stringify(out.plan));
  assert.deepEqual(out.ran, []);
  assert.equal(sim.addCalls, 0);
  assert.equal(sim.tasks.length, 0);
});

test("prepare registers a ticked device, then refuses to clear one nobody has been assigned to", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { base, row, runId } = await runWithPhone(app, { serialNumber: SN });
  await tick(app, runId, [row.id]);
  const r = await app.inject({ method: "POST", url: `${base}/prepare`, payload: {} });
  assert.equal(r.statusCode, 200, r.body);
  const out = body(r);
  assert.equal(out.ran[0].step, "claim");
  assert.equal(out.ran[0].ok, true);
  const wipe = out.ran.find((x: any) => x.step === "factory_reset");
  assert.ok(wipe, JSON.stringify(out));
  assert.equal(wipe.error, "needs_assignment");
  assert.equal(out.stoppedAt, "factory_reset");
  assert.equal(row.vendorCloudState, "managed");
  assert.equal(row.resetCount, 0);
  assert.equal(sim.tasks.length, 0, "nothing was sent to the phone");
});

test("RESET FIRST: a ticked, assigned phone is cleared first; its restart waits for the next prepare; never called online", async () => {
  reset();
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "online", owner: "ours" });
  const app = await makeApp(CUSTOMER);
  const { base, row, runId } = await runWithPhone(app);
  row.extNumber = "101"; row.extensionId = "e1";
  await tick(app, runId, [row.id]);

  const first = body(await app.inject({ method: "POST", url: `${base}/prepare`, payload: {} }));
  assert.deepEqual(first.ran.map((x: any) => x.step), ["factory_reset"], JSON.stringify(first));
  assert.equal(first.ran[0].ok, true);
  assert.equal(sim.tasks.length, 1);
  assert.equal(sim.tasks[0].type, 2, "the first thing sent is the reset");
  assert.ok(first.leftForOthers.includes("reboot"), JSON.stringify(first.leftForOthers));
  assert.equal(row.resetCount, 1);
  assert.equal(row.state, "WAITING_FOR_REBOOT");

  // Back online after the wipe: the restart goes, and no second reset.
  const second = body(await app.inject({ method: "POST", url: `${base}/prepare`, payload: {} }));
  assert.ok(!second.ran.some((x: any) => x.step === "factory_reset"), JSON.stringify(second));
  const restart = second.ran.find((x: any) => x.step === "reboot");
  assert.ok(restart, JSON.stringify(second));
  assert.equal(restart.ok, true);
  assert.equal(restart.outcome, "accepted");
  assert.equal(sim.tasks.length, 2);
  assert.equal(sim.tasks[1].type, 1);
  assert.equal(row.resetCount, 1, "never cleared twice");
  assert.notEqual(second.phone.provisioningStatus, "online", "an accepted task is not a registration");
  assert.ok(state.audits.some((a: any) => a.action === "DESK_PHONE_PREPARE_STEP" && a.metadata.step === "reboot"));
});

test("SEND: a managed Grandstream gets its config pushed over the cloud — the delivery that reaches a claimed phone", async () => {
  // The 2026-09-15 wall's other half: a GDMS-claimed phone never hears PnP multicast and ignores an
  // HTTP config write, so the config must be SENT through GDMS. Once the device is managed, /prepare
  // renders the (now clean per-model) config and pushes it; the reboot makes the phone apply it.
  reset();
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "online", owner: "ours" });
  const app = await makeApp(CUSTOMER);
  const { base, row, runId } = await runWithPhone(app);
  row.extNumber = "101"; row.extensionId = "e1"; row.resetCount = 1; // reset already done → no wipe this run
  await tick(app, runId, [row.id]);
  const out = body(await app.inject({ method: "POST", url: `${base}/prepare`, payload: {} }));
  assert.equal(sim.pushedConfigs.get(MAC12), "<?xml version=\"1.0\"?><gs_provision version=\"1\"><config version=\"1\"><P47>209.145.60.79</P47></config></gs_provision>", "the rendered config reached GDMS: " + JSON.stringify(out.ran));
  assert.ok(out.ran.some((x: any) => x.step === "reprovision" && x.ok), "a reprovision (cloud send) step ran: " + JSON.stringify(out.ran));
  assert.ok(state.audits.some((a: any) => a.action === "DESK_PHONE_PREPARE_STEP" && a.metadata.step === "reprovision"));
});

test("SEND is skipped when there is no rendered config (never pushes an empty send)", async () => {
  reset();
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "online", owner: "ours" });
  const app = await makeApp(CUSTOMER, { renderConfig: async () => null });
  const { base, row, runId } = await runWithPhone(app);
  row.extNumber = "101"; row.extensionId = "e1"; row.resetCount = 1;
  await tick(app, runId, [row.id]);
  const out = body(await app.inject({ method: "POST", url: `${base}/prepare`, payload: {} }));
  assert.equal(sim.configPushCalls, 0, "nothing pushed when there is no config to send");
  assert.ok(!out.ran.some((x: any) => x.step === "reprovision"), JSON.stringify(out.ran));
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

test("an unticked device still locked to another provider waits for the tick, and nothing is sent", async () => {
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

/* ── the wizard's ladder names the mechanism per brand ───────────────────── */

async function tickedAssigned(app: any, phone: Record<string, unknown> = {}) {
  const ctx = await runWithPhone(app, phone);
  ctx.row.extNumber = "101"; ctx.row.extensionId = "e1";
  await tick(app, ctx.runId, [ctx.row.id]);
  return ctx;
}
const advance = async (app: any, base: string) =>
  body(await app.inject({ method: "POST", url: `${base}/advance`, payload: { reachableOnLan: true } }));

test("a ticked Grandstream is cleared THROUGH GDMS from its serial — the password route is not taken when the cloud is connected", async () => {
  reset();
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "online", owner: "ours" });
  const app = await makeApp(CUSTOMER);
  const { base } = await tickedAssigned(app);
  const out = await advance(app, base);
  assert.equal(out.action, "reset_over_lan", JSON.stringify(out));
  assert.equal(out.via, "vendor_cloud", "the serial route, so nobody is asked for a password");
  assert.equal(out.provisioningUrl, FOLDER, "the office machine listens before the wipe");
  assert.equal(sim.tasks.length, 0, "/advance decides only — the wipe itself runs through /prepare");
});

test("the same Grandstream without a connected cloud is cleared over the LAN too", async () => {
  reset();
  const app = await makeApp(CUSTOMER, { registry: registry({ unconfigured: true }) });
  const { base } = await tickedAssigned(app);
  const out = await advance(app, base);
  assert.equal(out.action, "reset_over_lan");
  assert.equal(out.via, undefined);
});

test("a Yealink is cleared over the LAN and never sent to a maker cloud", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { base } = await tickedAssigned(app, { mac: "80:5E:C0:B3:B2:D0", vendor: "Yealink", model: "T42S" });
  const out = await advance(app, base);
  assert.equal(out.action, "reset_over_lan");
  assert.equal(out.via, undefined);
});

test("once its reset is spent, a Grandstream is handed its folder and restarted over the LAN", async () => {
  reset();
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "online", owner: "ours" });
  const app = await makeApp(CUSTOMER);
  const { base, row } = await tickedAssigned(app);
  row.resetCount = 1;
  const out = await advance(app, base);
  assert.equal(out.action, "set_provisioning", JSON.stringify(out));
  assert.equal(out.via, undefined);
  assert.equal(out.provisioningUrl, FOLDER);
});

test("⛔ no password: the phone is NOT abandoned — the maker's cloud route is offered so the wizard can ask for the serial", async () => {
  reset();
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "online", owner: "ours" });
  const app = await makeApp(CUSTOMER);
  const { base } = await tickedAssigned(app);
  const out = body(await app.inject({
    method: "POST", url: `${base}/advance`,
    payload: { reachableOnLan: true, locked: true, defaultCredentialsTried: true, passwordUnavailable: true },
  }));
  assert.equal(out.action, "reset_over_lan", JSON.stringify(out));
  assert.equal(out.via, "vendor_cloud", "the second door: clear it through the maker's cloud");
  assert.equal(out.provisioningUrl, FOLDER, "the office machine listens before the wipe");
  assert.equal(out.halted, false);
});

test("⛔ no password AND no serial: both doors shut, so the phone ends honestly at hands-on", async () => {
  reset();
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "online", owner: "ours" });
  const app = await makeApp(CUSTOMER);
  const { base } = await tickedAssigned(app);
  const out = body(await app.inject({
    method: "POST", url: `${base}/advance`,
    payload: {
      reachableOnLan: true, locked: true, defaultCredentialsTried: true,
      passwordUnavailable: true, makerCloudUnavailable: true,
    },
  }));
  assert.equal(out.via, undefined, "no second door is offered once the serial is refused too");
  assert.equal(out.halted, true);
  assert.match(String(out.customerMessage), /by hand|Support/i);
});

test("with a cloud that cannot wipe, no password still ends at hands-on (no false promise)", async () => {
  reset();
  const app = await makeApp(CUSTOMER, { registry: registry({ unconfigured: true }) });
  const { base } = await tickedAssigned(app);
  const out = body(await app.inject({
    method: "POST", url: `${base}/advance`,
    payload: { reachableOnLan: true, locked: true, defaultCredentialsTried: true, passwordUnavailable: true },
  }));
  assert.equal(out.via, undefined);
  assert.equal(out.halted, true);
});

test("an unticked Grandstream is never given a mechanism at all", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { base, row, runId } = await tickedAssigned(app);
  await tick(app, runId, []);
  const out = await advance(app, base);
  assert.equal(out.action, "do_nothing");
  assert.equal(out.skipped, true);
  assert.equal(out.via, undefined);
  assert.equal(row.resetCount, 0);
});

/* ── factory reset through the maker's cloud ─────────────────────────────── */

/** A maker cloud that can wipe but not restart — keeps the reset the only cloud step. */
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
  if (approve) await tick(app, ctx.runId, [ctx.row.id]);
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

  // The previous provider grabs it again: the one reset is already used, so none is planned.
  row.provisioningUrl = "https://oldprovider.example/cfg/";
  row.state = "RESET_AUTHORIZED";
  const again = body(await app.inject({ method: "POST", url: `${base}/prepare`, payload: {} }));
  assert.ok(!again.plan.steps.some((s: any) => s.step === "factory_reset"), JSON.stringify(again.plan));
  assert.ok(!again.ran.some((x: any) => x.step === "factory_reset"), JSON.stringify(again));
  assert.equal(sim.tasks.length, 1, "never wiped twice");
  assert.equal(row.resetCount, 1);
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

test("a wipe the maker refuses gives the reset back; unticking the phone means nothing is touched", async () => {
  reset();
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "offline", owner: "ours" });
  const app = await makeApp(CUSTOMER, { registry: resetOnlyRegistry() });
  const { base, row, runId } = await lockedManagedAssigned(app, true);
  const out = body(await app.inject({ method: "POST", url: `${base}/prepare`, payload: {} }));
  const wipe = out.ran.find((x: any) => x.step === "factory_reset");
  assert.equal(wipe?.error, "device_offline", JSON.stringify(out));
  assert.equal(row.resetCount, 0, "nothing reached the device, so the reset is not spent");
  assert.equal(sim.tasks.length, 0);

  await tick(app, runId, []);
  const denied = await app.inject({ method: "POST", url: `${base}/prepare`, payload: {} });
  assert.equal(denied.statusCode, 409);
  assert.equal(body(denied).error, "phone_not_in_setup");
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
      ["POST", "/admin/desk-phones/gdms-credentials/lookup"],
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

    // The read-only device lookup: finds a seeded device, changes nothing at GDMS.
    sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "online", owner: "ours" });
    const addsBefore = sim.addCalls;
    const tasksBefore = sim.tasks.length;
    const badMac = await staff.inject({ method: "POST", url: "/admin/desk-phones/gdms-credentials/lookup", payload: { mac: "nope" } });
    assert.equal(badMac.statusCode, 400);
    const looked = await staff.inject({ method: "POST", url: "/admin/desk-phones/gdms-credentials/lookup", payload: { mac: MAC } });
    assert.equal(looked.statusCode, 200, looked.body);
    assert.equal(body(looked).found, true);
    assert.match(String(body(looked).device.model), /GXP2170/);
    noLeak(looked.body, [SN, ...secrets]);
    const missing = await staff.inject({ method: "POST", url: "/admin/desk-phones/gdms-credentials/lookup", payload: { mac: "80:5E:0C:BD:13:5A" } });
    assert.equal(missing.statusCode, 200, missing.body);
    assert.equal(body(missing).found, false);
    assert.equal(sim.addCalls, addsBefore, "a lookup never adds");
    assert.equal(sim.tasks.length, tasksBefore, "a lookup never restarts or resets");
    assert.ok(state.audits.some((a: any) => a.action === "GDMS_DEVICE_LOOKUP"));
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

/* ── the label as a PHOTO: uploaded, or texted in ────────────────────────── */

/** One file in a multipart body, shaped the way a browser sends it. */
function photoUpload(fileName = "label.jpg", mime = "image/jpeg", bytes = "pretend-jpeg-bytes") {
  const boundary = "----deskphonetestboundary";
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
const upload = async (app: any, base: string, file = photoUpload()) =>
  app.inject({ method: "POST", url: `${base}/label-photo`, payload: file.payload, headers: file.headers });

/** The tenant's own number that can receive pictures. */
function seedTextingNumber(e164 = "+18455550112", over: Record<string, unknown> = {}) {
  state.smsNumbers.push({
    id: nextId("num"), tenantId: "t_abc", phoneE164: e164, active: true,
    smsCapable: true, mmsCapable: true, isTenantDefault: true, createdAt: new Date(), ...over,
  });
}

/** A picture sitting in the chat from `from`, at `at`. */
function seedTextedPhoto(from: string, at: Date, over: Record<string, unknown> = {}) {
  const threadId = nextId("thr");
  state.threads.push({ id: threadId, tenantId: "t_abc", externalSmsE164: from, lastMessageAt: at });
  state.messages.push({
    id: nextId("msg"), tenantId: "t_abc", threadId, direction: "INBOUND", createdAt: at,
    attachments: [{ storageKey: "k_1", mimeType: "image/jpeg", mediaKind: "image", fileName: "label.jpg" }],
    ...over,
  });
}

test("a clear photo of the label names the phone and stores its serial — no password, no typing", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app);
  ocrNext = { text: `Grandstream GXP2170 MAC: ${MAC12.toUpperCase()} S/N: ${SN}`, confidence: 91 };
  const r = await upload(app, base);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(body(r).found.serialFound, true);
  assert.equal(row.serialNumber, SN);
  assert.ok(row.identityEvidence.some((e: any) => e.source === "barcode_label"));
  const audit = state.audits.find((a: any) => a.action === "DESK_PHONE_LABEL_SCANNED");
  assert.equal(audit.metadata.via, "photo");
  assert.equal(audit.metadata.photoConfidence, 91);
  // ⛔ The audit carries the READING, never the text OCR pulled off the picture.
  noLeak(audit, [SN, "GXP2170 MAC"]);
});

test("a SIDEWAYS photo is read on a later rotation pass — the first garbage reading is not the verdict", async () => {
  reset();
  // Izzy, 2026-09-15: "It wasn't such an unclear photo. It should have been able to read it."
  // A phone photo is routinely rotated (EXIF is ignored by the engine), so the raw-pixel pass
  // reads garbage; the quarter-turn pass reads the label fine. The gate's rules are unchanged —
  // the rotation loop only picks WHICH reading to judge.
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app);
  ocrPassList = [
    { text: "~~|||~ ..", confidence: 12 },
    { text: `Grandstream GXP2170 MAC: ${MAC12.toUpperCase()} S/N: ${SN}`, confidence: 88 },
  ];
  const r = await upload(app, base);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(row.serialNumber, SN);
  const audit = state.audits.find((a: any) => a.action === "DESK_PHONE_LABEL_SCANNED");
  assert.equal(audit.metadata.photoPassesRun, 2);
  assert.equal(audit.metadata.photoConfidence, 88, "the accepted pass's reading is what is recorded");
});

test("when every rotation reads badly the refusal stands, and the audit says what was tried", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app);
  ocrPassList = [
    { text: "~~", confidence: 9 },
    { text: `S/N: ${SN}`, confidence: 31 },
    { text: "..", confidence: 4 },
  ];
  const r = await upload(app, base);
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(body(r).error, "photo_unreadable");
  assert.equal(row.serialNumber, null, "a serial we cannot vouch for is never stored");
  const audit = state.audits.find((a: any) => a.action === "DESK_PHONE_LABEL_PHOTO_REFUSED");
  assert.ok(audit, "a refused photo is auditable now");
  assert.equal(audit.metadata.photoConfidence, 31, "the best pass is the one judged");
  assert.equal(audit.metadata.photoPassesRun, 3);
  noLeak(audit, [SN]);
});

test("⛔ a BLURRY photo is refused and stores nothing — the customer is asked for a clearer one", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app);
  // Low confidence, and nothing on it corroborates that the read came out clean.
  ocrNext = { text: `S/N: ${SN}`, confidence: 21 };
  const r = await upload(app, base);
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(body(r).error, "photo_unreadable");
  assert.match(String(body(r).message), /clear|sharp|another one/i);
  assert.equal(row.serialNumber, null, "a serial we cannot vouch for is never stored");
});

test("a soft photo IS accepted when the address on it matches this very phone", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app);
  // ⛔ The corroboration rule: the sticker's own hardware address matching THIS handset is what
  // proves the read came out clean, so a soft picture is still trusted when it does.
  ocrNext = { text: `MAC ${MAC12.toUpperCase()} S/N: ${SN}`, confidence: 38 };
  const r = await upload(app, base);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(row.serialNumber, SN);
});

test("⛔ a photo of ANOTHER phone's label: refused as the wrong device when read clearly, as unreadable when not", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app);

  ocrNext = { text: `MAC: 805E0CBD135A S/N: ABCDE12345`, confidence: 88 };
  const clear = await upload(app, base);
  assert.equal(clear.statusCode, 409, clear.body);
  assert.equal(body(clear).error, "label_for_different_device");

  // ⛔ The SAME mismatch read badly must NOT accuse them of holding the wrong phone — on a soft
  // picture the address is the first thing OCR mangles, and "that's a different device" is an
  // accusation somebody holding the right handset cannot argue with.
  ocrNext = { text: `MAC: 805E0CBD135A S/N: ABCDE12345`, confidence: 19 };
  const soft = await upload(app, base);
  assert.equal(soft.statusCode, 400, soft.body);
  assert.equal(body(soft).error, "photo_unreadable");
  assert.equal(row.serialNumber, null);
});

test("with photo reading switched off the wizard says so plainly and stores nothing", async () => {
  reset();
  ocrEnabled = false;
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app);
  const r = await upload(app, base);
  assert.equal(r.statusCode, 503, r.body);
  assert.equal(body(r).error, "photo_reading_off");
  assert.match(String(body(r).message), /type the serial/i);
  assert.equal(row.serialNumber, null);
});

test("texting it in: we say where to send it, and remember which number it comes from", async () => {
  reset();
  seedTextingNumber();
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app);
  const r = await app.inject({
    method: "POST", url: `${base}/label-photo/expect`, payload: { fromNumber: "(845) 555-9999" },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.match(String(body(r).textTo), /\(845\) 555-0112/);
  assert.equal(row.labelPhotoFromE164, "+18455559999", "stored normalised, so the lookup can match it");
  assert.ok(row.labelPhotoAskedAt instanceof Date);

  const bad = await app.inject({ method: "POST", url: `${base}/label-photo/expect`, payload: { fromNumber: "nope" } });
  assert.equal(bad.statusCode, 400);
  assert.equal(body(bad).error, "bad_number");
});

test("⛔ no number of ours can receive pictures: say so, rather than send them texting into a hole", async () => {
  reset();
  seedTextingNumber("+18455550112", { mmsCapable: false });
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app);
  const r = await app.inject({ method: "POST", url: `${base}/label-photo/expect`, payload: { fromNumber: "8455559999" } });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(body(r).error, "no_texting_number");
  assert.match(String(body(r).message), /type the serial|upload/i);
  assert.equal(row.labelPhotoFromE164, null);
});

test("checking before anyone was asked is refused, not answered with a shrug", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { base } = await runWithPhone(app);
  const r = await app.inject({ method: "POST", url: `${base}/label-photo/check`, payload: {} });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(body(r).error, "not_expecting_a_photo");
});

test("the texted photo is read once, the serial lands, and we stop looking", async () => {
  reset();
  seedTextingNumber();
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app);
  await app.inject({ method: "POST", url: `${base}/label-photo/expect`, payload: { fromNumber: "8455559999" } });

  const nothingYet = body(await app.inject({ method: "POST", url: `${base}/label-photo/check`, payload: {} }));
  assert.equal(nothingYet.waiting, true, "not an error — it simply has not arrived");

  seedTextedPhoto("+18455559999", new Date(Date.now() + 1000));
  ocrNext = { text: `GXP2170 MAC ${MAC12.toUpperCase()} S/N: ${SN}`, confidence: 87 };
  const r = await app.inject({ method: "POST", url: `${base}/label-photo/check`, payload: {} });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(row.serialNumber, SN);
  assert.equal(row.labelPhotoFromE164, null, "read and accepted — a later picture is not pulled in");
  assert.equal(row.labelPhotoAskedAt, null);
  assert.ok(state.audits.some((a: any) => a.action === "DESK_PHONE_LABEL_SCANNED" && a.metadata.via === "texted_photo"));
});

test("⛔ a picture that was ALREADY in the thread, or came from another number, is never used", async () => {
  reset();
  seedTextingNumber();
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app);

  // Sent an hour before anybody was asked — a photo of something else entirely.
  seedTextedPhoto("+18455559999", new Date(Date.now() - 3_600_000));
  // And a picture from a different phone altogether.
  seedTextedPhoto("+18455551234", new Date(Date.now() + 1000));
  await app.inject({ method: "POST", url: `${base}/label-photo/expect`, payload: { fromNumber: "8455559999" } });
  ocrNext = { text: `S/N: ${SN}`, confidence: 95 };

  const r = body(await app.inject({ method: "POST", url: `${base}/label-photo/check`, payload: {} }));
  assert.equal(r.waiting, true, "the old photo and the stranger's photo are both invisible to this");
  assert.equal(row.serialNumber, null);
});

test("an unreadable texted photo keeps us looking, so a better one still works", async () => {
  reset();
  seedTextingNumber();
  const app = await makeApp(CUSTOMER);
  const { base, row } = await runWithPhone(app);
  await app.inject({ method: "POST", url: `${base}/label-photo/expect`, payload: { fromNumber: "8455559999" } });
  seedTextedPhoto("+18455559999", new Date(Date.now() + 1000));

  ocrNext = { text: "blurry nonsense", confidence: 12 };
  const blurry = await app.inject({ method: "POST", url: `${base}/label-photo/check`, payload: {} });
  assert.equal(blurry.statusCode, 400, blurry.body);
  assert.equal(body(blurry).error, "photo_unreadable");
  assert.equal(row.labelPhotoFromE164, "+18455559999", "still expecting — they can simply text a better one");

  ocrNext = { text: `MAC ${MAC12.toUpperCase()} S/N: ${SN}`, confidence: 90 };
  const good = await app.inject({ method: "POST", url: `${base}/label-photo/check`, payload: {} });
  assert.equal(good.statusCode, 200, good.body);
  assert.equal(row.serialNumber, SN);
});

/* ── the customer's own scan link ────────────────────────────────────────── */

/**
 * The link we text a customer so they can scan the stickers themselves.
 *
 * ⛔ PUBLIC BY TOKEN. There is no sign-in: the token in the path IS the credential, so
 * every one of these tests is written from the customer's side with NO jwt behind it —
 * `makeApp` still pins a user, but these routes never read `req.user`, they read the
 * token. What they must prove is therefore the opposite of the staff routes: that the
 * token alone decides, that it reaches exactly one run, and that it can be killed.
 */

/** Mint a link for a run and hand back the raw token out of the URL we return once. */
async function mintScanLink(app: any, runId: string) {
  const r = await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/scan-link`, payload: {} });
  assert.equal(r.statusCode, 200, r.body);
  const url = String(body(r).url);
  const token = url.split("/").pop() as string;
  assert.ok(token && token.length >= 20, `a real token came back: ${url}`);
  return { token, url };
}

const scanUpload = async (app: any, token: string, file = photoUpload("scan.jpg")) =>
  app.inject({ method: "POST", url: `/phone-setup/${token}/scan`, payload: file.payload, headers: file.headers });

test("the link lists the customer's own phones, in the customer's view — never the serial", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { runId } = await runWithPhone(app);
  const { token } = await mintScanLink(app, runId);

  const r = await app.inject({ method: "GET", url: `/phone-setup/${token}` });
  assert.equal(r.statusCode, 200, r.body);
  const out = body(r);
  assert.equal(out.company, "ABC Company");
  assert.equal(out.total, 1);
  assert.equal(out.scanned, 0);
  const p = out.phones[0];
  assert.equal(p.mac, "C0:74:AD:8C:60:5F", "the address is shown the way a person reads it off the sticker");
  assert.equal(p.done, false);
  assert.equal(p.serialOnFile, false);
  // ⛔ The technician's fields never cross to a page that anyone holding a link can open.
  for (const k of ["provisioningUrl", "identityEvidence", "technicalNote", "firmware", "serialNumber"]) {
    assert.ok(!(k in p), `the customer view must not carry ${k}`);
  }
  assert.ok(state.scanTokens[0].firstOpenedAt, "the first open is stamped once");
});

test("a scanned sticker finds its own phone BY ADDRESS — the customer never picks from a list", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { runId, row } = await runWithPhone(app);
  const { token } = await mintScanLink(app, runId);

  ocrNext = { text: `Grandstream GXP2170 MAC: ${MAC12.toUpperCase()} S/N: ${SN}`, confidence: 91 };
  const r = await scanUpload(app, token);
  assert.equal(r.statusCode, 200, r.body);
  const out = body(r);
  assert.equal(out.matched, true);
  assert.equal(out.makerLabel, "Grandstream", "the maker is named from the address, not from anything the customer chose");
  assert.equal(out.total, 1);
  assert.equal(out.scanned, 1);
  assert.equal(out.phone.done, true);
  assert.equal(row.serialNumber, SN, "the serial reached the phone record through the one gate");
  // ⛔ Stored, never echoed: the page that shows this is public to anyone holding the link.
  noLeak(out, [SN]);
  assert.equal(state.scanTokens[0].scanCount, 1, "the counter really increments (not a {increment:1} object)");
  assert.ok(state.scanTokens[0].lastUsedAt);

  const audit = state.audits.find((a: any) => a.action === "DESK_PHONE_LABEL_SCANNED");
  assert.equal(audit.actorUserId, CUSTOMER.sub, "audited against whoever put the link in the customer's hands");
  assert.equal(audit.tenantId, "t_abc");
});

test("a phone that is not on this order is refused BY MAKER, never attached to whatever is next", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { runId, row } = await runWithPhone(app);
  const { token } = await mintScanLink(app, runId);

  // A Yealink sticker (805ec0…): a maker we are approved for, but not this order's phone.
  // ⛔ The brand is read off the address, so this works for every approved maker without
  // the scanner being told which brand to expect.
  ocrNext = { text: "Yealink T53W MAC: 805EC0C89B86 S/N: 2142019121401463", confidence: 93 };
  const r = await scanUpload(app, token);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(body(r).error, "phone_not_in_order");
  assert.match(body(r).message, /Yealink/, "naming the maker is the whole point of the refusal");
  assert.equal(row.serialNumber, null, "nothing was attached to the phone we DO have");
  assert.equal(state.scanTokens[0].scanCount, 0, "a refusal is not a scan");
});

test("no camera: typing what the sticker says goes through the same one gate", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { runId, row } = await runWithPhone(app);
  const { token } = await mintScanLink(app, runId);

  const r = await app.inject({
    method: "POST", url: `/phone-setup/${token}/phones/${row.id}/label`,
    payload: { text: `Grandstream GXP2170 MAC: ${MAC12.toUpperCase()} S/N: ${SN}` },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(body(r).found.serialFound, true);
  assert.equal(row.serialNumber, SN);
  noLeak(body(r).phone, [SN]);
  assert.equal(state.scanTokens[0].scanCount, 1);
});

test("missing, revoked and expired links are ONE flat refusal that never says which", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { runId } = await runWithPhone(app);

  const bogus = await app.inject({ method: "GET", url: `/phone-setup/${"z".repeat(32)}` });
  assert.equal(bogus.statusCode, 404, bogus.body);
  assert.equal(body(bogus).error, "link_not_found");
  const flat = body(bogus).message;

  const { token: revoked } = await mintScanLink(app, runId);
  const rev = await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/scan-link/revoke`, payload: {} });
  assert.equal(rev.statusCode, 200, rev.body);
  assert.equal(body(rev).revoked, 1);
  const afterRevoke = await app.inject({ method: "GET", url: `/phone-setup/${revoked}` });
  assert.equal(afterRevoke.statusCode, 404);
  assert.equal(body(afterRevoke).message, flat, "a revoked link must not be distinguishable from a wrong one");

  const { token: expired } = await mintScanLink(app, runId);
  state.scanTokens.find((t: any) => !t.revokedAt).expiresAt = new Date(Date.now() - 1000);
  const afterExpiry = await app.inject({ method: "GET", url: `/phone-setup/${expired}` });
  assert.equal(afterExpiry.statusCode, 404);
  assert.equal(body(afterExpiry).message, flat);
});

test("minting again kills the old link — one sent to the wrong person stops working", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { runId } = await runWithPhone(app);
  const { token: first } = await mintScanLink(app, runId);
  const { token: second } = await mintScanLink(app, runId);

  assert.notEqual(first, second);
  assert.equal((await app.inject({ method: "GET", url: `/phone-setup/${first}` })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/phone-setup/${second}` })).statusCode, 200);
  assert.equal(state.scanTokens.filter((t: any) => !t.revokedAt).length, 1, "exactly one live link per run");
});

test("a link reaches ONLY its own run's phones", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const a = await runWithPhone(app);
  const { token } = await mintScanLink(app, a.runId);

  // ⛔ ONE LIVE RUN PER CUSTOMER: a second `POST /desk-phones/runs` RESUMES the first
  // and answers `resumed: true`, so a second run only exists once this one is closed —
  // which is exactly how it happens in life, when a customer sets up another batch of
  // phones weeks later. Closing it here is what makes the two runs real; without it both
  // "runs" are one run and this test would quietly prove nothing.
  state.runs.find((r: any) => r.id === a.runId).status = "done";
  const b = await runWithPhone(app, { mac: "80:5E:C0:C8:9B:86", vendor: "Yealink", model: "T53W" });
  assert.notEqual(b.runId, a.runId, "the second batch really is its own run");

  const out = body(await app.inject({ method: "GET", url: `/phone-setup/${token}` }));
  assert.equal(out.total, 1);
  assert.equal(out.phones[0].id, a.row.id, "the other run's phone is not even listed");

  // ⛔ And naming the other run's phone id outright is refused, not silently honoured.
  const r = await app.inject({
    method: "POST", url: `/phone-setup/${token}/phones/${b.row.id}/label`,
    payload: { text: `Yealink T53W MAC: 805EC0C89B86 S/N: 2142019121401463` },
  });
  assert.equal(r.statusCode, 404, r.body);
  assert.equal(b.row.serialNumber, null);
});

test("another company cannot mint a link for someone else's run", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { runId } = await runWithPhone(app);

  const intruder = await makeApp(OTHER);
  const r = await intruder.inject({ method: "POST", url: `/desk-phones/runs/${runId}/scan-link`, payload: {} });
  assert.notEqual(r.statusCode, 200, r.body);
  assert.equal(state.scanTokens.length, 0, "no link exists to be sent anywhere");
});

test("minting a link needs the desk-phone permission", async () => {
  reset();
  const app = await makeApp(CUSTOMER);
  const { runId } = await runWithPhone(app);

  allowSetup = false;
  const r = await app.inject({ method: "POST", url: `/desk-phones/runs/${runId}/scan-link`, payload: {} });
  assert.notEqual(r.statusCode, 200, r.body);
  assert.equal(state.scanTokens.length, 0);
  allowSetup = true;
});
