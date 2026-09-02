/**
 * The username and password that protect unattended access to THIS computer.
 *
 * ⛔⛔ THESE NEVER LEAVE THE MACHINE. The server records only the fact that a
 * login exists. The connecting person types the pair on their side; it travels
 * over the DTLS-encrypted peer connection straight to this app, which checks it
 * against the scrypt hash kept in its own settings file and answers yes or no.
 * A stolen Loopcom login alone therefore reaches nothing — the machine still
 * asks a question only its owner can answer.
 *
 * Pure functions, so the lockout can be tested exhaustively without a clock.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/** Five wrong tries in a row locks the computer for fifteen minutes. */
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

const SCRYPT_KEYLEN = 64;
/** N=2^15: ~50 ms on a laptop, far too slow for guessing, unnoticeable once. */
const SCRYPT_OPTS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export type AccessLogin = {
  username: string;
  /** hex */
  salt: string;
  /** hex, scrypt(password, salt) */
  hash: string;
  failures: number;
  lockedUntil: number | null;
  setAt: string;
};

export type ValidationResult = { ok: true } | { ok: false; reason: string; message: string };

export function validateUsername(raw: unknown): ValidationResult {
  const u = String(raw ?? "").trim();
  if (u.length < USERNAME_MIN) return { ok: false, reason: "username_too_short", message: `The username needs at least ${USERNAME_MIN} characters.` };
  if (u.length > USERNAME_MAX) return { ok: false, reason: "username_too_long", message: `Keep the username under ${USERNAME_MAX} characters.` };
  if (!/^[A-Za-z0-9._@-]+$/.test(u)) return { ok: false, reason: "username_characters", message: "Letters, numbers, dots, dashes and @ only." };
  return { ok: true };
}

export function validatePassword(raw: unknown): ValidationResult {
  const p = String(raw ?? "");
  if (p.length < PASSWORD_MIN) return { ok: false, reason: "password_too_short", message: `The password needs at least ${PASSWORD_MIN} characters.` };
  if (p.length > PASSWORD_MAX) return { ok: false, reason: "password_too_long", message: "That password is too long." };
  if (/^\s|\s$/.test(p)) return { ok: false, reason: "password_whitespace", message: "The password cannot start or end with a space." };
  return { ok: true };
}

/** Usernames compare case-insensitively; "Izzy-Home" and "izzy-home" are one login. */
export function normalizeUsername(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

export function createAccessLogin(username: string, password: string, now = new Date()): AccessLogin {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, Buffer.from(salt, "hex"), SCRYPT_KEYLEN, SCRYPT_OPTS).toString("hex");
  return { username: normalizeUsername(username), salt, hash, failures: 0, lockedUntil: null, setAt: now.toISOString() };
}

/** Constant-time on the hash; the username mismatch short-circuits deliberately (it is not secret). */
export function credentialsMatch(login: AccessLogin, username: unknown, password: unknown): boolean {
  if (normalizeUsername(username) !== login.username) return false;
  // ⛔ Only a STRING is a password. An object with a toString, a number, an
  // array — anything a hostile frame could carry — is refused before scrypt.
  if (typeof password !== "string" || password.length === 0 || password.length > PASSWORD_MAX) return false;
  const p = password;
  let candidate: Buffer;
  try {
    candidate = scryptSync(p, Buffer.from(login.salt, "hex"), SCRYPT_KEYLEN, SCRYPT_OPTS);
  } catch {
    return false;
  }
  const stored = Buffer.from(login.hash, "hex");
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
}

export type LoginVerdict =
  | { ok: true; login: AccessLogin }
  | { ok: false; reason: "no_login" | "locked" | "wrong"; login: AccessLogin | null; attemptsLeft: number; lockedUntil: number | null };

/**
 * One attempt. Returns the verdict AND the login state the caller must persist,
 * so a crash between "count the failure" and "write it down" cannot lose a strike.
 *
 * ⛔ The lockout is checked BEFORE the password is compared, so a locked
 * computer does not even spend the scrypt on a guess.
 */
export function attemptLogin(login: AccessLogin | null, username: unknown, password: unknown, now = new Date()): LoginVerdict {
  if (!login) return { ok: false, reason: "no_login", login: null, attemptsLeft: 0, lockedUntil: null };

  const t = now.getTime();
  if (login.lockedUntil && t < login.lockedUntil) {
    return { ok: false, reason: "locked", login, attemptsLeft: 0, lockedUntil: login.lockedUntil };
  }
  // A lockout that has expired resets the count — the fifteen minutes were the penalty.
  const base: AccessLogin = login.lockedUntil && t >= login.lockedUntil ? { ...login, failures: 0, lockedUntil: null } : login;

  if (credentialsMatch(base, username, password)) {
    return { ok: true, login: { ...base, failures: 0, lockedUntil: null } };
  }

  const failures = base.failures + 1;
  if (failures >= LOGIN_MAX_FAILURES) {
    const lockedUntil = t + LOGIN_LOCKOUT_MS;
    return { ok: false, reason: "locked", login: { ...base, failures: 0, lockedUntil }, attemptsLeft: 0, lockedUntil };
  }
  return { ok: false, reason: "wrong", login: { ...base, failures }, attemptsLeft: LOGIN_MAX_FAILURES - failures, lockedUntil: null };
}

/** What the screen may say about a login. ⛔ Never the username, never the hash. */
export function describeLogin(login: AccessLogin | null, now = new Date()): { set: boolean; username: string | null; lockedForMs: number } {
  if (!login) return { set: false, username: null, lockedForMs: 0 };
  const lockedForMs = login.lockedUntil ? Math.max(0, login.lockedUntil - now.getTime()) : 0;
  return { set: true, username: login.username, lockedForMs };
}

/**
 * A per-install machine key: 32 random bytes as hex. Minted once, kept in
 * settings.json, sent to the server on every machine-side call, which stores
 * only its hash. Rotating it is "remove this computer, enroll again".
 */
export function mintMachineKey(): string {
  return randomBytes(32).toString("hex");
}

/** A stable install id, minted once per installation. */
export function mintDeviceId(): string {
  return `win-${randomBytes(12).toString("hex")}`;
}
