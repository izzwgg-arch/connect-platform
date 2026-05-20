import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { SolaCardknoxAdapter, isApiKeyAuthError } from "@connect/integrations";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.PUBLIC_API_BASE_URL;
});

// ---------------------------------------------------------------------------
// testConnection — request shape
// ---------------------------------------------------------------------------

test("testConnection sends cc:auth with 0.00 amount (no monetary capture)", async () => {
  let parsedBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_url, init) => {
    parsedBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ xResult: "D", xStatus: "Declined", xError: "Declined", xErrorCode: "00050" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const adapter = new SolaCardknoxAdapter({
    baseUrl: "https://x1.cardknox.com",
    apiKey: "test_xkey",
    mode: "sandbox",
    simulate: false,
  });
  const out = await adapter.testConnection();
  assert.equal(out.simulated, false);
  assert.ok(parsedBody && typeof parsedBody === "object");
  const body = parsedBody as Record<string, unknown>;
  assert.equal(body.xCommand, "cc:auth");
  assert.equal(body.xAmount, "0.00");
  assert.equal(String(body.xKey || ""), "test_xkey");
  assert.equal(body.xVersion, "4.5.9");
  assert.equal(body.xversion, "4.5.9");
  assert.equal(body.xSoftwareName, "ConnectComms");
  assert.equal(body.xsoftwarename, "ConnectComms");
});

test("saveCardWithSut includes required xVersion on gatewayjson body", async () => {
  let parsedBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_url, init) => {
    parsedBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        xResult: "A",
        xStatus: "Approved",
        xRefNum: "999",
        xToken: "vault_tok_abc",
        xMaskedCardNumber: "xxxx4242",
        xCardType: "Visa",
        xExp: "1228",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const adapter = new SolaCardknoxAdapter({ apiKey: "test_xkey", simulate: false });
  const out = await adapter.saveCardWithSut({ sut: "sut_test_token_12345678", exp: "1228", cardholderName: "Jane", zip: "10950" });
  assert.equal(out.approved, true);
  assert.ok(parsedBody && typeof parsedBody === "object");
  const body = parsedBody as Record<string, unknown>;
  assert.equal(body.xCommand, "cc:save");
  assert.equal(body.xVersion, "4.5.9");
  assert.equal(body.xversion, "4.5.9");
  assert.equal(body.xCardNum, "sut_test_token_12345678");
  assert.equal(body.xExp, "1228");
  assert.equal(body.xSUT, undefined);
});

// ---------------------------------------------------------------------------
// testConnection — valid key, token-not-found response (xResult:E, code 01727)
// This is the primary scenario in production: a correct API key will receive
// xResult:"E" + xErrorCode:"01727" (Specified Token Not Found) because
// CONNECT_VALIDATION_PROBE is not a real token in the vault.
// testConnection must treat this as SUCCESS (key is valid).
// ---------------------------------------------------------------------------

test("testConnection succeeds when xResult:E + xErrorCode:01727 (token not found — key is valid)", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ xResult: "E", xStatus: "Error", xError: "Specified Token Not Found", xErrorCode: "01727" }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  const adapter = new SolaCardknoxAdapter({ apiKey: "valid_xkey", simulate: false });
  const out = await adapter.testConnection();
  assert.equal(out.ok, true);
  assert.equal(out.simulated, false);
});

test("testConnection succeeds when xResult:D (declined — key is valid)", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ xResult: "D", xStatus: "Declined", xError: "Declined", xErrorCode: "00050" }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  const adapter = new SolaCardknoxAdapter({ apiKey: "valid_xkey", simulate: false });
  const out = await adapter.testConnection();
  assert.equal(out.ok, true);
});

test("testConnection succeeds when xResult:A (approved — key is valid)", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ xResult: "A", xStatus: "Approved", xRefNum: "12345" }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  const adapter = new SolaCardknoxAdapter({ apiKey: "valid_xkey", simulate: false });
  const out = await adapter.testConnection();
  assert.equal(out.ok, true);
});

// ---------------------------------------------------------------------------
// testConnection — invalid key (xResult:E + auth error codes/text)
// ---------------------------------------------------------------------------

test("testConnection throws on xResult:E + xErrorCode:01208 (Specified Key Not Found)", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ xResult: "E", xStatus: "Error", xError: "Specified Key Not Found", xErrorCode: "01208" }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  const adapter = new SolaCardknoxAdapter({ apiKey: "bad_key", simulate: false });
  await assert.rejects(
    () => adapter.testConnection(),
    (err: any) => {
      assert.equal(err.code, "SOLA_VALIDATION_FAILED");
      assert.equal(err.xResult, "E");
      assert.ok(String(err.xError || "").includes("Key Not Found"));
      assert.equal(err.xErrorCode, "01208");
      return true;
    }
  );
});

test("testConnection throws on xResult:E + xErrorCode:01082 (Login Failed)", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ xResult: "E", xStatus: "Error", xError: "Login Failed", xErrorCode: "01082" }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  const adapter = new SolaCardknoxAdapter({ apiKey: "bad_key", simulate: false });
  await assert.rejects(
    () => adapter.testConnection(),
    (err: any) => err.code === "SOLA_VALIDATION_FAILED"
  );
});

test("testConnection throws on xResult:E + text 'Invalid xKey' (no error code)", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ xResult: "E", xStatus: "Error", xError: "Invalid xKey" }),
      { status: 200, headers: { "content-type": "application/json" } }
    )) as typeof fetch;

  const adapter = new SolaCardknoxAdapter({ apiKey: "bad", simulate: false });
  await assert.rejects(
    () => adapter.testConnection(),
    (err: any) => err.code === "SOLA_VALIDATION_FAILED" && String(err.xError).includes("Invalid xKey")
  );
});

// backward-compat: old test text "Invalid Key"
test("testConnection throws on gateway xResult E (bad auth / config)", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ xResult: "E", xError: "Invalid Key" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  const adapter = new SolaCardknoxAdapter({
    baseUrl: "https://x1.cardknox.com",
    apiKey: "bad",
    mode: "sandbox",
    simulate: false,
  });
  await assert.rejects(() => adapter.testConnection(), (err: any) => /SOLA_VALIDATION_FAILED/i.test(String(err?.code || err?.message || "")));
});

// ---------------------------------------------------------------------------
// testConnection — simulated mode
// ---------------------------------------------------------------------------

test("testConnection simulated mode does not call fetch", async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 500 });
  }) as typeof fetch;

  const adapter = new SolaCardknoxAdapter({
    baseUrl: "https://x1.cardknox.com",
    apiKey: "x",
    mode: "sandbox",
    simulate: true,
  });
  const out = await adapter.testConnection();
  assert.equal(out.simulated, true);
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// isApiKeyAuthError helper
// ---------------------------------------------------------------------------

test("isApiKeyAuthError: error code 01208 is a key auth error", () => {
  assert.equal(isApiKeyAuthError("01208", "Specified Key Not Found"), true);
});

test("isApiKeyAuthError: error code 01727 is NOT a key auth error (token not found)", () => {
  assert.equal(isApiKeyAuthError("01727", "Specified Token Not Found"), false);
});

test("isApiKeyAuthError: text 'Invalid xKey' is a key auth error (no code)", () => {
  assert.equal(isApiKeyAuthError("", "Invalid xKey"), true);
});

test("isApiKeyAuthError: text 'Not Authorized' is a key auth error (no code)", () => {
  assert.equal(isApiKeyAuthError("", "Not Authorized"), true);
});

test("isApiKeyAuthError: generic declined error is not a key auth error", () => {
  assert.equal(isApiKeyAuthError("00050", "Do Not Honor"), false);
});
