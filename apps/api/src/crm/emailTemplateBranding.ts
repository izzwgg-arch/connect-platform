import { db } from "@connect/db";
import type { CrmEmailBrandingInput, CrmEmailSignatureInput } from "@connect/shared";

const MAX_TEXT = 400;
const MAX_LONG_TEXT = 4000;
const MAX_URL = 600;
export const CRM_EMAIL_LOGO_CID = "connect-crm-business-logo";

export function sanitizeEmailTemplateText(input: unknown, maxLen = MAX_TEXT): string | null {
  if (input == null) return null;
  let s = String(input).replace(/\u0000/g, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!s) return null;
  if (s.length > maxLen) s = s.slice(0, maxLen).trimEnd();
  return s || null;
}

export function sanitizeEmailTemplateUrl(input: unknown): string | null {
  const s = sanitizeEmailTemplateText(input, MAX_URL);
  if (!s) return null;
  try {
    const url = new URL(s);
    if (url.protocol !== "https:") return null;
    if (!/^[\x21-\x7E]+$/.test(s)) return null;
    return s;
  } catch {
    return null;
  }
}

export function sanitizeEmailTemplateEmail(input: unknown): string | null {
  const s = sanitizeEmailTemplateText(input, 320);
  if (!s) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

export function normalizeCrmEmailBrandingPayload(input: Record<string, unknown>): Record<string, unknown> {
  return {
    businessName: sanitizeEmailTemplateText(input.businessName),
    tagline: sanitizeEmailTemplateText(input.tagline),
    website: sanitizeEmailTemplateUrl(input.website) || sanitizeEmailTemplateText(input.website, MAX_URL),
    phone: sanitizeEmailTemplateText(input.phone, 50),
    email: sanitizeEmailTemplateEmail(input.email),
    address: sanitizeEmailTemplateText(input.address, 1000),
    logoUrl: sanitizeEmailTemplateUrl(input.logoUrl),
    facebookUrl: sanitizeEmailTemplateUrl(input.facebookUrl),
    instagramUrl: sanitizeEmailTemplateUrl(input.instagramUrl),
    linkedinUrl: sanitizeEmailTemplateUrl(input.linkedinUrl),
    xUrl: sanitizeEmailTemplateUrl(input.xUrl),
  };
}

export function normalizeCrmEmailSignaturePayload(input: Record<string, unknown>): Record<string, unknown> {
  return {
    senderName: sanitizeEmailTemplateText(input.senderName),
    senderTitle: sanitizeEmailTemplateText(input.senderTitle),
    companyName: sanitizeEmailTemplateText(input.companyName),
    phone: sanitizeEmailTemplateText(input.phone, 50),
    email: sanitizeEmailTemplateEmail(input.email),
    website: sanitizeEmailTemplateUrl(input.website) || sanitizeEmailTemplateText(input.website, MAX_URL),
    logoUrl: sanitizeEmailTemplateUrl(input.logoUrl),
    avatarUrl: sanitizeEmailTemplateUrl(input.avatarUrl),
    facebookUrl: sanitizeEmailTemplateUrl(input.facebookUrl),
    instagramUrl: sanitizeEmailTemplateUrl(input.instagramUrl),
    linkedinUrl: sanitizeEmailTemplateUrl(input.linkedinUrl),
    xUrl: sanitizeEmailTemplateUrl(input.xUrl),
    legalDisclaimer: sanitizeEmailTemplateText(input.legalDisclaimer, MAX_LONG_TEXT),
  };
}

export async function resolveCrmEmailBranding(
  tenantId: string,
  tenantName?: string | null,
  opts: { logoMode?: "preview" | "cid" } = {},
): Promise<CrmEmailBrandingInput> {
  const row = await (db as any).crmEmailBranding.findUnique({
    where: { tenantId },
  }).catch(() => null);
  const uploadedLogoUrl = row?.logoStorageKey
    ? opts.logoMode === "cid"
      ? `cid:${CRM_EMAIL_LOGO_CID}`
      : "/api/crm/email/branding/logo"
    : null;
  return {
    businessName: row?.businessName || tenantName || "Your Company",
    tagline: row?.tagline || null,
    website: row?.website || null,
    phone: row?.phone || null,
    email: row?.email || null,
    address: row?.address || null,
    logoUrl: row?.logoUrl || uploadedLogoUrl,
    facebookUrl: row?.facebookUrl || null,
    instagramUrl: row?.instagramUrl || null,
    linkedinUrl: row?.linkedinUrl || null,
    xUrl: row?.xUrl || null,
  };
}

export async function resolveCrmEmailSignature(input: {
  tenantId: string;
  userId: string;
  fallbackName?: string | null;
  fallbackEmail?: string | null;
  fallbackCompany?: string | null;
}): Promise<CrmEmailSignatureInput> {
  const row = await (db as any).crmEmailSignature.findUnique({
    where: { tenantId_userId: { tenantId: input.tenantId, userId: input.userId } },
  }).catch(() => null);
  return {
    senderName: row?.senderName || input.fallbackName || null,
    senderTitle: row?.senderTitle || null,
    companyName: row?.companyName || input.fallbackCompany || null,
    phone: row?.phone || null,
    email: row?.email || input.fallbackEmail || null,
    website: row?.website || null,
    logoUrl: row?.logoUrl || null,
    avatarUrl: row?.avatarUrl || null,
    facebookUrl: row?.facebookUrl || null,
    instagramUrl: row?.instagramUrl || null,
    linkedinUrl: row?.linkedinUrl || null,
    xUrl: row?.xUrl || null,
    legalDisclaimer: row?.legalDisclaimer || null,
  };
}
