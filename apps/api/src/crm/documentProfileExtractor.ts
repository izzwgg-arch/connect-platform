/**
 * Regex/heuristic extraction of business profile fields from document text.
 * Used only at summary assembly time — values are not persisted (SSN never stored).
 */

export type ExtractedMatch = {
  raw: string;
  normalized: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  documentName?: string;
};

export type DocumentProfileExtraction = {
  ein: ExtractedMatch | null;
  /** Raw digits only — caller must mask before any API/log output. */
  ssnDigits: string | null;
  revenue: ExtractedMatch | null;
  industry: ExtractedMatch | null;
  creditScore: ExtractedMatch | null;
  businessStartDate: ExtractedMatch | null;
  businessAddress: ExtractedMatch | null;
  homeAddress: ExtractedMatch | null;
};

const EIN_REGEX = /\b(\d{2})[\s-]?(\d{7})\b/g;
const SSN_REGEX = /\b(\d{3})[\s-]?(\d{2})[\s-]?(\d{4})\b/g;
const CREDIT_SCORE_LABEL = /\b(credit\s*score|fico|beacon)\s*[:\s#-]*(\d{3})\b/i;
const CREDIT_SCORE_BARE = /\b([3-8]\d{2})\b/g;
const REVENUE_LABEL =
  /\b(?:annual\s*)?(?:revenue|sales|gross\s*income)\s*[:\s$]*\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(million|mil|m|k|thousand|billion|b)?/i;
const REVENUE_DOLLAR = /\$\s*([\d,]+(?:\.\d{1,2})?)\s*(million|mil|m|k|thousand|billion|b)?/i;
const INDUSTRY_LABEL = /\b(?:industry|business\s*type|naics|sector)\s*[:\-]\s*([^\n\r;|]{3,80})/i;
const START_DATE_LABEL =
  /\b(?:business\s*start(?:ed)?|date\s*established|established|incorporated|founded)\s*[:\-]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|[A-Za-z]+\s+\d{1,2},?\s+\d{4})/i;
const BUSINESS_ADDR_LABEL =
  /\b(?:business\s*address|company\s*address|principal\s*place\s*of\s*business)\s*[:\-]?\s*([^\n\r]{10,120})/i;
const HOME_ADDR_LABEL =
  /\b(?:home\s*address|residential\s*address|residence|home\s*addr)\s*[:\-]?\s*([^\n\r]{10,120})/i;

function normalizeEin(a: string, b: string): string {
  return `${a}-${b}`;
}

export function formatEinDisplay(normalized: string): string {
  const digits = normalized.replace(/\D/g, "");
  if (digits.length !== 9) return normalized;
  return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

/** Mask SSN for display — never include full number. */
export function maskSsnFromDigits(digits: string): string {
  const d = digits.replace(/\D/g, "");
  if (d.length !== 9) return "***-**-****";
  return `***-**-${d.slice(5)}`;
}

function parseRevenueAmount(raw: string, suffix?: string): string {
  const num = parseFloat(raw.replace(/,/g, ""));
  if (!Number.isFinite(num)) return raw.trim();
  const s = (suffix ?? "").toLowerCase();
  if (s === "k" || s === "thousand") return `$${Math.round(num * 1000).toLocaleString("en-US")}`;
  if (s === "m" || s === "mil" || s === "million") return `$${num}M`;
  if (s === "b" || s === "billion") return `$${num}B`;
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (num >= 10_000) return `$${Math.round(num).toLocaleString("en-US")}`;
  return `$${num.toLocaleString("en-US")}`;
}

function firstMatch(regex: RegExp, text: string): RegExpExecArray | null {
  regex.lastIndex = 0;
  return regex.exec(text);
}

function extractEinFromText(text: string): ExtractedMatch | null {
  EIN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EIN_REGEX.exec(text)) !== null) {
    const before = text.slice(Math.max(0, match.index - 20), match.index).toLowerCase();
    if (/\b(ssn|social)\b/.test(before)) continue;
    const normalized = normalizeEin(match[1], match[2]);
    return { raw: match[0], normalized: formatEinDisplay(normalized), confidence: "HIGH" };
  }
  return null;
}

function extractSsnDigitsFromText(text: string): string | null {
  SSN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SSN_REGEX.exec(text)) !== null) {
    const area = match[1];
    if (area === "000" || area === "666" || area.startsWith("9")) continue;
    const digits = `${match[1]}${match[2]}${match[3]}`;
    if (digits === "123456789" || digits === "078051120") continue;
    const before = text.slice(Math.max(0, match.index - 30), match.index).toLowerCase();
    const hasLabel = /\b(ssn|social\s*security)\b/.test(before);
    const afterEin = /\bein\b/.test(before);
    if (hasLabel || !afterEin) return digits;
  }
  return null;
}

function extractCreditScoreFromText(text: string): ExtractedMatch | null {
  const labeled = firstMatch(CREDIT_SCORE_LABEL, text);
  if (labeled) {
    const score = parseInt(labeled[2], 10);
    if (score >= 300 && score <= 850) {
      return { raw: labeled[0], normalized: String(score), confidence: "HIGH" };
    }
  }
  const ctx = text.match(/\bcredit[\s\S]{0,40}?(\d{3})\b/i);
  if (ctx) {
    const score = parseInt(ctx[1], 10);
    if (score >= 300 && score <= 850) {
      return { raw: ctx[0], normalized: String(score), confidence: "MEDIUM" };
    }
  }
  return null;
}

function extractRevenueFromText(text: string): ExtractedMatch | null {
  const labeled = firstMatch(REVENUE_LABEL, text);
  if (labeled) {
    const normalized = parseRevenueAmount(labeled[1], labeled[2]);
    return { raw: labeled[0], normalized, confidence: "HIGH" };
  }
  const dollar = firstMatch(REVENUE_DOLLAR, text);
  if (dollar && /revenue|sales|income|annual/i.test(text.slice(Math.max(0, dollar.index - 60), dollar.index))) {
    return {
      raw: dollar[0],
      normalized: parseRevenueAmount(dollar[1], dollar[2]),
      confidence: "MEDIUM",
    };
  }
  return null;
}

function extractIndustryFromText(text: string): ExtractedMatch | null {
  const labeled = firstMatch(INDUSTRY_LABEL, text);
  if (labeled) {
    const normalized = labeled[1].trim().replace(/\s+/g, " ");
    if (normalized.length >= 3) {
      return { raw: labeled[0], normalized, confidence: "HIGH" };
    }
  }
  return null;
}

function extractStartDateFromText(text: string): ExtractedMatch | null {
  const labeled = firstMatch(START_DATE_LABEL, text);
  if (labeled) {
    const normalized = labeled[1].trim();
    return { raw: labeled[0], normalized, confidence: "HIGH" };
  }
  return null;
}

function extractAddressFromText(text: string, labelRegex: RegExp): ExtractedMatch | null {
  const labeled = firstMatch(labelRegex, text);
  if (labeled) {
    const normalized = labeled[1].trim().replace(/\s+/g, " ");
    if (normalized.length >= 10) {
      return { raw: labeled[0], normalized, confidence: "HIGH" };
    }
  }
  return null;
}

export function extractDocumentProfileFromText(text: string): DocumentProfileExtraction {
  return {
    ein: extractEinFromText(text),
    ssnDigits: extractSsnDigitsFromText(text),
    revenue: extractRevenueFromText(text),
    industry: extractIndustryFromText(text),
    creditScore: extractCreditScoreFromText(text),
    businessStartDate: extractStartDateFromText(text),
    businessAddress: extractAddressFromText(text, BUSINESS_ADDR_LABEL),
    homeAddress: extractAddressFromText(text, HOME_ADDR_LABEL),
  };
}

export type DocumentTextInput = { fileName: string; text: string };

/** Merge extractions across documents — latest doc wins per field; highest confidence preferred. */
export function mergeDocumentProfileExtractions(
  docs: DocumentTextInput[],
): DocumentProfileExtraction & { phonesFromText: ExtractedMatch[] } {
  const empty: DocumentProfileExtraction = {
    ein: null,
    ssnDigits: null,
    revenue: null,
    industry: null,
    creditScore: null,
    businessStartDate: null,
    businessAddress: null,
    homeAddress: null,
  };
  const result = { ...empty, phonesFromText: [] as ExtractedMatch[] };
  const rank = { HIGH: 3, MEDIUM: 2, LOW: 1 };

  for (const doc of docs) {
    const ext = extractDocumentProfileFromText(doc.text);
    const withDoc = <T extends ExtractedMatch | null>(prev: T, next: ExtractedMatch | null): ExtractedMatch | null => {
      if (!next) return prev;
      if (!prev) return { ...next, documentName: doc.fileName };
      if (rank[next.confidence] >= rank[prev.confidence]) {
        return { ...next, documentName: doc.fileName };
      }
      return prev;
    };

    result.ein = withDoc(result.ein, ext.ein);
    result.revenue = withDoc(result.revenue, ext.revenue);
    result.industry = withDoc(result.industry, ext.industry);
    result.creditScore = withDoc(result.creditScore, ext.creditScore);
    result.businessStartDate = withDoc(result.businessStartDate, ext.businessStartDate);
    result.businessAddress = withDoc(result.businessAddress, ext.businessAddress);
    result.homeAddress = withDoc(result.homeAddress, ext.homeAddress);

    if (ext.ssnDigits && !result.ssnDigits) {
      result.ssnDigits = ext.ssnDigits;
    }
  }

  return result;
}

/** Strip SSN from AI documentProfile before persistence. */
export function stripSsnFromAiDocumentProfile(profile: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!profile || typeof profile !== "object") return null;
  const { ssn: _removed, SSN: _removed2, ...rest } = profile as Record<string, unknown>;
  return rest;
}
