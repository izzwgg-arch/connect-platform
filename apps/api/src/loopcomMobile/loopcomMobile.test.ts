/**
 * LoopCom Mobile — tests.
 *
 * Three layers, in the order the failures would bite:
 *   1. pure money math (plan proration, overage, usage totals, spike
 *      detection — deterministic and idempotent, so a billing job that runs
 *      twice cannot double-bill)
 *   2. the wireless client against a FAKE fetch — request shape, and the one
 *      behaviour that costs money if wrong: an eSIM purchase that times out
 *      is NOT re-sent — plus real Ed25519 webhook signature verification
 *      (fail-closed: tampered body, stale timestamp, wrong key all refuse)
 *   3. SOURCE guards on the wiring — routes registered in server.ts with BOTH
 *      permission-prefix rules, every console route gates on the owner,
 *      tenant routes derive the tenant from the JWT, the webhook is on the
 *      public bypass but fails closed in-handler, the nav/catalog/toggle
 *      contract holds on both sides, and the test glob itself is registered
 *      (the documented unregistered-test trap).
 *
 * ⛔ Nothing here calls Telnyx. Every mutating call there costs money.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import {
  buildMobileBillingLineItems,
  computeDataOverageCents,
  computeUsageTotals,
  detectUsageSpike,
  projectCycleDataMb,
  type MobilePlanShape,
} from "./mobilePlanMath";
import { purchaseEsims, listSimCards, mapSimCard } from "./telnyxWirelessClient";
import { setTelnyxFetch, TelnyxError } from "../telnyx/telnyxClient";
import { verifyTelnyxSignature, ed25519KeyFromBase64 } from "./mobileWebhookRoutes";
import { shouldSkipJwtVerification } from "../jwtPublicRouteBypass";

const src = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const rootFile = (rel: string) => readFileSync(path.join(__dirname, "..", "..", rel), "utf8").replace(/\r\n/g, "\n");
const repoFile = (rel: string) => readFileSync(path.join(__dirname, "..", "..", "..", "..", rel), "utf8").replace(/\r\n/g, "\n");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const CREDS = { apiKey: "KEY0123456789abcdef0123456789", publicKey: null } as any;

const PLAN: MobilePlanShape = {
  id: "p1", name: "Business 5GB", monthlyPriceCents: 2500, activationFeeCents: 1000,
  simFeeCents: 0, esimFeeCents: 0, includedDataMb: 5 * 1024, includedVoiceMinutes: null,
  includedSms: null, dataOverageBehavior: "charge", dataOverageCentsPerGb: 800,
};

// ── 1. money math ────────────────────────────────────────────────────────────

test("usage totals split by kind and ignore garbage", () => {
  const t = computeUsageTotals([
    { kind: "data", quantity: 100.5 },
    { kind: "data", quantity: 50 },
    { kind: "voice", quantity: 60 },
    { kind: "sms", quantity: 3 },
    { kind: "data", quantity: NaN as any },
    { kind: "data", quantity: -5 },
  ]);
  assert.equal(t.dataMb, 150.5);
  assert.equal(t.voiceSeconds, 60);
  assert.equal(t.smsCount, 3);
});

test("data overage: block plans owe nothing, charge plans round up to the cent", () => {
  const blocked = computeDataOverageCents({ ...PLAN, dataOverageBehavior: "block" }, 9999);
  assert.equal(blocked.overageCents, 0);
  const none = computeDataOverageCents(PLAN, 4000);
  assert.equal(none.overageCents, 0);
  const some = computeDataOverageCents(PLAN, 5 * 1024 + 512); // 0.5 GB over at $8/GB
  assert.equal(some.overageCents, 400);
  const tiny = computeDataOverageCents(PLAN, 5 * 1024 + 1); // 1 MB over — rounds UP
  assert.equal(tiny.overageCents, 1);
});

test("projection is straight-line and clamps outside the cycle", () => {
  const start = new Date("2026-09-01T00:00:00Z");
  const end = new Date("2026-10-01T00:00:00Z");
  const mid = new Date("2026-09-16T00:00:00Z");
  assert.equal(projectCycleDataMb(1000, start, end, mid), 2000);
  assert.equal(projectCycleDataMb(1000, start, end, new Date("2026-08-01T00:00:00Z")), 1000);
});

test("billing recount: full month, proration, activation fee once, terminated lines drop off — and it is idempotent", () => {
  const period = { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-10-01T00:00:00Z") };
  const lines = [
    { lineId: "a", label: "A", status: "active", plan: PLAN, activatedAt: new Date("2026-08-01T00:00:00Z"), terminatedAt: null, usedDataMb: 0 },
    { lineId: "b", label: "B", status: "active", plan: PLAN, activatedAt: new Date("2026-09-16T00:00:00Z"), terminatedAt: null, usedDataMb: 0 },
    { lineId: "c", label: "C", status: "terminated", plan: PLAN, activatedAt: new Date("2026-07-01T00:00:00Z"), terminatedAt: new Date("2026-08-15T00:00:00Z"), usedDataMb: 0 },
    { lineId: "d", label: "D", status: "suspended", plan: PLAN, activatedAt: new Date("2026-08-01T00:00:00Z"), terminatedAt: null, usedDataMb: 6 * 1024 },
    { lineId: "e", label: "E", status: "draft", plan: PLAN, activatedAt: null, terminatedAt: null, usedDataMb: 0 },
  ];
  const items = buildMobileBillingLineItems(lines, period);
  const again = buildMobileBillingLineItems(lines, period);
  assert.deepEqual(items, again); // ran twice -> identical recount, no double bill

  const a = items.filter((i) => i.lineId === "a");
  assert.equal(a.length, 1);
  assert.equal(a[0].amountCents, 2500); // full month, no activation fee (activated last month)

  const b = items.filter((i) => i.lineId === "b");
  assert.equal(b.length, 2); // prorated plan + activation fee (activated inside the period)
  const bPlan = b.find((i) => i.kind === "plan")!;
  assert.ok(bPlan.amountCents > 0 && bPlan.amountCents < 2500, `prorated, got ${bPlan.amountCents}`);
  assert.equal(b.find((i) => i.kind === "activation")!.amountCents, 1000);

  assert.equal(items.filter((i) => i.lineId === "c").length, 0); // ended before the period
  const d = items.filter((i) => i.lineId === "d");
  assert.ok(d.some((i) => i.kind === "plan")); // suspension holds the seat
  assert.equal(d.find((i) => i.kind === "data_overage")!.amountCents, 800); // 1 GB over
  assert.equal(items.filter((i) => i.lineId === "e").length, 0); // draft bills nothing
});

test("spike detection: floor, ratio, and the no-history case", () => {
  assert.equal(detectUsageSpike({ todayMb: 500, trailingDailyAvgMb: 10 }).spike, false); // under the 1 GB floor
  assert.equal(detectUsageSpike({ todayMb: 4000, trailingDailyAvgMb: 1000 }).spike, true);
  assert.equal(detectUsageSpike({ todayMb: 2500, trailingDailyAvgMb: 1000 }).spike, false);
  assert.equal(detectUsageSpike({ todayMb: 2000, trailingDailyAvgMb: 0 }).spike, true);
});

// ── 2. client against a fake fetch ───────────────────────────────────────────

function fakeFetch(handler: (url: string, init: any) => { status: number; body: any }) {
  const calls: Array<{ url: string; init: any }> = [];
  const fn = async (url: string, init: any) => {
    calls.push({ url, init });
    const out = handler(url, init);
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      text: async () => JSON.stringify(out.body),
      headers: { get: () => null },
    };
  };
  return { fn, calls };
}

test("purchaseEsims sends ONE request with the whitelabel body, and maps the SIM back", async () => {
  const { fn, calls } = fakeFetch(() => ({
    status: 202,
    body: { data: [{ id: "sim-1", type: "esim", status: { value: "standby" }, iccid: "8901", esim_installation_status: "released", voice_enabled: false }] },
  }));
  setTelnyxFetch(fn as any);
  try {
    const sims = await purchaseEsims(CREDS, { amount: 1, whitelabelName: "LoopCom", simCardGroupId: "g1", status: "standby", tags: ["tenant:t1"] });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/actions/purchase/esims"));
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body, { amount: 1, sim_card_group_id: "g1", product: "whitelabel", whitelabel_name: "LoopCom", status: "standby", tags: ["tenant:t1"] });
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${CREDS.apiKey}`);
    assert.equal(sims[0].id, "sim-1");
    assert.equal(sims[0].esimInstallationStatus, "released");
  } finally {
    setTelnyxFetch(null);
  }
});

test("a purchase that times out is NOT re-sent", async () => {
  let attempts = 0;
  setTelnyxFetch((async () => {
    attempts += 1;
    const err: any = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }) as any);
  try {
    await assert.rejects(
      () => purchaseEsims(CREDS, { amount: 1 }),
      (err: any) => err instanceof TelnyxError && err.code === "timeout" && /MAY still have gone through/.test(err.userMessage),
    );
    assert.equal(attempts, 1);
  } finally {
    setTelnyxFetch(null);
  }
});

test("listSimCards maps data limits to MB and reads status.value", async () => {
  const { fn } = fakeFetch(() => ({
    status: 200,
    body: { data: [{ id: "s1", type: "esim", status: { value: "enabled" }, data_limit: { amount: "2", unit: "GB" }, current_billing_period_consumed_data: { amount: "512", unit: "MB" } }] },
  }));
  setTelnyxFetch(fn as any);
  try {
    const sims = await listSimCards(CREDS);
    assert.equal(sims[0].status, "enabled");
    assert.equal(sims[0].dataLimitMb, 2048);
    assert.equal(sims[0].currentPeriodDataMb, 512);
  } finally {
    setTelnyxFetch(null);
  }
});

test("mapSimCard survives a sparse record", () => {
  const sim = mapSimCard({ id: 42 });
  assert.equal(sim.id, "42");
  assert.equal(sim.dataLimitMb, null);
  assert.equal(sim.voiceEnabled, false);
});

// ── 2b. Ed25519 webhook verification (real crypto, fail-closed) ──────────────

function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { privateKey, publicKeyB64: der.subarray(der.length - 32).toString("base64") };
}

test("webhook signature: a genuine Telnyx-style signature verifies; everything else refuses", () => {
  const { privateKey, publicKeyB64 } = makeKeys();
  const body = JSON.stringify({ data: { id: "evt1", event_type: "sim_card.updated" } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = cryptoSign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString("base64");

  assert.equal(verifyTelnyxSignature({ publicKeyB64, signatureB64: signature, timestamp, rawBody: body }).ok, true);
  // tampered body
  assert.equal(verifyTelnyxSignature({ publicKeyB64, signatureB64: signature, timestamp, rawBody: body + " " }).ok, false);
  // stale timestamp (replay)
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  const oldSig = cryptoSign(null, Buffer.from(`${old}|${body}`), privateKey).toString("base64");
  const stale = verifyTelnyxSignature({ publicKeyB64, signatureB64: oldSig, timestamp: old, rawBody: body });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "stale_timestamp");
  // wrong key
  const other = makeKeys();
  assert.equal(verifyTelnyxSignature({ publicKeyB64: other.publicKeyB64, signatureB64: signature, timestamp, rawBody: body }).ok, false);
  // malformed key
  assert.equal(ed25519KeyFromBase64("not-a-key"), null);
});

test("the webhook path is on the JWT bypass (both hostname shapes)", () => {
  assert.equal(shouldSkipJwtVerification("/webhooks/telnyx/mobile"), true);
  assert.equal(shouldSkipJwtVerification("/api/webhooks/telnyx/mobile"), true);
  assert.equal(shouldSkipJwtVerification("/webhooks/telnyx/mobile-evil"), false);
});

// ── 3. source guards ─────────────────────────────────────────────────────────

test("server.ts registers the routes, the webhook door, both permission rules, and the sweeps", () => {
  // Raw source, NOT stripComments: server.ts is 42k lines and contains
  // string literals with "/*" that make the comment-stripper eat whole
  // regions (proven here — the guard matched nothing on a file that had the
  // code). The patterns below are code tokens, so comments can't fake them.
  const server = src("server.ts");
  assert.match(server, /registerLoopcomMobileRoutes\(\{/);
  assert.match(server, /registerMobileWebhookRoutes\(\{ app, db \}\)/);
  assert.match(server, /\{ prefix: "\/mobile-service", permission: "can_view_workspace_mobile" \}/);
  assert.match(server, /\{ prefix: "\/admin\/mobile-service", permission: "can_manage_global_settings" \}/);
  assert.match(server, /runMobileUsageSyncCycle\(db\)/);
  assert.match(server, /runMobileStateReconcileCycle\(db\)/);
});

test("every console route gates on the owner; every tenant route derives its tenant from the JWT", () => {
  const routes = stripComments(src("loopcomMobile/mobileRoutes.ts"));
  for (const m of routes.matchAll(/app\.(get|post|patch|delete)\("(\/[^"]+)"[\s\S]{0,400}?(?=app\.(?:get|post|patch|delete)\(|$)/g)) {
    const [block, , routePath] = m;
    if (routePath.startsWith("/admin/mobile-service")) {
      assert.match(block, /await requireOwner\(req, reply\)/, `console route ${routePath} must call requireOwner first`);
    } else if (routePath.startsWith("/mobile-service")) {
      assert.match(block, /tenantUser\(req, reply\)/, `tenant route ${routePath} must resolve the JWT tenant`);
    }
  }
  // No tenant id is ever read from a request body.
  assert.doesNotMatch(routes, /req\.body[^\n]*tenantId/, "tenantId must never come from the body on tenant routes");
  // The money route demands confirm:true and is not retried.
  assert.match(routes, /provisionBody = z\.object\(\{ confirm: z\.literal\(true\)/);
  assert.match(routes, /do not re-click/);
});

test("the webhook handler fails closed and declares rawBody", () => {
  const hook = src("loopcomMobile/mobileWebhookRoutes.ts");
  const stripped = stripComments(hook);
  assert.match(stripped, /config: \{ rawBody: true \}/);
  assert.match(stripped, /if \(!creds\?\.publicKey\) return reply\.code\(401\)/);
  assert.match(stripped, /if \(!signature \|\| !timestamp \|\| rawBody == null\) return reply\.code\(401\)/);
  assert.match(stripped, /if \(!verdict\.ok\) return reply\.code\(401\)/);
  // no NODE_ENV escape hatch
  assert.doesNotMatch(stripped, /NODE_ENV/);
});

test("no client-side retry wrapper crept into the wireless client, and no console.log leaks", () => {
  const client = stripComments(src("loopcomMobile/telnyxWirelessClient.ts"));
  assert.doesNotMatch(client, /for\s*\(.*attempt|retry|backoff/i, "mutating wireless calls must never retry");
  assert.doesNotMatch(client, /console\.log/);
  const routes = stripComments(src("loopcomMobile/mobileRoutes.ts"));
  assert.doesNotMatch(routes, /console\.log/);
  assert.doesNotMatch(routes, /activationCodeEnc[^\n]*reply\.send/, "the encrypted blob never leaves the server");
});

test("nav + catalog + toggle contract on both sides", () => {
  const nav = repoFile("apps/portal/navigation/navConfig.ts").replace(/\r\n/g, "\n");
  // Tenant page: own key, NO force line (granting the key is the launch).
  assert.match(nav, /id: "workspace\.mobile", href: "\/mobile"[^\n]*permission: "can_view_workspace_mobile"/);
  assert.doesNotMatch(stripComments(nav), /item\.id === "workspace\.mobile"/, "workspace.mobile must have no force line — the honesty rule");
  // Console: own key + force line + fixed list.
  assert.match(nav, /id: "admin\.mobile_console", href: "\/admin\/mobile-console"[^\n]*permission: "can_view_admin_mobile_console"/);
  assert.match(nav, /item\.id === "admin\.mobile_console" && backendJwtRole !== "SUPER_ADMIN"/);
  assert.match(nav, /"admin\.mobile_console",/);
  // Shared catalog rows exist with the same ids and keys.
  const catalog = repoFile("packages/shared/src/portalPermissions.ts").replace(/\r\n/g, "\n");
  assert.match(catalog, /id: "workspace\.mobile"[^\n]*permission: "can_view_workspace_mobile"/);
  assert.match(catalog, /id: "admin\.mobile_console"[^\n]*permission: "can_view_admin_mobile_console"/);
  // Launch gate: the tenant key is in NO default bucket.
  const buckets = stripComments(catalog);
  const bucketMentions = buckets.split("can_view_workspace_mobile").length - 1;
  assert.equal(bucketMentions, 1, "can_view_workspace_mobile must appear ONLY in its SIDEBAR_ITEMS row (no default bucket)");
});

test("this test file's glob is registered in apps/api/package.json", () => {
  const pkg = rootFile("package.json");
  assert.match(pkg, /src\/loopcomMobile\/\*\.test\.ts/);
});
