/**
 * Wiring pins: the supermarket build is only live if server.ts actually
 * registers it, the permission rules actually gate it, the bypass list
 * actually admits its two public doors, and the sweeps are actually armed.
 * Every defect of this shape in this repo has been a CALLER omission a unit
 * test of the module passes straight through — so these tests read SOURCE.
 *
 * ⛔ Reads are CRLF-normalised (source-reading-tests-must-normalise-crlf) and
 * comments are NOT stripped for the positive matches (we assert executable
 * lines by their exact code shapes, which never appear in prose).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.join(__dirname, p), "utf8").replace(/\r\n/g, "\n");

const serverSrc = read("../server.ts");
const bypassSrc = read("../jwtPublicRouteBypass.ts");
const signingSrc = read("../urlSigningSecret.ts");
const permsSrc = readFileSync(
  path.join(__dirname, "../../../../packages/shared/src/portalPermissions.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

test("server.ts imports and registers the supermarket routes with real deps", () => {
  assert.match(serverSrc, /registerSupermarketRoutes/, "route module never registered");
  assert.match(serverSrc, /from "\.\/supermarket\/supermarketRoutes"/);
  assert.match(serverSrc, /await registerSupermarketRoutes\(\{/, "registration call missing");
  // the delivery tie-in and the driver invite must be REAL wiring, not stubs
  assert.match(serverSrc, /ingestDeliveryOrder/, "delivery ingest not passed");
  assert.match(serverSrc, /createUserPasswordToken/, "driver invite token minting not wired");
});

test("the CRM-mode enforcement hook is installed as a preHandler", () => {
  assert.match(serverSrc, /crmModeEnforcementHook/, "campaign wall not installed — supermarket tenants could still cold-call");
});

test("both sweeps are armed with boot kicks AND intervals, behind the kill switch", () => {
  assert.match(serverSrc, /runCatalogSyncSweep/);
  assert.match(serverSrc, /runDraftBuilderSweep/);
  assert.match(serverSrc, /SUPERMARKET_SWEEPS_DISABLED/, "no kill switch on the sweeps");
  assert.match(serverSrc, /SUPERMARKET_SWEEPS_ARMED/, "no armed boot line — the after-deploy check has nothing to grep");
  // ⛔ a bare setInterval with no boot kick is starved to nothing on a busy
  // deploy day (the voicemail watchdog's 67 silent minutes) — assert both.
  const armBlock = serverSrc.slice(serverSrc.indexOf("SUPERMARKET_SWEEPS_DISABLED"));
  const window = armBlock.slice(0, 2600);
  assert.match(window, /setTimeout/, "sweeps have no boot kick");
  assert.match(window, /setInterval/, "sweeps have no interval");
});

test("PORTAL_API_PERMISSION_RULES carries the three supermarket entries, mode-probe as authenticated-only", () => {
  assert.match(serverSrc, /\{ prefix: "\/supermarket", permission: "can_view_supermarket_orders" \}/);
  assert.match(serverSrc, /\{ prefix: "\/supermarket\/mode", permission: null \}/, "the mode probe must be reachable by every signed-in user or the order pop can never learn the tenant mode");
  assert.match(serverSrc, /\{ prefix: "\/admin\/integrations", permission: "can_manage_global_settings" \}/);
});

test("the two public doors are on the JWT bypass list — const AND the OR-chain", () => {
  assert.match(bypassSrc, /isInternalSupermarketPayIvrPath/);
  assert.match(bypassSrc, /\/internal\/supermarket\/pay-ivr\/step/);
  assert.match(bypassSrc, /isMarketingUnsubscribePath/);
  assert.match(bypassSrc, /\/marketing\/unsubscribe\//);
  // and both flags are actually consulted (an `|| flag` line — a const that is
  // declared but never OR'd leaves the door 401ing before its secret check)
  assert.match(bypassSrc, /\|\|\s*isInternalSupermarketPayIvrPath/, "pay-ivr const declared but never OR'd");
  assert.match(bypassSrc, /\|\|\s*isMarketingUnsubscribePath/, "unsubscribe const declared but never OR'd");
});

test("the marketing-unsubscribe signing scheme is registered in urlSigningSecret", () => {
  assert.match(signingSrc, /"marketing-unsubscribe"/);
  assert.match(signingSrc, /MARKETING_UNSUBSCRIBE_URL_SIGNING_SECRET/);
  assert.match(signingSrc, /marketing-unsubscribe-url-signing/);
});

test("the four supermarket permission keys are ACTION keys and sit in NO default bucket", () => {
  for (const key of [
    "can_view_supermarket_orders",
    "can_manage_supermarket_orders",
    "can_manage_supermarket_specials",
  ]) {
    assert.match(permsSrc, new RegExp(`"${key}"`), `${key} missing from portalPermissions`);
  }
  // absent from the default buckets: the keys appear only in ACTION_PERMISSION_KEYS
  const bucketsStart = permsSrc.indexOf("DEFAULT_ROLE_PERMISSIONS");
  if (bucketsStart >= 0) {
    const buckets = permsSrc.slice(bucketsStart);
    for (const key of ["can_view_supermarket_orders", "can_manage_supermarket_orders", "can_manage_supermarket_specials"]) {
      assert.ok(!buckets.includes(`"${key}"`), `${key} leaked into a default bucket — every tenant admin would get the supermarket surface`);
    }
  }
});

test("⛔ the per-tenant POS lane never falls back to a platform key", () => {
  const creds = read("./integrationCredentials.ts");
  // resolveIntegrationKey must be strictly tenant-scoped: no env fallback, no
  // cross-tenant findFirst without tenantId.
  assert.ok(!/process\.env\.POS/.test(creds), "an env fallback would bill one tenant's orders to another's key");
  assert.match(creds, /where: \{ tenantId, provider, isEnabled: true \}/, "the credential read must be pinned to the tenant's own row");
});

test("⛔ the submit path is the ONLY register-order writer in apps/api", () => {
  // createOrder may only ever be called from orderSubmit.ts — a second submit
  // path is how the two-IVR-publish-paths defect ships.
  const files = ["./supermarketRoutes.ts", "./draftBuilder.ts", "./catalogSync.ts", "./payIvrRuntime.ts"];
  for (const f of files) {
    const src = read(f).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!src.includes(".createOrder("), `${f} calls createOrder — the atomic-claim path in orderSubmit.ts is the only sanctioned submit`);
  }
  assert.match(read("./orderSubmit.ts"), /\.createOrder\(/);
});

test("⛔ the pay runtime never captures a card number: no card-collection prompts, charges only against stored cards", () => {
  const runtime = read("./payIvrRuntime.ts").replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const core = read("./payIvrCore.ts").replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const banned of ["card_number", "cardNumber", "collectCard", "cvv", "expir"]) {
    assert.ok(!runtime.includes(banned) && !core.includes(banned), `card-capture shape "${banned}" found — stored cards only, always`);
  }
  assert.match(runtime, /listCustomerCards/, "charging must resolve the STORED card");
});
