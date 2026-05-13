import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { SolaCardknoxAdapter } from "@connect/integrations";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.PUBLIC_API_BASE_URL;
});

test("testConnection sends cc:auth with 0.00 amount (no monetary capture)", async () => {
  let parsedBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_url, init) => {
    parsedBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ xResult: "D", xError: "Declined" }), {
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
});

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
  await assert.rejects(() => adapter.testConnection(), (err: any) => /SOLA_GATEWAY_ERROR|Invalid Key/i.test(String(err?.message || err)));
});

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
