// Token helpers for scan-label identifiers (Phase 2) and customer tracking links (Phase 6).
// High-entropy, unguessable, stored HASHED at rest (never the raw token).

import { createHash, randomBytes } from "node:crypto";

/** URL/label-safe high-entropy token (base32-ish, no ambiguous chars). */
export function generateToken(bytes = 24): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
  const buf = randomBytes(bytes);
  let out = "";
  for (let i = 0; i < buf.length; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

/** Deterministic hash for storage + lookup. Never store the raw token. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Format a scan label token into a short human-scannable code (grouped). */
export function formatLabelCode(token: string): string {
  const t = token.slice(0, 12);
  return `${t.slice(0, 4)}-${t.slice(4, 8)}-${t.slice(8, 12)}`;
}
