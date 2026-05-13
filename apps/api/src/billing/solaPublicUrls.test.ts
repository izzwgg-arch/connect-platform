import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { billingSolaCardknoxWebhookUrl } from "./solaPublicUrls";

const KEYS = ["PUBLIC_API_BASE_URL", "PUBLIC_API_URL", "PUBLIC_PORTAL_URL"] as const;

afterEach(() => {
  for (const k of KEYS) {
    delete process.env[k];
  }
});

test("webhook URL prefers PUBLIC_API_BASE_URL over PUBLIC_API_URL", () => {
  process.env.PUBLIC_API_BASE_URL = "https://api-primary.example.com/";
  process.env.PUBLIC_API_URL = "https://should-not-win.example.com";
  assert.equal(billingSolaCardknoxWebhookUrl(), "https://api-primary.example.com/webhooks/sola-cardknox");
});

test("webhook URL uses PUBLIC_API_URL when PUBLIC_API_BASE_URL is unset", () => {
  process.env.PUBLIC_API_URL = "https://fallback-api.example.com";
  assert.equal(billingSolaCardknoxWebhookUrl(), "https://fallback-api.example.com/webhooks/sola-cardknox");
});

test("webhook URL falls back to PUBLIC_PORTAL_URL + /api when API env vars are unset", () => {
  process.env.PUBLIC_PORTAL_URL = "https://portal.example.com";
  assert.equal(billingSolaCardknoxWebhookUrl(), "https://portal.example.com/api/webhooks/sola-cardknox");
});
