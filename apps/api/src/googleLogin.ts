/**
 * Sign in with Google — the pure rules (2026-09-10).
 *
 * The product rule, verbatim from Izzy: "they should be able to log in with
 * Google Auth ONLY if their email address is already in the system. They cannot
 * sign up, only log in." So this module never creates anything. Google proves
 * WHO is at the keyboard; the User table decides WHETHER they have a Loopcom
 * account. `decideGoogleLogin` is the whole policy and it has exactly three
 * answers: not_registered, disabled, ok.
 *
 * Two short-lived signed tokens ride the flow, both HS256 over a key DERIVED
 * from JWT_SECRET under this module's own label — so neither can ever be read
 * as a session by the api's JWT hook, telephony, realtime or the agent (the
 * same fence `mfa/preAuthToken.ts` uses, for the same reason):
 *
 *   state    (10 min)  start → Google → callback. Carries the origin the person
 *                      started from and where they wanted to go. Its signature is
 *                      what stops a forged callback (login CSRF) from signing a
 *                      victim into an attacker's Google account.
 *   handoff  (60 s)    callback → browser → POST /auth/google/complete. Carries
 *                      ONLY the user id. The callback is a GET that must redirect
 *                      the browser back to the portal; the session token must not
 *                      ride a URL (history, referrers, the desktop shell's logs),
 *                      so the callback hands over a one-shot code and the portal
 *                      trades it for the ordinary login body over POST. Single
 *                      use is enforced by `HandoffRegistry` (in memory — a
 *                      blue/green cutover inside the 60-second window costs one
 *                      retry, never a replay).
 *
 * ⛔ The ID token from Google is read WITHOUT verifying its signature, on
 * purpose: it arrives straight from Google's token endpoint over TLS in exchange
 * for the authorization code + our client secret, which Google's own docs name
 * as the case where signature validation is unnecessary. What IS checked, every
 * time: issuer, audience (our client id), expiry, and `email_verified === true`
 * — an unverified address must never match a Loopcom login.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const GOOGLE_LOGIN_SCOPES = ["openid", "email", "profile"] as const;
export const GOOGLE_LOGIN_STATE_TTL_SECONDS = 10 * 60;
export const GOOGLE_LOGIN_HANDOFF_TTL_SECONDS = 60;
/** The api path Google redirects back to — registered on the OAuth client for BOTH portal hostnames. */
export const GOOGLE_LOGIN_CALLBACK_PATH = "/api/auth/google/callback";
export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
/** ⛔ Frozen: changing it invalidates outstanding state/handoff tokens (harmless, they live minutes). */
const DERIVATION_LABEL = "connect:google-login:v1";

export type GoogleLoginPurpose = "google_login_state" | "google_login_handoff";

/** Portal-relative landing path after sign-in. Anything that is not a plain in-app path falls back. */
export function safeNextPath(raw: unknown, fallback = "/dashboard"): string {
  const s = String(raw ?? "").trim();
  if (!s.startsWith("/") || s.startsWith("//") || s.includes("\\") || /[\r\n\0]/.test(s)) return fallback;
  if (/^\/(login|auth\/)/i.test(s)) return fallback;
  if (s.length > 512) return fallback;
  return s;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function derivedKey(): Buffer {
  const jwtSecret = String(process.env.JWT_SECRET ?? "").trim();
  if (!jwtSecret) throw new Error("google_login_key_unavailable: JWT_SECRET is not set");
  return createHmac("sha256", jwtSecret).update(DERIVATION_LABEL).digest();
}

function sign(signingInput: string): string {
  return b64url(createHmac("sha256", derivedKey()).update(signingInput).digest());
}

type SignedClaims = { purpose: GoogleLoginPurpose; iat: number; exp: number; jti: string; [k: string]: unknown };

function mintSigned(purpose: GoogleLoginPurpose, ttlSeconds: number, extra: Record<string, unknown>, nowMs: number): { token: string; jti: string } {
  const iat = Math.floor(nowMs / 1000);
  const claims: SignedClaims = { ...extra, purpose, iat, exp: iat + ttlSeconds, jti: randomBytes(12).toString("base64url") };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  return { token: `${signingInput}.${sign(signingInput)}`, jti: claims.jti };
}

export type SignedVerifyResult<T> = { ok: true; claims: T } | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_purpose" };

function verifySigned<T extends SignedClaims>(token: unknown, purpose: GoogleLoginPurpose, nowMs: number): SignedVerifyResult<T> {
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
  if (!claims || typeof claims !== "object" || typeof claims.jti !== "string") return { ok: false, reason: "malformed" };
  if (claims.purpose !== purpose) return { ok: false, reason: "wrong_purpose" };
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  return { ok: true, claims: claims as T };
}

// ── state: start → Google → callback ─────────────────────────────────────────

export type GoogleLoginStateClaims = SignedClaims & { origin: string; next: string };

export function mintGoogleLoginState(input: { origin: string; next: string }, nowMs: number = Date.now()): string {
  return mintSigned("google_login_state", GOOGLE_LOGIN_STATE_TTL_SECONDS, { origin: input.origin, next: safeNextPath(input.next) }, nowMs).token;
}

export function verifyGoogleLoginState(token: unknown, nowMs: number = Date.now()): SignedVerifyResult<GoogleLoginStateClaims> {
  const r = verifySigned<GoogleLoginStateClaims>(token, "google_login_state", nowMs);
  if (!r.ok) return r;
  if (typeof r.claims.origin !== "string" || !/^https?:\/\/[^/]+$/.test(r.claims.origin)) return { ok: false, reason: "malformed" };
  return { ok: true, claims: { ...r.claims, next: safeNextPath(r.claims.next) } };
}

// ── handoff: callback → browser → POST /auth/google/complete ─────────────────

export type GoogleLoginHandoffClaims = SignedClaims & { sub: string };

export function mintGoogleLoginHandoff(userId: string, nowMs: number = Date.now()): { code: string; jti: string } {
  const { token, jti } = mintSigned("google_login_handoff", GOOGLE_LOGIN_HANDOFF_TTL_SECONDS, { sub: userId }, nowMs);
  return { code: token, jti };
}

export function verifyGoogleLoginHandoff(code: unknown, nowMs: number = Date.now()): SignedVerifyResult<GoogleLoginHandoffClaims> {
  const r = verifySigned<GoogleLoginHandoffClaims>(code, "google_login_handoff", nowMs);
  if (!r.ok) return r;
  if (typeof r.claims.sub !== "string" || !r.claims.sub) return { ok: false, reason: "malformed" };
  return r;
}

/**
 * Single-use registry for handoff codes. `claim` answers true exactly once per
 * jti; a second claim — a replay from browser history, a double-submit — is
 * refused. Entries expire with the code, so memory is bounded by the number of
 * sign-ins per minute.
 */
export class HandoffRegistry {
  private readonly used = new Map<string, number>();
  claim(jti: string, expMs: number, nowMs: number = Date.now()): boolean {
    this.sweep(nowMs);
    if (this.used.has(jti)) return false;
    this.used.set(jti, expMs);
    return true;
  }
  private sweep(nowMs: number): void {
    if (this.used.size < 256) return;
    for (const [k, exp] of this.used) if (exp <= nowMs) this.used.delete(k);
  }
  get size(): number {
    return this.used.size;
  }
}

// ── the Google side ──────────────────────────────────────────────────────────

export function buildGoogleAuthUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_LOGIN_SCOPES.join(" "));
  url.searchParams.set("state", input.state);
  // A sign-in, not a connection: no refresh token, no offline access, and the
  // account chooser every time so a shared computer never silently picks the
  // last Google account that used it.
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("include_granted_scopes", "false");
  return url.toString();
}

export type GoogleIdentity = { email: string; googleSub: string; name: string | null };
export type GoogleIdTokenResult =
  | { ok: true; identity: GoogleIdentity }
  | { ok: false; reason: "malformed" | "wrong_issuer" | "wrong_audience" | "expired" | "email_missing" | "email_unverified" };

/** Reads the ID token Google returned from the token endpoint. See the header for why the signature is not checked here. */
export function readGoogleIdToken(idToken: unknown, input: { clientId: string; nowMs?: number }): GoogleIdTokenResult {
  const nowMs = input.nowMs ?? Date.now();
  const raw = String(idToken ?? "").trim();
  const parts = raw.split(".");
  if (parts.length !== 3 || !parts[1]) return { ok: false, reason: "malformed" };
  let claims: any;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!claims || typeof claims !== "object") return { ok: false, reason: "malformed" };
  if (!GOOGLE_ISSUERS.has(String(claims.iss ?? ""))) return { ok: false, reason: "wrong_issuer" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(input.clientId)) return { ok: false, reason: "wrong_audience" };
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  const email = normalizeLoginEmail(claims.email);
  if (!email) return { ok: false, reason: "email_missing" };
  if (claims.email_verified !== true) return { ok: false, reason: "email_unverified" };
  const googleSub = String(claims.sub ?? "");
  const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim().slice(0, 200) : null;
  return { ok: true, identity: { email, googleSub, name } };
}

export function normalizeLoginEmail(raw: unknown): string {
  const s = String(raw ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : "";
}

// ── the policy ───────────────────────────────────────────────────────────────

export type GoogleLoginDecision = { kind: "not_registered" } | { kind: "disabled" } | { kind: "ok" };

/**
 * The whole rule. No user row → they are not on Loopcom, and nothing here will
 * make one. A disabled row → told plainly (Google already proved it is their
 * address, so this is not an oracle). INVITED counts as registered: an admin
 * adding a person's email to an extension is exactly the moment Izzy wants
 * Google sign-in to start working — the invitation email's create-a-password
 * step becomes optional for them.
 */
export function decideGoogleLogin(user: { status?: string | null } | null | undefined): GoogleLoginDecision {
  if (!user) return { kind: "not_registered" };
  if (String(user.status ?? "") === "DISABLED") return { kind: "disabled" };
  return { kind: "ok" };
}

/** The `google_error` values the portal renders. Kept as a closed list so the login page can map each to plain English. */
export const GOOGLE_LOGIN_ERRORS = [
  "not_registered",
  "disabled",
  "cancelled",
  "expired",
  "not_configured",
  "google_failed",
  "email_unverified",
] as const;
export type GoogleLoginError = (typeof GOOGLE_LOGIN_ERRORS)[number];

export function loginRedirectUrl(origin: string, params: Record<string, string | undefined>): string {
  const url = new URL("/login", origin);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  return url.toString();
}
