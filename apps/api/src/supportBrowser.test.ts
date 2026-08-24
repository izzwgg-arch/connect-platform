/**
 * The Workbench browser — the SSRF fence, and what the agent gets to see.
 *
 * ⛔ The fence tests are the load-bearing half. `app-api-1` sits on the docker
 * network beside Postgres, Redis and the PBX credential; a fetch tool inside it
 * that could be pointed anywhere is a server-side request forgery hole aimed at
 * production. Everything in the "refuses" block below is an attack, not a
 * hypothetical — this repo has already shipped an SSRF where the string that
 * was validated was not the string that was dialled.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BROWSABLE_HOSTS,
  MAX_PAGE_BYTES,
  checkBrowsableUrl,
  openPage,
  parsePage,
} from "./supportBrowser";

// ─────────────────────────────── the fence ───────────────────────────────

test("opens Loopcom's own hostnames", () => {
  for (const host of BROWSABLE_HOSTS) {
    const scheme = host.includes(":") ? "http" : "https";
    const out = checkBrowsableUrl(`${scheme}://${host}/login`);
    assert.equal(out.ok, true, `${host} should be browsable`);
  }
});

test("⛔ refuses every address that is not ours", () => {
  const hostile = [
    "https://example.com/",
    "https://evil.app.loopcom.net.attacker.com/",       // suffix trick
    "https://app.loopcom.net.attacker.com/",            // the classic
    "http://169.254.169.254/latest/meta-data/",         // cloud metadata
    "http://127.0.0.1:5432/",                           // the database's neighbour
    "http://localhost:3001/internal/agent/investigate",
    "http://api:3001/internal/agent/workbench",          // the api's own door
    "http://connectcomms-postgres:5432/",
    "http://209.145.60.79/",                            // the PBX
  ];
  for (const url of hostile) {
    const out = checkBrowsableUrl(url);
    assert.equal(out.ok, false, `SSRF: ${url} was allowed`);
  }
});

test("⛔ the api's own origin is NOT browsable — a confused deputy is not a feature", () => {
  // Reaching the api through the PUBLIC hostname is fine: that path goes out
  // through nginx and lands on the JWT hook and the /api/internal/ deny. From
  // INSIDE the network there is no such gate, which is the whole difference.
  assert.equal(checkBrowsableUrl("http://api:3001/health").ok, false);
  assert.equal(checkBrowsableUrl("https://app.loopcom.net/api/health").ok, true);
});

test("⛔ only http and https — no file:, data: or gopher:", () => {
  for (const url of ["file:///etc/passwd", "data:text/html,<h1>x", "gopher://app.loopcom.net/"]) {
    assert.equal(checkBrowsableUrl(url).ok, false, `${url} was allowed`);
  }
});

test("⛔ an address carrying credentials is refused", () => {
  assert.equal(checkBrowsableUrl("https://user:pass@app.loopcom.net/").ok, false);
});

test("⛔ host, not hostname — the port is part of the allowlist", () => {
  assert.equal(checkBrowsableUrl("http://portal:3000/login").ok, true);
  assert.equal(checkBrowsableUrl("http://portal:9999/login").ok, false);
  assert.equal(checkBrowsableUrl("http://portal/login").ok, false);
});

test("the refusal names what IS allowed, so it can be acted on", () => {
  const out = checkBrowsableUrl("https://example.com/");
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.reason, /app\.loopcom\.net/);
});

test("blank and unparseable addresses are refused in plain English", () => {
  for (const bad of ["", "   ", "not a url", "://"]) {
    const out = checkBrowsableUrl(bad);
    assert.equal(out.ok, false);
    if (!out.ok) assert.ok(out.reason.length > 10, "a refusal must explain itself");
  }
});

// ───────────────────────── redirects, per hop ─────────────────────────

function fakeFetch(steps: Array<{ status: number; headers?: Record<string, string>; body?: string }>) {
  let i = 0;
  const seen: string[] = [];
  const impl = (async (url: string) => {
    seen.push(String(url));
    const step = steps[Math.min(i++, steps.length - 1)];
    return {
      status: step.status,
      ok: step.status >= 200 && step.status < 300,
      headers: { get: (k: string) => step.headers?.[k.toLowerCase()] ?? null },
      body: null,
      text: async () => step.body ?? "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, seen };
}

test("⛔ a redirect OFF Loopcom is refused — every hop is re-validated", async () => {
  const { impl, seen } = fakeFetch([
    { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } },
    { status: 200, body: "<html>secrets</html>" },
  ]);
  const out = await openPage("https://app.loopcom.net/go", { fetchImpl: impl });
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.reason, /redirected off Loopcom/i);
  // The crucial assertion: the second address was NEVER dialled.
  assert.equal(seen.length, 1, "the browser followed a redirect it had not validated");
});

test("a redirect to another Loopcom page is followed", async () => {
  const { impl, seen } = fakeFetch([
    { status: 302, headers: { location: "/login" } },
    { status: 200, headers: { "content-type": "text/html" }, body: "<title>Sign in</title>" },
  ]);
  const out = await openPage("https://app.loopcom.net/", { fetchImpl: impl });
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.page.finalUrl, "https://app.loopcom.net/login");
    assert.equal(out.page.title, "Sign in");
  }
  assert.equal(seen.length, 2);
});

test("⛔ a redirect loop stops instead of spinning", async () => {
  const { impl } = fakeFetch([{ status: 302, headers: { location: "https://app.loopcom.net/a" } }]);
  const out = await openPage("https://app.loopcom.net/", { fetchImpl: impl });
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.reason, /redirected more than/i);
});

test("⛔ no Authorization and no Cookie header is ever sent", async () => {
  let sentHeaders: any = null;
  const impl = (async (_url: string, init: any) => {
    sentHeaders = init?.headers ?? {};
    return {
      status: 200, ok: true,
      headers: { get: () => "text/html" },
      body: null,
      text: async () => "<html></html>",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  await openPage("https://app.loopcom.net/", { fetchImpl: impl });
  const keys = Object.keys(sentHeaders).map((k) => k.toLowerCase());
  assert.ok(!keys.includes("authorization"), "the browser must never sign in");
  assert.ok(!keys.includes("cookie"), "the browser must never carry a session");
});

// ─────────────────────────── what it reads back ───────────────────────────

test("pulls out the things a diagnostician asks about", () => {
  const p = parsePage(`
    <html><head><title>  Invoice  1024 </title>
    <script src="/_next/static/chunks/main-abc.js"></script></head>
    <body>
      <h1>Invoice</h1><h2>Bill from</h2>
      <p>Loopcom LLC &amp; co</p>
      <a href="/pay/invoice/tok">Pay now</a>
      <form action="/pay" method="POST"><input name="card"><input name="cvv"></form>
      <style>.x{color:red}</style>
    </body></html>`);
  assert.equal(p.title, "Invoice 1024");
  assert.deepEqual(p.headings, [{ level: 1, text: "Invoice" }, { level: 2, text: "Bill from" }]);
  assert.equal(p.links[0].href, "/pay/invoice/tok");
  assert.equal(p.forms[0].method, "post");
  assert.deepEqual(p.forms[0].fields, ["card", "cvv"]);
  assert.equal(p.scripts[0], "/_next/static/chunks/main-abc.js");
  // Entities decoded, script and style content gone from the visible text.
  assert.match(p.text, /Loopcom LLC & co/);
  assert.ok(!p.text.includes("color:red"), "stylesheet text leaked into the page text");
});

test("⛔ a client-rendered shell is LABELLED, not reported as a blank page", () => {
  // The documented /login trap: curl-and-grep on a Next client page proves
  // nothing either way. Saying so is what stops the model concluding the deploy
  // is broken.
  const p = parsePage(`<html><head><title>Loopcom</title></head><body><div id="__next"></div><script src="/x.js"></script></body></html>`);
  assert.equal(p.clientRendered, true);
  const real = parsePage(`<html><body><p>${"word ".repeat(200)}</p></body></html>`);
  assert.equal(real.clientRendered, false);
});

test("a page with no title reports null rather than inventing one", () => {
  assert.equal(parsePage("<html><body>hi</body></html>").title, null);
  assert.equal(parsePage("<html><head><title>   </title></head></html>").title, null);
});

test("a huge page is capped and says so", async () => {
  const impl = (async () => ({
    status: 200, ok: true,
    headers: { get: () => "text/html" },
    body: null,
    text: async () => "x".repeat(MAX_PAGE_BYTES + 5_000),
  } as unknown as Response)) as unknown as typeof fetch;
  const out = await openPage("https://app.loopcom.net/big", { fetchImpl: impl });
  assert.equal(out.ok, true);
  if (out.ok) assert.equal(out.page.truncated, true);
});

test("a page that does not answer is a plain-English failure, never a throw", async () => {
  const impl = (async () => { throw new Error("The operation was aborted due to timeout"); }) as unknown as typeof fetch;
  const out = await openPage("https://app.loopcom.net/slow", { fetchImpl: impl, timeoutMs: 1000 });
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.reason, /did.?n.?t answer within/i);
});

test("a 404 is a RESULT, not an error — the status is what you asked for", async () => {
  const impl = (async () => ({
    status: 404, ok: false,
    headers: { get: () => "text/html" },
    body: null,
    text: async () => "<title>Not found</title>",
  } as unknown as Response)) as unknown as typeof fetch;
  const out = await openPage("https://app.loopcom.net/nope", { fetchImpl: impl });
  assert.equal(out.ok, true, "a 404 page must still be readable — that IS the finding");
  if (out.ok) {
    assert.equal(out.page.status, 404);
    assert.equal(out.page.ok, false);
  }
});
