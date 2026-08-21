import test from "node:test";
import assert from "node:assert/strict";

import {
  buildActionRequest, buildStatusRequest, isPrivateIpv4, assertPrivateIpv4,
  fingerprintFromResponse, supportsSipReset, classifyProvisioningUrl,
  testCredentials, sendAction, YEALINK_DEFAULT_CREDENTIALS,
  type HttpRequest, type HttpResponse,
} from "./yealink";
import { createPhoneCapability, PHONE_OPERATIONS } from "./capability";
import { parseArpTable, hostsInSubnet, localScannableSubnets, isPrivateIpv4 as scanPrivate } from "./lanScan";

const CREDS = { username: "admin", password: "sup3r-s3cret" };

function res(over: Partial<HttpResponse> = {}): HttpResponse {
  return { status: 200, headers: {}, body: "", ...over };
}

/* ── the fence ───────────────────────────────────────────────────────────── */

test("only private office addresses are addressable, ever", () => {
  for (const ok of ["192.168.1.41", "10.0.0.5", "172.16.9.9", "172.31.255.254"]) {
    assert.equal(isPrivateIpv4(ok), true, ok);
  }
  for (const no of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "0.0.0.0",
                    "256.1.1.1", "192.168.1", "example.com", "", null, undefined]) {
    assert.equal(isPrivateIpv4(no as any), false, String(no));
  }
});

test("a public address is refused before a request is even built", () => {
  assert.throws(() => buildActionRequest("8.8.8.8", "reboot", null), /private office address/);
  assert.throws(() => assertPrivateIpv4("203.0.113.7"), /private office address/);
});

test("a credential never appears in a URL", () => {
  // Yealink's own docs show http://user:pass@ip/... and that form is poison: the URL
  // is what lands in diagnostics, logs, errors and AI prompts.
  const req = buildActionRequest("192.168.1.41", "reboot", CREDS);
  assert.ok(!req.url.includes(CREDS.password), "the password must not be in the URL");
  assert.ok(!req.url.includes("@"), "no userinfo in the URL");
  assert.match(req.headers.Authorization, /^Basic /);
  const decoded = Buffer.from(req.headers.Authorization.slice(6), "base64").toString("utf8");
  assert.equal(decoded, "admin:sup3r-s3cret");
});

test("the two action verbs are the documented ones and nothing else", () => {
  assert.match(buildActionRequest("192.168.1.41", "reboot", null).url, /servlet\?key=Reboot$/);
  assert.match(buildActionRequest("192.168.1.41", "autop", null).url, /servlet\?key=AutoP$/);
});

test("a phone request cannot hang the wizard", () => {
  assert.ok(buildActionRequest("192.168.1.41", "reboot", null).timeoutMs <= 5000);
  assert.ok(buildStatusRequest("192.168.1.41", null).timeoutMs <= 5000);
});

/* ── reading a phone ─────────────────────────────────────────────────────── */

test("wrong password is 'locked', not 'broken'", async () => {
  const http = async () => res({ status: 401 });
  assert.deepEqual(await testCredentials(http, "192.168.1.41", CREDS), { ok: false, reason: "locked" });
});

test("nothing answering is 'unreachable', which is a different problem", async () => {
  const http = async () => { throw new Error("ECONNREFUSED"); };
  assert.deepEqual(await testCredentials(http, "192.168.1.41", CREDS), { ok: false, reason: "unreachable" });
});

test("a phone that opens is simply ok", async () => {
  assert.deepEqual(await testCredentials(async () => res({ status: 200 }), "192.168.1.41", CREDS), { ok: true });
});

test("the model is read from whichever place the firmware put it", () => {
  const fromServer = fingerprintFromResponse(res({ headers: { Server: "Yealink Embedded Web Server SIP-T54W 96.86.0.15" } }));
  assert.equal(fromServer.vendor, "yealink");
  assert.equal(fromServer.model, "T54W");
  assert.equal(fromServer.firmware, "96.86.0.15");
  assert.equal(fromServer.confidence, "banner");

  const fromRealm = fingerprintFromResponse(res({ status: 401, headers: { "WWW-Authenticate": 'Basic realm="Yealink SIP-T42S"' } }));
  assert.equal(fromRealm.model, "T42S");

  const fromTitle = fingerprintFromResponse(res({ body: "<html><head><title>Yealink SIP-T29G</title></head></html>" }));
  assert.equal(fromTitle.model, "T29G");
});

test("something that is not a phone is 'unknown', never a guess", () => {
  const f = fingerprintFromResponse(res({ headers: { Server: "nginx/1.24.0" }, body: "<title>Router</title>" }));
  assert.equal(f.vendor, "unknown");
  assert.equal(f.model, null);
  assert.equal(f.confidence, "none", "a guessed model shows a customer a picture of the wrong phone");
});

test("model names normalise so T21P-E2 and T21P_E2 are one model", () => {
  const f = fingerprintFromResponse(res({ headers: { Server: "Yealink SIP-T21P_E2" } }));
  assert.equal(f.model, "T21PE2");
});

test("firmware 81 is the line for resetting a phone from the PBX", () => {
  assert.equal(supportsSipReset("81.0.0.1"), true);
  assert.equal(supportsSipReset("96.86.0.15"), true);
  assert.equal(supportsSipReset("80.99.99.99"), false);
  assert.equal(supportsSipReset(null), false, "unknown firmware is treated as unable, never as able");
  assert.equal(supportsSipReset("garbage"), false);
});

/* ── whose provisioning is it ────────────────────────────────────────────── */

test("a provisioning address is ours, somebody else's, or absent", () => {
  const ours = ["m.connectcomunications.com", "loopcom.net"];
  assert.equal(classifyProvisioningUrl("https://m.connectcomunications.com/phoneprov/abc/", ours), "ours");
  assert.equal(classifyProvisioningUrl("https://pbx.loopcom.net/x", ours), "ours");
  assert.equal(classifyProvisioningUrl("https://prov.oldprovider.net/cfg/", ours), "other");
  assert.equal(classifyProvisioningUrl("", ours), "none");
  assert.equal(classifyProvisioningUrl(null, ours), "none");
});

test("a lookalike host is NOT ours", () => {
  const ours = ["loopcom.net"];
  // a bare substring match would hand this one to us
  assert.equal(classifyProvisioningUrl("https://loopcom.net.evil.example/cfg", ours), "other");
  assert.equal(classifyProvisioningUrl("https://notloopcom.net/cfg", ours), "other");
});

test("an unparseable provisioning value is somebody else's, not ours", () => {
  // failing open here would mark a phone as already-connected and skip it entirely
  assert.equal(classifyProvisioningUrl("::::not a url::::", ["loopcom.net"]), "other");
});

/* ── actions ─────────────────────────────────────────────────────────────── */

test("an action is sent exactly once, never retried inside the adapter", async () => {
  let calls = 0;
  const http = async () => { calls += 1; throw new Error("timeout"); };
  const out = await sendAction(http, "192.168.1.41", "reboot", CREDS);
  assert.deepEqual(out, { ok: false, reason: "unreachable" });
  // a reboot that "timed out" was very likely received - the phone stops answering
  // BECAUSE it is doing what it was told. Retrying here turns one reboot into three.
  assert.equal(calls, 1);
});

test("a locked phone reports locked rather than a generic failure", async () => {
  const out = await sendAction(async () => res({ status: 401 }), "192.168.1.41", "reboot", null);
  assert.deepEqual(out, { ok: false, reason: "locked", status: 401 });
});

/* ── the capability fence ────────────────────────────────────────────────── */

function cap(over: Partial<Parameters<typeof createPhoneCapability>[0]> = {}) {
  let t = 1_000_000;
  return {
    api: createPhoneCapability({
      http: async () => res({ status: 200, headers: { Server: "Yealink SIP-T54W 96.86.0.15" } }),
      resolveCredential: async () => CREDS,
      scan: async () => ({ subnet: "192.168.1.0/24", hostsSeen: 2, hosts: [], outcome: "ok" as const }),
      now: () => t,
      ...over,
    }),
    advance: (ms: number) => { t += ms; },
  };
}

test("an operation that is not on the list is refused without reading its arguments", async () => {
  const { api } = cap();
  assert.deepEqual(await api.run({ op: "factory_reset", ip: "192.168.1.41" } as any), { ok: false, refused: "unknown_operation" });
  assert.deepEqual(await api.run({ op: "run_command", cmd: "whoami" } as any), { ok: false, refused: "unknown_operation" });
  assert.deepEqual(await api.run(null as any), { ok: false, refused: "unknown_operation" });
});

test("factory reset is deliberately not a local capability", () => {
  assert.ok(!(PHONE_OPERATIONS as readonly string[]).includes("factory_reset"));
  assert.ok(!(PHONE_OPERATIONS as readonly string[]).includes("reset"));
});

test("there is no way to express an arbitrary request", () => {
  // the shape of the allowlist IS the security property
  assert.deepEqual([...PHONE_OPERATIONS].sort(),
    ["discover", "fingerprint", "reboot", "test_credentials", "trigger_autop"]);
});

test("a public address is refused even when the server asked for it", async () => {
  const { api } = cap();
  assert.deepEqual(await api.run({ op: "reboot", ip: "8.8.8.8" }), { ok: false, refused: "not_a_private_address" });
  assert.deepEqual(await api.run({ op: "fingerprint", ip: "203.0.113.7" }), { ok: false, refused: "not_a_private_address" });
});

test("a credential reference that resolves to nothing is refused, not retried without one", async () => {
  const { api } = cap({ resolveCredential: async () => null });
  const out = await api.run({ op: "reboot", ip: "192.168.1.41", credentialRef: "abc" });
  // "we tried without a password" and "we tried the wrong one" are different answers
  assert.deepEqual(out, { ok: false, refused: "credential_not_available" });
});

test("the documented default is requested by a flag, never by value", async () => {
  let sawAuth: string | undefined;
  const { api } = cap({
    http: async (req: HttpRequest) => { sawAuth = req.headers.Authorization; return res({ status: 200 }); },
  });
  await api.run({ op: "test_credentials", ip: "192.168.1.41", useDefault: true });
  const decoded = Buffer.from(String(sawAuth).slice(6), "base64").toString("utf8");
  assert.equal(decoded, `${YEALINK_DEFAULT_CREDENTIALS.username}:${YEALINK_DEFAULT_CREDENTIALS.password}`);
});

test("the same phone cannot be rebooted over and over", async () => {
  const { api, advance } = cap();
  assert.equal((await api.run({ op: "reboot", ip: "192.168.1.41" })).ok, true);
  const second = await api.run({ op: "reboot", ip: "192.168.1.41" });
  assert.deepEqual(second, { ok: false, refused: "too_soon_for_this_phone" });
  advance(6000);
  assert.equal((await api.run({ op: "reboot", ip: "192.168.1.41" })).ok, true);
});

test("reads are not spaced out - only things that change a phone are", async () => {
  const { api } = cap();
  assert.equal((await api.run({ op: "fingerprint", ip: "192.168.1.41" })).ok, true);
  assert.equal((await api.run({ op: "fingerprint", ip: "192.168.1.41" })).ok, true);
});

test("a caller told to hammer the office is refused locally", async () => {
  const { api, advance } = cap();
  let refusedAt = -1;
  for (let i = 0; i < 40; i += 1) {
    const out = await api.run({ op: "fingerprint", ip: `192.168.1.${(i % 200) + 10}` });
    if (!out.ok && out.refused === "rate_limited") { refusedAt = i; break; }
    advance(10);
  }
  assert.ok(refusedAt > 0 && refusedAt <= 31, `expected a cap around 30, refused at ${refusedAt}`);
});

test("scans cannot be run back to back", async () => {
  const { api, advance } = cap();
  assert.equal((await api.run({ op: "discover" })).ok, true);
  assert.deepEqual(await api.run({ op: "discover" }), { ok: false, refused: "too_soon" });
  advance(20_000);
  assert.equal((await api.run({ op: "discover" })).ok, true);
});

/* ── the lifted scanner still behaves ────────────────────────────────────── */

test("the scanner only ever considers private office networks", () => {
  assert.equal(scanPrivate("192.168.1.5"), true);
  assert.equal(scanPrivate("8.8.8.8"), false);
  const subnets = localScannableSubnets({
    vpn: [{ family: "IPv4", internal: false, address: "10.8.0.2", netmask: "255.255.255.0" } as any],
    wan: [{ family: "IPv4", internal: false, address: "203.0.113.5", netmask: "255.255.255.0" } as any],
    lo: [{ family: "IPv4", internal: true, address: "127.0.0.1", netmask: "255.0.0.0" } as any],
  } as any);
  assert.ok(!subnets.includes("203.0.113.0/24"), "a public range is never swept");
});

test("a sweep is one /24 and nothing wider", () => {
  assert.equal(hostsInSubnet("192.168.1.0/24").length, 254);
  assert.equal(hostsInSubnet("10.0.0.0/16").length, 0, "a /16 is 65,000 addresses and looks like a port scan");
});

test("the address table parser drops everything that is not a host", () => {
  const rows = parseArpTable([
    "  192.168.1.1     aa-bb-cc-dd-ee-01   dynamic",
    "  192.168.1.20    80-5e-0c-4d-7e-6b   dynamic",
    "  192.168.1.255   ff-ff-ff-ff-ff-ff   static",
    "  224.0.0.251     01-00-5e-00-00-fb   static",
    "  192.168.1.20    80-5e-0c-4d-7e-6b   dynamic",
  ].join("\n"));
  const macs = rows.map((r) => r.mac);
  assert.ok(macs.includes("805e0c4d7e6b"));
  assert.ok(!macs.includes("ffffffffffff"), "broadcast is not a phone");
  assert.ok(!macs.some((m) => m.startsWith("01005e")), "multicast would put phantom phones in an inventory");
  assert.equal(new Set(macs).size, macs.length, "a phone seen twice is one phone");
});

/* ── the wiring, which is where this class of defect actually lives ──────── */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  registerPhoneSetup, PHONE_SETUP_CHANNEL,
  PHONE_SETUP_STORE_CREDENTIAL_CHANNEL, PHONE_SETUP_FORGET_CREDENTIALS_CHANNEL,
} from "./mainWiring";

function fakeIpc() {
  const handlers = new Map<string, (e: unknown, ...a: any[]) => any>();
  return { handlers, ipcMain: { handle: (c: string, f: any) => { handlers.set(c, f); } } };
}

test("the capability is reachable on exactly three channels and no more", () => {
  const { handlers, ipcMain } = fakeIpc();
  registerPhoneSetup({ ipcMain, http: async () => res({ status: 200 }) });
  assert.deepEqual([...handlers.keys()].sort(), [
    PHONE_SETUP_FORGET_CREDENTIALS_CHANNEL, PHONE_SETUP_CHANNEL, PHONE_SETUP_STORE_CREDENTIAL_CHANNEL,
  ].sort());
});

test("storing a password gives nothing about it back", async () => {
  const { handlers, ipcMain } = fakeIpc();
  registerPhoneSetup({ ipcMain, http: async () => res({ status: 200 }) });
  const out = await handlers.get(PHONE_SETUP_STORE_CREDENTIAL_CHANNEL)!(null, {
    ref: "office", username: "admin", password: "hunter2",
  });
  assert.equal(out.ok, true);
  assert.ok(!JSON.stringify(out).includes("hunter2"), "not even an echo");
  assert.ok(!("password" in out));
});

test("a stored password is usable by reference and never returned", async () => {
  const { handlers, ipcMain } = fakeIpc();
  let seen: string | undefined;
  registerPhoneSetup({
    ipcMain,
    http: async (req) => { seen = req.headers.Authorization; return res({ status: 200 }); },
  });
  await handlers.get(PHONE_SETUP_STORE_CREDENTIAL_CHANNEL)!(null, { ref: "office", username: "admin", password: "hunter2" });
  const result = await handlers.get(PHONE_SETUP_CHANNEL)!(null, {
    op: "fingerprint", ip: "192.168.1.41", credentialRef: "office",
  });
  assert.equal(result.ok, true);
  assert.equal(Buffer.from(String(seen).slice(6), "base64").toString("utf8"), "admin:hunter2");
  assert.ok(!JSON.stringify(result).includes("hunter2"), "the result must not carry the secret back");
});

test("an incomplete credential is refused rather than half stored", async () => {
  const { handlers, ipcMain } = fakeIpc();
  registerPhoneSetup({ ipcMain, http: async () => res({ status: 200 }) });
  const store = handlers.get(PHONE_SETUP_STORE_CREDENTIAL_CHANNEL)!;
  assert.equal((await store(null, { ref: "a", username: "admin", password: "" })).ok, false);
  assert.equal((await store(null, { ref: "", username: "admin", password: "x" })).ok, false);
});

test("a credential that will not decrypt is 'we do not have one', not a crash", async () => {
  const { handlers, ipcMain } = fakeIpc();
  registerPhoneSetup({
    ipcMain,
    http: async () => res({ status: 200 }),
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.from("corrupt"),
      decryptString: () => { throw new Error("keyring changed"); },
    },
  });
  await handlers.get(PHONE_SETUP_STORE_CREDENTIAL_CHANNEL)!(null, { ref: "r", username: "a", password: "b" });
  const out = await handlers.get(PHONE_SETUP_CHANNEL)!(null, { op: "reboot", ip: "192.168.1.41", credentialRef: "r" });
  assert.deepEqual(out, { ok: false, refused: "credential_not_available" });
});

test("forgetting clears everything", async () => {
  const { handlers, ipcMain } = fakeIpc();
  registerPhoneSetup({ ipcMain, http: async () => res({ status: 200 }) });
  await handlers.get(PHONE_SETUP_STORE_CREDENTIAL_CHANNEL)!(null, { ref: "r", username: "a", password: "b" });
  await handlers.get(PHONE_SETUP_FORGET_CREDENTIALS_CHANNEL)!(null);
  const out = await handlers.get(PHONE_SETUP_CHANNEL)!(null, { op: "reboot", ip: "192.168.1.41", credentialRef: "r" });
  assert.deepEqual(out, { ok: false, refused: "credential_not_available" });
});

test("an adapter error never leaks a URL or a header back to the web page", async () => {
  const { handlers, ipcMain } = fakeIpc();
  registerPhoneSetup({
    ipcMain,
    http: async () => { throw new Error("connect ECONNREFUSED http://192.168.1.41/servlet?key=Reboot"); },
  });
  const out = await handlers.get(PHONE_SETUP_CHANNEL)!(null, { op: "fingerprint", ip: "192.168.1.41" });
  assert.equal(out.ok, false);
  assert.ok(!JSON.stringify(out).includes("servlet"));
});

// ⛔ A working capability that nothing calls is the exact shape of the bug this whole
// feature exists to fix: the scanner was written, tested and never wired into the app
// anyone actually has. These read the SOURCE, because a unit test of the module
// passes straight through a missing call site.
test("the shipped app actually registers the capability", () => {
  const main = readFileSync(join(__dirname, "..", "main.ts"), "utf8");
  assert.match(main, /registerPhoneSetup\(\{\s*ipcMain,\s*safeStorage\s*\}\)/,
    "a capability nothing calls is how the scanner sat unshipped for a week");
  assert.match(main, /from "\.\/phoneSetup\/mainWiring"/);
  assert.match(main, /\bsafeStorage\b.*from "electron"/,
    "without safeStorage the password sits in memory in the clear");
});

test("the preload exposes the narrow bridge and nothing URL-shaped", () => {
  const preload = readFileSync(join(__dirname, "..", "preload.ts"), "utf8");
  assert.match(preload, /phoneSetup:\s*\{/);
  assert.match(preload, /rememberCredential/);
  const block = preload.slice(preload.indexOf("phoneSetup: {"), preload.indexOf("notifications: {"));
  for (const banned of ["url", "host", "fetch", "exec", "command"]) {
    assert.ok(!new RegExp(banned, "i").test(block), `the bridge must not be able to express a ${banned}`);
  }
});
