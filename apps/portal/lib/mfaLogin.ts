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
 * Per-tenant sign-in code (2FA-by-code; v2 2026-09-08 — the person chooses
 * text or email, no "remember this device", no expiry: sign-out ends it):
 *
 *   200 { otpChallengeRequired: true, preAuthToken, expiresInSeconds, channels,
 *         destinations, sent: false, reason: "choose_channel", error: "otp_required" }
 *         → NOT signed in: show the choice, POST /auth/otp/send { preAuthToken,
 *           channel }, then ask for the code
 *   200 { …same…, channel, destination, sent: true }          → NOT signed in:
 *         only one channel was possible, the code is already on its way — ask
 *         for the code straight away
 *   then POST /auth/otp/verify { preAuthToken, code } → the first shape
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
  /** Per-tenant sign-in code (2FA-by-code). */
  otpChallengeRequired?: boolean;
  /** The channel a code was sent on (absent while the person still has to choose). */
  channel?: string;
  channels?: string[];
  /** Masked registered destination per offered channel: { SMS: "•••-•••-1213", EMAIL: "i•••@x.com" }. */
  destinations?: Record<string, string>;
  destination?: string;
  sent?: boolean;
  /** "choose_channel" = pick text or email first; "already_sent" = a code we sent earlier is still valid; "send_limit" = no more sends this login. */
  reason?: string;
};

export type OtpChallengeState = {
  preAuthToken: string;
  expiresInSeconds: number;
  channels: string[];
  destinations: Record<string, string>;
  /** True until a code has gone out (or is known to be on its way). */
  awaitingChannel: boolean;
  channel: string;
  destination: string;
  sent: boolean;
  reason?: string;
};

export type ClassifiedLogin =
  | { kind: "session"; token: string; portalPermissionSet?: string[]; mfaEnrollmentRequired: boolean }
  | { kind: "mfa_challenge"; preAuthToken: string; expiresInSeconds: number; methods: string[] }
  | ({ kind: "otp_challenge" } & OtpChallengeState)
  | { kind: "failed"; error: string };

export function classifyLoginResponse(res: LoginApiResponse | null | undefined): ClassifiedLogin {
  const token = String(res?.token || "");
  if (token) {
    return {
      kind: "session",
      token,
      portalPermissionSet: Array.isArray(res?.portalPermissionSet) ? res!.portalPermissionSet : undefined,
      mfaEnrollmentRequired: res?.mfaEnrollmentRequired === true,
    };
  }
  const preAuth = String(res?.preAuthToken || "");
  if (res?.otpChallengeRequired === true && preAuth) {
    const channels = Array.isArray(res?.channels) && res!.channels.length ? res!.channels.map(String) : ["EMAIL"];
    const destinations = sanitizeDestinations(res?.destinations, channels);
    const reason = res?.reason ? String(res.reason) : undefined;
    const channel = String(res?.channel || "");
    // The choice screen is shown when the api explicitly asks for it, or when
    // no channel has been used yet and more than one is on offer.
    const awaitingChannel = reason === "choose_channel" || (!channel && channels.length > 1);
    const effectiveChannel = channel || channels[0];
    return {
      kind: "otp_challenge",
      preAuthToken: preAuth,
      expiresInSeconds: Number.isFinite(res?.expiresInSeconds) ? Number(res!.expiresInSeconds) : 300,
      channels,
      destinations,
      awaitingChannel,
      channel: effectiveChannel,
      destination: String(res?.destination || destinations[effectiveChannel] || ""),
      sent: res?.sent === true,
      ...(reason ? { reason } : {}),
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

function sanitizeDestinations(raw: unknown, channels: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const c of channels) {
      const v = (raw as Record<string, unknown>)[c];
      if (typeof v === "string" && v) out[c] = v;
    }
  }
  return out;
}

/** Plain English for the two places a code can go. */
export function otpChannelLabel(channel: string): string {
  return channel === "SMS" ? "text message" : "email";
}

/** What the choice button says: "Text me at •••-•••-1213" / "Email me at i•••@x.com". */
export function otpChoiceLabel(channel: string, destination: string | undefined): string {
  const verb = channel === "SMS" ? "Text me" : "Email me";
  return destination ? `${verb} at ${destination}` : verb;
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
