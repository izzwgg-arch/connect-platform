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
  assert.deepEqual(id, { tenantId: "t1", clientUserId: "u1", role: "customer", email: "a@b.c" });
});

test("SUPER_ADMIN → owner mode", () => {
  const id = verifyPortalJwt(makeToken({ sub: "izzy", tenantId: "root", role: "SUPER_ADMIN" }), SECRET);
  assert.equal(id?.role, "owner");
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
