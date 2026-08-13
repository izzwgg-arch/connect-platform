import crypto from "node:crypto";

/** Default public pay link lifetime (30 days), aligned with legacy Invoice payToken. */
export const BILLING_PAY_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type PayTokenPayload = { i: string; t: string; e: number };

function payTokenSecret(): string {
  const raw =
    process.env.BILLING_PAY_TOKEN_SECRET?.trim()
    || process.env.CREDENTIALS_MASTER_KEY?.trim();
  if (!raw) {
    throw new Error("BILLING_PAY_TOKEN_SECRET or CREDENTIALS_MASTER_KEY is required for invoice pay links");
  }
  return raw;
}

function signPayload(payloadB64: string): string {
  return crypto.createHmac("sha256", payTokenSecret()).update(payloadB64).digest("base64url");
}

/** Create a signed, expiring token for public BillingInvoice payment (no DB column required). */
export function createBillingInvoicePayToken(
  invoiceId: string,
  tenantId: string,
  ttlMs: number = BILLING_PAY_TOKEN_TTL_MS,
): string {
  const payload: PayTokenPayload = {
    i: invoiceId,
    t: tenantId,
    e: Date.now() + ttlMs,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${signPayload(payloadB64)}`;
}

type MultiPayTokenPayload = { t: string; ii: string[]; e: number };

/**
 * One signed token covering SEVERAL invoices of one tenant — "pay everything
 * open in one go". Same secret and signing as the single-invoice token; the
 * payload shape (`ii` vs `i`) is what tells them apart, so neither verifier
 * ever accepts the other's token.
 */
export function createBillingMultiPayToken(
  tenantId: string,
  invoiceIds: string[],
  ttlMs: number = BILLING_PAY_TOKEN_TTL_MS,
): string {
  const ids = [...new Set(invoiceIds.filter((v) => typeof v === "string" && v.trim()))];
  if (!ids.length) throw new Error("A combined pay link needs at least one invoice.");
  const payload: MultiPayTokenPayload = { t: tenantId, ii: ids, e: Date.now() + ttlMs };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${signPayload(payloadB64)}`;
}

/** Verify a combined-invoices token; null if invalid, expired, or single-shape. */
export function verifyBillingMultiPayToken(
  token: string,
): { tenantId: string; invoiceIds: string[]; expiresAt: number } | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = signPayload(payloadB64);
  try {
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as MultiPayTokenPayload;
    if (!decoded?.t || typeof decoded.e !== "number") return null;
    if (!Array.isArray(decoded.ii) || !decoded.ii.length || !decoded.ii.every((v) => typeof v === "string" && v)) return null;
    if (decoded.e < Date.now()) return null;
    return { tenantId: decoded.t, invoiceIds: decoded.ii, expiresAt: decoded.e };
  } catch {
    return null;
  }
}

/** Verify token; returns null if invalid or expired. */
export function verifyBillingInvoicePayToken(
  token: string,
): { invoiceId: string; tenantId: string; expiresAt: number } | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = signPayload(payloadB64);
  try {
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as PayTokenPayload;
    if (!decoded?.i || !decoded?.t || typeof decoded.e !== "number") return null;
    if (decoded.e < Date.now()) return null;
    return { invoiceId: decoded.i, tenantId: decoded.t, expiresAt: decoded.e };
  } catch {
    return null;
  }
}
