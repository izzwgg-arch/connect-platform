/**
 * Desk-set phone PIN vault (2026-09-17) — `GET/PUT/DELETE
 * /supermarket/customers/:posCustomerId/phone-pin` + `POST .../check`.
 *
 * Harness matches supermarketStress.test.ts: a real Fastify + real
 * @fastify/jwt + the real permission-prefix emulation, driven against
 * FakeDb/FakePos from supermarketTestKit (snapshot reads, honest
 * deleteMany counts, a POS register with documented 401/403 semantics).
 *
 * ⛔ The FakePos balance handler today answers a single `401 {"error":"bad
 * pin"}` for every PIN mismatch (whether the account has no PIN at all or
 * the wrong one) — another engineer is changing it to the register's real
 * two messages ("Customer PIN required." / "Invalid customer PIN."). Every
 * test below that drives the classification through FakePos is written to
 * pass under EITHER wording (asserting only what both share: a `pin_invalid`
 * outcome for a wrong-pin-with-account-known probe, never a stored row).
 * The one test that actually PINS the pin_not_set vs pin_invalid vs
 * register_unreachable split uses a hand-written client stub that returns
 * the real register bodies directly, independent of FakePos.
 *
 * Run: node --experimental-test-module-mocks --import tsx --test src/supermarket/phonePinRoutes.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import jwt from "@fastify/jwt";

process.env.JWT_SECRET = process.env.JWT_SECRET || "phone-pin-test-secret-0123456789abcdef00";
process.env.CREDENTIALS_MASTER_KEY = process.env.CREDENTIALS_MASTER_KEY || "cd".repeat(32);
process.env.CDR_INGEST_SECRET = process.env.CDR_INGEST_SECRET || "phone-pin-internal-secret-000111222333";

import { FakeDb, FakePos, makeSupermarketDb } from "./supermarketTestKit";
import { posClientForTenant, storeIntegrationKey } from "./integrationCredentials";
import { PosApiError } from "./posWithLogic";
import { registerSupermarketRoutes } from "./supermarketRoutes";
import { checkInternalSecret } from "../internalSecret";
import { shouldSkipJwtVerification } from "../jwtPublicRouteBypass";

async function seedPosTenant(db: FakeDb, tenantId: string, pos: FakePos) {
  db.seed("tenant", { id: tenantId, name: `Store ${tenantId}`, crmMode: "supermarket" });
  await storeIntegrationKey(db, {
    tenantId,
    provider: "POS_TRACKING",
    apiKey: pos.apiKey,
    actorUserId: `admin-${tenantId}`,
  });
}

/** Like the stress suite's clientForFactory, but a tenant can be pinned to a
 *  hand-written client object instead of a FakePos-backed real client — the
 *  only way to exercise the register's exact 401 message text without
 *  depending on which FakePos wording happens to be live. */
function clientForFactory(posByTenant: Map<string, FakePos>, stubs: Map<string, any> = new Map()) {
  return async (db: any, tenantId: string, deps: any = {}) => {
    if (stubs.has(tenantId)) return stubs.get(tenantId);
    const pos = posByTenant.get(tenantId);
    if (!pos) return null;
    return posClientForTenant(db, tenantId, { ...deps, fetchImpl: pos.fetchImpl });
  };
}

type AppKit = {
  app: any;
  db: FakeDb;
  posByTenant: Map<string, FakePos>;
  stubs: Map<string, any>;
  keyHolders: Map<string, Set<string>>;
  tokenFor: (u: { sub: string; tenantId: string; role: string }) => string;
};

const RULES: Array<{ prefix: string; permission: string | null }> = [
  { prefix: "/supermarket", permission: "can_view_supermarket_orders" },
  { prefix: "/supermarket/mode", permission: null },
];
function rulePermissionFor(path: string): string | null {
  const rule = RULES.filter((r) => path === r.prefix || path.startsWith(`${r.prefix}/`)).sort(
    (a, b) => b.prefix.length - a.prefix.length,
  )[0];
  return rule?.permission ?? null;
}

async function buildApp(): Promise<AppKit> {
  const db = makeSupermarketDb();
  const posByTenant = new Map<string, FakePos>();
  const stubs = new Map<string, any>();
  const keyHolders = new Map<string, Set<string>>();

  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  app.addHook("preHandler", async (req: any, reply: any) => {
    const path = String(req.url).split("?")[0];
    if (shouldSkipJwtVerification(path)) return;
    try {
      await req.jwtVerify();
    } catch {
      return reply.status(401).send({ error: "unauthorized" });
    }
    const needed = rulePermissionFor(path);
    if (needed) {
      const user = req.user as any;
      if (user.role !== "SUPER_ADMIN" && !keyHolders.get(user.sub)?.has(needed)) {
        return reply.status(403).send({ error: "forbidden" });
      }
    }
  });

  await registerSupermarketRoutes({
    app,
    db,
    requireOwner: async (req: any, reply: any) => {
      try {
        await req.jwtVerify();
      } catch {
        reply.status(401).send({ error: "unauthorized" });
        return null;
      }
      if ((req.user as any).role !== "SUPER_ADMIN") {
        reply.status(403).send({ error: "forbidden" });
        return null;
      }
      return req.user;
    },
    audit: async () => {},
    internalGuard: (req: any, reply: any, _endpoint: string) => {
      const verdict = checkInternalSecret(process.env.CDR_INGEST_SECRET, req.headers?.["x-cdr-secret"]);
      if (verdict.ok) return true;
      reply.code(verdict.status).send({ error: verdict.error });
      return false;
    },
    renderShell: (opts) => `<html><body><h1>${opts.headerTitle}</h1>${opts.body}</body></html>`,
    publicOrigin: () => "https://app.example.test",
    ingestDeliveryOrder: async () => ({ ok: true }),
    driverInvite: {
      createInviteToken: async () => ({ token: "tok-1" }),
      portalPublicUrl: (p) => `https://app.example.test${p}`,
      queueEmailJob: async () => {},
    },
    hasActionPermission: (async (user: any, key: string) => keyHolders.get(user.sub)?.has(key) ?? false) as any,
    clientFor: clientForFactory(posByTenant, stubs) as any,
  });

  const tokenFor = (u: { sub: string; tenantId: string; role: string }) => (app as any).jwt.sign(u);
  return { app, db, posByTenant, stubs, keyHolders, tokenFor };
}

const body = (r: any) => JSON.parse(r.body);
const h = (t: string) => ({ authorization: `Bearer ${t}` });

// ═════════════════════════ permission matrix ═════════════════════════════

test("phone-pin: permission matrix — viewer can GET, cannot PUT/DELETE/check", async () => {
  const { app, db, posByTenant, keyHolders, tokenFor } = await buildApp();
  const pos = new FakePos();
  posByTenant.set("t-a", pos);
  await seedPosTenant(db, "t-a", pos);
  db.seed("user", { id: "u-view", tenantId: "t-a", email: "v@x.com" });
  keyHolders.set("u-view", new Set(["can_view_supermarket_orders"]));
  const view = tokenFor({ sub: "u-view", tenantId: "t-a", role: "USER" });

  const get = await app.inject({ method: "GET", url: "/supermarket/customers/c1/phone-pin", headers: h(view) });
  assert.equal(get.statusCode, 200);
  assert.deepEqual(body(get), { enrolled: false, enrolledAt: null, lastUsedAt: null, phones: [] });

  const put = await app.inject({ method: "PUT", url: "/supermarket/customers/c1/phone-pin", headers: h(view), payload: { pin: "1234" } });
  assert.equal(put.statusCode, 403);

  const del = await app.inject({ method: "DELETE", url: "/supermarket/customers/c1/phone-pin", headers: h(view) });
  assert.equal(del.statusCode, 403);

  const check = await app.inject({ method: "POST", url: "/supermarket/customers/c1/phone-pin/check", headers: h(view) });
  assert.equal(check.statusCode, 403);
});

test("phone-pin: manage-keyed user can PUT/DELETE/check; anonymous is 401", async () => {
  const { app, db, posByTenant, keyHolders, tokenFor } = await buildApp();
  const pos = new FakePos();
  posByTenant.set("t-a", pos);
  await seedPosTenant(db, "t-a", pos);
  db.seed("user", { id: "u-manage", tenantId: "t-a", email: "m@x.com" });
  keyHolders.set("u-manage", new Set(["can_view_supermarket_orders", "can_manage_supermarket_orders"]));
  const manage = tokenFor({ sub: "u-manage", tenantId: "t-a", role: "USER" });

  assert.equal((await app.inject({ method: "GET", url: "/supermarket/customers/c1/phone-pin" })).statusCode, 401);
  assert.equal((await app.inject({ method: "PUT", url: "/supermarket/customers/c1/phone-pin", payload: { pin: "1" } })).statusCode, 401);

  // no account on the register at all → the balance probe 404s, which is
  // neither 401 nor 403, so classification falls to register_unreachable.
  const put = await app.inject({ method: "PUT", url: "/supermarket/customers/ghost/phone-pin", headers: h(manage), payload: { pin: "1234" } });
  assert.equal(put.statusCode, 200);
  assert.equal(body(put).ok, false);
  assert.equal(body(put).reason, "register_unreachable");

  const del = await app.inject({ method: "DELETE", url: "/supermarket/customers/ghost/phone-pin", headers: h(manage) });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(body(del), { ok: true, removed: 0 });
});

// ═════════════════════════ tenant isolation ═════════════════════════════

test("phone-pin: a foreign tenant's account reads back its OWN empty state, never another tenant's rows", async () => {
  const { app, db, posByTenant, keyHolders, tokenFor } = await buildApp();
  const posA = new FakePos();
  const posB = new FakePos();
  posByTenant.set("t-a", posA);
  posByTenant.set("t-b", posB);
  await seedPosTenant(db, "t-a", posA);
  await seedPosTenant(db, "t-b", posB);
  // same posCustomerId string exists under BOTH tenants, on purpose — the
  // vault key is (tenantId, posCustomerId, phoneE164), never posCustomerId alone.
  db.seed("supermarketPhonePin", {
    tenantId: "t-a",
    posCustomerId: "shared-id",
    phoneE164: "+18455551111",
    pinEnc: "opaque-a",
    lastUsedAt: null,
  });

  db.seed("user", { id: "u-b", tenantId: "t-b", email: "b@x.com" });
  keyHolders.set("u-b", new Set(["can_view_supermarket_orders"]));
  const tokenB = tokenFor({ sub: "u-b", tenantId: "t-b", role: "USER" });

  const res = await app.inject({ method: "GET", url: "/supermarket/customers/shared-id/phone-pin", headers: h(tokenB) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(body(res), { enrolled: false, enrolledAt: null, lastUsedAt: null, phones: [] });
});

test("phone-pin: DELETE removes only the calling tenant's rows for that account", async () => {
  const { app, db, posByTenant, keyHolders, tokenFor } = await buildApp();
  const posA = new FakePos();
  posByTenant.set("t-a", posA);
  await seedPosTenant(db, "t-a", posA);
  db.seed("tenant", { id: "t-b", crmMode: "supermarket" });

  db.seed("supermarketPhonePin", { tenantId: "t-a", posCustomerId: "c1", phoneE164: "+18455550001", pinEnc: "e1", lastUsedAt: null });
  db.seed("supermarketPhonePin", { tenantId: "t-a", posCustomerId: "c3", phoneE164: "+18455550003", pinEnc: "e3", lastUsedAt: null });
  db.seed("supermarketPhonePin", { tenantId: "t-b", posCustomerId: "c1", phoneE164: "+18455559999", pinEnc: "e-foreign", lastUsedAt: null });

  db.seed("user", { id: "u-manage", tenantId: "t-a", email: "m@x.com" });
  keyHolders.set("u-manage", new Set(["can_view_supermarket_orders", "can_manage_supermarket_orders"]));
  const manage = tokenFor({ sub: "u-manage", tenantId: "t-a", role: "USER" });

  const res = await app.inject({ method: "DELETE", url: "/supermarket/customers/c1/phone-pin", headers: h(manage) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(body(res), { ok: true, removed: 1 });

  const remaining = db.rows("supermarketPhonePin");
  assert.equal(remaining.length, 2, "t-a's c3 row and t-b's c1 row must both survive");
  assert.ok(remaining.some((r) => r.tenantId === "t-a" && r.posCustomerId === "c3"));
  assert.ok(remaining.some((r) => r.tenantId === "t-b" && r.posCustomerId === "c1"));
});

// ═════════════════════════ PUT verifies before storing ═══════════════════

test("phone-pin: PUT with the WRONG pin stores nothing and answers ok:false (works under either FakePos wording)", async () => {
  const { app, db, posByTenant, keyHolders, tokenFor } = await buildApp();
  const pos = new FakePos();
  posByTenant.set("t-a", pos);
  await seedPosTenant(db, "t-a", pos);
  pos.addCustomer({ id: "c1", phone10: "8455551234", pin: "4321", balanceCents: 1000, cards: [] });

  db.seed("user", { id: "u-manage", tenantId: "t-a", email: "m@x.com" });
  keyHolders.set("u-manage", new Set(["can_view_supermarket_orders", "can_manage_supermarket_orders"]));
  const manage = tokenFor({ sub: "u-manage", tenantId: "t-a", role: "USER" });

  const res = await app.inject({ method: "PUT", url: "/supermarket/customers/c1/phone-pin", headers: h(manage), payload: { pin: "0000" } });
  assert.equal(res.statusCode, 200);
  assert.equal(body(res).ok, false);
  assert.ok(["pin_not_set", "pin_invalid"].includes(body(res).reason), `unexpected reason ${body(res).reason}`);
  assert.equal(db.rows("supermarketPhonePin").length, 0, "a rejected PIN must never be stored");
});

test("phone-pin: invalid PIN shape (empty / too long) is rejected before any register call", async () => {
  const { app, db, posByTenant, keyHolders, tokenFor } = await buildApp();
  const pos = new FakePos();
  posByTenant.set("t-a", pos);
  await seedPosTenant(db, "t-a", pos);
  pos.addCustomer({ id: "c1", phone10: "8455551234", pin: "4321", balanceCents: 1000, cards: [] });

  db.seed("user", { id: "u-manage", tenantId: "t-a", email: "m@x.com" });
  keyHolders.set("u-manage", new Set(["can_view_supermarket_orders", "can_manage_supermarket_orders"]));
  const manage = tokenFor({ sub: "u-manage", tenantId: "t-a", role: "USER" });

  const empty = await app.inject({ method: "PUT", url: "/supermarket/customers/c1/phone-pin", headers: h(manage), payload: { pin: "" } });
  assert.equal(empty.statusCode, 400);
  const long = await app.inject({ method: "PUT", url: "/supermarket/customers/c1/phone-pin", headers: h(manage), payload: { pin: "123456789" } });
  assert.equal(long.statusCode, 400);
  assert.equal(pos.requestLog.length, 0, "a malformed PIN must never reach the register");
});

// ═════════════════════════ PUT success + read-back ═══════════════════════

test("phone-pin: PUT with the CORRECT pin enrolls, never echoes the PIN, and GET never returns pinEnc", async () => {
  const { app, db, posByTenant, keyHolders, tokenFor } = await buildApp();
  const pos = new FakePos();
  posByTenant.set("t-a", pos);
  await seedPosTenant(db, "t-a", pos);
  pos.addCustomer({ id: "c2", phone10: "8455551111", pin: "4321", balanceCents: 500, cards: [] });
  db.seed("posCustomer", {
    tenantId: "t-a",
    posCustomerId: "c2",
    firstName: "Sarah",
    lastName: "K",
    name: "Sarah K",
    primaryPhone: "8455551111",
    phonesText: "8455551111",
  });

  db.seed("user", { id: "u-manage", tenantId: "t-a", email: "m@x.com" });
  keyHolders.set("u-manage", new Set(["can_view_supermarket_orders", "can_manage_supermarket_orders"]));
  const manage = tokenFor({ sub: "u-manage", tenantId: "t-a", role: "USER" });

  const put = await app.inject({ method: "PUT", url: "/supermarket/customers/c2/phone-pin", headers: h(manage), payload: { pin: "4321" } });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(body(put), { ok: true, enrolled: true });
  assert.ok(!put.body.includes("4321"), "the PIN must never appear in the response");

  const rows = db.rows("supermarketPhonePin");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenantId, "t-a");
  assert.equal(rows[0].posCustomerId, "c2");
  assert.equal(rows[0].phoneE164, "+18455551111", "phoneE164 comes from the mirror's primary phone");
  assert.ok(typeof rows[0].pinEnc === "string" && rows[0].pinEnc.length > 0);
  assert.ok(!rows[0].pinEnc.includes("4321"), "the stored row must never contain the plaintext PIN");

  const get = await app.inject({ method: "GET", url: "/supermarket/customers/c2/phone-pin", headers: h(manage) });
  assert.equal(get.statusCode, 200);
  const got = body(get);
  assert.equal(got.enrolled, true);
  assert.deepEqual(got.phones, ["+18455551111"]);
  assert.ok(got.enrolledAt && !Number.isNaN(Date.parse(got.enrolledAt)));
  assert.ok(!("pinEnc" in got), "GET must never expose pinEnc");
  assert.ok(!get.body.includes("4321"), "GET response must never contain the plaintext PIN");
});

test("phone-pin: PUT with no register account known (no phone on the mirror) falls back to phoneE164 'desk'", async () => {
  const { app, db, posByTenant, keyHolders, tokenFor } = await buildApp();
  const pos = new FakePos();
  posByTenant.set("t-a", pos);
  await seedPosTenant(db, "t-a", pos);
  pos.addCustomer({ id: "c9", phone10: "8455559999", pin: "1", balanceCents: 0, cards: [] });
  // deliberately no posCustomer mirror row for c9

  db.seed("user", { id: "u-manage", tenantId: "t-a", email: "m@x.com" });
  keyHolders.set("u-manage", new Set(["can_view_supermarket_orders", "can_manage_supermarket_orders"]));
  const manage = tokenFor({ sub: "u-manage", tenantId: "t-a", role: "USER" });

  const put = await app.inject({ method: "PUT", url: "/supermarket/customers/c9/phone-pin", headers: h(manage), payload: { pin: "1" } });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(body(put), { ok: true, enrolled: true });
  const row = db.rows("supermarketPhonePin").find((r) => r.posCustomerId === "c9");
  assert.equal(row.phoneE164, "desk");
});

// ═════════════════════════ /check ═════════════════════════════════════════

test("phone-pin/check: a real register success (sentinel pin literally correct) reports 'set' deterministically", async () => {
  const { app, db, posByTenant, keyHolders, tokenFor } = await buildApp();
  const pos = new FakePos();
  posByTenant.set("t-a", pos);
  await seedPosTenant(db, "t-a", pos);
  // pin is literally the sentinel "0" — the success branch, independent of
  // whichever wording the 401 path uses.
  pos.addCustomer({ id: "c4", phone10: "8455554444", pin: "0", balanceCents: 200, cards: [] });

  db.seed("user", { id: "u-manage", tenantId: "t-a", email: "m@x.com" });
  keyHolders.set("u-manage", new Set(["can_view_supermarket_orders", "can_manage_supermarket_orders"]));
  const manage = tokenFor({ sub: "u-manage", tenantId: "t-a", role: "USER" });

  const res = await app.inject({ method: "POST", url: "/supermarket/customers/c4/phone-pin/check", headers: h(manage) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(body(res), { registerPin: "set" });
});

test("phone-pin/check: no register connection configured answers 503, never guesses", async () => {
  const { app, db, keyHolders, tokenFor } = await buildApp();
  db.seed("tenant", { id: "t-nokeys", crmMode: "supermarket" });
  db.seed("user", { id: "u-manage", tenantId: "t-nokeys", email: "m@x.com" });
  keyHolders.set("u-manage", new Set(["can_view_supermarket_orders", "can_manage_supermarket_orders"]));
  const manage = tokenFor({ sub: "u-manage", tenantId: "t-nokeys", role: "USER" });

  const res = await app.inject({ method: "POST", url: "/supermarket/customers/c1/phone-pin/check", headers: h(manage) });
  assert.equal(res.statusCode, 503);
});

// ═════════════════ classification PINNED against the real register bodies ═

test("phone-pin: classification is pinned to the register's real bodies via a hand-written client stub", async () => {
  const { app, db, keyHolders, tokenFor, stubs } = await buildApp();
  db.seed("tenant", { id: "t-stub", crmMode: "supermarket" });
  db.seed("user", { id: "u-manage", tenantId: "t-stub", email: "m@x.com" });
  keyHolders.set("u-manage", new Set(["can_view_supermarket_orders", "can_manage_supermarket_orders"]));
  const manage = tokenFor({ sub: "u-manage", tenantId: "t-stub", role: "USER" });

  const NO_PIN_BODY = JSON.stringify({ error: "Customer PIN required." });
  const WRONG_PIN_BODY = JSON.stringify({ error: "Invalid customer PIN." });

  const makeStub = (throwErr: () => never) => ({
    getCustomerBalance: async () => throwErr(),
  });

  // account has NO pin configured at all
  stubs.set("t-stub", makeStub(() => {
    throw new PosApiError("POS answered 401", 401, "pos_auth_failed", NO_PIN_BODY);
  }));
  let res = await app.inject({ method: "PUT", url: "/supermarket/customers/no-pin-acct/phone-pin", headers: h(manage), payload: { pin: "1234" } });
  assert.deepEqual(body(res), { ok: false, reason: "pin_not_set" });
  res = await app.inject({ method: "POST", url: "/supermarket/customers/no-pin-acct/phone-pin/check", headers: h(manage) });
  assert.deepEqual(body(res), { registerPin: "not_set" });

  // account has a pin, ours was wrong
  stubs.set("t-stub", makeStub(() => {
    throw new PosApiError("POS answered 401", 401, "pos_auth_failed", WRONG_PIN_BODY);
  }));
  res = await app.inject({ method: "PUT", url: "/supermarket/customers/wrong-pin-acct/phone-pin", headers: h(manage), payload: { pin: "1234" } });
  assert.deepEqual(body(res), { ok: false, reason: "pin_invalid" });
  res = await app.inject({ method: "POST", url: "/supermarket/customers/wrong-pin-acct/phone-pin/check", headers: h(manage) });
  assert.deepEqual(body(res), { registerPin: "set" });

  // 403 with the same two message shapes classifies identically to 401
  stubs.set("t-stub", makeStub(() => {
    throw new PosApiError("POS answered 403", 403, "pos_auth_failed", WRONG_PIN_BODY);
  }));
  res = await app.inject({ method: "PUT", url: "/supermarket/customers/forbidden-acct/phone-pin", headers: h(manage), payload: { pin: "1234" } });
  assert.deepEqual(body(res), { ok: false, reason: "pin_invalid" });

  // anything that is NOT a 401/403 PosApiError is ambiguous — never guessed
  stubs.set("t-stub", makeStub(() => {
    throw new PosApiError("POS answered 500", 500, "pos_unavailable", "server error");
  }));
  res = await app.inject({ method: "PUT", url: "/supermarket/customers/down-acct/phone-pin", headers: h(manage), payload: { pin: "1234" } });
  assert.deepEqual(body(res), { ok: false, reason: "register_unreachable" });
  res = await app.inject({ method: "POST", url: "/supermarket/customers/down-acct/phone-pin/check", headers: h(manage) });
  assert.deepEqual(body(res), { registerPin: "unknown" });

  // no stored row from any of the rejected attempts above
  assert.equal(db.rows("supermarketPhonePin").length, 0);
});
