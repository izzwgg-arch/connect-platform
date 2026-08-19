import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyPortalJwt } from "./auth";

const SECRET = "test-secret";

function b64url(obj: object | Buffer): string {
  const buf = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj));
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeToken(payload: object, secret = SECRET, alg = "HS256"): string {
  const h = b64url({ alg, typ: "JWT" });
  const p = b64url(payload);
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64url(sig)}`;
}

test("valid customer token → customer identity", () => {
  const id = verifyPortalJwt(makeToken({ sub: "u1", tenantId: "t1", role: "USER", email: "a@b.c" }), SECRET);
  assert.deepEqual(id, { tenantId: "t1", clientUserId: "u1", role: "customer", email: "a@b.c", platformRole: "USER" });
});

test("SUPER_ADMIN → owner mode", () => {
  const id = verifyPortalJwt(makeToken({ sub: "izzy", tenantId: "root", role: "SUPER_ADMIN" }), SECRET);
  assert.equal(id?.role, "owner");
});

/**
 * ⛔ The RAW platform role must survive the mapping, because "admin MODE" and
 * "is this Connect staff" are different questions and the escalation gate needs
 * the second one. Collapsing them silently discarded every TENANT_ADMIN's
 * escalations from 2026-08-06 to 2026-08-19 — see escalationGate.test.ts.
 */
test("the raw platform role is preserved beside the mapped role", () => {
  const admin = verifyPortalJwt(makeToken({ sub: "u2", tenantId: "t1", role: "TENANT_ADMIN" }), SECRET);
  assert.equal(admin?.role, "owner", "tenant admins keep admin mode");
  assert.equal(admin?.platformRole, "TENANT_ADMIN", "…and are still distinguishable from Connect staff");

  const staff = verifyPortalJwt(makeToken({ sub: "izzy", tenantId: "root", role: "SUPER_ADMIN" }), SECRET);
  assert.equal(staff?.platformRole, "SUPER_ADMIN");

  // A token with no role at all leaves it undefined — which isPlatformStaff
  // reads as "not staff", i.e. the request still reaches a person.
  const anon = verifyPortalJwt(makeToken({ sub: "u3", tenantId: "t1" }), SECRET);
  assert.equal(anon?.platformRole, undefined);
});

test("wrong secret rejected", () => {
  assert.equal(verifyPortalJwt(makeToken({ sub: "u1", tenantId: "t1" }, "other"), SECRET), null);
});

test("expired token rejected", () => {
  const id = verifyPortalJwt(makeToken({ sub: "u1", tenantId: "t1", exp: Math.floor(Date.now() / 1000) - 10 }), SECRET);
  assert.equal(id, null);
});

test("alg none / RS256 confusion rejected", () => {
  assert.equal(verifyPortalJwt(makeToken({ sub: "u1", tenantId: "t1" }, SECRET, "none"), SECRET), null);
  assert.equal(verifyPortalJwt(makeToken({ sub: "u1", tenantId: "t1" }, SECRET, "RS256"), SECRET), null);
});

test("missing claims rejected", () => {
  assert.equal(verifyPortalJwt(makeToken({ sub: "u1" }), SECRET), null);
  assert.equal(verifyPortalJwt("garbage.token.here", SECRET), null);
});
