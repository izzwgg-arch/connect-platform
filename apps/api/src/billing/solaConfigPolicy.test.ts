import test from "node:test";
import assert from "node:assert/strict";
import {
  adminPutPathOverridesSource,
  resolveSolaPutApiBaseUrl,
  resolveTenantPutAuthMode,
  solaEnableBlockedMissingProdPin,
  solaWebhookPinMissingForProd,
  tenantPutPathOverridesSource,
} from "./solaConfigPolicy";

test("solaWebhookPinMissingForProd: production requires non-empty PIN", () => {
  assert.equal(solaWebhookPinMissingForProd("prod", ""), true);
  assert.equal(solaWebhookPinMissingForProd("prod", "   "), true);
  assert.equal(solaWebhookPinMissingForProd("prod", null), true);
  assert.equal(solaWebhookPinMissingForProd("prod", "abc123"), false);
});

test("solaWebhookPinMissingForProd: sandbox allows empty PIN", () => {
  assert.equal(solaWebhookPinMissingForProd("sandbox", ""), false);
  assert.equal(solaWebhookPinMissingForProd("sandbox", undefined), false);
});

test("solaEnableBlockedMissingProdPin", () => {
  assert.equal(solaEnableBlockedMissingProdPin("SANDBOX", ""), false);
  assert.equal(solaEnableBlockedMissingProdPin("PROD", ""), true);
  assert.equal(solaEnableBlockedMissingProdPin("PROD", "pin"), false);
});

test("resolveSolaPutApiBaseUrl: omitted input preserves existing", () => {
  assert.equal(resolveSolaPutApiBaseUrl(undefined, "https://existing.example/gw"), "https://existing.example/gw");
  assert.equal(resolveSolaPutApiBaseUrl(null, "https://existing.example/gw"), "https://existing.example/gw");
  assert.equal(resolveSolaPutApiBaseUrl("  ", "https://existing.example/gw"), "https://existing.example/gw");
});

test("resolveSolaPutApiBaseUrl: explicit input wins", () => {
  assert.equal(resolveSolaPutApiBaseUrl("https://new.example", "https://old.example"), "https://new.example");
});

test("tenantPutPathOverridesSource preserves existing when input omitted", () => {
  const existing = { transactionPath: "/custom", hostedSessionPath: "/hosted" };
  assert.deepEqual(tenantPutPathOverridesSource(undefined, existing), existing);
});

test("tenantPutPathOverridesSource replaces when input provided", () => {
  const existing = { transactionPath: "/old" };
  assert.deepEqual(tenantPutPathOverridesSource({ transactionPath: "/new" }, existing), { transactionPath: "/new" });
});

test("adminPutPathOverridesSource preserves existing when input omitted", () => {
  const existing = { transactionPath: "/admin-custom" };
  assert.deepEqual(adminPutPathOverridesSource(undefined, existing), existing);
});

test("resolveTenantPutAuthMode preserves existing auth when input omitted", () => {
  assert.equal(resolveTenantPutAuthMode(undefined, "AUTHORIZATION_HEADER"), "authorization_header");
  assert.equal(resolveTenantPutAuthMode(undefined, "XKEY_BODY"), "xkey_body");
  assert.equal(resolveTenantPutAuthMode(undefined, null), "xkey_body");
});

test("resolveTenantPutAuthMode uses explicit input", () => {
  assert.equal(resolveTenantPutAuthMode("authorization_header", "XKEY_BODY"), "authorization_header");
});
