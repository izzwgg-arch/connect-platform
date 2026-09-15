/**
 * The maker-cloud providers and the identification store, driven against the GDMS
 * simulator — never a real account, never a real device.
 *
 * Run with: node --experimental-test-module-mocks --import tsx --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GdmsSimulator } from "./gdmsSimulator";
import {
  assertGdmsHost,
  assertGdmsRuntimeMode,
  GdmsClient,
  gdmsPasswordDigest,
  gdmsSignature,
  parseGdmsDevice,
} from "./gdmsClient";
import { GrandstreamProvider } from "./grandstreamProvider";
import { FanvilDeviceProvider, PolyDeviceProvider, YealinkDeviceProvider } from "./otherDeviceProviders";
import { createDeviceProviderRegistry } from "./deviceProviderRegistry";
import { failureFromError, isResetAuthorization, providerFailure } from "./deviceProvider";
import {
  clearGdmsCredentialsCache,
  describeGdmsCredentials,
  resolveGdmsCredentials,
  validateGdmsCredentials,
} from "./gdmsCredentials";
import {
  addEvidence,
  cloudStateFromRow,
  evidenceForRow,
  identityColumns,
  readStoredEvidence,
  reportedEvidence,
  sanitizeEvidence,
  vendorCloudStateFor,
} from "./deviceIdentityStore";
import { DeviceError } from "./yealinkRps";

const MAC = "C0:74:AD:8C:60:5F";
const SN = "20EZ115N308C605F";
const AUTH = { runId: "run_1", phoneId: "ph_1", approvedAtMs: 1_786_000_000_000 };
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function grandstream(sim: GdmsSimulator, over: Record<string, unknown> = {}) {
  return new GrandstreamProvider({ resolveCredentials: async () => sim.creds, request: sim.fetch, env: {}, ...over });
}

const noLeak = (value: unknown, needles: string[]) => {
  const text = JSON.stringify(value);
  for (const n of needles) assert.ok(!text.includes(n), `leaked "${n}": ${text.slice(0, 200)}`);
};

/* ── the GDMS wire ──────────────────────────────────────────────────────── */

test("the GDMS signature follows the documented canonical string", () => {
  const body = JSON.stringify({ mac: MAC });
  assert.equal(
    gdmsSignature({ accessToken: "tok", clientId: "id1", clientSecret: "sec1", timestamp: "1700000000000", body }),
    sha(`&access_token=tok&client_id=id1&client_secret=sec1&timestamp=1700000000000&${sha(body)}&`),
  );
  assert.equal(
    gdmsSignature({ accessToken: "tok", clientId: "id1", clientSecret: "sec1", timestamp: "1700000000000", body: "" }),
    sha("&access_token=tok&client_id=id1&client_secret=sec1&timestamp=1700000000000&"),
    "an empty body adds no hash segment",
  );
  assert.equal(gdmsPasswordDigest("pw"), sha(createHash("md5").update("pw", "utf8").digest("hex")));
});

test("only Grandstream's own hosts are ever contacted", () => {
  assert.equal(assertGdmsHost("www.gdms.cloud"), "www.gdms.cloud");
  assert.equal(assertGdmsHost("eu.gdms.cloud"), "eu.gdms.cloud");
  for (const bad of ["gdms.cloud.evil.example", "evilgdms.cloud", "169.254.169.254", "api:3001", ""]) {
    assert.throws(() => assertGdmsHost(bad), (e: any) => e instanceof DeviceError && e.code === "gdms_endpoint_invalid", bad);
  }
});

test("a simulated GDMS can never be selected at runtime", async () => {
  for (const mode of ["test", "mock", "simulator", "TEST"]) {
    assert.throws(() => assertGdmsRuntimeMode({ GDMS_MODE: mode }), (e: any) => e.code === "gdms_mock_not_allowed_in_runtime");
  }
  assert.doesNotThrow(() => assertGdmsRuntimeMode({}));
  const sim = new GdmsSimulator();
  const p = grandstream(sim, { env: { GDMS_MODE: "mock" } });
  const r = await p.readiness();
  assert.equal(r.cloudConfigured, false);
  assert.deepEqual(r.supportedActions, []);
  const look = await p.lookup(MAC);
  assert.equal(look.ok, false);
  assert.equal(sim.apiCalls.length, 0, "nothing was sent");
});

test("no runtime module imports the simulator", () => {
  const root = join(__dirname, "..");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name === "gdmsSimulator.ts") continue;
      if (/gdmsSimulator/.test(readFileSync(full, "utf8"))) offenders.push(full);
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});

test("wrong credentials are refused as an authentication failure, not retried forever", async () => {
  const sim = new GdmsSimulator();
  const client = new GdmsClient({ ...sim.creds, secretKey: "wrong-secret-key-0000" }, sim.fetch);
  await assert.rejects(client.verify(), (e: any) => e.code === "gdms_authentication_failed");
  assert.equal(sim.apiCalls.length, 0);
});

test("parseGdmsDevice reads the fields defensively and never guesses online", () => {
  const d = parseGdmsDevice({ deviceMac: "c0-74-ad-8c-60-5f", deviceStatus: "Offline", sn: SN, programVersion: "1.0.11.64" });
  assert.ok(d);
  assert.equal(d!.mac, "c074ad8c605f");
  assert.equal(d!.online, false);
  assert.equal(d!.serialNumber, SN);
  assert.equal(d!.firmware, "1.0.11.64");
  assert.equal(parseGdmsDevice({ mac: MAC, status: "sleeping" })!.online, null, "an unreadable status is unknown, never false");
  assert.equal(parseGdmsDevice({ mac: MAC, status: true })!.online, true);
  assert.equal(parseGdmsDevice([{ mac: MAC }]), null);
  assert.equal(parseGdmsDevice({ mac: "not-a-mac" }), null);
  assert.equal(parseGdmsDevice(null), null);
});

/* ── Grandstream through GDMS ───────────────────────────────────────────── */

test("lookup: a device not in Loopcom's account is not found, and ownership elsewhere stays unknown", async () => {
  const sim = new GdmsSimulator();
  const r = await grandstream(sim).lookup(MAC);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.state, { checked: true, found: false, managedByUs: false, ownedElsewhere: null, online: null });
  assert.equal(r.device, null);
});

test("lookup: a device in Loopcom's account reports its model, serial, firmware and online state", async () => {
  const sim = new GdmsSimulator();
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1.0.11.64", status: "online", owner: "ours" });
  const r = await grandstream(sim).lookup(MAC);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.state.managedByUs, true);
  assert.equal(r.state.online, true);
  assert.deepEqual(r.device, { model: "GXP2170", serialNumber: SN, firmware: "1.0.11.64", name: null });
});

test("lookup refuses an unreadable hardware address before calling anything", async () => {
  const sim = new GdmsSimulator();
  const r = await grandstream(sim).lookup("zz:zz");
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "invalid_mac");
  assert.equal(sim.apiCalls.length, 0);
});

test("claim needs the serial number and sends nothing without it", async () => {
  const sim = new GdmsSimulator();
  const r = await grandstream(sim).claim({ mac: MAC, serialNumber: null });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "serial_number_required");
  assert.equal(sim.addCalls, 0);
});

test("claim registers the device, proves it by reading it back, and is idempotent", async () => {
  const sim = new GdmsSimulator();
  const p = grandstream(sim);
  const first = await p.claim({ mac: MAC, serialNumber: SN, deviceName: "Front desk" });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.outcome, "verified");
  assert.equal(sim.addCalls, 1);
  const again = await p.claim({ mac: MAC, serialNumber: SN });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.outcome, "already_done");
  assert.equal(sim.addCalls, 1, "an already-registered device is never added twice");
});

test("a claim whose response timed out after the write landed is still verified by read-back", async () => {
  const sim = new GdmsSimulator();
  sim.failNext = "timeout_after_add";
  const r = await grandstream(sim).claim({ mac: MAC, serialNumber: SN });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.outcome, "verified");
  assert.equal(sim.addCalls, 1, "the write is never retried");
});

test("a serial belonging to a different handset is refused by the BATCH result, never read as success (live shape, 2026-09-15)", async () => {
  // The live cloud answered the add with retCode 0 and the refusal inside data
  // (success:0, failure:1, errorDeviceList[0].errorMsg "30010"). Reading only the
  // envelope turned that refusal into claim_not_verified — retryable — and the
  // wizard spun on "Finding" forever with a serial that could never work.
  const sim = new GdmsSimulator();
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1.0.11.64", status: "offline", owner: "unowned" });
  const p = grandstream(sim);
  const r = await p.claim({ mac: MAC, serialNumber: "20ZE115N30WRONG0" });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "gdms_request_rejected");
  assert.equal(r.retryable, false, "a refused MAC+serial pair must stop the driver's retry loop");
  assert.equal(sim.addCalls, 1);
  noLeak(r, ["30010", "errorMsg", "errorDeviceList"]);
  const look = await p.lookup(MAC);
  assert.equal(look.ok && look.state.found, false, "nothing was added to the account");
  const good = await p.claim({ mac: MAC, serialNumber: SN });
  assert.equal(good.ok, true, "the right serial still registers the device afterwards");
});

test("a device bound to another GDMS account is refused as a POSSIBLE conflict, with no vendor text", async () => {
  const sim = new GdmsSimulator();
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "online", owner: "other" });
  const p = grandstream(sim);
  const look = await p.lookup(MAC);
  assert.equal(look.ok && look.state.found, false, "another account's device is invisible to lookup");
  const r = await p.claim({ mac: MAC, serialNumber: SN });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, "gdms_request_rejected");
  assert.equal(r.possibleOwnershipConflict, true);
  noLeak(r, ["bound to another account", "retCode", "10003"]);
});

test("every injected failure maps to a written message and the right retry advice", async () => {
  const cases: Array<[any, string, boolean]> = [
    ["429", "gdms_rate_limited_retry_later", true],
    ["500", "gdms_service_unavailable", true],
    ["timeout", "gdms_unreachable_retry_later", true],
    ["token_401", "gdms_authentication_failed", false],
  ];
  for (const [failure, code, retryable] of cases) {
    const sim = new GdmsSimulator();
    sim.failNext = failure;
    const r = await grandstream(sim).lookup(MAC);
    assert.equal(r.ok, false, failure);
    if (r.ok) continue;
    assert.equal(r.code, code, failure);
    assert.equal(r.retryable, retryable, failure);
    noLeak(r, ["too many requests", "internal error", "simulated", "invalid_client", sim.creds.secretKey, sim.creds.password]);
  }
});

test("a read refused for its token is retried once with a fresh session", async () => {
  const sim = new GdmsSimulator();
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "online", owner: "ours" });
  sim.failNext = "401";
  const r = await grandstream(sim).lookup(MAC);
  assert.equal(r.ok, true);
  assert.equal(sim.apiCalls.filter((a) => a === "v1.0.0/device/list").length, 2);
});

test("restart: refused for a device Loopcom does not manage, refused while offline, accepted when online", async () => {
  const sim = new GdmsSimulator();
  const p = grandstream(sim);
  const notManaged = await p.reboot(MAC);
  assert.equal(!notManaged.ok && notManaged.code, "device_not_managed");

  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "offline", owner: "ours" });
  const offline = await p.reboot(MAC);
  assert.equal(!offline.ok && offline.code, "device_offline");
  assert.equal(sim.tasks.length, 0);

  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "online", owner: "ours" });
  const ok = await p.reboot(MAC);
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.outcome, "accepted", "an accepted task is never reported as done");
  assert.equal(sim.tasks.length, 1);
  assert.equal(sim.tasks[0].type, 1);
});

test("factory reset is refused without the person's authorization for this device", async () => {
  const sim = new GdmsSimulator();
  sim.seed({ mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1", status: "online", owner: "ours" });
  const p = grandstream(sim);
  for (const authorization of [null, { runId: "", phoneId: "p", approvedAtMs: 1 }, { runId: "r", phoneId: "p", approvedAtMs: 0 }] as any[]) {
    const r = await p.reset({ mac: MAC, authorization });
    assert.equal(!r.ok && r.code, "reset_authorization_required");
  }
  assert.equal(sim.tasks.length, 0, "nothing was wiped");
  const r = await p.reset({ mac: MAC, authorization: AUTH });
  assert.equal(r.ok, true);
  assert.equal(sim.tasks[0].type, 2);
});

test("an unconfigured Grandstream cloud refuses honestly and contacts nobody", async () => {
  const sim = new GdmsSimulator();
  const p = grandstream(sim, { resolveCredentials: async () => null });
  const r = await p.readiness();
  assert.equal(r.cloudConfigured, false);
  assert.deepEqual(r.supportedActions, []);
  const look = await p.lookup(MAC);
  assert.equal(look.ok && look.state.checked, false);
  const claim = await p.claim({ mac: MAC, serialNumber: SN });
  assert.equal(!claim.ok && claim.code, "cloud_not_configured");
  assert.equal(sim.apiCalls.length + sim.tokenCalls, 0);
});

/* ── the other makers are honest about how little they do ───────────────── */

test("readiness: Grandstream configured, Yealink redirect-only, Fanvil and Poly not connected", async () => {
  const sim = new GdmsSimulator();
  const gs = await grandstream(sim).readiness();
  assert.equal(gs.cloudConfigured, true);
  assert.equal(gs.claimRequiresSerial, true);
  for (const a of ["lookup", "claim", "reboot", "factory_reset", "status"]) assert.ok(gs.supportedActions.includes(a as any), a);
  for (const a of ["push_config", "firmware_update", "diagnostics", "reprovision"]) assert.ok(!gs.supportedActions.includes(a as any), `${a} is not claimed`);

  const yl = await new YealinkDeviceProvider({ env: {} }).readiness();
  assert.equal(yl.cloudConfigured, false);
  assert.equal(yl.redirectOnly, true);
  for (const p of [new FanvilDeviceProvider(), new PolyDeviceProvider()]) {
    const r = await p.readiness();
    assert.equal(r.cloudConfigured, false);
    assert.deepEqual(r.supportedActions, []);
    for (const res of [await p.claim({ mac: MAC, serialNumber: SN }), await p.reboot(MAC), await p.reset({ mac: MAC, authorization: AUTH }), await p.pushConfig(MAC), await p.firmwareUpdate(MAC)]) {
      assert.equal(!res.ok && res.code, "not_supported");
    }
    const sip = await p.assignSip(MAC);
    assert.equal(!sip.ok && sip.code, "assign_sip_via_phone_system");
  }
});

test("Yealink RPS: tells ours from another account's, and never claims or restarts", async () => {
  const live = (answer: any) => new YealinkDeviceProvider({
    rps: () => ({ mode: "live", checkMac: async () => answer, assign: async () => ({ state: "assigned" }), release: async () => {} }) as any,
  });
  const other = await live({ existed: true, self: false }).lookup(MAC);
  assert.equal(other.ok && other.state.ownedElsewhere, true);
  assert.equal(other.ok && other.state.managedByUs, false);
  const ours = await live({ existed: true, self: true }).lookup(MAC);
  assert.equal(ours.ok && ours.state.managedByUs, true);
  const none = await live({ existed: false, self: null }).lookup(MAC);
  assert.equal(none.ok && none.state.found, false);
  const r = await live({ existed: true, self: true }).readiness();
  assert.deepEqual(r.supportedActions, ["lookup"]);
  const claim = await live({ existed: false, self: null }).claim({ mac: MAC, serialNumber: null });
  assert.equal(!claim.ok && claim.code, "not_supported");

  const failing = new YealinkDeviceProvider({
    rps: () => ({ mode: "live", checkMac: async () => { throw new DeviceError("rps_rate_limited_retry_later", 503); } }) as any,
  });
  const f = await failing.lookup(MAC);
  assert.equal(!f.ok && f.code, "rps_rate_limited_retry_later");
  assert.equal(!f.ok && f.retryable, true);
});

test("a raw error never becomes a customer message", () => {
  const f = failureFromError(new Error("token=abc123 password=hunter2"), "Grandstream");
  assert.equal(f.code, "provider_error");
  noLeak(f, ["abc123", "hunter2", "token="]);
  const unmapped = providerFailure("something_new", "Poly");
  assert.match(unmapped.message, /Loopcom Support/);
  assert.equal(unmapped.retryable, false);
  assert.equal(isResetAuthorization(AUTH), true);
  assert.equal(isResetAuthorization({ runId: "r", phoneId: "p", approvedAtMs: Number.NaN }), false);
});

/* ── the single execution loop ──────────────────────────────────────────── */

const PLAN = (): any => ({
  status: "identified",
  manualAction: null,
  resetNeeded: false,
  resetAuthorized: false,
  steps: [
    { step: "validate_ownership", via: "phone_system", why: "" },
    { step: "claim", via: "vendor_cloud", why: "" },
    { step: "reprovision", via: "local_pnp", why: "" },
    { step: "reboot", via: "vendor_cloud", why: "" },
    { step: "assign_sip", via: "pbx_record", why: "" },
  ],
});

test("prepare runs only the maker-cloud steps, in order, and hands the rest back", async () => {
  const sim = new GdmsSimulator();
  const seen: string[] = [];
  const out = await grandstream(sim).prepare({
    mac: MAC, serialNumber: SN, plan: PLAN(), resetAuthorization: null,
    hooks: { afterStep: async (step, result) => { seen.push(`${step}:${result.ok}`); } },
  });
  assert.deepEqual(out.ran.map((r) => r.step), ["claim", "reboot"]);
  assert.equal(out.stoppedAt, null);
  assert.deepEqual(out.leftForOthers, ["validate_ownership", "reprovision", "assign_sip"]);
  assert.deepEqual(seen, ["claim:true", "reboot:true"]);
  assert.equal(sim.tasks.length, 1);
});

test("a beforeStep refusal stops the loop without calling the maker", async () => {
  const sim = new GdmsSimulator();
  const out = await grandstream(sim).prepare({
    mac: MAC, serialNumber: SN, plan: PLAN(), resetAuthorization: null,
    hooks: { beforeStep: async (step) => (step === "reboot" ? providerFailure("needs_assignment", "Grandstream") : null) },
  });
  assert.equal(out.stoppedAt, "reboot");
  assert.equal(out.ran[1].result.ok, false);
  assert.equal(sim.tasks.length, 0, "the refused restart never reached GDMS");
  assert.equal(sim.addCalls, 1);
});

test("a failed step stops everything after it, and a plan needing a person runs nothing", async () => {
  const sim = new GdmsSimulator();
  const failed = await grandstream(sim).prepare({ mac: MAC, serialNumber: null, plan: PLAN(), resetAuthorization: null });
  assert.equal(failed.stoppedAt, "claim");
  assert.equal(failed.ran.length, 1);
  assert.equal(sim.tasks.length, 0);

  const manual = { ...PLAN(), manualAction: { code: "serial_required", message: "x" } };
  const none = await grandstream(sim).prepare({ mac: MAC, serialNumber: SN, plan: manual, resetAuthorization: null });
  assert.deepEqual(none, { ran: [], stoppedAt: null, leftForOthers: [] });
});

/* ── registry ───────────────────────────────────────────────────────────── */

test("the registry answers with a provider for what was discovered, never for a brand picked", async () => {
  const reg = createDeviceProviderRegistry({
    db: {},
    env: {},
    overrides: { fanvil: { manufacturer: "fanvil", platform: "fanvil_fdps", readiness: async () => { throw new Error("boom"); } } as any },
  });
  assert.equal(reg.providerFor("polycom")?.manufacturer, "poly");
  assert.equal(reg.providerFor("Grandstream")?.platform, "gdms");
  assert.equal(reg.providerFor("unknown"), null);
  assert.equal(reg.providerFor(null), null);
  const all = await reg.allReadiness();
  assert.equal(all.length, 4);
  const fanvil = all.find((r) => r.manufacturer === "fanvil");
  assert.equal(fanvil?.cloudConfigured, false, "a readiness check that throws degrades to not connected");
});

/* ── credentials ────────────────────────────────────────────────────────── */

test("GDMS credentials are validated in plain English", () => {
  const good = { region: "us", apiId: "abcd1234", secretKey: "secretkey-12345678", username: "ops@loopcom.net", password: "pw" };
  assert.equal(validateGdmsCredentials(good).ok, true);
  const bad: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...good, region: "asia" }, /region/],
    [{ ...good, apiId: "" }, /API ID/],
    [{ ...good, secretKey: "abcd1234" }, /same value|too short/],
    [{ ...good, username: "" }, /username/],
    [{ ...good, password: "" }, /password/],
  ];
  for (const [input, message] of bad) {
    const r = validateGdmsCredentials(input);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, message);
  }
});

test("env credentials that look like placeholders are ignored, and a description never carries a value", async () => {
  const saved = { ...process.env };
  delete process.env.CREDENTIALS_MASTER_KEY;
  const fakeDb = { agentSecret: { findUnique: async () => null } };
  try {
    clearGdmsCredentialsCache();
    const placeholder = await resolveGdmsCredentials(fakeDb, {
      GDMS_API_ID: "paste-your-id", GDMS_SECRET_KEY: "paste-your-secret", GDMS_USERNAME: "u", GDMS_PASSWORD: "p",
    } as any);
    assert.equal(placeholder, null);

    const sim = new GdmsSimulator();
    Object.assign(process.env, {
      GDMS_REGION: "us", GDMS_API_ID: sim.creds.apiId, GDMS_SECRET_KEY: sim.creds.secretKey,
      GDMS_USERNAME: sim.creds.username, GDMS_PASSWORD: sim.creds.password,
    });
    clearGdmsCredentialsCache();
    const d = await describeGdmsCredentials(fakeDb);
    assert.equal(d.configured, true);
    assert.equal(d.source, "env");
    noLeak(d, [sim.creds.apiId, sim.creds.secretKey, sim.creds.password, "sim-owner"]);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    clearGdmsCredentialsCache();
  }
});

/* ── the identification store ───────────────────────────────────────────── */

test("evidence from an unknown source, the MAC prefix, or a different device is dropped", () => {
  assert.equal(sanitizeEvidence({ source: "mac_oui", manufacturer: "grandstream" }), null);
  assert.equal(sanitizeEvidence({ source: "made_up", model: "GXP2170" }), null);
  assert.equal(sanitizeEvidence({ source: "barcode_label", model: "GXP2170", mac: "nonsense" }), null);
  assert.equal(sanitizeEvidence({ source: "barcode_label" }), null, "evidence with no facts is not evidence");
  const ok = sanitizeEvidence({ source: "barcode_label", model: "GXP2170", deviceType: "not-a-type" });
  assert.equal(ok?.model, "GXP2170");
  assert.equal(ok?.deviceType, null);
});

test("each source keeps only its newest word, and stored JSON is re-cleaned on the way out", () => {
  const merged = addEvidence(
    [{ source: "manual_entry", manufacturer: "grandstream", model: "GXP2135", firmware: null, serialNumber: null, deviceType: null, mac: null, observedAt: "1" }],
    [sanitizeEvidence({ source: "manual_entry", model: "GXP2170" }), sanitizeEvidence({ source: "http_banner", model: "GXP2170" }), null],
  );
  assert.equal(merged.filter((e) => e.source === "manual_entry").length, 1);
  assert.equal(merged.find((e) => e.source === "manual_entry")?.model, "GXP2170");
  assert.deepEqual(readStoredEvidence("not json"), []);
  assert.deepEqual(readStoredEvidence({ not: "an array" }), []);
  assert.equal(readStoredEvidence(JSON.stringify([{ source: "http_banner", model: "GXP2170" }, { source: "mac_oui" }])).length, 1);
});

test("what the office machine read becomes evidence at the source it names", () => {
  assert.equal(reportedEvidence({ identitySource: "none", model: "GXP2170" }, "t"), null);
  assert.equal(reportedEvidence({ identitySource: "weird", model: "GXP2170" }, "t")?.source, "device_banner");
  assert.equal(reportedEvidence({ identitySource: "sip_user_agent", model: "GXP2170" }, "t")?.source, "sip_user_agent");
  assert.equal(reportedEvidence({ vendor: "unknown", model: "GXP2170" }, "t")?.manufacturer, null);
});

test("a row written before identification existed is read as existing inventory", () => {
  const legacy = evidenceForRow({ vendor: "grandstream", model: "GXP2170", firmware: null });
  assert.equal(legacy[0]?.source, "existing_inventory");
  assert.deepEqual(evidenceForRow({ vendor: null, model: null }), []);
  const stored = evidenceForRow({ identityEvidence: [{ source: "barcode_label", model: "GXP2170" }], vendor: "yealink", model: "T54W" });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].source, "barcode_label", "stored evidence wins over legacy columns");
});

test("identity columns carry type, confidence and evidence, and a serial only when known", () => {
  const withSerial = identityColumns({ mac: MAC, evidence: [sanitizeEvidence({ source: "barcode_label", model: "GXP2170", serialNumber: SN })!] });
  assert.equal(withSerial.identification.manufacturer, "grandstream");
  assert.equal(withSerial.data.serialNumber, SN);
  assert.ok(typeof withSerial.data.deviceType === "string");
  assert.ok(typeof withSerial.data.identityConfidence === "string");
  const without = identityColumns({ mac: MAC, evidence: [] });
  assert.equal("serialNumber" in without.data, false);
});

test("the recorded cloud state round-trips through the row", () => {
  for (const state of ["managed", "conflict", "not_found"] as const) {
    assert.equal(vendorCloudStateFor(cloudStateFromRow({ vendorCloudState: state })), state);
  }
  assert.equal(cloudStateFromRow({ vendorCloudState: null }).checked, false);
  assert.equal(cloudStateFromRow({ vendorCloudState: "claiming" }).checked, false, "an in-flight claim proves nothing yet");
});
