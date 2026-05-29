/**
 * Lead Intelligence Provider abstraction — Phase 7
 *
 * Defines the contract that all AI providers must implement.
 * Currently ships with one provider: OpenAI (gpt-4o-mini by default).
 *
 * To add a new provider:
 *   1. Implement `LeadIntelligenceProvider`.
 *   2. Export a factory from this file.
 *   3. Switch in `leadIntelligenceService.ts::getProvider()`.
 *
 * Environment variables:
 *   OPENAI_API_KEY           — required for OpenAI provider
 *   LEAD_INTELLIGENCE_MODEL  — optional override (default: gpt-4o-mini)
 */

import OpenAI from "openai";

// ── Types ─────────────────────────────────────────────────────────────────────

export type IntelligenceInput = {
  /** Contact basic info (never includes secrets or tokens). */
  contactName: string;
  companyName: string | null;
  existingPhones: string[];
  existingEmails: string[];
  /** Accepted discoveries — already on the contact. */
  acceptedPhones: string[];
  acceptedEmails: string[];
  /** Pending discoveries — found but not yet reviewed. */
  pendingPhones: string[];
  pendingEmails: string[];
  /** Imported documents. Text is capped before reaching this point. */
  documents: {
    fileName: string;
    mimeType: string | null;
    sizeBytes: number | null;
    /** First MAX_TEXT_PER_DOC chars of extracted text. Empty if not extracted. */
    textSnippet: string;
  }[];
};

export type IntelligenceOutput = {
  summary: string;
  businessOverview: string;
  keyFindings: {
    phoneCount: number;
    emailCount: number;
    documentCount: number;
    namesFound: string[];
    addressesFound: string[];
    additionalNotes: string[];
  };
  discoveredEntities: {
    phones: string[];
    emails: string[];
    websites: string[];
    names: string[];
    addresses: string[];
  };
  riskFlags: string[];
  missingInformation: string[];
  confidenceScore: number;
};

export interface LeadIntelligenceProvider {
  readonly name: string;
  generateReport(input: IntelligenceInput): Promise<IntelligenceOutput>;
}

// ── Prompt builder ────────────────────────────────────────────────────────────

/**
 * Builds the prompt sent to the AI.
 * Contains only structured metadata — no secrets, no storage paths, no tokens.
 * Document text is already capped at MAX_TEXT_PER_DOC chars per document.
 */
function buildPrompt(input: IntelligenceInput): string {
  const docLines = input.documents
    .map((d, i) => {
      const header = `Document ${i + 1}: ${d.fileName} (${d.mimeType ?? "unknown type"}, ${d.sizeBytes ? `${Math.round(d.sizeBytes / 1024)}KB` : "size unknown"})`;
      const text = d.textSnippet.trim()
        ? `Text excerpt:\n${d.textSnippet.trim()}`
        : "Text excerpt: [not available — scanned or unsupported format]";
      return `${header}\n${text}`;
    })
    .join("\n\n");

  return `You are a CRM lead intelligence analyst. Analyze the following lead information and return a structured JSON report.

CONTACT INFORMATION:
Name: ${input.contactName}
Company: ${input.companyName ?? "(unknown)"}
Existing phones: ${input.existingPhones.length > 0 ? input.existingPhones.join(", ") : "(none on file)"}
Existing emails: ${input.existingEmails.length > 0 ? input.existingEmails.join(", ") : "(none on file)"}
Accepted phone discoveries: ${input.acceptedPhones.length > 0 ? input.acceptedPhones.join(", ") : "(none)"}
Accepted email discoveries: ${input.acceptedEmails.length > 0 ? input.acceptedEmails.join(", ") : "(none)"}
Pending phone discoveries (not yet reviewed): ${input.pendingPhones.length > 0 ? input.pendingPhones.join(", ") : "(none)"}
Pending email discoveries (not yet reviewed): ${input.pendingEmails.length > 0 ? input.pendingEmails.join(", ") : "(none)"}

IMPORTED DOCUMENTS (${input.documents.length} total):
${docLines || "(no documents imported)"}

TASK:
Return a JSON object with exactly these fields:

{
  "summary": "<2-3 sentence executive summary of this lead>",
  "businessOverview": "<paragraph about the company/business based on available data>",
  "keyFindings": {
    "phoneCount": <total distinct phone numbers found>,
    "emailCount": <total distinct email addresses found>,
    "documentCount": <number of documents analyzed>,
    "namesFound": ["<name>", ...],
    "addressesFound": ["<address>", ...],
    "additionalNotes": ["<note>", ...]
  },
  "discoveredEntities": {
    "phones": ["<phone>", ...],
    "emails": ["<email>", ...],
    "websites": ["<url>", ...],
    "names": ["<name>", ...],
    "addresses": ["<address>", ...]
  },
  "riskFlags": ["<code>", ...],
  "missingInformation": ["<code>", ...],
  "confidenceScore": <0.0 to 1.0>
}

Risk flag codes to use (only include applicable ones):
- "missing_primary_phone" — no confirmed phone number
- "missing_primary_email" — no confirmed email
- "conflicting_phone_numbers" — multiple phones with no clear primary
- "conflicting_addresses" — multiple different addresses found
- "insufficient_documentation" — fewer than 2 documents available
- "extraction_failures" — one or more documents could not be text-extracted
- "scanned_documents" — documents present but appear to be scanned/image-only
- "no_company_identified" — company name absent from all sources
- "stale_contact_data" — contact info appears outdated

Missing information codes to use (only include applicable ones):
- "missing_owner" — no owner/principal name found
- "missing_address" — no business address found
- "missing_email" — no email address
- "missing_phone" — no phone number
- "missing_financial_docs" — no financial documentation imported
- "missing_business_description" — cannot determine what the business does
- "missing_website" — no website found

Set confidenceScore between 0.0 (very low data quality / few documents) and 1.0 (comprehensive data, consistent information).

Return ONLY the JSON object. No markdown. No explanation outside the JSON.`;
}

// ── OpenAI provider ───────────────────────────────────────────────────────────

const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_TOKENS = 2000;

export class OpenAiLeadIntelligenceProvider implements LeadIntelligenceProvider {
  readonly name: string;
  private client: OpenAI;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set. Set it in the API environment to use AI lead intelligence.",
      );
    }
    this.name = process.env.LEAD_INTELLIGENCE_MODEL ?? DEFAULT_MODEL;
    this.client = new OpenAI({ apiKey });
  }

  async generateReport(input: IntelligenceInput): Promise<IntelligenceOutput> {
    const model = process.env.LEAD_INTELLIGENCE_MODEL ?? DEFAULT_MODEL;
    const prompt = buildPrompt(input);

    const completion = await this.client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: MAX_TOKENS,
      temperature: 0.3, // low temperature for consistent structured output
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) throw new Error("AI provider returned empty response.");

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("AI provider returned non-JSON response.");
    }

    return validateAndNormalizeOutput(parsed);
  }
}

// ── Output validation ─────────────────────────────────────────────────────────

function ensureStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((v): v is string => typeof v === "string");
}

function validateAndNormalizeOutput(raw: unknown): IntelligenceOutput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("AI output is not an object.");
  }
  const r = raw as Record<string, unknown>;

  const kf = (typeof r.keyFindings === "object" && r.keyFindings !== null ? r.keyFindings : {}) as Record<string, unknown>;
  const de = (typeof r.discoveredEntities === "object" && r.discoveredEntities !== null ? r.discoveredEntities : {}) as Record<string, unknown>;

  return {
    summary: typeof r.summary === "string" ? r.summary.slice(0, 2000) : "No summary available.",
    businessOverview: typeof r.businessOverview === "string" ? r.businessOverview.slice(0, 3000) : "",
    keyFindings: {
      phoneCount: typeof kf.phoneCount === "number" ? kf.phoneCount : 0,
      emailCount: typeof kf.emailCount === "number" ? kf.emailCount : 0,
      documentCount: typeof kf.documentCount === "number" ? kf.documentCount : 0,
      namesFound: ensureStringArray(kf.namesFound),
      addressesFound: ensureStringArray(kf.addressesFound),
      additionalNotes: ensureStringArray(kf.additionalNotes),
    },
    discoveredEntities: {
      phones: ensureStringArray(de.phones),
      emails: ensureStringArray(de.emails),
      websites: ensureStringArray(de.websites),
      names: ensureStringArray(de.names),
      addresses: ensureStringArray(de.addresses),
    },
    riskFlags: ensureStringArray(r.riskFlags),
    missingInformation: ensureStringArray(r.missingInformation),
    confidenceScore: typeof r.confidenceScore === "number"
      ? Math.min(1, Math.max(0, r.confidenceScore))
      : 0.5,
  };
}

// ── Provider factory ──────────────────────────────────────────────────────────

/**
 * Returns the configured provider.
 * Currently only OpenAI is supported. Returns null if OPENAI_API_KEY is not set
 * (allows the service to return a clear error without crashing at startup).
 */
export function getLeadIntelligenceProvider(): LeadIntelligenceProvider | null {
  try {
    return new OpenAiLeadIntelligenceProvider();
  } catch {
    return null;
  }
}
