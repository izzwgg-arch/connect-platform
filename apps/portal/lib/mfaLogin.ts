/**
 * The portal side of MFA (Phase 11, 2026-08-18) — the pure bits, so they can be
 * tested without a browser.
 *
 * The api's login contract (apps/api/src/mfa/mfaService.ts, top comment):
 *
 *   200 { token, portalPermissionSet? }                        → signed in
 *   200 { …same…, mfaEnrollmentRequired: true }                → signed in, but
 *         this role must set up two-step verification (GRACE mode: nothing is
 *         refused; the portal only prompts)
 *   200 { mfaChallengeRequired: true, preAuthToken, expiresInSeconds, methods,
 *         error: "mfa_required" }                             → NOT signed in:
 *         ask for a code and POST /auth/mfa/challenge { preAuthToken, code }
 *         which answers the first shape
 *
 * ⛔ The pre-auth token is NOT a session and must never be written to
 * localStorage as one — `writeAuthToken` would then hand it to every poller,
 * each of which gets 401 unauthorized, and the global 401 handler would tear the
 * (nonexistent) session down. It lives in React state on the login page only.
 */

export type LoginApiResponse = {
  token?: string;
  portalPermissionSet?: string[];
  mfaEnrollmentRequired?: boolean;
  mfaChallengeRequired?: boolean;
  preAuthToken?: string;
  expiresInSeconds?: number;
  methods?: string[];
  error?: string;
  /** Per-tenant sign-in code (2FA-by-code, 2026-08-19). */
  otpChallengeRequired?: boolean;
  channel?: string;
  channels?: string[];
  destination?: string;
  sent?: boolean;
  /** "already_sent" = a code we sent earlier is still valid; we did NOT send another. */
  reason?: string;
  /** Returned by /auth/otp/verify when "remember this device" was ticked. */
  trustedDeviceToken?: string;
  trustedDeviceExpiresAt?: string;
};

export type ClassifiedLogin =
  | { kind: "session"; token: string; portalPermissionSet?: string[]; mfaEnrollmentRequired: boolean; trustedDeviceToken?: string; trustedDeviceExpiresAt?: string }
  | { kind: "mfa_challenge"; preAuthToken: string; expiresInSeconds: number; methods: string[] }
  | { kind: "otp_challenge"; preAuthToken: string; expiresInSeconds: number; channel: string; channels: string[]; destination: string; sent: boolean; reason?: string }
  | { kind: "failed"; error: string };

export function classifyLoginResponse(res: LoginApiResponse | null | undefined): ClassifiedLogin {
  const token = String(res?.token || "");
  if (token) {
    return {
      kind: "session",
      token,
      portalPermissionSet: Array.isArray(res?.portalPermissionSet) ? res!.portalPermissionSet : undefined,
      mfaEnrollmentRequired: res?.mfaEnrollmentRequired === true,
      ...(res?.trustedDeviceToken ? { trustedDeviceToken: String(res.trustedDeviceToken), trustedDeviceExpiresAt: String(res.trustedDeviceExpiresAt || "") } : {}),
    };
  }
  const preAuth = String(res?.preAuthToken || "");
  if (res?.otpChallengeRequired === true && preAuth) {
    return {
      kind: "otp_challenge",
      preAuthToken: preAuth,
      expiresInSeconds: Number.isFinite(res?.expiresInSeconds) ? Number(res!.expiresInSeconds) : 300,
      channel: String(res?.channel || "EMAIL"),
      channels: Array.isArray(res?.channels) && res!.channels.length ? res!.channels.map(String) : ["EMAIL"],
      destination: String(res?.destination || ""),
      sent: res?.sent !== false,
      ...(res?.reason ? { reason: String(res.reason) } : {}),
    };
  }
  if (res?.mfaChallengeRequired === true && preAuth) {
    return {
      kind: "mfa_challenge",
      preAuthToken: preAuth,
      expiresInSeconds: Number.isFinite(res?.expiresInSeconds) ? Number(res!.expiresInSeconds) : 300,
      methods: Array.isArray(res?.methods) ? res!.methods : ["totp", "recovery_code"],
    };
  }
  return { kind: "failed", error: String(res?.error || "Login failed") };
}

/** Six digits = an authenticator code; ten letters/digits = a recovery code. */
export function normalizeMfaCodeInput(raw: unknown): string {
  return String(raw ?? "").trim().replace(/\s+/g, "");
}

export function looksLikeTotpCodeInput(raw: unknown): boolean {
  return /^\d{6}$/.test(String(raw ?? "").replace(/\D+/g, ""));
}

export function looksLikeRecoveryCodeInput(raw: unknown): boolean {
  return /^[A-Za-z0-9]{10}$/.test(String(raw ?? "").replace(/[^A-Za-z0-9]/g, ""));
}

/** Can this be sent at all? Anything else gets a local hint instead of a round trip. */
export function isSubmittableMfaCode(raw: unknown): boolean {
  return looksLikeTotpCodeInput(raw) || looksLikeRecoveryCodeInput(raw);
}

/**
 * Plain English for the challenge failures. Reads `e.body` (never `.payload`,
 * which does not exist on ApiError — CLAUDE.md), and never shows a bare slug.
 */
export function mfaChallengeErrorMessage(status: number, body: unknown): string {
  const code = String((body as { error?: string } | null)?.error || "");
  if (status === 429) return "Too many wrong codes. Wait ten minutes and try again.";
  if (code === "preauth_invalid") return "That sign-in step timed out. Enter your email and password again.";
  if (code === "invalid_code") return "That code didn't match. Codes change every 30 seconds — try the current one, or use a recovery code.";
  if (status >= 500) return "The server had a problem. Try again in a moment.";
  return "That code didn't work. Try again.";
}

/**
 * Where a required-role person who has not enrolled is sent after signing in:
 * the security page, with the place they were going preserved so "Not now"
 * takes them there.
 */
export function securityPageDestination(next: string | null | undefined): string {
  const dest = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  return `/account/security?setup=1&next=${encodeURIComponent(dest)}`;
}

/** Only ever navigate to a same-origin path — a `next` param is attacker-writable. */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next) return fallback;
  let decoded = next;
  try { decoded = decodeURIComponent(next); } catch { /* keep raw */ }
  if (!decoded.startsWith("/") || decoded.startsWith("//") || /^\/\\/.test(decoded)) return fallback;
  return decoded;
}
