/**
 * MFA (Phase 11) — TOTP + recovery codes + pre-auth token + the login gate.
 *
 * What is proven here, and how:
 *   - the TOTP implementation against the RFC 6238 Appendix B vectors (so the
 *     codes agree with every authenticator app);
 *   - setup → verify happy path, wrong code, replay of a used code, recovery
 *     code single-use, regenerate refuses a recovery code, disable (self and
 *     admin), the challenge throttle — all through the real service with a
 *     fake store;
 *   - the pre-auth token is REJECTED by the ordinary JWT hook (a real Fastify
 *     app with @fastify/jwt and the same preHandler shape as server.ts), and a
 *     session-key token tagged mfa_pending is rejected too;
 *   - login without MFA is UNCHANGED, and a required-role user who has not
 *     enrolled is let in with the grace flag (default mode is grace);
 *   - the routes end to end via app.inject: status / setup / verify /
 *     challenge / disable / regenerate / admin disable;
 *   - source guards on server.ts and the bypass list, so the wiring cannot be
 *     silently undone (each defect of this shape here has been a call site).
 *
 * ⛔ Source reads are CRLF-normalised (CLAUDE.md, source-reading-tests-must-normalise-crlf).
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { createLoginThrottle } from "../loginThrottle";
import { shouldSkipJwtVerification } from "../jwtPublicRouteBypass";
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateTotpSecret,
  hotp,
  totpCode,
  totpCounter,
  verifyTotp,
} from "./totp";
import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCodes,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  normalizeRecoveryCode,
  recoveryCodeMatches,
} from "./recoveryCodes";
import { PRE_AUTH_TOKEN_TTL_SECONDS, mintPreAuthToken, verifyPreAuthToken } from "./preAuthToken";
import { decideMfaLoginGate, mfaEnforcementMode, mfaRequiredRoles } from "./mfaPolicy";
import {
  MFA_CHALLENGE_THROTTLE_CONFIG,
  beginTotpEnrollment,
  completeMfaChallenge,
  confirmTotpEnrollment,
  decideLoginMfa,
  disableMfaByAdmin,
  disableMfaSelf,
  getMfaStatus,
  regenerateRecoveryCodes,
  type MfaDeps,
  type MfaRow,
  type MfaStore,
  type MfaUserRow,
} from "./mfaService";
import { registerMfaRoutes } from "./mfaRoutes";

const here = __dirname;
const read = (p: string) => readFileSync(join(here, p), "utf8").replace(/\r\n/g, "\n");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-mfa-tests-0123456789abcdef";
delete process.env.MFA_ENFORCEMENT;
delete process.env.MFA_REQUIRED_ROLES;
delete process.env.LOGIN_THROTTLE_DISABLED;

// ─── Fake store ──────────────────────────────────────────────────────────────

function makeStore(users: MfaUserRow[]) {
  const mfaRows = new Map<string, MfaRow>(); // by userId
  const codes: Array<{ id: string; userMfaId: string; codeHash: string; usedAt: Date | null }> = [];
  let seq = 0;
  const store: MfaStore = {
    async getUser(userId) {
      return users.find((u) => u.id === userId) ?? null;
    },
    async getMfa(userId) {
      const r = mfaRows.get(userId);
      return r ? { ...r } : null;
    },
    async upsertPending(userId, totpSecretEncrypted) {
      const existing = mfaRows.get(userId);
      const row: MfaRow = { id: existing?.id ?? `mfa-${++seq}`, userId, totpSecretEncrypted, enabledAt: null, lastUsedCounter: null };
      mfaRows.set(userId, row);
      for (let i = codes.length - 1; i >= 0; i--) if (codes[i].userMfaId === row.id) codes.splice(i, 1);
      return { ...row };
    },
    async markEnabled(mfaId, enabledAt, lastUsedCounter) {
      for (const r of mfaRows.values()) if (r.id === mfaId) Object.assign(r, { enabledAt, lastUsedCounter });
    },
    async setLastUsedCounter(mfaId, counter) {
      for (const r of mfaRows.values()) if (r.id === mfaId) r.lastUsedCounter = counter;
    },
    async replaceRecoveryCodes(mfaId, hashes) {
      for (let i = codes.length - 1; i >= 0; i--) if (codes[i].userMfaId === mfaId) codes.splice(i, 1);
      for (const h of hashes) codes.push({ id: `rc-${++seq}`, userMfaId: mfaId, codeHash: h, usedAt: null });
    },
    async listUnusedRecoveryCodes(mfaId) {
      return codes.filter((c) => c.userMfaId === mfaId && !c.usedAt).map((c) => ({ id: c.id, codeHash: c.codeHash }));
    },
    async countUnusedRecoveryCodes(mfaId) {
      return codes.filter((c) => c.userMfaId === mfaId && !c.usedAt).length;
    },
    async consumeRecoveryCode(codeId, usedAt) {
      const c = codes.find((x) => x.id === codeId);
      if (!c || c.usedAt) return false;
      c.usedAt = usedAt;
      return true;
    },
    async deleteMfa(userId) {
      const r = mfaRows.get(userId);
      if (!r) return;
      mfaRows.delete(userId);
      for (let i = codes.length - 1; i >= 0; i--) if (codes[i].userMfaId === r.id) codes.splice(i, 1);
    },
  };
  return { store, mfaRows, codes };
}

const IZZY: MfaUserRow = { id: "u-izzy", tenantId: "t-admin", email: "izzy@example.com", role: "SUPER_ADMIN", status: "ACTIVE" };
const BAILA: MfaUserRow = { id: "u-baila", tenantId: "t-inii", email: "baila@example.com", role: "USER", status: "ACTIVE" };
const TENANT_ADMIN: MfaUserRow = { id: "u-ta", tenantId: "t-inii", email: "boss@example.com", role: "TENANT_ADMIN", status: "ACTIVE" };

function makeDeps(opts: { now?: () => number; audits?: any[] } = {}) {
  const fake = makeStore([IZZY, BAILA, TENANT_ADMIN]);
  const audits: any[] = opts.audits ?? [];
  const deps: MfaDeps = {
    store: fake.store,
    // "encryption" that is reversible and visibly not the plaintext — the real
    // envelope is @connect/security encryptJson, injected by mfaRoutes.
    encrypt: (s) => `enc:${Buffer.from(s).toString("base64")}`,
    decrypt: (s) => Buffer.from(String(s).replace(/^enc:/, ""), "base64").toString(),
    audit: async (p) => { audits.push(p); },
    now: opts.now ?? (() => Date.now()),
    recoveryHashRounds: 4,
    issuer: "Loopcom",
    throttle: createLoginThrottle(MFA_CHALLENGE_THROTTLE_CONFIG),
  };
  return { deps, audits, ...fake };
}

/** Enrol a user through the real service, returning the plaintext secret and recovery codes. */
async function enrol(deps: MfaDeps, userId: string) {
  const setup = await beginTotpEnrollment(deps, userId);
  assert.equal(setup.ok, true);
  if (!setup.ok) throw new Error("unreachable");
  const confirm = await confirmTotpEnrollment(deps, { userId, code: totpCode(setup.secretBase32, deps.now!()), sourceIp: "203.0.113.5" });
  assert.equal(confirm.ok, true, JSON.stringify(confirm));
  if (!confirm.ok) throw new Error("unreachable");
  return { secret: setup.secretBase32, recoveryCodes: confirm.recoveryCodes, otpauthUri: setup.otpauthUri };
}

beforeEach(() => {
  delete process.env.MFA_ENFORCEMENT;
  delete process.env.MFA_REQUIRED_ROLES;
});

// ─── TOTP: RFC 6238 Appendix B (SHA1) ────────────────────────────────────────

const RFC_SECRET_ASCII = "12345678901234567890";
const RFC_SECRET_B32 = base32Encode(Buffer.from(RFC_SECRET_ASCII, "ascii"));

test("base32 round-trips and matches the RFC 6238 test secret", () => {
  assert.equal(RFC_SECRET_B32, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(base32Decode(RFC_SECRET_B32).toString("ascii"), RFC_SECRET_ASCII);
  assert.equal(base32Decode("gezd gnbv-gy3tqojq").toString("ascii"), "1234567890");
  const fresh = generateTotpSecret();
  assert.equal(base32Decode(fresh).length, 20);
  assert.match(fresh, /^[A-Z2-7]{32}$/);
});

test("TOTP agrees with the RFC 6238 Appendix B vectors (last 6 of the 8-digit values)", () => {
  // Time (s) → 8-digit HOTP-SHA1 from the RFC table; we run 6 digits.
  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [t, eight] of vectors) {
    assert.equal(hotp(RFC_SECRET_B32, totpCounter(t * 1000), 8), eight, `T=${t}`);
    assert.equal(totpCode(RFC_SECRET_B32, t * 1000), eight.slice(-6), `T=${t} (6 digits)`);
  }
});

test("verifyTotp: current step, ±1 step accepted; ±2 refused; replay refused; junk malformed", () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;
  const cur = totpCounter(now);
  assert.deepEqual(verifyTotp({ secretBase32: secret, code: hotp(secret, cur), nowMs: now }), { ok: true, counter: cur });
  assert.deepEqual(verifyTotp({ secretBase32: secret, code: hotp(secret, cur - 1), nowMs: now }), { ok: true, counter: cur - 1 });
  assert.deepEqual(verifyTotp({ secretBase32: secret, code: hotp(secret, cur + 1), nowMs: now }), { ok: true, counter: cur + 1 });
  assert.equal(verifyTotp({ secretBase32: secret, code: hotp(secret, cur + 2), nowMs: now }).ok, false);
  assert.equal(verifyTotp({ secretBase32: secret, code: hotp(secret, cur - 2), nowMs: now }).ok, false);
  // Spaces in what a person typed are fine.
  const c = hotp(secret, cur);
  assert.equal(verifyTotp({ secretBase32: secret, code: `${c.slice(0, 3)} ${c.slice(3)}`, nowMs: now }).ok, true);
  // Replay: the same code, once its counter has been recorded, is refused.
  assert.deepEqual(verifyTotp({ secretBase32: secret, code: c, nowMs: now, lastUsedCounter: cur }), { ok: false, reason: "replayed" });
  // Even the PREVIOUS step's code is refused once a later one was accepted.
  assert.deepEqual(verifyTotp({ secretBase32: secret, code: hotp(secret, cur - 1), nowMs: now, lastUsedCounter: cur }), { ok: false, reason: "replayed" });
  assert.deepEqual(verifyTotp({ secretBase32: secret, code: "12345", nowMs: now }), { ok: false, reason: "malformed" });
  assert.deepEqual(verifyTotp({ secretBase32: secret, code: "abcdef", nowMs: now }), { ok: false, reason: "malformed" });
});

test("otpauth URI carries issuer, account, secret, SHA1/6/30", () => {
  const uri = buildOtpauthUri({ issuer: "Loopcom", account: "izzy@example.com", secretBase32: RFC_SECRET_B32 });
  assert.ok(uri.startsWith("otpauth://totp/Loopcom%3Aizzy%40example.com?"), uri);
  const q = new URL(uri).searchParams;
  assert.equal(q.get("secret"), RFC_SECRET_B32);
  assert.equal(q.get("issuer"), "Loopcom");
  assert.equal(q.get("algorithm"), "SHA1");
  assert.equal(q.get("digits"), "6");
  assert.equal(q.get("period"), "30");
});

// ─── Recovery codes ──────────────────────────────────────────────────────────

test("recovery codes: 10 distinct, readable alphabet, normalise + bcrypt match", async () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, RECOVERY_CODE_COUNT);
  assert.equal(new Set(codes).size, RECOVERY_CODE_COUNT);
  for (const c of codes) {
    assert.match(c, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/, c);
    assert.equal(looksLikeRecoveryCode(c), true);
    assert.equal(looksLikeRecoveryCode(c.toLowerCase().replace("-", " ")), true);
  }
  assert.equal(normalizeRecoveryCode(" ab-cde fgh jk "), "ABCDEFGHJK");
  const hash = await hashRecoveryCode(codes[0], 4);
  assert.notEqual(hash, codes[0]);
  assert.equal(await recoveryCodeMatches(codes[0].toLowerCase(), hash), true);
  assert.equal(await recoveryCodeMatches(codes[1], hash), false);
  assert.equal(looksLikeRecoveryCode("123456"), false, "a TOTP code is never mistaken for a recovery code");
});

// ─── Pre-auth token ──────────────────────────────────────────────────────────

test("pre-auth token: mints, verifies, expires at 5 minutes, refuses tampering and wrong purpose", () => {
  const now = 1_700_000_000_000;
  const { token, expiresInSeconds } = mintPreAuthToken("u-izzy", now);
  assert.equal(expiresInSeconds, PRE_AUTH_TOKEN_TTL_SECONDS);
  assert.equal(expiresInSeconds, 300);
  const ok = verifyPreAuthToken(token, now + 1000);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.claims.sub, "u-izzy");
    assert.equal(ok.claims.mfa_pending, true);
    assert.equal(ok.claims.purpose, "mfa_challenge");
  }
  assert.deepEqual(verifyPreAuthToken(token, now + 301_000), { ok: false, reason: "expired" });
  const [h, p, s] = token.split(".");
  assert.deepEqual(verifyPreAuthToken(`${h}.${p}.${s.slice(0, -2)}xx`, now), { ok: false, reason: "bad_signature" });
  // Payload swap: change the sub, keep the signature.
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), sub: "u-baila" })).toString("base64url");
  assert.deepEqual(verifyPreAuthToken(`${h}.${forged}.${s}`, now), { ok: false, reason: "bad_signature" });
  assert.equal(verifyPreAuthToken("garbage", now).ok, false);
  assert.equal(verifyPreAuthToken("", now).ok, false);
});

// The Fastify app below mirrors server.ts: @fastify/jwt on JWT_SECRET, the
// bypass list, the 401 body, and the mfa_pending belt-and-braces check.
async function buildAppWithHook() {
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  app.addHook("preHandler", async (req: any, reply: any) => {
    const path = req.url.split("?")[0];
    if (shouldSkipJwtVerification(path)) return;
    try {
      await req.jwtVerify();
    } catch {
      return reply.status(401).send({ error: "unauthorized" });
    }
    if ((req.user as any)?.mfa_pending === true) {
      return reply.status(401).send({ error: "unauthorized" });
    }
  });
  app.get("/me", async (req: any) => ({ sub: req.user.sub }));
  return app;
}

test("⛔ the pre-auth token is REJECTED by the ordinary JWT hook on a normal route", async () => {
  const app = await buildAppWithHook();
  const { token } = mintPreAuthToken("u-izzy");
  const res = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), { error: "unauthorized" });
  // The same shape signed with the SESSION key is refused too (belt and braces).
  const sessionKeyed = app.jwt.sign({ sub: "u-izzy", mfa_pending: true, purpose: "mfa_challenge" }, { expiresIn: "5m" });
  const res2 = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${sessionKeyed}` } });
  assert.equal(res2.statusCode, 401);
  // And a real session still works, so the hook is not simply refusing everything.
  const real = app.jwt.sign({ sub: "u-izzy", tenantId: "t", email: "izzy@example.com", role: "SUPER_ADMIN" });
  const res3 = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${real}` } });
  assert.equal(res3.statusCode, 200);
  await app.close();
});

test("bypass list: /auth/mfa/challenge is public; setup / verify / disable / status / regenerate are NOT", () => {
  assert.equal(shouldSkipJwtVerification("/auth/mfa/challenge"), true);
  for (const p of ["/auth/mfa/status", "/auth/mfa/totp/setup", "/auth/mfa/totp/verify", "/auth/mfa/disable", "/auth/mfa/recovery-codes/regenerate", "/admin/users/x/mfa/disable"]) {
    assert.equal(shouldSkipJwtVerification(p), false, `${p} must require a session`);
  }
});

// ─── Policy ──────────────────────────────────────────────────────────────────

test("policy: default is GRACE, default required role is SUPER_ADMIN only", () => {
  assert.equal(mfaEnforcementMode(), "grace");
  assert.deepEqual(mfaRequiredRoles(), ["SUPER_ADMIN"]);
  assert.deepEqual(decideMfaLoginGate({ role: "USER", mfaEnabled: false }), { kind: "none" });
  assert.deepEqual(decideMfaLoginGate({ role: "TENANT_ADMIN", mfaEnabled: false }), { kind: "none" });
  assert.deepEqual(decideMfaLoginGate({ role: "SUPER_ADMIN", mfaEnabled: false }), { kind: "enroll_grace" });
  assert.deepEqual(decideMfaLoginGate({ role: "SUPER_ADMIN", mfaEnabled: true }), { kind: "challenge" });
  assert.deepEqual(decideMfaLoginGate({ role: "USER", mfaEnabled: true }), { kind: "challenge" });
  // Junk values of the env stay grace — a typo must never lock the admin out.
  process.env.MFA_ENFORCEMENT = "hard";
  assert.equal(mfaEnforcementMode(), "grace");
  process.env.MFA_ENFORCEMENT = "true";
  assert.equal(mfaEnforcementMode(), "grace");
  process.env.MFA_ENFORCEMENT = " Required ";
  assert.equal(mfaEnforcementMode(), "required");
  assert.deepEqual(decideMfaLoginGate({ role: "SUPER_ADMIN", mfaEnabled: false }), { kind: "enroll_required" });
  assert.deepEqual(decideMfaLoginGate({ role: "USER", mfaEnabled: false }), { kind: "none" }, "hard mode never touches roles outside the list");
  delete process.env.MFA_ENFORCEMENT;
  process.env.MFA_REQUIRED_ROLES = "super_admin, tenant_admin";
  assert.deepEqual(mfaRequiredRoles(), ["SUPER_ADMIN", "TENANT_ADMIN"]);
  assert.deepEqual(decideMfaLoginGate({ role: "TENANT_ADMIN", mfaEnabled: false }), { kind: "enroll_grace" });
});

// ─── Service: login gate ─────────────────────────────────────────────────────

test("login without MFA is unchanged (kind none); unenrolled SUPER_ADMIN gets grace; enrolled gets a pre-auth token", async () => {
  const { deps } = makeDeps();
  assert.deepEqual(await decideLoginMfa(deps, { id: BAILA.id, role: BAILA.role }), { kind: "none" });
  assert.deepEqual(await decideLoginMfa(deps, { id: IZZY.id, role: IZZY.role }), { kind: "enroll_grace" });
  await enrol(deps, IZZY.id);
  const out = await decideLoginMfa(deps, { id: IZZY.id, role: IZZY.role });
  assert.equal(out.kind, "challenge");
  if (out.kind === "challenge") {
    assert.equal(out.expiresInSeconds, 300);
    assert.deepEqual(out.methods, ["totp", "recovery_code"]);
    const v = verifyPreAuthToken(out.preAuthToken);
    assert.equal(v.ok && v.claims.sub, IZZY.id);
  }
  // A pending (started, never confirmed) setup is inert at login.
  await beginTotpEnrollment(deps, BAILA.id);
  assert.deepEqual(await decideLoginMfa(deps, { id: BAILA.id, role: BAILA.role }), { kind: "none" });
});

test("a broken MFA store degrades login to the pre-MFA behaviour rather than locking everyone out", async () => {
  const { deps } = makeDeps();
  deps.store.getMfa = async () => { throw new Error("db down"); };
  assert.deepEqual(await decideLoginMfa(deps, { id: BAILA.id, role: BAILA.role }), { kind: "none" });
});

// ─── Service: enrolment / challenge / recovery ───────────────────────────────

test("setup → verify happy path: enabled, 10 recovery codes shown once, audited, secret stored encrypted", async () => {
  const { deps, audits, mfaRows } = makeDeps();
  const setup = await beginTotpEnrollment(deps, IZZY.id);
  assert.equal(setup.ok, true);
  if (!setup.ok) return;
  assert.equal(setup.account, IZZY.email);
  assert.equal(setup.manualKey.replace(/ /g, ""), setup.secretBase32);
  const stored = mfaRows.get(IZZY.id)!;
  assert.ok(stored.totpSecretEncrypted.startsWith("enc:"), "the secret must go through encrypt()");
  assert.ok(!stored.totpSecretEncrypted.includes(setup.secretBase32));
  assert.equal(stored.enabledAt, null);
  assert.equal((await getMfaStatus(deps, IZZY)).pendingSetup, true);

  const wrong = await confirmTotpEnrollment(deps, { userId: IZZY.id, code: "000000", sourceIp: "203.0.113.5" });
  assert.deepEqual(wrong, { ok: false, status: 401, error: "invalid_code" });

  const confirm = await confirmTotpEnrollment(deps, { userId: IZZY.id, code: totpCode(setup.secretBase32), sourceIp: "203.0.113.5" });
  assert.equal(confirm.ok, true);
  if (!confirm.ok) return;
  assert.equal(confirm.recoveryCodes.length, 10);
  const status = await getMfaStatus(deps, IZZY);
  assert.equal(status.enabled, true);
  assert.equal(status.recoveryCodesRemaining, 10);
  assert.equal(status.required, true);
  assert.equal(status.enrollmentRequired, false);
  assert.ok(audits.some((a) => a.action === "MFA_TOTP_ENROLLED" && a.targetUserId === IZZY.id));
  // Setting up again while enabled is refused.
  assert.deepEqual(await beginTotpEnrollment(deps, IZZY.id), { ok: false, error: "already_enabled" });
});

test("challenge: right TOTP → user; the same code again is REPLAY-refused; wrong code refused; bad pre-auth refused", async () => {
  let clock = 1_700_000_000_000;
  const { deps } = makeDeps({ now: () => clock });
  const { secret } = await enrol(deps, IZZY.id);
  const login = await decideLoginMfa(deps, { id: IZZY.id, role: IZZY.role });
  assert.equal(login.kind, "challenge");
  if (login.kind !== "challenge") return;
  clock += 40_000; // next TOTP step, so enrolment's counter is not the one we present
  const code = totpCode(secret, clock);
  const ok = await completeMfaChallenge(deps, { preAuthToken: login.preAuthToken, code, sourceIp: "203.0.113.5" });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.user.id, IZZY.id);
    assert.equal(ok.method, "totp");
  }
  // Replay inside the same 30-second window: refused.
  const replay = await completeMfaChallenge(deps, { preAuthToken: login.preAuthToken, code, sourceIp: "203.0.113.5" });
  assert.deepEqual(replay, { ok: false, status: 401, error: "invalid_code" });
  // Wrong code.
  const wrong = await completeMfaChallenge(deps, { preAuthToken: login.preAuthToken, code: "999999", sourceIp: "203.0.113.5" });
  assert.deepEqual(wrong, { ok: false, status: 401, error: "invalid_code" });
  // Forged / expired pre-auth token.
  assert.deepEqual(await completeMfaChallenge(deps, { preAuthToken: "nope", code, sourceIp: "203.0.113.5" }), { ok: false, status: 401, error: "preauth_invalid" });
  clock += 301_000;
  assert.deepEqual(await completeMfaChallenge(deps, { preAuthToken: login.preAuthToken, code: totpCode(secret, clock), sourceIp: "203.0.113.5" }), { ok: false, status: 401, error: "preauth_invalid" });
});

test("challenge with a recovery code works ONCE, is audited, and the second use is refused", async () => {
  let clock = 1_700_000_000_000;
  const { deps, audits } = makeDeps({ now: () => clock });
  const { recoveryCodes } = await enrol(deps, IZZY.id);
  const login = await decideLoginMfa(deps, { id: IZZY.id, role: IZZY.role });
  if (login.kind !== "challenge") throw new Error("expected challenge");
  const first = await completeMfaChallenge(deps, { preAuthToken: login.preAuthToken, code: recoveryCodes[3].toLowerCase(), sourceIp: "203.0.113.5" });
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.method, "recovery_code");
    assert.equal(first.recoveryCodesRemaining, 9);
  }
  assert.ok(audits.some((a) => a.action === "MFA_RECOVERY_CODE_USED" && a.metadata?.recoveryCodesRemaining === 9));
  clock += 1000;
  const again = await completeMfaChallenge(deps, { preAuthToken: login.preAuthToken, code: recoveryCodes[3], sourceIp: "203.0.113.5" });
  assert.deepEqual(again, { ok: false, status: 401, error: "invalid_code" });
  assert.equal((await getMfaStatus(deps, IZZY)).recoveryCodesRemaining, 9);
  // A different one still works.
  const other = await completeMfaChallenge(deps, { preAuthToken: login.preAuthToken, code: recoveryCodes[0], sourceIp: "203.0.113.5" });
  assert.equal(other.ok, true);
});

test("challenge throttle: five wrong codes → 429 with a Retry-After, then the RIGHT code is also refused until the window passes; another user is unaffected", async () => {
  let clock = 1_700_000_000_000;
  const { deps } = makeDeps({ now: () => clock });
  const { secret } = await enrol(deps, IZZY.id);
  await enrol(deps, BAILA.id);
  const login = await decideLoginMfa(deps, { id: IZZY.id, role: IZZY.role });
  if (login.kind !== "challenge") throw new Error("expected challenge");
  for (let i = 0; i < MFA_CHALLENGE_THROTTLE_CONFIG.accountFailureLimit; i++) {
    const r = await completeMfaChallenge(deps, { preAuthToken: login.preAuthToken, code: "000000", sourceIp: "203.0.113.5" });
    assert.deepEqual(r, { ok: false, status: 401, error: "invalid_code" }, `attempt ${i + 1}`);
  }
  clock += 40_000;
  const throttled = await completeMfaChallenge(deps, { preAuthToken: login.preAuthToken, code: totpCode(secret, clock), sourceIp: "203.0.113.5" });
  assert.equal(throttled.ok, false);
  if (!throttled.ok) {
    assert.equal(throttled.status, 429);
    assert.equal(throttled.error, "RATE_LIMITED");
    assert.ok((throttled.retryAfterSeconds ?? 0) > 0);
  }
  // Someone else on the same source is not caught by the account throttle.
  const bailaLogin = await decideLoginMfa(deps, { id: BAILA.id, role: BAILA.role });
  if (bailaLogin.kind !== "challenge") throw new Error("expected challenge");
  const bailaWrong = await completeMfaChallenge(deps, { preAuthToken: bailaLogin.preAuthToken, code: "111111", sourceIp: "203.0.113.5" });
  assert.deepEqual(bailaWrong, { ok: false, status: 401, error: "invalid_code" });
  // Window passes: Izzy is let back in with a real code.
  clock += MFA_CHALLENGE_THROTTLE_CONFIG.accountWindowMs + 1000;
  const login2 = await decideLoginMfa(deps, { id: IZZY.id, role: IZZY.role });
  if (login2.kind !== "challenge") throw new Error("expected challenge");
  const ok = await completeMfaChallenge(deps, { preAuthToken: login2.preAuthToken, code: totpCode(secret, clock), sourceIp: "203.0.113.5" });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test("regenerate: refuses a recovery code (needs TOTP), invalidates every old code, issues 10 new", async () => {
  let clock = 1_700_000_000_000;
  const { deps, audits } = makeDeps({ now: () => clock });
  const { secret, recoveryCodes } = await enrol(deps, IZZY.id);
  clock += 40_000;
  const viaRecovery = await regenerateRecoveryCodes(deps, { userId: IZZY.id, code: recoveryCodes[0], sourceIp: "1.1.1.1" });
  assert.deepEqual(viaRecovery, { ok: false, status: 401, error: "invalid_code" });
  const fresh = await regenerateRecoveryCodes(deps, { userId: IZZY.id, code: totpCode(secret, clock), sourceIp: "1.1.1.1" });
  assert.equal(fresh.ok, true);
  if (!fresh.ok) return;
  assert.equal(fresh.recoveryCodes.length, 10);
  assert.ok(audits.some((a) => a.action === "MFA_RECOVERY_CODES_REGENERATED"));
  // An old code no longer opens the door.
  const login = await decideLoginMfa(deps, { id: IZZY.id, role: IZZY.role });
  if (login.kind !== "challenge") throw new Error("expected challenge");
  clock += 1000;
  assert.deepEqual(await completeMfaChallenge(deps, { preAuthToken: login.preAuthToken, code: recoveryCodes[1], sourceIp: "1.1.1.1" }), { ok: false, status: 401, error: "invalid_code" });
  assert.equal((await completeMfaChallenge(deps, { preAuthToken: login.preAuthToken, code: fresh.recoveryCodes[1], sourceIp: "1.1.1.1" })).ok, true);
});

test("disable (self) needs a current code; after it, login is back to normal and the pre-auth token is dead", async () => {
  let clock = 1_700_000_000_000;
  const { deps, audits } = makeDeps({ now: () => clock });
  const { secret } = await enrol(deps, IZZY.id);
  const login = await decideLoginMfa(deps, { id: IZZY.id, role: IZZY.role });
  if (login.kind !== "challenge") throw new Error("expected challenge");
  clock += 40_000;
  assert.deepEqual(await disableMfaSelf(deps, { userId: IZZY.id, code: "000000", sourceIp: "1.1.1.1" }), { ok: false, status: 401, error: "invalid_code" });
  assert.deepEqual(await disableMfaSelf(deps, { userId: IZZY.id, code: totpCode(secret, clock), sourceIp: "1.1.1.1" }), { ok: true });
  assert.ok(audits.some((a) => a.action === "MFA_DISABLED" && a.metadata?.by === "self"));
  assert.deepEqual(await decideLoginMfa(deps, { id: IZZY.id, role: IZZY.role }), { kind: "enroll_grace" });
  assert.equal((await getMfaStatus(deps, IZZY)).enabled, false);
  // The pre-auth token minted before the disable can no longer finish a login.
  clock += 40_000;
  assert.deepEqual(await completeMfaChallenge(deps, { preAuthToken: login.preAuthToken, code: totpCode(secret, clock), sourceIp: "1.1.1.1" }), { ok: false, status: 401, error: "preauth_invalid" });
  assert.deepEqual(await disableMfaSelf(deps, { userId: IZZY.id, code: "123456" }), { ok: false, status: 400, error: "not_enabled" });
});

test("disable by admin: SUPER_ADMIN only, audited with both ids; a TENANT_ADMIN is refused", async () => {
  const { deps, audits } = makeDeps();
  await enrol(deps, BAILA.id);
  assert.deepEqual(await disableMfaByAdmin(deps, { actor: TENANT_ADMIN, targetUserId: BAILA.id }), { ok: false, status: 403, error: "forbidden" });
  assert.equal((await getMfaStatus(deps, BAILA)).enabled, true, "a refused admin must change nothing");
  assert.deepEqual(await disableMfaByAdmin(deps, { actor: IZZY, targetUserId: "nobody" }), { ok: false, status: 404, error: "user_not_found" });
  assert.deepEqual(await disableMfaByAdmin(deps, { actor: IZZY, targetUserId: BAILA.id, reason: "lost phone" }), { ok: true, wasEnabled: true });
  const row = audits.find((a) => a.action === "MFA_DISABLED_BY_ADMIN");
  assert.ok(row);
  assert.equal(row.actorUserId, IZZY.id);
  assert.equal(row.targetUserId, BAILA.id);
  assert.equal(row.tenantId, BAILA.tenantId);
  assert.equal(row.metadata?.reason, "lost phone");
  assert.equal((await getMfaStatus(deps, BAILA)).enabled, false);
});

// ─── Routes end to end (Fastify inject) ──────────────────────────────────────

async function buildRoutedApp() {
  const fake = makeDeps({ now: () => Date.now() });
  const app = await buildAppWithHook();
  await registerMfaRoutes(app, {
    audit: fake.deps.audit,
    issueSession: async (userId) => {
      const u = await fake.store.getUser(userId);
      return { token: app.jwt.sign({ sub: u!.id, tenantId: u!.tenantId, email: u!.email, role: u!.role }), portalPermissionSet: ["can_view_dashboard"] };
    },
    service: fake.deps,
    cryptoReady: () => true,
  });
  const sessionFor = (u: MfaUserRow) => app.jwt.sign({ sub: u.id, tenantId: u.tenantId, email: u.email, role: u.role });
  return { app, fake, sessionFor };
}

test("routes: status → setup → verify → challenge returns the SAME body shape as a normal login; disable; admin disable", async () => {
  const { app, fake, sessionFor } = await buildRoutedApp();
  const auth = { authorization: `Bearer ${sessionFor(IZZY)}` };

  const status0 = await app.inject({ method: "GET", url: "/auth/mfa/status", headers: auth });
  assert.equal(status0.statusCode, 200);
  assert.equal(status0.json().enabled, false);
  assert.equal(status0.json().enrollmentRequired, true, "SUPER_ADMIN unenrolled → the portal prompts");

  // No session → every private route 401s; the challenge route does not.
  assert.equal((await app.inject({ method: "POST", url: "/auth/mfa/totp/setup" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/auth/mfa/status" })).statusCode, 401);

  const setup = await app.inject({ method: "POST", url: "/auth/mfa/totp/setup", headers: auth });
  assert.equal(setup.statusCode, 200, setup.body);
  const { secretBase32, otpauthUri, manualKey } = setup.json();
  assert.match(secretBase32, /^[A-Z2-7]{32}$/);
  assert.ok(String(otpauthUri).startsWith("otpauth://totp/"));
  assert.equal(String(manualKey).replace(/ /g, ""), secretBase32);

  const bad = await app.inject({ method: "POST", url: "/auth/mfa/totp/verify", headers: auth, payload: { code: "000000" } });
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.json().error, "invalid_code");

  const verify = await app.inject({ method: "POST", url: "/auth/mfa/totp/verify", headers: auth, payload: { code: totpCode(secretBase32) } });
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal(verify.json().enabled, true);
  assert.equal(verify.json().recoveryCodes.length, 10);
  const recovery: string[] = verify.json().recoveryCodes;

  // Login would now hand out a pre-auth token; the challenge route turns it into a session.
  const login = await decideLoginMfa(fake.deps, { id: IZZY.id, role: IZZY.role });
  if (login.kind !== "challenge") throw new Error("expected challenge");
  const preAuth = login.preAuthToken;
  // The pre-auth token is refused on a normal route by the very same app…
  assert.equal((await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${preAuth}` } })).statusCode, 401);
  // …and on the private MFA routes.
  assert.equal((await app.inject({ method: "GET", url: "/auth/mfa/status", headers: { authorization: `Bearer ${preAuth}` } })).statusCode, 401);

  // Enrolment already spent this step's counter; wait for the next window.
  const nextStepMs = (totpCounter(Date.now()) + 1) * 30_000 - Date.now() + 50;
  await new Promise((r) => setTimeout(r, Math.max(0, nextStepMs)));

  const wrongChallenge = await app.inject({ method: "POST", url: "/auth/mfa/challenge", payload: { preAuthToken: preAuth, code: "000000" } });
  assert.equal(wrongChallenge.statusCode, 401);
  assert.deepEqual(wrongChallenge.json(), { error: "invalid_code" });
  const badPre = await app.inject({ method: "POST", url: "/auth/mfa/challenge", payload: { preAuthToken: "x".repeat(30), code: "000000" } });
  assert.equal(badPre.statusCode, 401);
  assert.deepEqual(badPre.json(), { error: "preauth_invalid" });

  const challenge = await app.inject({ method: "POST", url: "/auth/mfa/challenge", payload: { preAuthToken: preAuth, code: totpCode(secretBase32) } });
  assert.equal(challenge.statusCode, 200, challenge.body);
  const body = challenge.json();
  assert.ok(typeof body.token === "string" && body.token.length > 20);
  assert.deepEqual(body.portalPermissionSet, ["can_view_dashboard"]);
  assert.equal(body.mfaMethod, "totp");
  assert.equal(body.mfaChallengeRequired, undefined);
  assert.equal(body.preAuthToken, undefined);
  // The session it minted works on a normal route.
  assert.equal((await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${body.token}` } })).statusCode, 200);

  // Recovery code through the route, once.
  const rc = await app.inject({ method: "POST", url: "/auth/mfa/challenge", payload: { preAuthToken: preAuth, code: recovery[2] } });
  assert.equal(rc.statusCode, 200, rc.body);
  assert.equal(rc.json().mfaMethod, "recovery_code");
  assert.equal(rc.json().recoveryCodesRemaining, 9);
  const rc2 = await app.inject({ method: "POST", url: "/auth/mfa/challenge", payload: { preAuthToken: preAuth, code: recovery[2] } });
  assert.equal(rc2.statusCode, 401);

  // Admin disable: a TENANT_ADMIN is refused, SUPER_ADMIN succeeds.
  const taAuth = { authorization: `Bearer ${sessionFor(TENANT_ADMIN)}` };
  assert.equal((await app.inject({ method: "POST", url: `/admin/users/${IZZY.id}/mfa/disable`, headers: taAuth, payload: {} })).statusCode, 403);
  const adminDisable = await app.inject({ method: "POST", url: `/admin/users/${IZZY.id}/mfa/disable`, headers: auth, payload: { reason: "test" } });
  assert.equal(adminDisable.statusCode, 200, adminDisable.body);
  assert.deepEqual(adminDisable.json(), { ok: true, wasEnabled: true });
  assert.equal((await app.inject({ method: "GET", url: "/auth/mfa/status", headers: auth })).json().enabled, false);
  // The old pre-auth token is dead now.
  assert.equal((await app.inject({ method: "POST", url: "/auth/mfa/challenge", payload: { preAuthToken: preAuth, code: totpCode(secretBase32) } })).statusCode, 401);
  await app.close();
});

test("routes: throttled challenge answers 429 + Retry-After, never 401", async () => {
  const { app, fake } = await buildRoutedApp();
  await enrol(fake.deps, BAILA.id);
  const login = await decideLoginMfa(fake.deps, { id: BAILA.id, role: BAILA.role });
  if (login.kind !== "challenge") throw new Error("expected challenge");
  for (let i = 0; i < 5; i++) {
    const r: any = await app.inject({ method: "POST", url: "/auth/mfa/challenge", payload: { preAuthToken: login.preAuthToken, code: "000000" }, headers: { "x-forwarded-for": "198.51.100.9" } });
    assert.equal(r.statusCode, 401);
  }
  const last: any = await app.inject({ method: "POST", url: "/auth/mfa/challenge", payload: { preAuthToken: login.preAuthToken, code: "000000" }, headers: { "x-forwarded-for": "198.51.100.9" } });
  assert.equal(last.statusCode, 429);
  assert.deepEqual(last.json(), { error: "RATE_LIMITED" });
  assert.ok(Number(last.headers["retry-after"]) > 0);
  await app.close();
});

// ─── Source guards — the wiring in server.ts and the bypass list ─────────────

test("⛔ server.ts wiring: login decides via decideLoginMfa AFTER the password check, the challenge branch carries NO token, and the hook refuses mfa_pending", () => {
  const server = read("../server.ts");
  const login = server.slice(server.indexOf('app.post("/auth/login"'), server.indexOf('app.get("/auth/invite/validate"'));
  assert.ok(login.length > 500, "login route anchor");
  const bcryptAt = login.indexOf("bcrypt.compare(input.password");
  const mfaAt = login.indexOf("decideLoginMfa(");
  assert.notEqual(bcryptAt, -1);
  assert.notEqual(mfaAt, -1, "login must consult decideLoginMfa");
  assert.ok(mfaAt > bcryptAt, "the MFA decision must come AFTER the password check — a wrong password must answer the same 401 whether or not MFA is on");
  const challengeBranch = login.slice(login.indexOf('mfaOutcome.kind === "challenge"'), login.indexOf("await db.user.update({ where: { id: user.id }, data: { lastLoginAt"));
  assert.match(challengeBranch, /mfaChallengeRequired: true/);
  assert.match(challengeBranch, /preAuthToken: mfaOutcome\.preAuthToken/);
  assert.doesNotMatch(challengeBranch, /\btoken:/, "the challenge response must NOT carry a session token");
  assert.doesNotMatch(challengeBranch, /issueLoginSession\(/, "no session may be minted before the second factor");
  assert.match(login, /mfaEnrollmentRequired: true/, "grace mode flag on the normal body");
  // The normal path still returns the shared session body.
  // ⛔ THE "NORMAL LOGIN IS UNCHANGED" PROOF: the no-MFA body is `issueLoginSession`'s
  // `{ token, portalPermissionSet? }` and NOTHING else — the only extra key is the
  // grace flag, and it is conditional on the required-role outcome.
  assert.match(login, /const session = await issueLoginSession\(user\.id\);\s*\n\s*return \{\s*\n\s*\.\.\.session,\s*\n\s*\.\.\.\(mfaOutcome\.kind === "enroll_grace" \? \{ mfaEnrollmentRequired: true \} : \{\}\),\s*\n\s*\};/);
  const issueBody = server.slice(server.indexOf("async function issueLoginSession("), server.indexOf("const mfaDeps = buildMfaDeps("));
  assert.match(issueBody, /return \{\s*\n\s*token,\s*\n\s*\.\.\.\(portalPermissionSet \? \{ portalPermissionSet \} : \{\}\),\s*\n\s*\};/, "the session body is exactly { token, portalPermissionSet? } — what /auth/login returned before MFA");
  // issueLoginSession still fetches the naming extension (userDisplayName.callsites guard depends on it).
  const issue = server.slice(server.indexOf("async function issueLoginSession("), server.indexOf("const mfaDeps = buildMfaDeps("));
  assert.match(issue, /const namingExtension = await db\.extension/);
  assert.match(issue, /portalPermissionSet/);
  // Hook: belt-and-braces refusal of a pre-auth claim, AFTER jwtVerify.
  const hook = server.slice(server.indexOf('app.addHook("preHandler", async (req, reply) => {'), server.indexOf('app.get("/me",'));
  assert.match(hook, /await req\.jwtVerify\(\);\s*\n\s*\} catch \{\s*\n\s*return reply\.status\(401\)\.send\(\{ error: "unauthorized" \}\);/);
  assert.match(hook, /\(req\.user as any\)\?\.mfa_pending === true\)\s*\{\s*\n\s*return reply\.status\(401\)\.send\(\{ error: "unauthorized" \}\);/);
  // Routes are registered with the same session minter login uses.
  assert.match(server, /registerMfaRoutes\(app, \{ audit, issueSession: issueLoginSession, service: mfaDeps \}\)/);
});

test("⛔ bypass list: exactly one /auth/mfa/ entry, and it is the challenge", () => {
  const src = read("../jwtPublicRouteBypass.ts").replace(/\/\/[^\n]*/g, "");
  const entries = src.match(/"\/auth\/mfa\/[^"]*"/g) ?? [];
  assert.deepEqual(entries, ['"/auth/mfa/challenge"']);
});

test("⛔ mfaRoutes: only the challenge route reads a pre-auth token; every other route reads req.user", () => {
  const src = read("./mfaRoutes.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const routes = [...src.matchAll(/app\.(get|post)\("([^"]+)"/g)].map((m) => m[2]);
  assert.deepEqual(routes.sort(), [
    "/admin/users/:id/mfa/disable",
    "/auth/mfa/challenge",
    "/auth/mfa/disable",
    "/auth/mfa/recovery-codes/regenerate",
    "/auth/mfa/status",
    "/auth/mfa/totp/setup",
    "/auth/mfa/totp/verify",
  ]);
  const challengeBody = src.slice(src.indexOf('app.post("/auth/mfa/challenge"'), src.indexOf('app.post("/auth/mfa/disable"'));
  assert.match(challengeBody, /completeMfaChallenge\(/);
  assert.doesNotMatch(challengeBody, /getUser\(req\)/, "the challenge route has no session to read");
  for (const name of ["/auth/mfa/status", "/auth/mfa/totp/setup", "/auth/mfa/totp/verify", "/auth/mfa/disable", "/auth/mfa/recovery-codes/regenerate", "/admin/users/:id/mfa/disable"]) {
    const start = src.indexOf(`"${name}"`);
    assert.match(src.slice(start, start + 400), /getUser\(req\)/, `${name} must act on the signed-in user`);
  }
});

test("⛔ the Prisma store uses accessors that EXIST on the generated client (the `(db as any)` transposition trap, CLAUDE.md)", async () => {
  // prismaMfaStore takes `client: any`, so a typo like `mfaUser` would typecheck
  // green and crash on the first real call — exactly how `billingTenantSettings`
  // shipped broken. Ask the generated client, not the source.
  const { Prisma } = await import("@prisma/client");
  assert.equal((Prisma.ModelName as any).UserMfa, "UserMfa");
  assert.equal((Prisma.ModelName as any).UserMfaRecoveryCode, "UserMfaRecoveryCode");
  const src = read("./mfaRoutes.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const accessors = new Set([...src.matchAll(/client\.(\w+)\./g)].map((m) => m[1]));
  accessors.delete("$transaction");
  assert.deepEqual([...accessors].sort(), ["user", "userMfa", "userMfaRecoveryCode"]);
  for (const a of accessors) {
    const model = a.charAt(0).toUpperCase() + a.slice(1);
    assert.equal((Prisma.ModelName as any)[model], model, `client.${a} must map to a real model`);
  }
});

test("⛔ nothing in the MFA module logs a secret or a code", () => {
  for (const f of ["./mfaService.ts", "./mfaRoutes.ts", "./totp.ts", "./recoveryCodes.ts", "./preAuthToken.ts"]) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(src, /console\.(log|info|warn|error)\(/, `${f} must not console-log`);
    assert.doesNotMatch(src, /log\.(info|warn|error)\([^)]*(secret|code|recovery)/i, `${f} must not log a secret or code`);
  }
});
