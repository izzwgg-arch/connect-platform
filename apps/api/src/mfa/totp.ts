/**
 * RFC 6238 TOTP (time-based one-time password) — hand-rolled over `node:crypto`.
 *
 * ⛔ Deliberately NO third-party OTP library. apps/api has been killed on boot
 * before by an import that was in node_modules but not in package.json (the
 * `undici` incident; `dependencyHygiene.test.ts`), and TOTP is forty lines of
 * HMAC-SHA1 plus base32. Every authenticator app (Google Authenticator, Authy,
 * 1Password, Microsoft Authenticator, Bitwarden) speaks exactly this: SHA1,
 * 6 digits, 30-second step — the defaults below are the interoperable ones and
 * must not be "upgraded" to SHA256/8 digits without checking each app.
 *
 * Nothing in this file touches a database, an env var or a clock it was not
 * handed, so it is testable against the RFC 6238 Appendix B vectors (see
 * `mfa.test.ts`).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;
/**
 * ±1 step of tolerance, i.e. a code from the previous or next 30-second window
 * is accepted — the standard allowance for phone clocks that drift a little.
 * Wider than this and a stolen code lives longer for no usability gain.
 */
export const TOTP_WINDOW = 1;
/** 20 random bytes = 160-bit secret, the size RFC 4226 recommends for SHA1. */
export const TOTP_SECRET_BYTES = 20;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, no padding — the form authenticator apps expect in the URI. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = String(input || "").toUpperCase().replace(/=+$/g, "").replace(/[\s-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("invalid_base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh secret, base32 — what gets encrypted at rest and shown once as a QR. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

/** The time-step counter for a moment in time. */
export function totpCounter(nowMs: number, stepSeconds: number = TOTP_STEP_SECONDS): number {
  return Math.floor(nowMs / 1000 / stepSeconds);
}

/** HOTP (RFC 4226) for one counter value. */
export function hotp(secretBase32: string, counter: number, digits: number = TOTP_DIGITS): string {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  // Big-endian 64-bit counter. Counters for any date this century fit in 32
  // bits, so the high word is written as 0 explicitly rather than trusted to
  // a bit-shift that would silently wrap.
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac("sha1", key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  const otp = binary % 10 ** digits;
  return String(otp).padStart(digits, "0");
}

/** The code an authenticator app shows right now. */
export function totpCode(secretBase32: string, nowMs: number = Date.now()): string {
  return hotp(secretBase32, totpCounter(nowMs));
}

/** Only ever compare digit strings in constant time — a 6-digit space is small
 *  enough that a timing oracle would matter. */
function digitsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Normalise what a person typed: strip spaces, keep digits. "123 456" → "123456". */
export function normalizeTotpInput(input: unknown): string {
  return String(input ?? "").replace(/\D+/g, "");
}

export function looksLikeTotpCode(input: unknown): boolean {
  return /^\d{6}$/.test(normalizeTotpInput(input));
}

/**
 * Verify a code against a secret at a moment in time.
 *
 * Returns the matched counter, or null. `lastUsedCounter` is the replay guard:
 * a code whose counter is not strictly greater than the last one accepted is
 * refused even if it is otherwise valid — so the same 6 digits cannot be
 * used twice inside their 30 s (or 90 s, with the window) of validity.
 * ⛔ Callers MUST persist the returned counter as the new `lastUsedCounter`.
 */
export function verifyTotp(input: {
  secretBase32: string;
  code: unknown;
  nowMs?: number;
  window?: number;
  lastUsedCounter?: number | null;
}): { ok: true; counter: number } | { ok: false; reason: "malformed" | "replayed" | "mismatch" } {
  const code = normalizeTotpInput(input.code);
  if (code.length !== TOTP_DIGITS) return { ok: false, reason: "malformed" };
  const now = input.nowMs ?? Date.now();
  const window = input.window ?? TOTP_WINDOW;
  const center = totpCounter(now);
  const last = input.lastUsedCounter ?? null;
  let sawReplay = false;
  // Check the current step first so the common case costs one HMAC.
  const order = [0];
  for (let i = 1; i <= window; i++) order.push(-i, i);
  for (const delta of order) {
    const counter = center + delta;
    if (counter < 0) continue;
    if (digitsEqual(hotp(input.secretBase32, counter), code)) {
      if (last != null && counter <= last) {
        sawReplay = true;
        continue;
      }
      return { ok: true, counter };
    }
  }
  return { ok: false, reason: sawReplay ? "replayed" : "mismatch" };
}

/**
 * The `otpauth://` URI an authenticator app scans. Issuer appears both as the
 * label prefix and the query parameter because different apps read different
 * ones; both are percent-encoded so a company name with a space or a colon
 * cannot break the label.
 */
export function buildOtpauthUri(input: { issuer: string; account: string; secretBase32: string }): string {
  const issuer = String(input.issuer || "Loopcom").trim() || "Loopcom";
  const account = String(input.account || "").trim();
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: input.secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Group a base32 secret in fours for a person typing it by hand. */
export function formatSecretForDisplay(secretBase32: string): string {
  return String(secretBase32 || "").replace(/(.{4})/g, "$1 ").trim();
}
