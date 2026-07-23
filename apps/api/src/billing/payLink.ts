import crypto from "node:crypto";

/** Default pay-link lifetime (30 days) — aligned with BILLING_PAY_TOKEN_TTL_MS. */
export const BILLING_PAY_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Unambiguous alphabet — no 0/O, 1/l/I. */
const PAY_LINK_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAY_LINK_CODE_LENGTH = 6;
export const PAY_LINK_CODE_RE = new RegExp(`^[${PAY_LINK_ALPHABET}]{${PAY_LINK_CODE_LENGTH}}$`);

/** Cryptographically random short code, e.g. "X7K2QF". */
export function generatePayLinkCode(length = PAY_LINK_CODE_LENGTH): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += PAY_LINK_ALPHABET[bytes[i] % PAY_LINK_ALPHABET.length];
  return out;
}

export type PayLinkInvoiceLike = {
  id: string;
  invoiceNumber: string;
  status: string;
  totalCents: number | null;
  balanceDueCents: number | null;
  periodStart: Date | string;
};

/**
 * Split the link's invoice set into the payable subset (still owed) and the rest.
 * Always computed live — invoices paid/voided elsewhere drop out of the total.
 * Payable subset is ordered oldest-first (allocation order).
 */
export function computePayableSet(invoices: PayLinkInvoiceLike[]): {
  payable: PayLinkInvoiceLike[];
  settled: PayLinkInvoiceLike[];
  totalDueCents: number;
} {
  const payable: PayLinkInvoiceLike[] = [];
  const settled: PayLinkInvoiceLike[] = [];
  for (const inv of invoices) {
    const due = Math.max(0, inv.balanceDueCents ?? inv.totalCents ?? 0);
    if (!["PAID", "VOID"].includes(inv.status) && due > 0) payable.push(inv);
    else settled.push(inv);
  }
  payable.sort((a, b) => new Date(a.periodStart).getTime() - new Date(b.periodStart).getTime());
  const totalDueCents = payable.reduce(
    (sum, inv) => sum + Math.max(0, inv.balanceDueCents ?? inv.totalCents ?? 0),
    0,
  );
  return { payable, settled, totalDueCents };
}

export function payLinkPublicUrl(code: string): string {
  const base = (process.env.PUBLIC_PORTAL_URL || "https://app.connectcomunications.com").replace(/\/$/, "");
  return `${base}/p/${encodeURIComponent(code)}`;
}
