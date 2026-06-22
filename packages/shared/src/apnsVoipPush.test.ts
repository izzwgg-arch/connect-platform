import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import {
  isApnsVoipConfigured,
  describeApnsVoipConfig,
  sendApnsVoipPush,
} from "./apnsVoipPush";

const APNS_ENV_KEYS = [
  "APNS_TEAM_ID",
  "APNS_KEY_ID",
  "APNS_AUTH_KEY_P8",
  "APNS_AUTH_KEY_BASE64",
  "APNS_BUNDLE_ID",
  "APNS_VOIP_TOPIC",
  "APNS_PRODUCTION",
];

function clearApnsEnv() {
  for (const k of APNS_ENV_KEYS) delete process.env[k];
}

function makeP8(): string {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return privateKey as string;
}

test("unconfigured: isApnsVoipConfigured is false", () => {
  clearApnsEnv();
  assert.equal(isApnsVoipConfigured(), false);
});

test("unconfigured: sendApnsVoipPush resolves with apns_not_configured (no network)", async () => {
  clearApnsEnv();
  const result = await sendApnsVoipPush("deadbeef", {
    callId: "call-1",
    tenantId: "tenant-1",
    toExtension: "1001",
    callerNumber: "+15551234567",
    callerName: null,
    timestamp: new Date().toISOString(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "apns_not_configured");
  assert.equal(result.tokenInvalid, false);
});

test("topic defaults to <bundleId>.voip", () => {
  clearApnsEnv();
  process.env.APNS_BUNDLE_ID = "com.connectcommunications.mobile";
  const cfg = describeApnsVoipConfig();
  assert.equal(cfg.bundleId, "com.connectcommunications.mobile");
  assert.equal(cfg.topic, "com.connectcommunications.mobile.voip");
});

test("explicit APNS_VOIP_TOPIC overrides the derived topic", () => {
  clearApnsEnv();
  process.env.APNS_BUNDLE_ID = "com.connectcommunications.mobile";
  process.env.APNS_VOIP_TOPIC = "com.example.custom.voip";
  assert.equal(describeApnsVoipConfig().topic, "com.example.custom.voip");
});

test("host selects sandbox vs production via APNS_PRODUCTION", () => {
  clearApnsEnv();
  assert.match(describeApnsVoipConfig().host, /sandbox\.push\.apple\.com/);
  process.env.APNS_PRODUCTION = "true";
  assert.match(describeApnsVoipConfig().host, /^https:\/\/api\.push\.apple\.com/);
});

test("configured with a valid EC .p8 → isApnsVoipConfigured true", () => {
  clearApnsEnv();
  process.env.APNS_TEAM_ID = "ABCDE12345";
  process.env.APNS_KEY_ID = "KEY1234567";
  process.env.APNS_AUTH_KEY_P8 = makeP8();
  assert.equal(isApnsVoipConfigured(), true);
});

test("base64-encoded .p8 is accepted", () => {
  clearApnsEnv();
  process.env.APNS_TEAM_ID = "ABCDE12345";
  process.env.APNS_KEY_ID = "KEY1234567";
  process.env.APNS_AUTH_KEY_BASE64 = Buffer.from(makeP8(), "utf8").toString("base64");
  assert.equal(isApnsVoipConfigured(), true);
});
