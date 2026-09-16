/**
 * The two secrets a texting registration carries (2026-09-16).
 *
 * 1. THE EIN TOKEN (Izzy, 2026-09-16: "EIN should be tokenized").
 *    The customer types the EIN on the link; platform staff file later. So the
 *    EIN is held — but only as an opaque AES-256-GCM token (`encryptJson` from
 *    @connect/security, the credentials master key), in its own table, next to
 *    nothing but its last 4 digits. It is decrypted in exactly two places: the
 *    brand-create/brand-update call, and an audited "Show" by a holder of
 *    `can_view_texting_registration_ein`. It is DESTROYED (row deleted) once the
 *    registry has verified the business, or when it goes unfiled past
 *    EIN_TOKEN_TTL_DAYS.
 *    ⛔ The token is bound to its registration id — a token copied onto another
 *    registration fails to open. ⛔ Never log it, never return it, never put it
 *    in an audit payload.
 *
 * 2. THE CUSTOMER LINK TOKEN. 32 random bytes, base64url. Only its SHA-256
 *    hash is stored, so a database read cannot be replayed as a link. One live
 *    link per registration: creating a new one revokes the rest.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { decryptJson, encryptJson, hasCredentialsMasterKey } from "@connect/security";
import { normalizeEin } from "./content";

export const EIN_TOKEN_PURPOSE = "texting_registration_ein_v1";
export const EIN_TOKEN_TTL_DAYS = 14;
export const LINK_TTL_DAYS = 30;

export class EinVaultUnavailableError extends Error {
  constructor() {
    super("ein_vault_unavailable");
  }
}

export interface EinToken {
  token: string;
  last4: string;
}

/** Tokenize a raw EIN for ONE registration. Throws on a malformed EIN — never stores garbage. */
export function tokenizeEin(rawEin: string, registrationId: string, deps: { encrypt?: (v: unknown) => string; hasKey?: () => boolean } = {}): EinToken {
  const hasKey = deps.hasKey ?? hasCredentialsMasterKey;
  const encrypt = deps.encrypt ?? encryptJson;
  if (!hasKey()) throw new EinVaultUnavailableError();
  const ein = normalizeEin(rawEin);
  if (!ein) throw new Error("ein_invalid");
  if (!registrationId) throw new Error("ein_token_needs_registration");
  return { token: encrypt({ p: EIN_TOKEN_PURPOSE, r: registrationId, ein }), last4: ein.slice(-4) };
}

/** Open a token for its OWN registration. Returns null for anything that does not match exactly. */
export function detokenizeEin(token: string, registrationId: string, deps: { decrypt?: (v: string) => any } = {}): string | null {
  const decrypt = deps.decrypt ?? decryptJson;
  try {
    const v = decrypt(token);
    if (!v || v.p !== EIN_TOKEN_PURPOSE || v.r !== registrationId) return null;
    return normalizeEin(v.ein);
  } catch {
    return null;
  }
}

/** "••-•••4821" for display. */
export function maskedEin(last4: string | null | undefined): string {
  const l = String(last4 || "").replace(/\D/g, "").slice(-4);
  return l.length === 4 ? `••-•••${l}` : "Not on file";
}

export function einTokenExpired(createdAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - createdAt.getTime() > EIN_TOKEN_TTL_DAYS * 86_400_000;
}

// ── Customer link tokens ────────────────────────────────────────────────────

export function newLinkToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashLinkToken(token) };
}

export function hashLinkToken(token: string): string {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

/** Shape check before any database read — a malformed token never reaches a query. */
export function isWellFormedLinkToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{40,64}$/.test(String(token || ""));
}

export function sameHash(a: string, b: string): boolean {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export type LinkState = "ok" | "expired" | "revoked" | "used";

export function linkState(link: { expiresAt: Date; revokedAt: Date | null; usedAt: Date | null }, now: Date = new Date()): LinkState {
  if (link.revokedAt) return "revoked";
  if (link.usedAt) return "used";
  if (link.expiresAt.getTime() <= now.getTime()) return "expired";
  return "ok";
}

export function linkExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + LINK_TTL_DAYS * 86_400_000);
}
