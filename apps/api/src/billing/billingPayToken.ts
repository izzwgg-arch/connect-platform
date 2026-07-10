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


// -- Tenant-scoped "pay all unpaid" token (cowork) --------------------------
// One link that resolves ALL of a tenant's currently-unpaid invoices at pay
// time, so it stays correct as invoices are created/paid between send and open.
type PayAllTokenPayload = { t: string; e: number; k: "all" };

/** Create a signed, expiring token to pay ALL of a tenant's unpaid invoices. */
export function createTenantPayAllToken(
  tenantId: string,
  ttlMs: number = BILLING_PAY_TOKEN_TTL_MS,
): string {
  const payload: PayAllTokenPayload = { t: tenantId, e: Date.now() + ttlMs, k: "all" };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${signPayload(payloadB64)}`;
}

/** Verify a tenant pay-all token; null if invalid, expired, or not a pay-all token. */
export function verifyTenantPayAllToken(
  token: string,
): { tenantId: string; expiresAt: number } | null {
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
    const decoded = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as PayAllTokenPayload;
    if (!decoded?.t || decoded.k !== "all" || typeof decoded.e !== "number") return null;
    if (decoded.e < Date.now()) return null;
    return { tenantId: decoded.t, expiresAt: decoded.e };
  } catch {
    return null;
  }
}
