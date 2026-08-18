/**
 * The MFA pre-auth token — what `/auth/login` hands back INSTEAD of a session
 * when the password was right but a second factor is still owed.
 *
 * ⛔ THE ONE PROPERTY THAT MATTERS: this token must be worthless everywhere
 * except `POST /auth/mfa/challenge`. It is a JWT in shape, but it is signed
 * with a key DERIVED from `JWT_SECRET` under its own label — never the raw
 * `JWT_SECRET`. So `req.jwtVerify()` in the api's preHandler, the telephony
 * WebSocket server, the realtime service and the agent all reject it as a bad
 * signature with NO change to any of them. Had it been signed with the session
 * key and merely tagged `mfa_pending: true`, every verifier on the platform
 * would have had to learn to read that claim, and the one that forgot would
 * accept a half-authenticated token as a full session.
 *
 * (The api's preHandler ALSO refuses any verified token carrying `mfa_pending`
 * as belt and braces — see server.ts — but the derived key is the real fence.)
 *
 * Five-minute lifetime: long enough to open an authenticator app, short enough
 * that a token lifted from a network trace is dead before it can be brute-
 * forced against the challenge throttle.
 *
 * Read the secret at CALL time (not module load) so tests can set it and so a
 * container that gains the variable needs no code change.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const PRE_AUTH_TOKEN_TTL_SECONDS = 5 * 60;
export const PRE_AUTH_PURPOSE = "mfa_challenge";
/** ⛔ Frozen: changing it invalidates every outstanding pre-auth token (harmless, they live 5 min). */
const DERIVATION_LABEL = "connect:mfa-preauth-token:v1";

export type PreAuthClaims = {
  sub: string;
  /** Distinct claim so a reader can never mistake this for a session. */
  mfa_pending: true;
  purpose: typeof PRE_AUTH_PURPOSE;
  iat: number;
  exp: number;
  jti: string;
};

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function preAuthKey(): Buffer {
  const jwtSecret = String(process.env.JWT_SECRET ?? "").trim();
  if (!jwtSecret) throw new Error("mfa_preauth_key_unavailable: JWT_SECRET is not set");
  return createHmac("sha256", jwtSecret).update(DERIVATION_LABEL).digest();
}

function sign(signingInput: string): string {
  return b64url(createHmac("sha256", preAuthKey()).update(signingInput).digest());
}

export function mintPreAuthToken(userId: string, nowMs: number = Date.now()): { token: string; expiresInSeconds: number } {
  const iat = Math.floor(nowMs / 1000);
  const claims: PreAuthClaims = {
    sub: userId,
    mfa_pending: true,
    purpose: PRE_AUTH_PURPOSE,
    iat,
    exp: iat + PRE_AUTH_TOKEN_TTL_SECONDS,
    jti: randomBytes(12).toString("base64url"),
  };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  return { token: `${signingInput}.${sign(signingInput)}`, expiresInSeconds: PRE_AUTH_TOKEN_TTL_SECONDS };
}

export type PreAuthVerifyResult =
  | { ok: true; claims: PreAuthClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_purpose" };

export function verifyPreAuthToken(token: unknown, nowMs: number = Date.now()): PreAuthVerifyResult {
  const raw = String(token ?? "").trim();
  const parts = raw.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return { ok: false, reason: "malformed" };
  const [header, payload, sig] = parts;
  let expected: string;
  try {
    expected = sign(`${header}.${payload}`);
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
  let claims: any;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!claims || typeof claims.sub !== "string" || !claims.sub) return { ok: false, reason: "malformed" };
  if (claims.mfa_pending !== true || claims.purpose !== PRE_AUTH_PURPOSE) return { ok: false, reason: "wrong_purpose" };
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, claims: claims as PreAuthClaims };
}
