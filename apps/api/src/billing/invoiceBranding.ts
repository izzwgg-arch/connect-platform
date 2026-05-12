import { z } from "zod";

const MAX_NAME = 200;
const MAX_URL = 600;
const MAX_EMAIL = 320;
const MAX_PHONE = 50;
const MAX_NOTE = 4000;

export type InvoiceEmailBranding = {
  displayName: string;
  logoUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  footerNote: string | null;
  paymentInstructions: string | null;
  paymentTermsDays: number;
};

export const DEFAULT_INVOICE_DISPLAY_NAME = "Connect Communications";

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function sanitizePlainText(input: unknown, maxLen: number): string | null {
  if (input == null) return null;
  let s = String(input).replace(/\u0000/g, "");
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!s) return null;
  if (s.length > maxLen) s = s.slice(0, maxLen).trimEnd();
  return s;
}

/** Allow only https URLs for email <img> (no javascript:, data:, etc.). */
export function sanitizeInvoiceLogoUrl(input: unknown): string | null {
  const s = sanitizePlainText(input, MAX_URL);
  if (!s) return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!/^[\x21-\x7E]+$/.test(s)) return null;
  return s;
}

export function resolveInvoiceEmailBranding(
  settings: Record<string, unknown> | null | undefined,
  tenantName: string | null | undefined,
): InvoiceEmailBranding {
  const display =
    sanitizePlainText(settings?.invoiceCompanyName, MAX_NAME) ||
    sanitizePlainText(tenantName, MAX_NAME) ||
    DEFAULT_INVOICE_DISPLAY_NAME;
  const logoUrl = sanitizeInvoiceLogoUrl(settings?.invoiceLogoUrl);
  const supportEmail = sanitizePlainText(settings?.invoiceSupportEmail, MAX_EMAIL);
  const supportPhone = sanitizePlainText(settings?.invoiceSupportPhone, MAX_PHONE);
  const footerNote = sanitizePlainText(settings?.invoiceFooterNote, MAX_NOTE);
  const paymentInstructions = sanitizePlainText(settings?.invoicePaymentInstructions, MAX_NOTE);
  const paymentTermsDays = Math.min(90, Math.max(0, Number(settings?.paymentTermsDays ?? 15) || 15));
  return {
    displayName: display,
    logoUrl,
    supportEmail,
    supportPhone,
    footerNote,
    paymentInstructions,
    paymentTermsDays,
  };
}

export const invoiceBrandingPutSchema = z.object({
  invoiceCompanyName: z.string().max(MAX_NAME).nullable().optional(),
  invoiceLogoUrl: z.string().max(MAX_URL).nullable().optional(),
  invoiceSupportEmail: z.string().max(MAX_EMAIL).nullable().optional(),
  invoiceSupportPhone: z.string().max(MAX_PHONE).nullable().optional(),
  invoiceFooterNote: z.string().max(MAX_NOTE).nullable().optional(),
  invoicePaymentInstructions: z.string().max(MAX_NOTE).nullable().optional(),
});

export function normalizeBrandingPayload(input: z.infer<typeof invoiceBrandingPutSchema>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.invoiceCompanyName !== undefined) {
    out.invoiceCompanyName = sanitizePlainText(input.invoiceCompanyName, MAX_NAME);
  }
  if (input.invoiceLogoUrl !== undefined) {
    out.invoiceLogoUrl = input.invoiceLogoUrl == null || input.invoiceLogoUrl === "" ? null : sanitizeInvoiceLogoUrl(input.invoiceLogoUrl);
  }
  if (input.invoiceSupportEmail !== undefined) {
    const raw = input.invoiceSupportEmail == null || input.invoiceSupportEmail === "" ? null : String(input.invoiceSupportEmail).trim();
    out.invoiceSupportEmail = raw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw.slice(0, MAX_EMAIL) : null;
  }
  if (input.invoiceSupportPhone !== undefined) {
    out.invoiceSupportPhone = input.invoiceSupportPhone == null || input.invoiceSupportPhone === "" ? null : sanitizePlainText(input.invoiceSupportPhone, MAX_PHONE);
  }
  if (input.invoiceFooterNote !== undefined) {
    out.invoiceFooterNote = input.invoiceFooterNote == null || input.invoiceFooterNote === "" ? null : sanitizePlainText(input.invoiceFooterNote, MAX_NOTE);
  }
  if (input.invoicePaymentInstructions !== undefined) {
    out.invoicePaymentInstructions =
      input.invoicePaymentInstructions == null || input.invoicePaymentInstructions === ""
        ? null
        : sanitizePlainText(input.invoicePaymentInstructions, MAX_NOTE);
  }
  return out;
}
