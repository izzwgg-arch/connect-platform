/**
 * Assembles tenant-scoped lead document summary from CRM contact fields,
 * extracted document text, and optional AI intelligence (advisory fields only).
 * SSN is extracted transiently and returned masked — never persisted or logged.
 */

import { db } from "@connect/db";
import { normalizePhone } from "./contactDiscoveryService";
import {
  maskSsnFromDigits,
  mergeDocumentProfileExtractions,
  stripSsnFromAiDocumentProfile,
  type DocumentTextInput,
} from "./documentProfileExtractor";

export type SummaryFieldSource = "contact" | "document" | "ai";

export type SummaryField = {
  displayValue: string | null;
  source: SummaryFieldSource | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | null;
  documentName: string | null;
};

export type SummaryPhone = {
  number: string;
  normalized: string | null;
  source: "contact" | "discovered" | "document";
  label: string | null;
  isPrimary: boolean;
};

export type LeadDocumentSummary = {
  verified: {
    ein: SummaryField | null;
    revenue: SummaryField | null;
    industry: SummaryField | null;
    creditScore: SummaryField | null;
    businessStartDate: SummaryField | null;
    timezone: SummaryField | null;
    businessAddress: SummaryField | null;
    homeAddress: SummaryField | null;
  };
  extracted: {
    ein: SummaryField | null;
    ssn: SummaryField | null;
    revenue: SummaryField | null;
    industry: SummaryField | null;
    creditScore: SummaryField | null;
    businessStartDate: SummaryField | null;
    businessAddress: SummaryField | null;
    homeAddress: SummaryField | null;
  };
  phones: SummaryPhone[];
  meta: {
    documentCount: number;
    documentsWithText: number;
    intelligenceStatus: string | null;
    intelligenceGeneratedAt: string | null;
    hasConflicts: boolean;
  };
};

export class LeadDocumentSummaryError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LeadDocumentSummaryError";
    this.code = code;
  }
}

function fieldFromContact(value: string | null | undefined): SummaryField | null {
  const v = value?.trim();
  if (!v) return null;
  return { displayValue: v, source: "contact", confidence: null, documentName: null };
}

function fieldFromDocument(
  match: { normalized: string; confidence: "HIGH" | "MEDIUM" | "LOW"; documentName?: string } | null,
): SummaryField | null {
  if (!match?.normalized) return null;
  return {
    displayValue: match.normalized,
    source: "document",
    confidence: match.confidence,
    documentName: match.documentName ?? null,
  };
}

function fieldFromAi(
  value: unknown,
  confidence?: unknown,
  documentName?: unknown,
): SummaryField | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const conf =
    confidence === "HIGH" || confidence === "MEDIUM" || confidence === "LOW" ? confidence : "MEDIUM";
  return {
    displayValue: value.trim(),
    source: "ai",
    confidence: conf,
    documentName: typeof documentName === "string" ? documentName : null,
  };
}

function readAiProfileField(
  profile: Record<string, unknown> | null,
  key: string,
): SummaryField | null {
  if (!profile) return null;
  const entry = profile[key];
  if (typeof entry === "string") return fieldFromAi(entry);
  if (entry && typeof entry === "object") {
    const o = entry as Record<string, unknown>;
    return fieldFromAi(o.value ?? o.displayValue, o.confidence, o.documentName);
  }
  return null;
}

function formatAddress(addr: {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
}): string | null {
  const line1 = addr.street?.trim() ?? "";
  const line2 = [addr.city, addr.state, addr.zip].filter(Boolean).join(", ").trim();
  const combined = [line1, line2].filter(Boolean).join(", ");
  return combined || null;
}

function timezoneDisplay(meta: {
  timezoneLabel?: string | null;
  timezoneIana?: string | null;
}): string | null {
  if (meta.timezoneLabel?.trim()) return meta.timezoneLabel.trim();
  if (meta.timezoneIana?.trim()) return meta.timezoneIana.trim();
  return null;
}

function valuesConflict(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  return a.trim().toLowerCase() !== b.trim().toLowerCase();
}

export function buildLeadDocumentSummary(input: {
  contact: {
    company: string | null;
    phones: Array<{ numberRaw: string; isPrimary: boolean; type: string }>;
    addresses: Array<{
      street?: string | null;
      city?: string | null;
      state?: string | null;
      zip?: string | null;
      country?: string | null;
    }>;
    crmMeta: {
      timezoneLabel?: string | null;
      timezoneIana?: string | null;
    } | null;
  };
  documentTexts: DocumentTextInput[];
  discoveredPhones: Array<{ phoneNumber: string; status: string }>;
  aiDocumentProfile: Record<string, unknown> | null;
  intelligenceStatus: string | null;
  intelligenceGeneratedAt: Date | null;
  documentCount: number;
}): LeadDocumentSummary {
  const docMerge = mergeDocumentProfileExtractions(input.documentTexts);
  const aiProfile = stripSsnFromAiDocumentProfile(input.aiDocumentProfile);

  const primaryAddress = input.contact.addresses[0] ?? null;
  const contactAddressStr = primaryAddress ? formatAddress(primaryAddress) : null;

  const verifiedTimezone = fieldFromContact(timezoneDisplay(input.contact.crmMeta ?? {}));
  const verifiedBusinessAddress = fieldFromContact(contactAddressStr);
  const verifiedIndustry = fieldFromContact(input.contact.company);

  const extractedEin = fieldFromDocument(docMerge.ein);
  const extractedRevenue = fieldFromDocument(docMerge.revenue);
  const extractedIndustry = fieldFromDocument(docMerge.industry);
  const extractedCredit = fieldFromDocument(docMerge.creditScore);
  const extractedStart = fieldFromDocument(docMerge.businessStartDate);
  const extractedBusinessAddr = fieldFromDocument(docMerge.businessAddress);
  const extractedHomeAddr = fieldFromDocument(docMerge.homeAddress);

  const aiEin = readAiProfileField(aiProfile, "ein");
  const aiRevenue = readAiProfileField(aiProfile, "revenue");
  const aiIndustry = readAiProfileField(aiProfile, "industry");
  const aiCredit = readAiProfileField(aiProfile, "creditScore");
  const aiStart = readAiProfileField(aiProfile, "businessStartDate");
  const aiBusinessAddr = readAiProfileField(aiProfile, "businessAddress");
  const aiHomeAddr = readAiProfileField(aiProfile, "homeAddress");

  const extractedSsn: SummaryField | null = docMerge.ssnDigits
    ? {
        displayValue: maskSsnFromDigits(docMerge.ssnDigits),
        source: "document",
        confidence: "HIGH",
        documentName: null,
      }
    : null;

  const pickExtracted = (...candidates: (SummaryField | null)[]): SummaryField | null =>
    candidates.find(Boolean) ?? null;

  const phones: SummaryPhone[] = [];
  const seenPhones = new Set<string>();

  for (const p of input.contact.phones) {
    const normalized = normalizePhone(p.numberRaw);
    const key = normalized ?? p.numberRaw;
    if (seenPhones.has(key)) continue;
    seenPhones.add(key);
    phones.push({
      number: p.numberRaw,
      normalized,
      source: "contact",
      label: p.type,
      isPrimary: p.isPrimary,
    });
  }

  for (const p of input.discoveredPhones) {
    const normalized = normalizePhone(p.phoneNumber);
    const key = normalized ?? p.phoneNumber;
    if (seenPhones.has(key)) continue;
    seenPhones.add(key);
    phones.push({
      number: p.phoneNumber,
      normalized,
      source: "discovered",
      label: p.status === "ACCEPTED" ? "Discovered (accepted)" : "Discovered (pending)",
      isPrimary: false,
    });
  }

  const conflicts = [
    valuesConflict(verifiedIndustry?.displayValue, extractedIndustry?.displayValue),
    valuesConflict(verifiedBusinessAddress?.displayValue, extractedBusinessAddr?.displayValue),
    valuesConflict(extractedBusinessAddr?.displayValue, aiBusinessAddr?.displayValue),
    valuesConflict(extractedEin?.displayValue, aiEin?.displayValue),
  ].some(Boolean);

  return {
    verified: {
      ein: null,
      revenue: null,
      industry: verifiedIndustry,
      creditScore: null,
      businessStartDate: null,
      timezone: verifiedTimezone,
      businessAddress: verifiedBusinessAddress,
      homeAddress: null,
    },
    extracted: {
      ein: pickExtracted(extractedEin, aiEin),
      ssn: extractedSsn,
      revenue: pickExtracted(extractedRevenue, aiRevenue),
      industry: pickExtracted(extractedIndustry, aiIndustry),
      creditScore: pickExtracted(extractedCredit, aiCredit),
      businessStartDate: pickExtracted(extractedStart, aiStart),
      businessAddress: pickExtracted(extractedBusinessAddr, aiBusinessAddr),
      homeAddress: pickExtracted(extractedHomeAddr, aiHomeAddr),
    },
    phones,
    meta: {
      documentCount: input.documentCount,
      documentsWithText: input.documentTexts.length,
      intelligenceStatus: input.intelligenceStatus,
      intelligenceGeneratedAt: input.intelligenceGeneratedAt
        ? input.intelligenceGeneratedAt.toISOString()
        : null,
      hasConflicts: conflicts,
    },
  };
}

/** Sanitize summary for JSON response — ensures no raw SSN digits appear. */
export function sanitizeSummaryForResponse(summary: LeadDocumentSummary): LeadDocumentSummary {
  const ssn = summary.extracted.ssn;
  if (ssn?.displayValue && !/^\*\*\*-\*\*-\d{4}$/.test(ssn.displayValue)) {
    return {
      ...summary,
      extracted: {
        ...summary.extracted,
        ssn: ssn.displayValue ? { ...ssn, displayValue: "***-**-****" } : null,
      },
    };
  }
  return summary;
}

export async function getLeadDocumentSummary(
  contactId: string,
  tenantId: string,
): Promise<LeadDocumentSummary> {
  const contact = await (db as any).contact.findFirst({
    where: { id: contactId, tenantId },
    select: {
      id: true,
      company: true,
      phones: { select: { numberRaw: true, isPrimary: true, type: true } },
      addresses: { select: { street: true, city: true, state: true, zip: true, country: true } },
      crmMeta: {
        select: { timezoneLabel: true, timezoneIana: true },
      },
    },
  });

  if (!contact) {
    throw new LeadDocumentSummaryError("contact_not_found", "Contact not found for this tenant.");
  }

  const [docs, discoveredPhones, intelligence] = await Promise.all([
    db.crmLeadDocument.findMany({
      where: { contactId, tenantId, status: "IMPORTED" },
      select: {
        originalFileName: true,
        textExtraction: { select: { text: true, extractionStatus: true } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    db.crmLeadDiscoveredPhone.findMany({
      where: { contactId, tenantId },
      select: { phoneNumber: true, status: true },
    }),
    db.crmLeadIntelligenceReport.findUnique({
      where: { contactId },
      select: {
        status: true,
        generatedAt: true,
        keyFindings: true,
      },
    }),
  ]);

  const documentTexts: DocumentTextInput[] = docs
    .filter((d) => d.textExtraction?.extractionStatus === "TEXT_COMPLETE" && d.textExtraction.text?.trim())
    .map((d) => ({
      fileName: d.originalFileName,
      text: d.textExtraction!.text,
    }));

  const kf = intelligence?.keyFindings as Record<string, unknown> | null;
  const aiDocumentProfile =
    kf?.documentProfile && typeof kf.documentProfile === "object"
      ? stripSsnFromAiDocumentProfile(kf.documentProfile as Record<string, unknown>)
      : null;

  const summary = buildLeadDocumentSummary({
    contact,
    documentTexts,
    discoveredPhones,
    aiDocumentProfile,
    intelligenceStatus: intelligence?.status ?? null,
    intelligenceGeneratedAt: intelligence?.generatedAt ?? null,
    documentCount: docs.length,
  });

  return sanitizeSummaryForResponse(summary);
}
