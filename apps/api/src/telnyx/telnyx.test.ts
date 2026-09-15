/**
 * Telnyx evaluation console — tests.
 *
 * Three layers, in the order the failures would bite:
 *   1. pure functions (credential shape check, URL build, error classing)
 *   2. the client against a FAKE fetch — request shape, response mapping, and
 *      the one behaviour that costs money if wrong: an order that times out
 *      is NOT re-sent
 *   3. SOURCE guards on the wiring — the routes are registered in server.ts
 *      with a permission rule, every console route gates on the owner, the
 *      module keeps its promise not to touch VoIP.ms / TenantSmsNumber /
 *      onboarding, the nav item exists and is SUPER_ADMIN-forced, and the
 *      test glob itself is registered in apps/api/package.json (the
 *      documented unregistered-test trap).
 *
 * ⛔ Nothing here calls Telnyx. Every mutating call there costs money.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  validateTelnyxCredentials,
  type StoredTelnyxCredentials,
} from "./telnyxCredentials";
import {
  TelnyxError,
  buildUrl,
  checkConnection,
  classifyError,
  listNumbers,
  orderNumber,
  searchNumbers,
  sendMessage,
  setTelnyxFetch,
} from "./telnyxClient";
import { shouldSkipJwtVerification } from "../jwtPublicRouteBypass";

const CREDS: StoredTelnyxCredentials = {
  apiKey: "KEY" + "0123456789abcdef".repeat(3),
  publicKey: null,
};

const src = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

// ── 1. Credentials ──────────────────────────────────────────────────────────

test("validateTelnyxCredentials refuses the mistakes that would otherwise read as a 401", () => {
  const good = validateTelnyxCredentials({ apiKey: CREDS.apiKey });
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.value.publicKey, null);

  const bad = (i: any) => { const r = validateTelnyxCredentials(i); assert.equal(r.ok, false); return r.ok ? "" : r.message; };
  assert.match(bad({ apiKey: "" }), /API key/);
  assert.match(bad({ apiKey: "short" }), /too short/);
  assert.match(bad({ apiKey: "X".repeat(40) }), /start with KEY/);
  assert.match(bad({ apiKey: "KEY with spaces and $ signs!" }), /characters/);
  assert.match(bad({ apiKey: CREDS.apiKey, publicKey: CREDS.apiKey }), /same value/);
  assert.match(bad({ apiKey: CREDS.apiKey, publicKey: "tiny" }), /too short/);

  const withKey = validateTelnyxCredentials({ apiKey: CREDS.apiKey, publicKey: "A".repeat(44) });
  assert.equal(withKey.ok && withKey.value.publicKey, "A".repeat(44));
});

// ── 2. Client (fake fetch) ──────────────────────────────────────────────────

test("buildUrl addresses api.telnyx.com/v2 and drops empty query values", () => {
  assert.equal(
    buildUrl({ path: "/available_phone_numbers", query: { "filter[national_destination_code]": "845", "filter[limit]": 20, "filter[locality]": undefined } }),
    "https://api.telnyx.com/v2/available_phone_numbers?filter%5Bnational_destination_code%5D=845&filter%5Blimit%5D=20",
  );
  assert.equal(buildUrl({ path: "/balance" }), "https://api.telnyx.com/v2/balance");
});

test("classifyError turns the status codes that matter into plain English (Telnyx {errors:[…]} shape)", () => {
  const mk = (status: number, data: any = null) => classifyError({ ok: false, status, data, text: null, url: "u" });
  assert.equal(mk(401).code, "unauthorized");
  assert.match(mk(401).userMessage, /API key/);
  assert.equal(mk(403, { errors: [{ title: "Forbidden", detail: "level too low" }] }).code, "forbidden");
  assert.match(mk(403, { errors: [{ title: "Forbidden" }] }).userMessage, /Trial/);
  assert.equal(mk(422, { errors: [{ title: "Invalid", detail: "phone_number is invalid" }] }).code, "invalid_request");
  assert.match(mk(422, { errors: [{ title: "Invalid", detail: "phone_number is invalid" }] }).userMessage, /phone_number is invalid/);
  assert.equal(mk(402).code, "payment_required");
  assert.equal(mk(503).code, "provider_error");
});

type FakeCall = { url: string; init: any };
function withFakeFetch(handler: (url: string, init: any) => { status: number; body: any } | Promise<{ status: number; body: any }>) {
  const calls: FakeCall[] = [];
  setTelnyxFetch(async (url: string, init: any) => {
    calls.push({ url: String(url), init });
    const r = await handler(String(url), init);
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => text,
      headers: { get: () => "application/json" },
    };
  });
  return { calls, restore: () => setTelnyxFetch(null) };
}

test("searchNumbers: filter query + Bearer auth + region/cost mapping", async () => {
  const f = withFakeFetch(() => ({ status: 200, body: { data: [
    {
      phone_number: "+18455550100",
      phone_number_type: "local",
      features: [{ name: "voice" }, { name: "sms" }],
      cost_information: { upfront_cost: "1.00", monthly_cost: "1.00" },
      region_information: [{ region_type: "state", region_name: "NY" }, { region_type: "location", region_name: "MONSEY" }],
    },
    { phone_number: "" },
  ] } }));
  try {
    const rows = await searchNumbers(CREDS, { areaCode: "845", contains: "55", numberType: "local", limit: 500 });
    assert.equal(f.calls.length, 1);
    const u = new URL(f.calls[0].url);
    assert.equal(u.pathname, "/v2/available_phone_numbers");
    assert.equal(u.searchParams.get("filter[national_destination_code]"), "845");
    assert.equal(u.searchParams.get("filter[phone_number][contains]"), "55");
    assert.equal(u.searchParams.get("filter[limit]"), "50", "the limit must be clamped to Telnyx's 50");
    assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${CREDS.apiKey}`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].region, "NY");
    assert.equal(rows[0].locality, "MONSEY");
    assert.deepEqual(rows[0].features, ["voice", "sms"]);
    assert.equal(rows[0].monthlyCost, "1.00");
  } finally { f.restore(); }
});

test("listNumbers maps connection / emergency / CNAM / tags off the phone_numbers row", async () => {
  const f = withFakeFetch(() => ({ status: 200, body: { data: [
    {
      id: 123, phone_number: "+18455550100", status: "active",
      connection_id: 3049, connection_name: "Loopcom-Primary-SIP",
      emergency_enabled: true, emergency_address_id: 77,
      cnam_listing_enabled: true, cnam_listing_details: "ABC PLUMBING",
      tags: ["tenant:abc"], customer_reference: "T102", created_at: "2026-09-15",
    },
  ] } }));
  try {
    const rows = await listNumbers(CREDS);
    assert.equal(rows.length, 1);
    const n = rows[0];
    assert.equal(n.id, "123");
    assert.equal(n.connectionId, "3049");
    assert.equal(n.connectionName, "Loopcom-Primary-SIP");
    assert.equal(n.emergencyEnabled, true);
    assert.equal(n.cnamListingDetails, "ABC PLUMBING");
    assert.deepEqual(n.tags, ["tenant:abc"]);
    assert.equal(n.customerReference, "T102");
  } finally { f.restore(); }
});

test("sendMessage posts JSON {from,to,text} to /messages", async () => {
  const f = withFakeFetch(() => ({ status: 200, body: { data: { id: "msg1" } } }));
  try {
    const r = await sendMessage(CREDS, "+18455557768", "+18455551212", "hi");
    const call = f.calls[0];
    assert.match(call.url, /\/v2\/messages$/);
    assert.equal(call.init.method, "POST");
    assert.deepEqual(JSON.parse(call.init.body), { from: "+18455557768", to: "+18455551212", text: "hi" });
    assert.equal(r.id, "msg1");
  } finally { f.restore(); }
});

test("⛔ orderNumber sends ONE request and never retries — a timeout is a TelnyxError(timeout), not a second purchase", async () => {
  let calls = 0;
  setTelnyxFetch(async () => { calls += 1; const e: any = new Error("aborted"); e.name = "AbortError"; throw e; });
  try {
    await assert.rejects(() => orderNumber(CREDS, "+18455550100"), (err: any) => err instanceof TelnyxError && err.code === "timeout");
    assert.equal(calls, 1);
  } finally { setTelnyxFetch(null); }
});

test("checkConnection is READ-only, and a numbers listing refused by account level still reports a live credential", async () => {
  const f = withFakeFetch((url) => {
    if (url.includes("/balance")) return { status: 200, body: { data: { balance: "5.00", currency: "USD" } } };
    return { status: 403, body: { errors: [{ title: "Forbidden" }] } };
  });
  try {
    const c = await checkConnection(CREDS);
    assert.equal(c.ok, true);
    assert.equal(c.balance, "5.00");
    assert.equal(c.ownedNumberCount, null);
    for (const call of f.calls) assert.equal((call.init.method ?? "GET"), "GET");
  } finally { f.restore(); }
});

// ── 3. SOURCE guards ────────────────────────────────────────────────────────

test("server.ts registers the routes and gives /admin/apps/telnyx a permission rule (not silently outside the global gate)", () => {
  // Positive matches, so no comment stripping: server.ts holds regex literals
  // that a naive stripper reads as an opening block comment.
  const server = src("server.ts");
  const has = (re: RegExp, what: string) => assert.ok(re.test(server), `server.ts is missing ${what}`);
  has(/import \{ registerTelnyxRoutes \} from "\.\/telnyx\/telnyxRoutes";/, "the import");
  has(/registerTelnyxRoutes\(\{\s*app,\s*db,\s*requireOwner: \(req, reply\) => requireSuperAdmin\(req, reply\),\s*\}\);/, "the registration with requireSuperAdmin as the owner gate");
  has(/\{ prefix: "\/admin\/apps\/telnyx", permission: "can_manage_global_settings" \}/, "the PORTAL_API_PERMISSION_RULES entry");
});

test("every /admin/apps/telnyx route calls requireOwner first, and nothing under it is on the JWT bypass list", () => {
  const routes = stripComments(src("telnyx/telnyxRoutes.ts"));
  const adminRoutes = routes.match(/app\.(get|post|put|patch|delete)\("\/admin\/apps\/telnyx[^"]*"/g) ?? [];
  assert.ok(adminRoutes.length >= 12, `expected the console routes, found ${adminRoutes.length}`);
  const parts = routes.split(/app\.(?:get|post|put|patch|delete)\("\/admin\/apps\/telnyx[^"]*"/).slice(1);
  for (const [i, part] of parts.entries()) {
    const head = part.slice(0, 220);
    assert.match(head, /const user = await requireOwner\(req, reply\);\s*if \(!user\) return;/, `route #${i + 1} (${adminRoutes[i]}) must gate on requireOwner`);
  }
  assert.equal(shouldSkipJwtVerification("/admin/apps/telnyx/status"), false);
  assert.equal(shouldSkipJwtVerification("/admin/apps/telnyx/numbers/order"), false);
});

test("⛔ the Telnyx module keeps its promise: it never touches VoIP.ms, TenantSmsNumber, onboarding or the worker, and never logs a secret", () => {
  for (const file of ["telnyx/telnyxRoutes.ts", "telnyx/telnyxClient.ts", "telnyx/telnyxCredentials.ts"]) {
    const s = stripComments(src(file));
    assert.doesNotMatch(s, /globalVoipMsConfig|voipMs[A-Z]|tenantSmsNumber|onboarding\/|@connect\/integrations|vms\(/, `${file} must stay off the VoIP.ms paths`);
    assert.doesNotMatch(s, /console\.log/, `${file} must not console.log (the API key would end up in docker logs)`);
  }
  const routes = stripComments(src("telnyx/telnyxRoutes.ts"));
  const auditCalls = routes.match(/recordTelnyxEvent\([\s\S]*?\)\;/g) ?? [];
  assert.ok(auditCalls.length >= 6, "the mutating routes must write audit rows");
  for (const c of auditCalls) assert.doesNotMatch(c, /apiKey|publicKey:\s*[a-z]/, `an audit row must never carry a secret: ${c.slice(0, 80)}`);
});

test("portal: the nav item exists, is SUPER_ADMIN-forced, and sits in the Locked (owner-only fixed) list", () => {
  const nav = readFileSync(path.join(__dirname, "..", "..", "..", "portal", "navigation", "navConfig.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.match(nav, /id: "apps\.telnyx", href: "\/apps\/telnyx"/);
  assert.match(nav, /item\.id === "apps\.telnyx" && backendJwtRole !== "SUPER_ADMIN"\) return false;/);
  const fixed = nav.match(/OWNER_ONLY_FIXED_NAV_ITEMS[^\]]*\]/)?.[0] ?? "";
  assert.match(fixed, /"apps\.telnyx"/, "apps.telnyx must be in OWNER_ONLY_FIXED_NAV_ITEMS so the role editor shows the honest Locked chip");
});

test("portal: the shared catalog carries the apps.telnyx row with its own key (the toggles rule)", () => {
  const shared = readFileSync(path.join(__dirname, "..", "..", "..", "..", "packages", "shared", "src", "portalPermissions.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.match(shared, /id: "apps\.telnyx"[^\n]*permission: "can_view_apps_telnyx"/);
});

test("⛔ this test file is REGISTERED: apps/api/package.json's test script globs src/telnyx", () => {
  // The documented unregistered-test trap (carrierMigration hit it): a test
  // file that no glob names passes by never running.
  const pkg = readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8");
  assert.match(pkg, /src\/telnyx\/\*\.test\.ts/);
});
