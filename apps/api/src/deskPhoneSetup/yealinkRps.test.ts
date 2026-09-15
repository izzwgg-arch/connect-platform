import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configuredRps, DeviceError, strictMac, YealinkRpsClient } from "./yealinkRps";
import { managedModel, yealinkConfig } from "./yealinkConfig";
import { RpsSimulator, sip } from "./yealinkRpsSimulator";

test("MAC input forms normalize; malformed, multicast and zero addresses refuse", () => {
  for (const m of ["80:5E:C0:11:22:33", "80-5E-C0-11-22-33", "805EC0112233", "805ec0112233"])
    assert.equal(strictMac(m), "805ec0112233");
  for (const m of ["805ec0112233ZZ", "80:5e-c0:11:22:33", "ffffffffffff", "000000000000", "015ec0112233", "805ec0112233\nkey=x", "../805ec0112233"])
    assert.throws(() => strictMac(m), /invalid_mac/);
});
test("OAuth2 v2: Basic-auth token is cached across calls and refreshed once on 401", async () => {
  const fake = new RpsSimulator(); const client = fake.client();
  await client.listDevices({}); await client.listDevices({});
  assert.equal(fake.tokenCalls, 1); // cached, not re-requested per call
  fake.expireToken = true; // server-side token death → exactly one refresh, then success
  const page = await client.listDevices({});
  assert.equal(fake.tokenCalls, 2);
  assert.deepEqual(page.data ?? [], []);
  // Wrong credentials are an auth failure, not a loop.
  const bad = new YealinkRpsClient("https://us-api.ymcs.yealink.com", "wrong", "creds", fake.fetch);
  await assert.rejects(bad.listDevices({}), /rps_authentication_failed/);
});
test("runtime cannot select a mock; disabled never calls the network", async () => {
  assert.throws(() => configuredRps({ YEALINK_RPS_MODE: "test" }), /mock_not_allowed/);
  assert.deepEqual(await configuredRps({}).assign({} as any), { state: "pending_credentials" });
  // Enabled but half-configured stays DISABLED (pending credentials), never a guess.
  assert.equal(configuredRps({ YEALINK_RPS_ENABLED: "1", YEALINK_RPS_ACCESS_KEY_ID: "k" }).mode, "disabled");
  for (const url of ["http://dm.yealink.com", "https://localhost", "https://yealink.com.evil.test", "https://x:y@dm.yealink.com", "https://dm.yealink.com/a"])
    assert.throws(() => new YealinkRpsClient(url, "key", "secret"));
});
test("⛔ no runtime module imports the test-only RPS simulator", () => {
  const dir = __dirname;
  for (const f of readdirSync(dir).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "yealinkRpsSimulator.ts"))
    assert.doesNotMatch(readFileSync(join(dir, f), "utf8"), /yealinkRpsSimulator/, f);
});
test("config uses existing credentials, bounded BLF and unique passwords; injection rejected", () => {
  const config = yealinkConfig("T53W", sip, { adminPassword: "unique-admin", provisioningPassword: "unique-provision" }, "https://example.com/api/phone-provisioning/805ec0112233/", "805ec0112233");
  assert.match(config, /^#!version:1.0.0.1\n/);
  assert.match(config, /account.1.password = canonical-secret/);
  assert.match(config, /security.user_password = admin:unique-admin/);
  assert.match(config, /linekey.2.value = 102/);
  assert.doesNotMatch(config, /firmware.url|factory_reset/);
  assert.throws(() => yealinkConfig("T53W", { ...sip, displayName: "x\naccount.1.password = hack" }, {} as any, "url", "mac"), /configuration_value/);
  assert.throws(() => managedModel("UNKNOWN"), /unsupported_model/);
  assert.equal(managedModel("T53W").capabilities.factoryReset, false);
});
test("BLF keys never exceed the model's physical line keys", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ extension: String(200 + i), label: `P${i}` }));
  const t31 = yealinkConfig("T31P", { ...sip, blf: many }, { adminPassword: "a", provisioningPassword: "p" }, "https://x/", "805ec0112233");
  assert.match(t31, /linekey.2.value = 200/);
  assert.doesNotMatch(t31, /linekey.3\./);
});

const assignment = { mac: "805ec0112233", serialNumber: "SN-TEST-0001", serverId: "server", uniqueServerUrl: "https://example.com/provision/", authName: "phone", password: "test-only" };
test("RPS reconciles success after timeout without duplicate add; rejects other ownership/assignment", async () => {
  const fake = new RpsSimulator(); const client = fake.client(); fake.failNext = "timeout_after_add";
  await assert.rejects(client.assign(assignment), /retry_to_reconcile/);
  assert.equal((await client.assign(assignment)).state, "assigned");
  assert.equal(fake.calls.filter(p => p === "rps/devices").length, 1);
  await assert.rejects(client.assign({ ...assignment, serverId: "different" }), /conflict/);
  fake.foreign.add("805ec0112234");
  await assert.rejects(client.assign({ ...assignment, mac: "805ec0112234" }), /ownership_conflict/);
  await client.release(assignment.mac, assignment.serverId, assignment.uniqueServerUrl);
  await client.release(assignment.mac, assignment.serverId, assignment.uniqueServerUrl);
  assert.equal(fake.devices.size, 0);
});
test("assign requires a serial and uses the SN device endpoint, never the forbidden MAC-only add", async () => {
  const fake = new RpsSimulator(); const client = fake.client();
  // No serial → refused before any network call (RPS forbids a MAC-only claim).
  await assert.rejects(client.assign({ ...assignment, serialNumber: "" }), /serial_number_required/);
  assert.equal(fake.calls.length, 0);
  // With serial → SN-based add (rps/devices, 201), never rps/addDevicesByMac (403).
  assert.equal((await client.assign(assignment)).state, "assigned");
  assert.equal(fake.calls.filter(p => p === "rps/devices").length, 1);
  assert.equal(fake.calls.filter(p => p === "rps/addDevicesByMac").length, 0);
});
test("checkMac reports our devices; a foreign MAC is honestly unknown until an add is attempted", async () => {
  const fake = new RpsSimulator(); const client = fake.client();
  await client.assign(assignment);
  assert.deepEqual(await client.checkMac(assignment.mac), { existed: true, self: true });
  fake.foreign.add("805ec0112234");
  // v2 only ever shows OUR devices: a MAC held elsewhere reads as absent, never as self:false.
  assert.deepEqual(await client.checkMac("805ec0112234"), { existed: false, self: null });
});
for (const status of [401, 403, 429, 500]) test(`RPS ${status} is actionable and never exposes upstream body`, async () => {
  const fake = new RpsSimulator(); fake.fail(status, status === 401 ? 2 : 1);
  await assert.rejects(fake.client().assign(assignment), e => e instanceof DeviceError && !e.message.includes("secret-never") && e.status === 503);
});
test("server create requires a url and appears in the listing", async () => {
  const fake = new RpsSimulator(); const client = fake.client();
  await assert.rejects(client.addServer({ serverName: "Loopcom", url: "" }), /rps_request_rejected_check_account/);
  const server: any = await client.addServer({ serverName: "Loopcom", url: "https://example.com/" });
  const listed = await client.listServers();
  assert.equal((listed.data ?? []).find((s: any) => s.id === server.id)?.serverName, "Loopcom");
});
