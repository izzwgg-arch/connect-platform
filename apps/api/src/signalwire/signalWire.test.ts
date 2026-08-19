/**
 * SignalWire evaluation console — tests.
 *
 * Three layers, in the order the failures would bite:
 *   1. pure functions (credential shape check, webhook signature, URL rebuild)
 *   2. the client against a FAKE fetch — request shape per family, response
 *      mapping, and the one behaviour that costs money if wrong: a purchase
 *      that times out is NOT re-sent
 *   3. SOURCE guards on the wiring — the routes are registered, both public
 *      webhook paths are on the JWT bypass list, every console route gates on
 *      the owner, and the module keeps its promise not to touch VoIP.ms,
 *      TenantSmsNumber, onboarding or the worker.
 *
 * ⛔ Nothing here calls SignalWire. Every mutating call there costs money.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  normalizeSpaceUrl,
  validateSignalWireCredentials,
  type StoredSignalWireCredentials,
} from "./signalWireCredentials";
import {
  candidatePublicUrls,
  computeSignalWireSignature,
  explainRefusal,
  isSignalWireWebhookAuthorized,
} from "./signalWireWebhookAuth";
import {
  SignalWireError,
  buildUrl,
  checkConnection,
  classifyError,
  createSipEndpoint,
  purchaseNumber,
  searchNumbers,
  sendMessage,
} from "./signalWireClient";
import { resolvePublicApiBase, inboundSmsWebhookUrl } from "./signalWireRoutes";
import { shouldSkipJwtVerification } from "../jwtPublicRouteBypass";

const CREDS: StoredSignalWireCredentials = {
  spaceUrl: "loopcom.signalwire.com",
  projectId: "12345678-1234-1234-1234-123456789abc",
  apiToken: "PT" + "a".repeat(40),
  signingKey: "PSK_" + "b".repeat(30),
};

const src = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

// ── 1. Credentials ──────────────────────────────────────────────────────────

test("normalizeSpaceUrl accepts every form people paste and reduces it to the bare host", () => {
  assert.equal(normalizeSpaceUrl("loopcom"), "loopcom.signalwire.com");
  assert.equal(normalizeSpaceUrl("Loopcom.SignalWire.com"), "loopcom.signalwire.com");
  assert.equal(normalizeSpaceUrl("https://loopcom.signalwire.com/"), "loopcom.signalwire.com");
  assert.equal(normalizeSpaceUrl("https://loopcom.signalwire.com/dashboard/projects/x?y=1"), "loopcom.signalwire.com");
  assert.equal(normalizeSpaceUrl("loopcom.signalwire.com:443"), "loopcom.signalwire.com");
  assert.equal(normalizeSpaceUrl("evil.example.com"), null);
  assert.equal(normalizeSpaceUrl(""), null);
  assert.equal(normalizeSpaceUrl("loopcom.signalwire.com.evil.com"), null);
});

test("validateSignalWireCredentials refuses the mistakes that would otherwise read as a 401", () => {
  const good = validateSignalWireCredentials({ spaceUrl: "loopcom", projectId: CREDS.projectId, apiToken: CREDS.apiToken });
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.value.spaceUrl, "loopcom.signalwire.com");
    assert.equal(good.value.signingKey, null);
  }
  const bad = (i: any) => { const r = validateSignalWireCredentials(i); assert.equal(r.ok, false); return r.ok ? "" : r.message; };
  assert.match(bad({ spaceUrl: "", projectId: CREDS.projectId, apiToken: CREDS.apiToken }), /Space URL/);
  assert.match(bad({ spaceUrl: "loopcom", projectId: "not-a-uuid", apiToken: CREDS.apiToken }), /Project ID/);
  assert.match(bad({ spaceUrl: "loopcom", projectId: CREDS.projectId, apiToken: "short" }), /too short/);
  assert.match(bad({ spaceUrl: "loopcom", projectId: CREDS.projectId, apiToken: "X".repeat(40) }), /start with PT/);
  assert.match(bad({ spaceUrl: "loopcom", projectId: CREDS.projectId, apiToken: CREDS.projectId }), /start with PT|same/);
  assert.match(bad({ spaceUrl: "loopcom", projectId: CREDS.projectId, apiToken: CREDS.apiToken, signingKey: CREDS.apiToken }), /same value/);
  const withKey = validateSignalWireCredentials({ spaceUrl: "loopcom", projectId: CREDS.projectId, apiToken: CREDS.apiToken, signingKey: CREDS.signingKey });
  assert.equal(withKey.ok && withKey.value.signingKey, CREDS.signingKey);
});

// ── 2. Webhook signature ────────────────────────────────────────────────────

test("computeSignalWireSignature matches the Twilio reference vector (same scheme, signing key as HMAC key)", () => {
  // Twilio's published example: URL, sorted params concatenated, HMAC-SHA1
  // with the token "12345", base64.
  const sig = computeSignalWireSignature(
    "12345",
    "https://mycompany.com/myapp.php?foo=1&bar=2",
    { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" },
  );
  assert.equal(sig, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
});

test("webhook auth FAILS CLOSED: no key, no signature, wrong signature all refuse; the right one passes on any candidate URL", () => {
  const url = "https://app.connectcomunications.com/api/webhooks/signalwire/sms";
  const params = { From: "+18455551212", To: "+18455557768", Body: "hi", MessageSid: "abc" };
  const sig = computeSignalWireSignature(CREDS.signingKey!, url, params);

  assert.equal(isSignalWireWebhookAuthorized({ signingKey: null, signature: sig, candidateUrls: [url], params }), false);
  assert.equal(explainRefusal({ signingKey: "", signature: sig, candidateUrls: [url], params }), "no_signing_key");
  assert.equal(isSignalWireWebhookAuthorized({ signingKey: CREDS.signingKey, signature: "", candidateUrls: [url], params }), false);
  assert.equal(explainRefusal({ signingKey: CREDS.signingKey, signature: null, candidateUrls: [url], params }), "no_signature");
  assert.equal(isSignalWireWebhookAuthorized({ signingKey: CREDS.signingKey, signature: sig.slice(0, -2) + "==", candidateUrls: [url], params }), false);
  assert.equal(isSignalWireWebhookAuthorized({ signingKey: CREDS.signingKey, signature: sig, candidateUrls: [url], params: { ...params, Body: "tampered" } }), false);
  assert.equal(explainRefusal({ signingKey: CREDS.signingKey, signature: sig, candidateUrls: [url], params }), "signature_mismatch");
  // Wrong URL first, right URL second — the bare/prefixed ambiguity.
  assert.equal(isSignalWireWebhookAuthorized({ signingKey: CREDS.signingKey, signature: sig, candidateUrls: ["https://app.connectcomunications.com/webhooks/signalwire/sms", url], params }), true);
});

test("candidatePublicUrls rebuilds the URL SignalWire signed from what nginx forwarded — /api-prefixed first", () => {
  const urls = candidatePublicUrls({
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "app.loopcom.net", host: "api:3001" },
    url: "/webhooks/signalwire/sms?x=1",
  });
  assert.deepEqual(urls, ["https://app.loopcom.net/api/webhooks/signalwire/sms?x=1", "https://app.loopcom.net/webhooks/signalwire/sms?x=1"]);
  const already = candidatePublicUrls({ headers: { host: "app.connectcomunications.com" }, url: "/api/webhooks/signalwire/sms" });
  assert.equal(already[0], "https://app.connectcomunications.com/api/webhooks/signalwire/sms");
  assert.deepEqual(candidatePublicUrls({ headers: {}, url: "/x" }), []);
});

// ── 3. Client (fake fetch) ──────────────────────────────────────────────────

test("buildUrl addresses each API family on the Space with the right prefix", () => {
  assert.equal(buildUrl(CREDS, { family: "relay", path: "/phone_numbers/search", query: { areacode: "845", max_results: 25, city: undefined } }),
    "https://loopcom.signalwire.com/api/relay/rest/phone_numbers/search?areacode=845&max_results=25");
  assert.equal(buildUrl(CREDS, { family: "laml", path: "/Messages.json" }),
    `https://loopcom.signalwire.com/api/laml/2010-04-01/Accounts/${CREDS.projectId}/Messages.json`);
  assert.equal(buildUrl(CREDS, { family: "fabric", path: "/resources/sip_gateways" }), "https://loopcom.signalwire.com/api/fabric/resources/sip_gateways");
  assert.equal(buildUrl(CREDS, { family: "projects", path: "/projects" }), "https://loopcom.signalwire.com/api/projects");
});

test("classifyError turns the status codes that matter into plain English", () => {
  const mk = (status: number, data: any = null) => classifyError({ ok: false, status, data, text: null, url: "u" });
  assert.equal(mk(401).code, "unauthorized");
  assert.match(mk(401).userMessage, /Project ID and API token/);
  assert.equal(mk(403, { message: "Forbidden" }).code, "forbidden");
  assert.match(mk(403, { message: "Forbidden" }).userMessage, /scope/);
  assert.equal(mk(422, { errors: [{ detail: "number is invalid" }] }).code, "invalid_request");
  assert.match(mk(422, { errors: [{ detail: "number is invalid" }] }).userMessage, /number is invalid/);
  assert.equal(mk(402).code, "payment_required");
  assert.equal(mk(503).code, "provider_error");
});

type FakeCall = { url: string; init: any };
function withFakeFetch(handler: (url: string, init: any) => { status: number; body: any } | Promise<{ status: number; body: any }>) {
  const calls: FakeCall[] = [];
  const original = globalThis.fetch;
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url: String(url), init });
    const r = await handler(String(url), init);
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => { (globalThis as any).fetch = original; } };
}

test("searchNumbers: relay search query + capability mapping (array AND object shapes)", async () => {
  const f = withFakeFetch(() => ({ status: 200, body: { data: [
    { number: "+18455550100", region: "NY", city: "Monsey", rate_center: "SPRINGVLY", capabilities: ["voice", "sms", "mms"] },
    { number: "+18455550101", region: "NY", capabilities: { voice: true, sms: false, mms: false, fax: true } },
    { number: "" },
  ] } }));
  try {
    const rows = await searchNumbers(CREDS, { areaCode: "845", contains: "55", numberType: "local", maxResults: 500 });
    assert.equal(f.calls.length, 1);
    const u = new URL(f.calls[0].url);
    assert.equal(u.pathname, "/api/relay/rest/phone_numbers/search");
    assert.equal(u.searchParams.get("areacode"), "845");
    assert.equal(u.searchParams.get("contains"), "55");
    assert.equal(u.searchParams.get("max_results"), "100");
    assert.equal(f.calls[0].init.headers.authorization, "Basic " + Buffer.from(`${CREDS.projectId}:${CREDS.apiToken}`).toString("base64"));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].capabilities, { voice: true, sms: true, mms: true, fax: false });
    assert.deepEqual(rows[1].capabilities, { voice: true, sms: false, mms: false, fax: true });
  } finally { f.restore(); }
});

test("sendMessage posts the Compatibility form (From/To/Body/StatusCallback) and maps the answer", async () => {
  const f = withFakeFetch(() => ({ status: 201, body: { sid: "M1", status: "queued", num_segments: "2", price: null } }));
  try {
    const r = await sendMessage(CREDS, { from: "+18455557768", to: "+18455551212", body: "hi", statusCallback: "https://x/api/webhooks/signalwire/sms-status" });
    const call = f.calls[0];
    assert.match(call.url, /\/api\/laml\/2010-04-01\/Accounts\/.+\/Messages\.json$/);
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers["content-type"], "application/x-www-form-urlencoded");
    const p = new URLSearchParams(call.init.body);
    assert.equal(p.get("From"), "+18455557768");
    assert.equal(p.get("To"), "+18455551212");
    assert.equal(p.get("Body"), "hi");
    assert.equal(p.get("StatusCallback"), "https://x/api/webhooks/signalwire/sms-status");
    assert.deepEqual({ sid: r.sid, status: r.status, numSegments: r.numSegments }, { sid: "M1", status: "queued", numSegments: 2 });
  } finally { f.restore(); }
});

test("⛔ purchaseNumber sends ONE request and never retries — a timeout is a SignalWireError(timeout), not a second purchase", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  (globalThis as any).fetch = async () => { calls += 1; const e: any = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; };
  try {
    await assert.rejects(() => purchaseNumber(CREDS, "+18455550100"), (err: any) => err instanceof SignalWireError && err.code === "timeout");
    assert.equal(calls, 1);
  } finally { (globalThis as any).fetch = original; }
});

test("createSipEndpoint tries Fabric first and falls back to the legacy relay path only on 404, reporting which answered", async () => {
  const f = withFakeFetch((url) => url.includes("/api/fabric/") ? { status: 404, body: { message: "not found" } } : { status: 201, body: { id: "ep1", username: "loopcom-pbx", call_handler: "passthrough" } });
  try {
    const ep = await createSipEndpoint(CREDS, { username: "loopcom-pbx", password: "x".repeat(20) });
    assert.equal(ep.via, "relay-legacy");
    assert.equal(ep.id, "ep1");
    assert.equal(f.calls.length, 2);
    assert.match(f.calls[0].url, /\/api\/fabric\/resources\/sip_endpoints$/);
    assert.match(f.calls[1].url, /\/api\/relay\/rest\/endpoints\/sip$/);
    // The password travels to SignalWire and nowhere else.
    assert.equal(JSON.parse(f.calls[0].init.body).password, "x".repeat(20));
  } finally { f.restore(); }
  const g = withFakeFetch(() => ({ status: 403, body: { message: "Forbidden" } }));
  try {
    await assert.rejects(() => createSipEndpoint(CREDS, { username: "u", password: "p".repeat(20) }), (err: any) => err.code === "forbidden");
    assert.equal(g.calls.length, 1, "a 403 must NOT fall back — the token lacks the scope on both paths");
  } finally { g.restore(); }
});

test("checkConnection is READ-only and separates 'numbers work' from 'messaging refused'", async () => {
  const f = withFakeFetch((url) => {
    if (url.includes("/phone_numbers")) return { status: 200, body: { data: [{ id: "n1", number: "+18455550100" }] } };
    if (url.includes("/api/laml/")) return { status: 403, body: { message: "Forbidden" } };
    if (url.includes("/api/projects")) return { status: 200, body: { data: [{ id: "p", subproject: true }, { id: "root" }] } };
    return { status: 500, body: {} };
  });
  try {
    const c = await checkConnection(CREDS);
    assert.equal(c.ok, true);
    assert.equal(c.numbersScope, true);
    assert.equal(c.lamlReachable, false);
    assert.match(c.message ?? "", /messaging API refused/);
    assert.equal(c.subprojectCount, 1);
    for (const call of f.calls) assert.equal((call.init.method ?? "GET"), "GET");
  } finally { f.restore(); }
});

// ── 4. Route helpers + SOURCE guards ────────────────────────────────────────

test("resolvePublicApiBase: trusts only an https origin from the client, always ends in /api", () => {
  assert.equal(resolvePublicApiBase("https://app.loopcom.net"), "https://app.loopcom.net/api");
  assert.equal(resolvePublicApiBase("https://app.loopcom.net/api/"), "https://app.loopcom.net/api");
  assert.equal(resolvePublicApiBase("http://evil.example.com"), "https://app.connectcomunications.com/api");
  assert.equal(resolvePublicApiBase("javascript:alert(1)"), "https://app.connectcomunications.com/api");
  assert.equal(inboundSmsWebhookUrl(resolvePublicApiBase(undefined)), "https://app.connectcomunications.com/api/webhooks/signalwire/sms");
});

test("both public webhook paths are on the JWT bypass list, and nothing else under /admin/apps/signalwire is", () => {
  assert.equal(shouldSkipJwtVerification("/webhooks/signalwire/sms"), true);
  assert.equal(shouldSkipJwtVerification("/api/webhooks/signalwire/sms"), true);
  assert.equal(shouldSkipJwtVerification("/webhooks/signalwire/sms-status"), true);
  assert.equal(shouldSkipJwtVerification("/admin/apps/signalwire/status"), false);
  assert.equal(shouldSkipJwtVerification("/admin/apps/signalwire/numbers/purchase"), false);
});

test("server.ts registers the routes and gives /admin/apps/signalwire a permission rule (not silently outside the global gate)", () => {
  // Positive matches, so no comment stripping: server.ts holds regex literals
  // that a naive stripper reads as an opening block comment.
  const server = src("server.ts");
  const has = (re: RegExp, what: string) => assert.ok(re.test(server), `server.ts is missing ${what}`);
  has(/import \{ registerSignalWireRoutes \} from "\.\/signalwire\/signalWireRoutes";/, "the import");
  has(/registerSignalWireRoutes\(\{\s*app,\s*db,\s*requireOwner: \(req, reply\) => requireSuperAdmin\(req, reply\),\s*\}\);/, "the registration with requireSuperAdmin as the owner gate");
  has(/\{ prefix: "\/admin\/apps\/signalwire", permission: "can_manage_global_settings" \}/, "the PORTAL_API_PERMISSION_RULES entry");
});

test("every /admin/apps/signalwire route calls requireOwner first; the webhooks do not", () => {
  const routes = stripComments(src("signalwire/signalWireRoutes.ts"));
  const adminRoutes = routes.match(/app\.(get|post|put|delete)\("\/admin\/apps\/signalwire[^"]*"/g) ?? [];
  assert.ok(adminRoutes.length >= 15, `expected the console routes, found ${adminRoutes.length}`);
  // Split the file at each admin route registration and check the handler
  // opens with the owner gate.
  const parts = routes.split(/app\.(?:get|post|put|delete)\("\/admin\/apps\/signalwire[^"]*"/).slice(1);
  for (const [i, part] of parts.entries()) {
    const head = part.slice(0, 220);
    assert.match(head, /const user = await requireOwner\(req, reply\);\s*if \(!user\) return;/, `route #${i + 1} (${adminRoutes[i]}) must gate on requireOwner`);
  }
  assert.match(routes, /app\.post\(SIGNALWIRE_INBOUND_SMS_PATH, inboundHandler\)/);
  assert.match(routes, /webhookGate\(req, reply, "inbound_sms"\)/);
});

test("⛔ the SignalWire module keeps its promise: it never touches VoIP.ms, TenantSmsNumber, onboarding or the worker, and never logs a secret", () => {
  for (const file of ["signalwire/signalWireRoutes.ts", "signalwire/signalWireClient.ts", "signalwire/signalWireCredentials.ts", "signalwire/signalWireWebhookAuth.ts"]) {
    const s = stripComments(src(file));
    assert.doesNotMatch(s, /globalVoipMsConfig|voipMs[A-Z]|tenantSmsNumber|onboarding\/|@connect\/integrations|vms\(/, `${file} must stay off the VoIP.ms paths`);
    assert.doesNotMatch(s, /console\.log/, `${file} must not console.log (a token or password would end up in docker logs)`);
  }
  const routes = stripComments(src("signalwire/signalWireRoutes.ts"));
  // The generated SIP password is returned once, never audited.
  const auditCalls = routes.match(/recordSignalWireEvent\([\s\S]*?\}\)/g) ?? [];
  for (const c of auditCalls) assert.doesNotMatch(c, /password|apiToken|signingKey:\s*[a-z]/i, `an audit row must never carry a secret: ${c.slice(0, 80)}`);
});

test("portal: the nav item exists and is forced SUPER_ADMIN-only", () => {
  const nav = readFileSync(path.join(__dirname, "..", "..", "..", "portal", "navigation", "navConfig.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.match(nav, /id: "apps\.signalwire", href: "\/apps\/signalwire"/);
  assert.match(nav, /item\.id === "apps\.signalwire" && backendJwtRole !== "SUPER_ADMIN"\) return false;/);
});

test("⛔ the registrar host is read from the SIP profile, never guessed from the Space name", () => {
  // Proven live 2026-08-18: loopcom.signalwire.com registers at
  // loopcom-ef2ea3442802.sip.signalwire.com. A `<space>.sip.signalwire.com`
  // guess registers nothing and reads exactly like a bad password.
  const routes = stripComments(src("signalwire/signalWireRoutes.ts"));
  assert.doesNotMatch(routes, /\.sip\.signalwire\.com`/, "routes must not build the registrar from the Space URL");
  assert.match(routes, /getSipProfile\(creds\)/);
  const client = stripComments(src("signalwire/signalWireClient.ts"));
  assert.match(client, /path: "\/sip_profile"/);
});
