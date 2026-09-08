/**
 * Sign-in code — "2FA by text or email". Per USER, turned on by the person
 * themself on Account → Security. Nothing else on the platform switches it.
 *
 * v1 (2026-08-19, Izzy): per-tenant admin switch, code by text or email,
 *   "remember this device" 90 days, 90-day sessions.
 * v2 (2026-09-08, Izzy): "give an option between sms and email … only
 *   required once when the customer logs in … removed every time the customer
 *   logs out … no expiry … send to the registered phone number and email."
 * v3 (2026-09-08, Izzy, from the approved mockups): "I want the 2fa only to be
 *   accessed here [Account → Security] … remove the authenticator app, just
 *   stick with text or email." → `User.loginOtpEnabledAt`; the per-tenant
 *   switch and channel setting are gone from the UI and the api (the two
 *   Tenant columns stay in the database, inert — dropping them would break the
 *   OLD api container during a blue/green swap); the authenticator-app
 *   enrolment UI is gone (its routes stay, dormant, 0 users enrolled).
 *
 * THE FLOW
 *   Account → Security → "Turn on two-step verification" → POST /auth/otp/enable
 *   (no confirmation needed: it only adds a factor). From then on, after the
 *   password, /auth/login answers the challenge with BOTH masked registered
 *   destinations and sends NOTHING; the person picks Text me / Email me →
 *   POST /auth/otp/send { preAuthToken, channel } → the code goes to the
 *   REGISTERED phone (User.phone) or email (User.email), never to an address the
 *   client supplies → POST /auth/otp/verify { preAuthToken, code } → the
 *   ordinary session. When only ONE channel is possible (no phone on file) the
 *   login sends by email straight away. A client may pass `otpChannel` to
 *   /auth/login and skip the round trip.
 *   Turning it off (POST /auth/otp/disable) asks for the PASSWORD, not a code —
 *   so a person who lost their phone is not locked out of turning it off.
 *
 * ONCE PER SIGN-IN, NO EXPIRY: the code is asked exactly once per sign-in. The
 * session it mints lives until the person signs out — like every other session
 * on the platform, nothing expires on a clock. No trusted-device token exists
 * (`TrustedLoginDevice` rows are inert).
 *
 * ⛔ THE RULES
 *  - The code is stored ONLY as a SHA-256 hash and compared in constant time.
 *  - The code is BOUND to the pre-auth token that requested it (`preAuthJti`),
 *    so a code can only be spent by the login attempt that caused it.
 *  - Five wrong guesses spend the challenge; a new sign-in is needed. Every
 *    verify is ALSO throttled per account and per source IP (`loginThrottle.ts`
 *    factory) — a throttled answer is 429, never 401. The password check on
 *    /auth/otp/disable rides the same throttle.
 *  - Sends are capped (3 per challenge) and each send REPLACES the code.
 *  - One live code per person (`decideChallengeReuse`): a loop on /auth/login or
 *    /auth/otp/send cannot spend the SMS balance.
 *  - The pre-auth token has its OWN purpose (`otp_challenge`), so a TOTP
 *    pre-auth token cannot be spent here and vice versa.
 *  - A person who is TOTP-enrolled (legacy, dormant) is never asked twice: the
 *    authenticator challenge already ran.
 *  - ⛔ The mobile app has no code step. A person who turns this on cannot
 *    finish sign-in on the current app until the build with the code step
 *    ships. The Security page says so before they turn it on.
 *  - Nothing here sends by itself: the code goes out through the SAME doors
 *    every other message uses — the platform SMS sender (`billingSmsSender.ts`)
 *    and the `EmailJob` outbox with type `LOGIN_CODE` (⛔ never `ADMIN_ALERT`,
 *    which the send door drops).
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";

export const LOGIN_OTP_CODE_LENGTH = 6;
export const LOGIN_OTP_TTL_SECONDS = 10 * 60;
export const LOGIN_OTP_MAX_ATTEMPTS = 5;
export const LOGIN_OTP_MAX_SENDS = 3;
/** EmailJob.type for the code email — a customer email, so NEVER "ADMIN_ALERT". */
export const LOGIN_CODE_EMAIL_TYPE = "LOGIN_CODE";

export type OtpChannel = "SMS" | "EMAIL";

export function normalizeOtpChannel(raw: unknown): OtpChannel | null {
  const v = String(raw ?? "").trim().toUpperCase();
  return v === "SMS" || v === "EMAIL" ? v : null;
}

// ── the gate ─────────────────────────────────────────────────────────────────

export type OtpGateInput = {
  /** `User.loginOtpEnabledAt` is set — the person turned it on. */
  userOtpEnabled: boolean;
  /** TOTP-enrolled users (legacy) already carry a second factor; the code is not layered on. */
  userHasTotp: boolean;
};
export type OtpGate = { kind: "none" } | { kind: "challenge" };

/**
 * v3: per user. ON and not TOTP-enrolled = a code, every sign-in. What makes it
 * "once per login" is that the SESSION lasts until sign-out.
 */
export function decideOtpGate(input: OtpGateInput): OtpGate {
  if (!input.userOtpEnabled) return { kind: "none" };
  if (input.userHasTotp) return { kind: "none" };
  return { kind: "challenge" };
}

// ── one live code per person, however many times they sign in ────────────────

/**
 * ⛔ WHY THIS EXISTS: without it, every POST /auth/login for an enabled user
 * minted a fresh code and sent a fresh TEXT. Sends are capped per challenge
 * (`LOGIN_OTP_MAX_SENDS`), but nothing capped creating CHALLENGES — so anyone
 * holding a valid password could spend our SMS balance at the global rate
 * limit (480/min per IP), and an ordinary customer double-clicking Sign in
 * got two texts with two different codes, of which only the newer worked.
 *
 * So a send that finds a LIVE challenge (unconsumed, unexpired, and with
 * tries left) re-binds that challenge to the new login instead of creating
 * another: the code already on their phone stays the one that works, and
 * only the newest login can spend it.
 *
 * ⛔ A challenge that has burned its attempts is NOT reused — that would hand
 * someone a dead code and no way forward until it expired. Burning those five
 * attempts is itself throttled, so this is not a way to force new texts.
 */
export type LiveChallengeRow = { attempts: number; consumedAt: Date | null; expiresAt: Date } | null;

export function decideChallengeReuse(row: LiveChallengeRow, nowMs: number): { reuse: boolean } {
  if (!row) return { reuse: false };
  if (row.consumedAt) return { reuse: false };
  if (row.expiresAt.getTime() <= nowMs) return { reuse: false };
  if (row.attempts >= LOGIN_OTP_MAX_ATTEMPTS) return { reuse: false };
  return { reuse: true };
}

// ── channels ─────────────────────────────────────────────────────────────────

export type ChannelChoice = { channels: OtpChannel[]; preferred: OtpChannel };

/**
 * Which channels this person may receive the code on. Email is always possible
 * (an account IS an email address). SMS needs a phone on file. There is no
 * tenant setting any more (v3).
 */
export function chooseChannels(hasPhone: boolean, requested?: unknown): ChannelChoice {
  const channels: OtpChannel[] = hasPhone ? ["SMS", "EMAIL"] : ["EMAIL"];
  const req = normalizeOtpChannel(requested);
  const preferred = req && channels.includes(req) ? req : channels[0];
  return { channels, preferred };
}

/** The masked place each offered channel would deliver to — what the chooser and the Security page show. */
export type ChannelOffer = { channels: OtpChannel[]; destinations: Partial<Record<OtpChannel, string>> };

export function offerChannels(phone: string | null | undefined, email: string): ChannelOffer {
  const { channels } = chooseChannels(!!phone);
  const destinations: Partial<Record<OtpChannel, string>> = {};
  for (const c of channels) destinations[c] = maskDestination(c, c === "SMS" ? String(phone) : email);
  return { channels, destinations };
}

/**
 * Does the login send now, or wait for the person to choose?
 *   - the client named an allowed channel → send on it (no extra round trip);
 *   - exactly one channel is possible     → send on it (nothing to choose);
 *   - otherwise                           → offer the choice, send nothing.
 */
export type FirstSend = { kind: "send"; channel: OtpChannel } | { kind: "choose" };

export function decideFirstSend(channels: OtpChannel[], requested?: unknown): FirstSend {
  const req = normalizeOtpChannel(requested);
  if (req && channels.includes(req)) return { kind: "send", channel: req };
  if (channels.length === 1) return { kind: "send", channel: channels[0] };
  return { kind: "choose" };
}

// ── code + hashing ───────────────────────────────────────────────────────────

export function generateOtpCode(): string {
  // randomInt is uniform; zero-padded to the full length so leading zeros count.
  return String(randomInt(0, 10 ** LOGIN_OTP_CODE_LENGTH)).padStart(LOGIN_OTP_CODE_LENGTH, "0");
}

export function hashOtpCode(code: string, challengeId: string): string {
  // Salted with the challenge id so identical codes never share a hash.
  return createHash("sha256").update(`${challengeId}:${String(code).trim()}`).digest("hex");
}

export function otpCodeMatches(candidate: unknown, challengeId: string, storedHash: string): boolean {
  const c = String(candidate ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  const a = Buffer.from(hashOtpCode(c, challengeId), "utf8");
  const b = Buffer.from(String(storedHash), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function maskDestination(channel: OtpChannel, value: string): string {
  const v = String(value ?? "");
  if (channel === "SMS") {
    const digits = v.replace(/\D/g, "");
    return digits.length >= 4 ? `•••-•••-${digits.slice(-4)}` : "•••";
  }
  const [local = "", domain = ""] = v.split("@");
  const head = local.slice(0, 1);
  return `${head}${"•".repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}

// ── verify decision (pure) ────────────────────────────────────────────────────

export type ChallengeRow = {
  id: string;
  userId: string;
  preAuthJti: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
};

export type VerifyDecision =
  | { ok: true }
  | { ok: false; reason: "no_challenge" | "expired" | "consumed" | "too_many_attempts" | "wrong_code" | "wrong_login" };

export function decideOtpVerify(row: ChallengeRow | null, input: { userId: string; preAuthJti: string; code: unknown }, nowMs: number): VerifyDecision {
  if (!row) return { ok: false, reason: "no_challenge" };
  if (row.userId !== input.userId || row.preAuthJti !== input.preAuthJti) return { ok: false, reason: "wrong_login" };
  if (row.consumedAt) return { ok: false, reason: "consumed" };
  if (row.expiresAt.getTime() <= nowMs) return { ok: false, reason: "expired" };
  if (row.attempts >= LOGIN_OTP_MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };
  if (!otpCodeMatches(input.code, row.id, row.codeHash)) return { ok: false, reason: "wrong_code" };
  return { ok: true };
}

// ── message text ─────────────────────────────────────────────────────────────

/** ⛔ Plain ASCII: one emoji flips the SMS to UCS-2 and doubles the segments. */
export function otpSmsBody(code: string, brand: string = "Loopcom"): string {
  return `${brand} sign-in code: ${code}. It expires in 10 minutes. If you did not try to sign in, ignore this text.`;
}

export function otpEmailSubject(code: string, brand: string = "Loopcom"): string {
  return `${code} is your ${brand} sign-in code`;
}

export function otpEmailText(code: string, brand: string = "Loopcom"): string {
  return `Your ${brand} sign-in code is ${code}.\n\nIt expires in 10 minutes. If you did not try to sign in, you can ignore this email.`;
}

export function otpEmailHtml(code: string, brand: string = "Loopcom"): string {
  const safe = String(code).replace(/[^0-9]/g, "");
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#0c1218;background:#ffffff;padding:24px">
<p style="font-size:15px;margin:0 0 12px">Your ${brand} sign-in code is</p>
<p style="font-size:32px;letter-spacing:6px;font-weight:700;margin:0 0 16px">${safe}</p>
<p style="font-size:13px;color:#555;margin:0">It expires in 10 minutes. If you did not try to sign in, you can ignore this email.</p>
</body></html>`;
}
