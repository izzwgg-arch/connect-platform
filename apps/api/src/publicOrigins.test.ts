/**
 * publicOrigins.ts — the one place apps/api knows its public hostnames — and
 * the guards that keep the platform flippable to Loopcom with ONE env change.
 *
 * ⛔ The tree sweep is the point: it reads every apps/api/src/*.ts with comments
 * stripped and fails if `app.connectcomunications.com` (or the mail domain)
 * appears as CODE anywhere but publicOrigins.ts. On 2026-08-19 that literal was
 * in ~30 places, eleven of them pay links with no env override — a Loopcom
 * cut-over would have left them pointing at a removed hostname.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  PLATFORM_PORTAL_HOSTS,
  DEFAULT_CANONICAL_PORTAL_ORIGIN,
  canonicalApiBase,
  canonicalPortalHost,
  canonicalPortalOrigin,
  oauthRedirectUriForRequest,
  platformBillingFromEmail,
  platformNoreplyEmail,
  platformSupportEmail,
  portalOriginForRequest,
  requestPortalOrigin,
} from "./publicOrigins";

const ENV_KEYS = [
  "PUBLIC_PORTAL_URL", "PORTAL_PUBLIC_URL", "CONNECT_APP_URL", "APP_PUBLIC_URL",
  "PUBLIC_API_BASE_URL", "API_PUBLIC_URL", "PUBLIC_API_URL",
  "PLATFORM_MAIL_DOMAIN", "PLATFORM_SUPPORT_EMAIL", "PLATFORM_BILLING_FROM_EMAIL", "PLATFORM_NOREPLY_EMAIL",
];
function withEnv(vals: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(vals)) if (v !== undefined) process.env[k] = v;
  try { fn(); } finally { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

// ─── canonical origins ────────────────────────────────────────────────────────

test("canonical: default is the current host; PUBLIC_PORTAL_URL flips it; trailing slashes stripped", () => {
  withEnv({}, () => {
    assert.equal(canonicalPortalOrigin(), DEFAULT_CANONICAL_PORTAL_ORIGIN);
    assert.equal(canonicalApiBase(), DEFAULT_CANONICAL_PORTAL_ORIGIN + "/api");
    assert.equal(canonicalPortalHost(), "app.connectcomunications.com");
  });
  withEnv({ PUBLIC_PORTAL_URL: "https://app.loopcom.net/" }, () => {
    assert.equal(canonicalPortalOrigin(), "https://app.loopcom.net");
    assert.equal(canonicalApiBase(), "https://app.loopcom.net/api", "the API base follows the portal unless set separately");
    assert.equal(canonicalPortalHost(), "app.loopcom.net");
  });
});

test("canonical: every legacy env name still works, in the documented order", () => {
  withEnv({ PORTAL_PUBLIC_URL: "https://a.example" }, () => assert.equal(canonicalPortalOrigin(), "https://a.example"));
  withEnv({ CONNECT_APP_URL: "https://b.example" }, () => assert.equal(canonicalPortalOrigin(), "https://b.example"));
  withEnv({ APP_PUBLIC_URL: "https://c.example" }, () => assert.equal(canonicalPortalOrigin(), "https://c.example"));
  withEnv({ PUBLIC_PORTAL_URL: "https://win.example", PORTAL_PUBLIC_URL: "https://lose.example" }, () => assert.equal(canonicalPortalOrigin(), "https://win.example"));
  withEnv({ PUBLIC_API_BASE_URL: "https://api.example/api/" }, () => assert.equal(canonicalApiBase(), "https://api.example/api"));
  withEnv({ API_PUBLIC_URL: "https://api2.example/api" }, () => assert.equal(canonicalApiBase(), "https://api2.example/api"));
});

// ─── request-host origins ─────────────────────────────────────────────────────

test("request origin: only OUR hosts count; a forged Host never mints a foreign link", () => {
  assert.equal(requestPortalOrigin({ headers: { host: "app.loopcom.net" } }), "https://app.loopcom.net");
  assert.equal(requestPortalOrigin({ headers: { host: "app.connectcomunications.com" } }), "https://app.connectcomunications.com");
  assert.equal(requestPortalOrigin({ headers: { "x-forwarded-host": "app.loopcom.net", host: "127.0.0.1:3001" } }), "https://app.loopcom.net", "X-Forwarded-Host wins over the upstream Host");
  assert.equal(requestPortalOrigin({ headers: { host: "APP.LOOPCOM.NET:443" } }), "https://app.loopcom.net", "case + port tolerant");
  assert.equal(requestPortalOrigin({ headers: { host: "evil.example" } }), null);
  assert.equal(requestPortalOrigin({ headers: { host: "app.loopcom.net.evil.example" } }), null);
  assert.equal(requestPortalOrigin({ headers: {} }), null);
  assert.equal(requestPortalOrigin(null), null);
  withEnv({}, () => {
    assert.equal(portalOriginForRequest({ headers: { host: "evil.example" } }), DEFAULT_CANONICAL_PORTAL_ORIGIN, "unknown host → canonical");
    assert.equal(portalOriginForRequest({ headers: { host: "app.loopcom.net" } }), "https://app.loopcom.net");
  });
});

test("both platform hostnames are registered", () => {
  assert.ok(PLATFORM_PORTAL_HOSTS.has("app.connectcomunications.com"));
  assert.ok(PLATFORM_PORTAL_HOSTS.has("app.loopcom.net"));
});

// ─── OAuth redirect ───────────────────────────────────────────────────────────

test("oauth redirect: keeps the REGISTERED PATH byte-for-byte and swaps only the origin for our hosts", () => {
  const registered = "https://app.connectcomunications.com/api/crm/email/oauth/callback?x=1";
  assert.equal(oauthRedirectUriForRequest({ headers: { host: "app.loopcom.net" } }, registered), "https://app.loopcom.net/api/crm/email/oauth/callback?x=1");
  assert.equal(oauthRedirectUriForRequest({ headers: { host: "app.connectcomunications.com" } }, registered), registered);
  assert.equal(oauthRedirectUriForRequest({ headers: { host: "evil.example" } }, registered), registered, "unknown host → the registered value, unchanged");
  assert.equal(oauthRedirectUriForRequest(null, registered), registered);
  assert.throws(() => oauthRedirectUriForRequest({ headers: { host: "app.loopcom.net" } }, ""), /oauth_redirect_uri_not_configured/);
});

// ─── mail identity ────────────────────────────────────────────────────────────

test("mail identity: defaults, domain flip, per-address override", () => {
  withEnv({}, () => {
    assert.equal(platformSupportEmail(), "support@connectcomunications.com");
    assert.equal(platformBillingFromEmail(), "billing@connectcomunications.com");
    assert.equal(platformNoreplyEmail(), "noreply@connectcomunications.com");
  });
  withEnv({ PLATFORM_MAIL_DOMAIN: "loopcom.net" }, () => {
    assert.equal(platformSupportEmail(), "support@loopcom.net");
    assert.equal(platformBillingFromEmail(), "billing@loopcom.net");
  });
  withEnv({ PLATFORM_MAIL_DOMAIN: "loopcom.net", PLATFORM_SUPPORT_EMAIL: "help@loopcom.net" }, () => {
    assert.equal(platformSupportEmail(), "help@loopcom.net");
    assert.equal(platformNoreplyEmail(), "noreply@loopcom.net");
  });
});

// ─── the tree sweep ───────────────────────────────────────────────────────────

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".orig")) out.push(p);
  }
  return out;
}

test("apps/api/src: the old hostname and mail domain appear as CODE only in publicOrigins.ts", () => {
  const files = walk(__dirname);
  const offenders: string[] = [];
  // The ONE legitimate survivor: sipPublicEndpoint.ts keeps the HISTORIC hardcoded
  // SIP URL as a named constant so it can recognise and migrate old tenant rows.
  // It is a value to compare against, not a link anyone is sent to.
  const ALLOWED = [{ file: "sipPublicEndpoint.ts", line: /LEGACY_SIP_WS_URL = "wss:\/\/app\.connectcomunications\.com\/sip"/ }];
  for (const f of files) {
    if (path.basename(f) === "publicOrigins.ts") continue;
    const src = stripComments(readFileSync(f, "utf8").replace(/\r\n/g, "\n"));
    if (/connectcomunications\.com/.test(src)) {
      const allow = ALLOWED.filter((a) => a.file === path.basename(f)).map((a) => a.line);
      const lines = src.split("\n").map((l, i) => [i + 1, l] as const)
        .filter(([, l]) => /connectcomunications\.com/.test(l) && !allow.some((re) => re.test(l)));
      if (lines.length === 0) continue;
      offenders.push(`${path.relative(__dirname, f)}: ${lines.map(([n, l]) => `L${n} ${l.trim().slice(0, 90)}`).join(" | ")}`);
    }
  }
  assert.deepEqual(offenders, [], "route every public origin / mail address through publicOrigins.ts:\n" + offenders.join("\n"));
});

// ─── the call sites (source guards) ───────────────────────────────────────────

const read = (rel: string) => stripComments(readFileSync(path.join(__dirname, rel), "utf8").replace(/\r\n/g, "\n"));

test("server.ts: /auth/signup is OFF by default and never grants a role from an email pattern", () => {
  const src = read("server.ts");
  const start = src.indexOf('app.post("/auth/signup"');
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf("return { token, user:", start));
  assert.ok(/PUBLIC_SIGNUP_ENABLED/.test(body), "signup must be gated behind PUBLIC_SIGNUP_ENABLED");
  assert.ok(/status\(404\)/.test(body), "a disabled signup answers 404 like an unrouted path");
  assert.ok(!/"ADMIN"/.test(body), "no ADMIN role may be minted by signup");
  assert.ok(/const role = "USER";/.test(body));
});

test("server.ts: the eleven pay/billing links and the SBC Origin headers use the canonical origin", () => {
  const src = read("server.ts");
  assert.ok(!/https:\/\/app\.connectcomunications\.com\/pay\/invoice\//.test(src));
  assert.ok((src.match(/\$\{canonicalPortalOrigin\(\)\}\/pay\/invoice\//g) || []).length >= 10, "expected ≥10 pay-link sites on canonicalPortalOrigin()");
  assert.ok(/Origin: canonicalPortalOrigin\(\)/.test(src));
  assert.ok(/canonicalPortalOrigin\(\)\}\/dashboard\/billing\?checkout=success/.test(src));
});

test("OAuth: email + drive routes derive the redirect from the request host", () => {
  for (const f of ["crm/emailRoutes.ts", "crm/driveRoutes.ts"]) {
    const src = read(f);
    assert.ok(!/redirectUri = requireEnv\("GOOGLE_OAUTH_REDIRECT_URI"\);/.test(src), f + " still reads the env directly");
    assert.equal((src.match(/oauthRedirectUriForRequest\(req, requireEnv\("GOOGLE_OAUTH_REDIRECT_URI"\)\)/g) || []).length, 2, f + " must resolve at BOTH start and exchange");
  }
});

test("billing: every portal-base helper is canonicalPortalOrigin()", () => {
  assert.ok(/return canonicalPortalOrigin\(\);/.test(read("billing/billingEmailLifecycle.ts")));
  assert.ok(/return canonicalPortalOrigin\(\);/.test(read("billing/routes.ts")));
  assert.ok(/const base = canonicalPortalOrigin\(\);/.test(read("billing/payLink.ts")));
  assert.ok(/const base = canonicalPortalOrigin\(\);/.test(read("billing/emailTemplates.ts")));
  assert.ok(/const base = canonicalPortalOrigin\(\);/.test(read("billing/serviceInterruption/serviceInterruptionRunner.ts")));
  assert.ok(/platformSupportEmail\(\)/.test(read("billing/pdf.ts")) && /platformWebsite\(\)/.test(read("billing/pdf.ts")));
});
