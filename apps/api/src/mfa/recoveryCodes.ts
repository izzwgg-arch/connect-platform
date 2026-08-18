/**
 * MFA recovery codes — the "I lost my phone" path.
 *
 * Ten single-use codes, shown exactly once at enrolment, stored only as bcrypt
 * hashes (bcryptjs is already a dependency; the same cost as passwords). A code
 * is ~50 bits (32^10), so an UNKEYED fast hash would leave a leaked table
 * brute-forceable on one GPU in days — bcrypt is what makes the stored form
 * safe. The cost is bounded: a recovery attempt compares against at most ten
 * unused hashes, on a path a person walks a handful of times in their life.
 *
 * Alphabet drops I / L / O / 0 / 1 because a recovery code gets read off a
 * printout or over a phone. Input is normalised (uppercase, non-alphanumerics
 * stripped) so `abcde-fghjk`, `ABCDE FGHJK` and `abcdefghjk` all match.
 */

import { randomInt } from "node:crypto";
import bcrypt from "bcryptjs";

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_LENGTH = 10;
export const RECOVERY_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** bcrypt cost — same as passwords in this codebase (`bcrypt.hash(pw, 10)`). */
export const RECOVERY_CODE_HASH_ROUNDS = 10;

export function generateRecoveryCode(): string {
  let raw = "";
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
    raw += RECOVERY_CODE_ALPHABET[randomInt(0, RECOVERY_CODE_ALPHABET.length)];
  }
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const out = new Set<string>();
  while (out.size < count) out.add(generateRecoveryCode());
  return [...out];
}

/** Uppercase, alphanumerics only. What gets hashed and what gets compared. */
export function normalizeRecoveryCode(input: unknown): string {
  return String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function looksLikeRecoveryCode(input: unknown): boolean {
  const n = normalizeRecoveryCode(input);
  return n.length === RECOVERY_CODE_LENGTH && [...n].every((c) => RECOVERY_CODE_ALPHABET.includes(c));
}

export async function hashRecoveryCode(code: string, rounds: number = RECOVERY_CODE_HASH_ROUNDS): Promise<string> {
  return bcrypt.hash(normalizeRecoveryCode(code), rounds);
}

export async function recoveryCodeMatches(code: string, hash: string): Promise<boolean> {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized || !hash) return false;
  try {
    return await bcrypt.compare(normalized, hash);
  } catch {
    return false;
  }
}
