import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveWebrtcSipIdentity,
  buildVoiceProvisioningBundleFromIdentity,
  webrtcSipUri,
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
