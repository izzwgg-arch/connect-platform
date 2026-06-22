import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveWebrtcSipIdentity,
  buildVoiceProvisioningBundleFromIdentity,
  webrtcSipUri,
  isIpLiteralHost,
  hostnameIfFqdn,
  deriveCanonicalPbxHost,
  normalizeSipWsUrlHost,
  computeEndpointLiveHealth,
} from "./voiceProvisioningBundle";

const webrtcCfg = {
  sipWsUrl: "wss://m.connectcomunications.com:8089/ws",
  sipDomain: "m.connectcomunications.com",
  outboundProxy: null,
  iceServers: [],
  dtmfMode: "RFC2833",
};

test("Relax Tires T25_101_1: pbxDeviceName drives sipUsername and authUsername", () => {
  const link = { pbxSipUsername: "101_1", pbxDeviceName: "T25_101_1" };
  const identity = resolveWebrtcSipIdentity(link);
  assert.equal(identity.sipUsername, "T25_101_1");
  assert.equal(identity.authUsername, "T25_101_1");

  const bundle = buildVoiceProvisioningBundleFromIdentity(webrtcCfg, link, "secret");
  assert.equal(bundle.sipUsername, "T25_101_1");
  assert.equal(bundle.authUsername, "T25_101_1");
  assert.equal(webrtcSipUri(webrtcCfg.sipDomain, link), "sip:T25_101_1@m.connectcomunications.com");
});

test("when pbxDeviceName exists, provisioning sipUsername equals pbxDeviceName", () => {
  const link = { pbxSipUsername: "102_1", pbxDeviceName: "T30_102_1" };
  const bundle = buildVoiceProvisioningBundleFromIdentity(webrtcCfg, link, null);
  assert.equal(bundle.sipUsername, "T30_102_1");
  assert.equal(bundle.authUsername, "T30_102_1");
});

test("when pbxDeviceName is missing, fallback to pbxSipUsername", () => {
  const link = { pbxSipUsername: "1101", pbxDeviceName: null };
  const identity = resolveWebrtcSipIdentity(link);
  assert.equal(identity.sipUsername, "1101");
  assert.equal(identity.authUsername, "1101");

  const bundle = buildVoiceProvisioningBundleFromIdentity(webrtcCfg, link, "pw");
  assert.equal(bundle.sipUsername, "1101");
  assert.equal(bundle.authUsername, "1101");
});

test("when pbxDeviceName is empty string, fallback to pbxSipUsername", () => {
  const link = { pbxSipUsername: "desk01", pbxDeviceName: "  " };
  const identity = resolveWebrtcSipIdentity(link);
  assert.equal(identity.sipUsername, "desk01");
  assert.equal(identity.authUsername, "desk01");
});

test("JsSIP URI uses resolved sipUsername not raw pbxSipUsername", () => {
  assert.equal(
    webrtcSipUri("m.connectcomunications.com", { pbxSipUsername: "101_1", pbxDeviceName: "T25_101_1" }),
    "sip:T25_101_1@m.connectcomunications.com",
  );
});

// ── WS host normalization (regression: T33 stranded on wss://<ip>) ─────────────

test("isIpLiteralHost detects IPv4/IPv6 literals and not FQDNs", () => {
  assert.equal(isIpLiteralHost("209.145.60.79"), true);
  assert.equal(isIpLiteralHost("[::1]"), true);
  assert.equal(isIpLiteralHost("2001:db8::1"), true);
  assert.equal(isIpLiteralHost("m.connectcomunications.com"), false);
  assert.equal(isIpLiteralHost(""), false);
  assert.equal(isIpLiteralHost(null), false);
});

test("hostnameIfFqdn extracts FQDN from URLs and bare hosts, rejects IPs", () => {
  assert.equal(hostnameIfFqdn("https://m.connectcomunications.com"), "m.connectcomunications.com");
  assert.equal(hostnameIfFqdn("wss://m.connectcomunications.com:8089/ws"), "m.connectcomunications.com");
  assert.equal(hostnameIfFqdn("m.connectcomunications.com:8089"), "m.connectcomunications.com");
  assert.equal(hostnameIfFqdn("https://209.145.60.79"), null);
  assert.equal(hostnameIfFqdn("209.145.60.79"), null);
  assert.equal(hostnameIfFqdn(""), null);
});

test("deriveCanonicalPbxHost prefers sipDomain, then pbxDomain, then instance baseUrl, then env", () => {
  assert.equal(
    deriveCanonicalPbxHost({ sipDomain: "sip.example.com", pbxDomain: "pbx.example.com" }),
    "sip.example.com",
  );
  assert.equal(
    deriveCanonicalPbxHost({ sipDomain: "209.145.60.79", pbxInstanceBaseUrl: "https://m.connectcomunications.com" }),
    "m.connectcomunications.com",
  );
  assert.equal(
    deriveCanonicalPbxHost({ sipDomain: "1.2.3.4", pbxDomain: "5.6.7.8", envPublicHost: "fallback.example.com" }),
    "fallback.example.com",
  );
  assert.equal(deriveCanonicalPbxHost({ sipDomain: "1.2.3.4" }), null);
});

test("normalizeSipWsUrlHost rewrites IP host to canonical FQDN, preserving port/path", () => {
  assert.equal(
    normalizeSipWsUrlHost("wss://209.145.60.79:8089/ws", "m.connectcomunications.com"),
    "wss://m.connectcomunications.com:8089/ws",
  );
});

test("normalizeSipWsUrlHost leaves FQDN URLs untouched", () => {
  assert.equal(
    normalizeSipWsUrlHost("wss://m.connectcomunications.com:8089/ws", "other.example.com"),
    "wss://m.connectcomunications.com:8089/ws",
  );
  assert.equal(
    normalizeSipWsUrlHost("wss://app.connectcomunications.com/sip", "m.connectcomunications.com"),
    "wss://app.connectcomunications.com/sip",
  );
});

test("normalizeSipWsUrlHost is a no-op when no canonical host is known", () => {
  assert.equal(normalizeSipWsUrlHost("wss://209.145.60.79:8089/ws", null), "wss://209.145.60.79:8089/ws");
});

// ── computeEndpointLiveHealth: provisioned-but-never-live safeguard ────────────

test("PROVISIONED but PBX never reported a registration → warns to Apply Changes (the ext 104 / T30_104_1 case)", () => {
  const h = computeEndpointLiveHealth({
    provisionStatus: "PROVISIONED",
    endpoint: "T30_104_1",
    registration: null,
  });
  assert.equal(h.liveRegistration, "NEVER_REGISTERED");
  assert.equal(h.everRegistered, false);
  assert.ok(h.healthWarning, "expected a health warning");
  assert.match(h.healthWarning ?? "", /Apply Changes/i);
  assert.match(h.healthWarning ?? "", /T30_104_1/);
});

test("PROVISIONED and currently REGISTERED → live, no warning", () => {
  const h = computeEndpointLiveHealth({
    provisionStatus: "PROVISIONED",
    endpoint: "T21_101_1",
    registration: { status: "REGISTERED", lastRegisteredAt: new Date() },
  });
  assert.equal(h.liveRegistration, "LIVE");
  assert.equal(h.everRegistered, true);
  assert.equal(h.healthWarning, null);
});

test("PROVISIONED, registered before but offline now → no Apply-Changes warning (phone is just closed)", () => {
  const h = computeEndpointLiveHealth({
    provisionStatus: "PROVISIONED",
    endpoint: "T33_102_1",
    registration: { status: "UNREACHABLE", lastRegisteredAt: new Date(Date.now() - 3600_000) },
  });
  assert.equal(h.liveRegistration, "OFFLINE");
  assert.equal(h.everRegistered, true);
  assert.equal(h.healthWarning, null);
});

test("not PROVISIONED (PENDING) and never registered → no warning (nothing claims healthy)", () => {
  const h = computeEndpointLiveHealth({
    provisionStatus: "PENDING",
    endpoint: "T30_105_1",
    registration: null,
  });
  assert.equal(h.liveRegistration, "NEVER_REGISTERED");
  assert.equal(h.healthWarning, null);
});

test("no endpoint name → UNKNOWN, no warning", () => {
  const h = computeEndpointLiveHealth({ provisionStatus: "PROVISIONED", endpoint: null, registration: null });
  assert.equal(h.liveRegistration, "UNKNOWN");
  assert.equal(h.everRegistered, false);
  assert.equal(h.healthWarning, null);
});

test("status REGISTERED without lastRegisteredAt still counts as ever-registered (no false warning)", () => {
  const h = computeEndpointLiveHealth({
    provisionStatus: "PROVISIONED",
    endpoint: "T30_104_1",
    registration: { status: "REGISTERED", lastRegisteredAt: null },
  });
  assert.equal(h.liveRegistration, "LIVE");
  assert.equal(h.everRegistered, true);
  assert.equal(h.healthWarning, null);
});
