import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { configuredRps, DeviceError, rpsSignature, strictMac, YealinkRpsClient } from "./yealinkRps";
import { managedModel, yealinkConfig } from "./yealinkConfig";
import { RpsSimulator, sip } from "./yealinkRpsSimulator";

test("MAC input forms normalize; malformed, multicast and zero addresses refuse", () => {
  for (const m of ["80:5E:C0:11:22:33", "80-5E-C0-11-22-33", "805EC0112233", "805ec0112233"])
    assert.equal(strictMac(m), "805ec0112233");
  for (const m of ["805ec0112233ZZ", "80:5e-c0:11:22:33", "ffffffffffff", "000000000000", "015ec0112233", "805ec0112233\nkey=x", "../805ec0112233"])
    assert.throws(() => strictMac(m), /invalid_mac/);
});
test("official signing algorithm; MD5 uses exact serialized bytes, GET has no MD5", () => {
  const key = "example-key", secret = "example-secret";
  const headers = rpsSignature("POST", "api/open/v1/server/list", key, secret, '{"key":"TestServer","skip":0}', {}, "nonce", "1544008291631");
  assert.equal(headers["Content-MD5"], "SsPhq3/DEuS3yHj3kYOV9w==");
  assert.equal(rpsSignature("POST", "api/open/v1/server/list", key, secret, "abc")["Content-MD5"], "kAFQmDzST7DWlj99KOF/cg==");
  const expected = "POST\nContent-MD5:SsPhq3/DEuS3yHj3kYOV9w==\nX-Ca-Key:example-key\nX-Ca-Nonce:nonce\nX-Ca-Timestamp:1544008291631\napi/open/v1/server/list";
  assert.equal(headers["X-Ca-Signature"], createHmac("sha256", secret).update(expected).digest("base64"));
  const get = rpsSignature("GET", "api/open/v1/device/checkMac", key, secret, undefined, { mac: "805ec0112233" }, "n", "1");
  assert.equal(get["Content-MD5"], undefined);
  assert.equal(get["X-Ca-Signature"], createHmac("sha256", secret).update("GET\nX-Ca-Key:example-key\nX-Ca-Nonce:n\nX-Ca-Timestamp:1\napi/open/v1/device/checkMac\nmac=805ec0112233").digest("base64"));
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

const assignment = { mac: "805ec0112233", serverId: "server", uniqueServerUrl: "https://example.com/provision/", authName: "phone", password: "test-only" };
test("RPS reconciles success after timeout without duplicate add; rejects other ownership/assignment", async () => {
  const fake = new RpsSimulator(); const client = fake.client(); fake.failNext = "timeout_after_add";
  await assert.rejects(client.assign(assignment), /retry_to_reconcile/);
  assert.equal((await client.assign(assignment)).state, "assigned");
  assert.equal(fake.calls.filter(p => p === "device/add").length, 1);
  await assert.rejects(client.assign({ ...assignment, serverId: "different" }), /conflict/);
  fake.foreign.add("805ec0112234");
  await assert.rejects(client.assign({ ...assignment, mac: "805ec0112234" }), /ownership_conflict/);
  await client.release(assignment.mac, assignment.serverId, assignment.uniqueServerUrl);
  await client.release(assignment.mac, assignment.serverId, assignment.uniqueServerUrl);
  assert.equal(fake.devices.size, 0);
});
for (const status of [401, 403, 429, 500]) test(`RPS ${status} is actionable and never exposes upstream body`, async () => {
  const fake = new RpsSimulator(); fake.failNext = status;
  await assert.rejects(fake.client().assign(assignment), e => e instanceof DeviceError && !e.message.includes("secret-never") && e.status === 503);
});
test("server lifecycle uses documented API operations", async () => {
  const fake = new RpsSimulator(); const client = fake.client();
  const server: any = await client.addServer({ serverName: "Loopcom", url: "https://example.com/" });
  assert.equal(await client.serverExists("Loopcom"), true);
  await client.editServer({ id: server.id, serverName: "Loopcom2", url: "https://example.com/" });
  assert.equal((await client.serverDetail(server.id) as any).serverName, "Loopcom2");
  await client.deleteServers([server.id]); assert.equal(fake.servers.size, 0);
});
