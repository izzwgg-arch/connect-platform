/**
 * Per-tenant sign-in code — "2FA by code".
 *
 * v1 (2026-08-19, Izzy): "a switch to turn it on and off per tenant. When they
 *   log in, they get a text or email with a code, and they have to hit
 *   'Remember me' to be able to log in without it. They should have to
 *   re-login every 90 days if 2FA is enabled."
 * v2 (2026-09-08, Izzy): "Make the 2FA give an option between SMS and email.
 *   It is only required once when the customer or tenant logs in, and it gets
 *   removed every time the customer logs out. There is no expiry and the only
 *   thing that removes it is logging out. Send the 2FA code to the registered
 *   phone number and email of the customer."
 *
 * WHAT v2 CHANGED
 *   - THE PERSON CHOOSES WHERE THE CODE GOES. When both channels are possible,
 *     /auth/login sends NOTHING: it answers the challenge with `channels` and
 *     the masked `destinations` for each (`•••-•••-1213`, `i•••@example.com`),
 *     `sent: false`, `reason: "choose_channel"`. The portal shows "Text me at …"
 *     / "Email me at …"; `POST /auth/otp/send { preAuthToken, channel }` creates
 *     the code and sends it to the REGISTERED phone (User.phone) or email
 *     (User.email) — never to an address the client supplies. When only ONE
 *     channel is possible (no phone on file, or the tenant allows one channel)
 *     the login sends on it straight away, as before: a one-button choice is
 *     no choice. A client that already knows the answer may pass `otpChannel`
 *     to /auth/login and skip the extra round trip.
 *   - "REMEMBER THIS DEVICE" IS GONE. The code is asked exactly once per
 *     sign-in. The session it mints lives until the person signs out — like
 *     every other session on the platform, nothing expires on a clock — and
 *     signing out is the only thing that ends it; the next sign-in asks for a
 *     code again. No trusted-device token is read, minted or honoured any more.
 *     `TrustedLoginDevice` rows are inert (the table stays; nothing reads it).
 *   - THE 90-DAY SESSION FOR OTP TENANTS IS GONE ("there is no expiry").
 *     `issueLoginSession` signs one way for everyone again.
 *
 * HOW IT FITS THE LOGIN THAT ALREADY EXISTS (server.ts `/auth/login`):
 *   password ok → TOTP MFA decision (mfaService, unchanged) → THIS gate:
 *   - tenant switch OFF                     → nothing changes, byte-for-byte
 *   - user is TOTP-enrolled                 → nothing changes (they already have a
 *                                             stronger second factor; the TOTP
 *                                             challenge above already ran)
 *   - otherwise                             → the challenge above, and NO session
 *     token. `POST /auth/otp/verify { preAuthToken, code }` mints the session.
 *
 * ⛔ THE RULES (unchanged from v1)
 *  - The code is stored ONLY as a SHA-256 hash and compared in constant time.
 *  - The code is BOUND to the pre-auth token that requested it (`preAuthJti`),
 *    so a code can only be spent by the login attempt that caused it.
 *  - Five wrong guesses spend the challenge; a new sign-in is needed. Every
 *    verify is ALSO throttled per account and per source IP (`loginThrottle.ts`
 *    factory, the same shape as TOTP) — a throttled answer is 429, never 401.
 *  - Sends are capped (3 per challenge) and each send REPLACES the code.
 *  - One live code per person (`decideChallengeReuse`): a loop on /auth/login or
 *    /auth/otp/send cannot spend the SMS balance.
 *  - The pre-auth token has its OWN purpose (`otp_challenge`), so a TOTP
 *    pre-auth token cannot be spent here and vice versa.
 *  - ⛔ The mobile app has no code step. A user on an OTP tenant cannot finish
 *    sign-in on the current app (it throws `otp_required` like it throws
 *    `mfa_required`) until the build with the code step ships. Say so before
 *    switching a tenant on whose people live in the app.
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
export type TenantOtpChannelSetting = "EMAIL" | "SMS" | "EITHER";

export function normalizeTenantOtpChannel(raw: unknown): TenantOtpChannelSetting {
  const v = String(raw ?? "").trim().toUpperCase();
  return v === "SMS" || v === "EMAIL" ? v : "EITHER";
}

export function normalizeOtpChannel(raw: unknown): OtpChannel | null {
  const v = String(raw ?? "").trim().toUpperCase();
  return v === "SMS" || v === "EMAIL" ? v : null;
}

// ── the gate ─────────────────────────────────────────────────────────────────

export type OtpGateInput = {
  tenantOtpRequired: boolean;
  /** TOTP-enrolled users already carry a stronger factor; the code is not layered on. */
  userHasTotp: boolean;
};
export type OtpGate = { kind: "none" } | { kind: "challenge" };

/**
 * v2: there is no "trusted device" branch any more. Tenant ON and not
 * TOTP-enrolled = a code, every sign-in. What makes it "once per login" is that
 * the SESSION lasts until sign-out, not a skip-the-code token.
 */
export function decideOtpGate(input: OtpGateInput): OtpGate {
  if (!input.tenantOtpRequired) return { kind: "none" };
  if (input.userHasTotp) return { kind: "none" };
  return { kind: "challenge" };
}

// ── one live code per person, however many times they sign in ────────────────

/**
 * ⛔ WHY THIS EXISTS: without it, every POST /auth/login for an OTP tenant
 * minted a fresh code and sent a fresh TEXT. Sends are capped per challenge
 * (`LOGIN_OTP_MAX_SENDS`), but nothing capped creating CHALLENGES — so anyone
 * holding a valid password could spend our SMS balance at the global rate
 * limit (480/min per IP), and an ordinary customer double-clicking Sign in
 * got two texts with two different codes, of which only the newer worked.
 *
 * So a send that finds a LIVE challenge (unconsumed, unexpired, and with
 * tries left) re-binds that challenge to the new login instead of creating
 * another: the code already on their phone stays the one that works, and
 * only the newest login can spend it. SMS per person is then bounded by the
 * send cap inside one 10-minute window, not by how often login is called.
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
 * Which channels this user may receive the code on, given the tenant's setting
 * and what the user actually has. Email is always possible (an account IS an
 * email address). SMS needs a phone. Under "SMS" with no phone → email anyway,
 * because a code that cannot be delivered is a locked-out customer.
 */
export function chooseChannels(setting: TenantOtpChannelSetting, hasPhone: boolean, requested?: unknown): ChannelChoice {
  const channels: OtpChannel[] = [];
  if ((setting === "SMS" || setting === "EITHER") && hasPhone) channels.push("SMS");
  if (setting === "EMAIL" || setting === "EITHER" || !hasPhone) channels.push("EMAIL");
  if (channels.length === 0) channels.push("EMAIL");
  const req = normalizeOtpChannel(requested);
  const preferred = req && channels.includes(req) ? req : channels[0];
  return { channels, preferred };
}

/** The masked place each offered channel would deliver to — what the chooser shows. */
export type ChannelOffer = { channels: OtpChannel[]; destinations: Partial<Record<OtpChannel, string>> };

export function offerChannels(setting: TenantOtpChannelSetting, phone: string | null | undefined, email: string): ChannelOffer {
  const { channels } = chooseChannels(setting, !!phone);
  const destinations: Partial<Record<OtpChannel, string>> = {};
  for (const c of channels) destinations[c] = maskDestination(c, c === "SMS" ? String(phone) : email);
  return { channels, destinations };
}

/**
 * v2: does the login send now, or wait for the person to choose?
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
