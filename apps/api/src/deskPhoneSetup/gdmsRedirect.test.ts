import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertRedirectConfigSafe, hostOf, isUnreachablePublicly, parseRedirectTargets,
} from "./gdmsRedirect";
import { GrandstreamProvider } from "./grandstreamProvider";
import { GdmsSimulator } from "./gdmsSimulator";

/** A real-shaped gs_provision config: P237 = provisioning server, P47 = SIP server. */
function cfg(opts: { prov?: string; sip?: string } = {}): string {
  const prov = opts.prov ?? "209.145.60.79/phoneprov/a70274ea0f143ca0";
  const sip = opts.sip ?? "209.145.60.79";
  return `<?xml version="1.0" encoding="UTF-8" ?>
<gs_provision version="1"><config version="1">
<P271>1</P271><P47>${sip}</P47><P212>2</P212>
<P237>${prov}</P237></config></gs_provision>`;
}

/* ── the fence ──────────────────────────────────────────────────────────────── */

test("parses the provisioning (P237) and SIP (P47) hosts out of a real config", () => {
  const t = parseRedirectTargets(cfg());
  assert.equal(t.provisioning, "209.145.60.79");
  assert.equal(t.sip, "209.145.60.79");
});

test("hostOf strips scheme, path, port and userinfo", () => {
  assert.equal(hostOf("209.145.60.79/phoneprov/abc"), "209.145.60.79");
  assert.equal(hostOf("m.connectcomunications.com:5060"), "m.connectcomunications.com");
  assert.equal(hostOf("https://user@Loopcom.NET/x"), "loopcom.net");
  assert.equal(hostOf(""), null);
});

test("the private/VPN/loopback address gate — the exact proven bug", () => {
  assert.equal(isUnreachablePublicly("10.8.0.1"), true, "Create A Box's VPN gateway");
  assert.equal(isUnreachablePublicly("192.168.6.1"), true);
  assert.equal(isUnreachablePublicly("172.20.0.5"), true);
  assert.equal(isUnreachablePublicly("127.0.0.1"), true);
  assert.equal(isUnreachablePublicly("169.254.1.1"), true);
  assert.equal(isUnreachablePublicly("100.100.0.1"), true, "CGNAT");
  assert.equal(isUnreachablePublicly("209.145.60.79"), false, "the real public PBX IP");
  assert.equal(isUnreachablePublicly("m.connectcomunications.com"), false, "a hostname is not judged here");
});

test("a clean config pointing at the public PBX passes", () => {
  assert.doesNotThrow(() => assertRedirectConfigSafe(cfg(), ["m.connectcomunications.com"]));
});

test("⛔ a config whose SIP server is a VPN address is REFUSED (the 10.8.0.1 bug)", () => {
  assert.throws(() => assertRedirectConfigSafe(cfg({ sip: "10.8.0.1" }), ["m.connectcomunications.com"]),
    /gdms_redirect_target_refused/);
});

test("⛔ a config whose PROVISIONING server is private is refused", () => {
  assert.throws(() => assertRedirectConfigSafe(cfg({ prov: "192.168.1.50/phoneprov/x" })), /gdms_redirect_target_refused/);
});

test("⛔ a config with NO provisioning server (P237) is refused — a redirect to nowhere", () => {
  const noProv = `<gs_provision version="1"><config><P47>209.145.60.79</P47></config></gs_provision>`;
  assert.throws(() => assertRedirectConfigSafe(noProv), /gdms_redirect_target_refused/);
});

test("⛔ a PUBLIC but look-alike provisioning host is refused when an allow-list is given", () => {
  assert.throws(() => assertRedirectConfigSafe(cfg({ prov: "m.connectcomunications.com.evil.com/p" }), ["m.connectcomunications.com"]),
    /gdms_redirect_target_refused/);
});

test("the tenant's own provisioning HOSTNAME passes the allow-list; a bare public IP always passes", () => {
  assert.doesNotThrow(() => assertRedirectConfigSafe(cfg({ prov: "m.connectcomunications.com/phoneprov/x", sip: "m.connectcomunications.com" }), ["m.connectcomunications.com"]));
  assert.doesNotThrow(() => assertRedirectConfigSafe(cfg(), [])); // no list → address gate only, public IP fine
});

test("a non-gs_provision blob is refused as invalid, never parsed as a config", () => {
  assert.throws(() => assertRedirectConfigSafe("<html>not a config</html>"), /gdms_config_xml_invalid/);
});

/* ── the delivery orchestrator, against the simulator ───────────────────────── */

function providerOn(sim: GdmsSimulator): GrandstreamProvider {
  // The same construction every other provider test uses — the simulator IS the cloud.
  return new GrandstreamProvider({ resolveCredentials: async () => sim.creds, request: sim.fetch as any, env: {} });
}

const MAC = "c074ad8c605f";
const SN = "20EZ115N308C605F";

test("deliverRedirect: an ONLINE claimed phone → delivered (config synchronised)", async () => {
  const sim = new GdmsSimulator();
  sim.devices.set(MAC, { mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1.0.11.64", status: "online", owner: "ours" });
  const out = await providerOn(sim).deliverRedirect({ mac: MAC, xml: cfg(), allowedHosts: ["m.connectcomunications.com"] });
  assert.deepEqual(out, { state: "delivered" });
  assert.equal(sim.pushedConfigs.has(MAC), true, "the config was actually pushed");
});

test("deliverRedirect: an OFFLINE phone → queued_offline, honest, still pushed for GDMS to hold", async () => {
  const sim = new GdmsSimulator();
  sim.devices.set(MAC, { mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1.0.11.64", status: "offline", owner: "ours" });
  const out = await providerOn(sim).deliverRedirect({ mac: MAC, xml: cfg(), allowedHosts: ["m.connectcomunications.com"] });
  assert.deepEqual(out, { state: "queued_offline" });
});

test("deliverRedirect: a phone not in our GDMS → not_claimed, and nothing is pushed", async () => {
  const sim = new GdmsSimulator();
  const out = await providerOn(sim).deliverRedirect({ mac: MAC, xml: cfg() });
  assert.deepEqual(out, { state: "not_claimed" });
  assert.equal(sim.configPushCalls, 0, "no push against a phone we do not manage");
});

test("⛔ deliverRedirect NEVER pushes a VPN-targeted config, even to an online phone", async () => {
  const sim = new GdmsSimulator();
  sim.devices.set(MAC, { mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1.0.11.64", status: "online", owner: "ours" });
  const out = await providerOn(sim).deliverRedirect({ mac: MAC, xml: cfg({ sip: "10.8.0.1" }), allowedHosts: ["m.connectcomunications.com"] });
  assert.equal(out.state, "refused");
  assert.equal((out as any).code, "gdms_redirect_target_refused");
  assert.equal(sim.configPushCalls, 0, "the fence stopped it before the cloud");
});

test("deviceStatus reads online + synchronized, both null when unknown", async () => {
  const sim = new GdmsSimulator();
  sim.devices.set(MAC, { mac: MAC, model: "GXP2170", sn: SN, firmwareVersion: "1.0.11.64", status: "online", owner: "ours" });
  const p = providerOn(sim);
  const before = await p.deviceStatus(MAC);
  assert.equal(before.found, true);
  assert.equal(before.online, true);
  assert.equal(before.synchronized, false);
  await p.deliverRedirect({ mac: MAC, xml: cfg(), allowedHosts: ["m.connectcomunications.com"] });
  const after = await p.deviceStatus(MAC);
  assert.equal(after.synchronized, true, "synchronised after the phone took the config");
});
