import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { billingSolaCardknoxWebhookUrl } from "./solaPublicUrls";
import { maskSolaSecretsForResponse } from "./solaConfigMasking";

afterEach(() => {
  delete process.env.PUBLIC_API_BASE_URL;
  delete process.env.PUBLIC_API_URL;
});

test("maskSolaSecretsForResponse masks API key and never returns raw PIN", () => {
  const masked = maskSolaSecretsForResponse({
    apiKey: "abcdefghijklmnop",
    apiSecret: "sec",
    webhookSecret: "super-secret-pin",
    ifieldsKey: "ifields_public_12345",
  });
  assert.ok(masked.apiKey && masked.apiKey.includes("*"), "api key should be partially masked");
  assert.equal(masked.apiSecret, "********");
  assert.equal(masked.webhookSecret, "********");
  assert.ok(!String(masked.webhookSecret || "").includes("super-secret"));
  assert.ok(masked.ifieldsKey && masked.ifieldsKey.includes("*"));
});

test("maskSolaSecretsForResponse returns nulls when secrets missing", () => {
  assert.deepEqual(maskSolaSecretsForResponse(null), {
    apiKey: null,
    apiSecret: null,
    webhookSecret: null,
    ifieldsKey: null,
  });
});

test("masked payload includes webhookUrl pattern without embedding secrets", () => {
  process.env.PUBLIC_API_BASE_URL = "https://api.example.com";
  const url = billingSolaCardknoxWebhookUrl();
  assert.equal(url, "https://api.example.com/webhooks/sola-cardknox");
  assert.ok(!url.toLowerCase().includes("secret"));
});
