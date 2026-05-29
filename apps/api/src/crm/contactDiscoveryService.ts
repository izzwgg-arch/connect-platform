/**
 * CRM Contact Discovery Service — Phase 6
 *
 * Extracts phone numbers and email addresses from CrmLeadDocumentText
 * and stores them as PENDING discoveries for user review.
 *
 * Contract:
 *   - Only processes documents with extractionStatus=TEXT_COMPLETE.
 *   - Tenant ownership verified on every call.
 *   - Discoveries already ACCEPTED or REJECTED are never overwritten.
 *   - Values already present on the contact (ContactPhone, ContactEmail) are skipped.
 *   - Source snippets are capped at 200 chars — extracted text is never logged.
 *   - Accepting a phone creates a ContactPhone row; accepting an email creates a ContactEmail row.
 *   - Rejecting records the decision but does not delete the row.
 *
 * Confidence scoring:
 *   Phones:
 *     HIGH   — valid US 10-digit + appears within 80 chars of a phone label
 *     MEDIUM — valid US 10-digit, no label context
 *   Emails:
 *     HIGH   — standard email format
 */

import { db } from "@connect/db";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_SNIPPET_CHARS = 200;
const SNIPPET_WINDOW = 100; // chars before + after the match
const PHONE_LABEL_WINDOW = 80; // chars before match to look for phone label
const MAX_BATCH_LIMIT = 10;

/** Labels that, when found near a number, boost confidence to HIGH. */
const PHONE_LABELS = /\b(phone|mobile|cell|tel|contact|call|ph|m\.?\s*:?|p\.?\s*:?|direct)\b/i;

// ── Errors ────────────────────────────────────────────────────────────────────

export class ContactDiscoveryError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ContactDiscoveryError";
    this.code = code;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type DiscoveredPhone = {
  phoneNumber: string;
  normalizedPhone: string;
  confidence: "HIGH" | "MEDIUM";
  sourceSnippet: string | null;
};

export type DiscoveredEmail = {
  email: string;
  confidence: "HIGH";
  sourceSnippet: string | null;
};

export type DiscoveryResult = {
  phonesFound: number;
  emailsFound: number;
  phonesSkipped: number; // already on contact or already discovered
  emailsSkipped: number;
};

export type BatchDiscoveryResult = {
  documentsProcessed: number;
  totalPhonesFound: number;
  totalEmailsFound: number;
};

// ── Phone extraction ──────────────────────────────────────────────────────────

/**
 * Normalize a raw phone string to digits only (US).
 * Returns null if the result is not 10 or 11 digits (11 must start with 1).
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return null;
}

/**
 * Extracts phone number candidates from text.
 * Uses a conservative regex, then normalizes and validates.
 * Returns at most one entry per unique normalizedPhone.
 */
export function extractPhones(text: string): DiscoveredPhone[] {
  // Conservative US phone pattern: requires groups of 3-4 digits with separators
  // Matches: (555) 123-4567 | 555-123-4567 | 555.123.4567 | +1 555 123 4567 | 5551234567
  const phoneRegex =
    /(?:\+?1[\s\-.]?)?\(?(\d{3})\)?[\s\-.](\d{3})[\s\-.](\d{4})\b|\b(\d{10})\b|\b(\d{3}[\s\-.]\d{3}[\s\-.]\d{4})\b/g;

  const seen = new Set<string>();
  const results: DiscoveredPhone[] = [];

  let match: RegExpExecArray | null;
  while ((match = phoneRegex.exec(text)) !== null) {
    const rawMatch = match[0].trim();
    const normalized = normalizePhone(rawMatch);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    // Context window for confidence + snippet
    const start = Math.max(0, match.index - SNIPPET_WINDOW);
    const end = Math.min(text.length, match.index + rawMatch.length + SNIPPET_WINDOW);
    const snippet = text.slice(start, end).trim().slice(0, MAX_SNIPPET_CHARS);

    // Confidence: HIGH if a phone label appears in the 80 chars before the match
    const before = text.slice(Math.max(0, match.index - PHONE_LABEL_WINDOW), match.index);
    const confidence: "HIGH" | "MEDIUM" = PHONE_LABELS.test(before) ? "HIGH" : "MEDIUM";

    results.push({ phoneNumber: rawMatch, normalizedPhone: normalized, confidence, sourceSnippet: snippet });
  }

  return results;
}

// ── Email extraction ──────────────────────────────────────────────────────────

/**
 * Extracts email addresses from text.
 * Returns at most one entry per unique lowercased email.
 */
export function extractEmails(text: string): DiscoveredEmail[] {
  // Standard email pattern — conservative, avoids garbage matches
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

  const seen = new Set<string>();
  const results: DiscoveredEmail[] = [];

  let match: RegExpExecArray | null;
  while ((match = emailRegex.exec(text)) !== null) {
    const email = match[0].toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);

    const start = Math.max(0, match.index - SNIPPET_WINDOW);
    const end = Math.min(text.length, match.index + match[0].length + SNIPPET_WINDOW);
    const snippet = text.slice(start, end).trim().slice(0, MAX_SNIPPET_CHARS);

    results.push({ email, confidence: "HIGH", sourceSnippet: snippet });
  }

  return results;
}

// ── Core discovery ────────────────────────────────────────────────────────────

/**
 * Runs phone + email discovery for a single IMPORTED + TEXT_COMPLETE document.
 *
 * Idempotency:
 *   - Skips values already on the contact (ContactPhone/ContactEmail).
 *   - Skips discoveries already ACCEPTED or REJECTED.
 *   - Reuses existing PENDING discoveries (idempotent upsert-like insert).
 */
export async function extractDiscoveriesFromDocument(
  documentId: string,
  tenantId: string,
): Promise<DiscoveryResult> {
  // Load document — must be IMPORTED and belong to this tenant
  const doc = await db.crmLeadDocument.findFirst({
    where: { id: documentId, tenantId, status: "IMPORTED" },
    select: {
      id: true,
      tenantId: true,
      contactId: true,
      textExtraction: {
        select: {
          id: true,
          text: true,
          extractionStatus: true,
        },
      },
    },
  });

  if (!doc) {
    throw new ContactDiscoveryError(
      "doc_not_found",
      "Document not found, not imported, or does not belong to this tenant.",
    );
  }

  if (!doc.contactId) {
    throw new ContactDiscoveryError(
      "doc_no_contact",
      "Document is not attached to a contact. Run Drive match and confirm the match first.",
    );
  }

  const textRec = doc.textExtraction;
  if (!textRec || textRec.extractionStatus !== "TEXT_COMPLETE") {
    throw new ContactDiscoveryError(
      "text_not_extracted",
      "Text extraction must complete before discovery can run. Run text extraction first.",
    );
  }

  const contactId = doc.contactId;
  const documentTextId = textRec.id;
  const text = textRec.text;

  // Load existing contact phones + emails for suppression
  const [existingPhones, existingEmails] = await Promise.all([
    db.contactPhone.findMany({
      where: { contactId },
      select: { numberNormalized: true },
    }),
    db.contactEmail.findMany({
      where: { contactId },
      select: { email: true },
    }),
  ]);

  const existingPhoneSet = new Set(existingPhones.map((p) => p.numberNormalized));
  const existingEmailSet = new Set(existingEmails.map((e) => e.email.toLowerCase()));

  // Extract candidates
  const phoneCandidates = extractPhones(text);
  const emailCandidates = extractEmails(text);

  const result: DiscoveryResult = {
    phonesFound: 0,
    emailsFound: 0,
    phonesSkipped: 0,
    emailsSkipped: 0,
  };

  // Process phones
  for (const candidate of phoneCandidates) {
    // Skip if already on the contact
    if (existingPhoneSet.has(candidate.normalizedPhone)) {
      result.phonesSkipped++;
      continue;
    }

    // Try to insert — unique constraint on (tenantId, contactId, normalizedPhone, documentId)
    // will prevent duplicates across reruns. ACCEPTED/REJECTED rows are not overwritten.
    try {
      const existing = await db.crmLeadDiscoveredPhone.findUnique({
        where: {
          tenantId_contactId_normalizedPhone_documentId: {
            tenantId,
            contactId,
            normalizedPhone: candidate.normalizedPhone,
            documentId,
          },
        },
        select: { id: true, status: true },
      });

      if (existing) {
        // Already exists — never reopen ACCEPTED/REJECTED, skip if PENDING (idempotent)
        result.phonesSkipped++;
        continue;
      }

      await db.crmLeadDiscoveredPhone.create({
        data: {
          tenantId,
          contactId,
          documentId,
          documentTextId,
          phoneNumber: candidate.phoneNumber,
          normalizedPhone: candidate.normalizedPhone,
          confidence: candidate.confidence,
          sourceSnippet: candidate.sourceSnippet,
          status: "PENDING",
        },
      });
      result.phonesFound++;
    } catch {
      // Unique constraint violation from race condition — treat as skip
      result.phonesSkipped++;
    }
  }

  // Process emails
  for (const candidate of emailCandidates) {
    if (existingEmailSet.has(candidate.email)) {
      result.emailsSkipped++;
      continue;
    }

    try {
      const existing = await db.crmLeadDiscoveredEmail.findUnique({
        where: {
          tenantId_contactId_email_documentId: {
            tenantId,
            contactId,
            email: candidate.email,
            documentId,
          },
        },
        select: { id: true, status: true },
      });

      if (existing) {
        result.emailsSkipped++;
        continue;
      }

      await db.crmLeadDiscoveredEmail.create({
        data: {
          tenantId,
          contactId,
          documentId,
          documentTextId,
          email: candidate.email,
          confidence: candidate.confidence,
          sourceSnippet: candidate.sourceSnippet,
          status: "PENDING",
        },
      });
      result.emailsFound++;
    } catch {
      result.emailsSkipped++;
    }
  }

  return result;
}

// ── Batch discovery ───────────────────────────────────────────────────────────

/**
 * Runs discovery for up to `limit` documents in a batch that have
 * TEXT_COMPLETE extraction and are attached to a contact.
 */
export async function extractDiscoveriesForBatch(
  batchId: string,
  tenantId: string,
  limit = 5,
): Promise<BatchDiscoveryResult> {
  const batch = await db.crmImportBatch.findFirst({
    where: { id: batchId, tenantId },
    select: { id: true },
  });
  if (!batch) {
    throw new ContactDiscoveryError("batch_not_found", "Import batch not found for this tenant.");
  }

  const effectiveLimit = Math.min(MAX_BATCH_LIMIT, Math.max(1, limit));

  const docs = await db.crmLeadDocument.findMany({
    where: {
      importBatchId: batchId,
      tenantId,
      status: "IMPORTED",
      contactId: { not: null },
      textExtraction: { extractionStatus: "TEXT_COMPLETE" },
    },
    select: { id: true },
    take: effectiveLimit,
    orderBy: { createdAt: "asc" },
  });

  const summary: BatchDiscoveryResult = {
    documentsProcessed: docs.length,
    totalPhonesFound: 0,
    totalEmailsFound: 0,
  };

  for (const doc of docs) {
    try {
      const res = await extractDiscoveriesFromDocument(doc.id, tenantId);
      summary.totalPhonesFound += res.phonesFound;
      summary.totalEmailsFound += res.emailsFound;
    } catch {
      // Non-fatal per-document failure — continue with remaining docs
    }
  }

  return summary;
}

// ── Accept / Reject ───────────────────────────────────────────────────────────

/**
 * Accepts a phone discovery: creates a ContactPhone row and marks the discovery ACCEPTED.
 */
export async function acceptPhoneDiscovery(
  discoveryId: string,
  tenantId: string,
): Promise<{ ok: true; phoneId: string }> {
  const discovery = await db.crmLeadDiscoveredPhone.findFirst({
    where: { id: discoveryId, tenantId },
    select: {
      id: true,
      status: true,
      contactId: true,
      phoneNumber: true,
      normalizedPhone: true,
    },
  });

  if (!discovery) {
    throw new ContactDiscoveryError("not_found", "Discovery not found for this tenant.");
  }
  if (discovery.status === "ACCEPTED") {
    throw new ContactDiscoveryError("already_accepted", "This discovery has already been accepted.");
  }
  if (discovery.status === "REJECTED") {
    throw new ContactDiscoveryError("already_rejected", "This discovery was rejected and cannot be accepted.");
  }

  // Verify contact still exists
  const contact = await (db as any).contact.findFirst({
    where: { id: discovery.contactId, tenantId, active: true },
    select: { id: true },
  });
  if (!contact) {
    throw new ContactDiscoveryError("contact_not_found", "Contact not found or inactive.");
  }

  // Check if phone already on contact (may have been added manually since discovery was created)
  const existingPhone = await db.contactPhone.findUnique({
    where: {
      contactId_numberNormalized: {
        contactId: discovery.contactId,
        numberNormalized: discovery.normalizedPhone,
      },
    },
    select: { id: true },
  });

  let phoneId: string;

  if (existingPhone) {
    // Already present — just mark discovery accepted
    phoneId = existingPhone.id;
  } else {
    // Create the ContactPhone row
    const newPhone = await db.contactPhone.create({
      data: {
        contactId: discovery.contactId,
        type: "MOBILE",
        numberRaw: discovery.phoneNumber,
        numberNormalized: discovery.normalizedPhone,
        isPrimary: false,
      },
    });
    phoneId = newPhone.id;
  }

  await db.crmLeadDiscoveredPhone.update({
    where: { id: discoveryId },
    data: { status: "ACCEPTED", updatedAt: new Date() },
  });

  return { ok: true, phoneId };
}

/**
 * Rejects a phone discovery. Record is kept for audit.
 */
export async function rejectPhoneDiscovery(
  discoveryId: string,
  tenantId: string,
): Promise<{ ok: true }> {
  const discovery = await db.crmLeadDiscoveredPhone.findFirst({
    where: { id: discoveryId, tenantId },
    select: { id: true, status: true },
  });

  if (!discovery) {
    throw new ContactDiscoveryError("not_found", "Discovery not found for this tenant.");
  }
  if (discovery.status === "ACCEPTED") {
    throw new ContactDiscoveryError("already_accepted", "Accepted discoveries cannot be rejected.");
  }

  await db.crmLeadDiscoveredPhone.update({
    where: { id: discoveryId },
    data: { status: "REJECTED", updatedAt: new Date() },
  });

  return { ok: true };
}

/**
 * Accepts an email discovery: creates a ContactEmail row and marks the discovery ACCEPTED.
 */
export async function acceptEmailDiscovery(
  discoveryId: string,
  tenantId: string,
): Promise<{ ok: true; emailId: string }> {
  const discovery = await db.crmLeadDiscoveredEmail.findFirst({
    where: { id: discoveryId, tenantId },
    select: {
      id: true,
      status: true,
      contactId: true,
      email: true,
    },
  });

  if (!discovery) {
    throw new ContactDiscoveryError("not_found", "Discovery not found for this tenant.");
  }
  if (discovery.status === "ACCEPTED") {
    throw new ContactDiscoveryError("already_accepted", "This discovery has already been accepted.");
  }
  if (discovery.status === "REJECTED") {
    throw new ContactDiscoveryError("already_rejected", "This discovery was rejected and cannot be accepted.");
  }

  const contact = await (db as any).contact.findFirst({
    where: { id: discovery.contactId, tenantId, active: true },
    select: { id: true },
  });
  if (!contact) {
    throw new ContactDiscoveryError("contact_not_found", "Contact not found or inactive.");
  }

  // Check for existing email
  const existingEmail = await db.contactEmail.findUnique({
    where: { contactId_email: { contactId: discovery.contactId, email: discovery.email } },
    select: { id: true },
  });

  let emailId: string;

  if (existingEmail) {
    emailId = existingEmail.id;
  } else {
    const newEmail = await db.contactEmail.create({
      data: {
        contactId: discovery.contactId,
        type: "WORK",
        email: discovery.email,
        isPrimary: false,
      },
    });
    emailId = newEmail.id;
  }

  await db.crmLeadDiscoveredEmail.update({
    where: { id: discoveryId },
    data: { status: "ACCEPTED", updatedAt: new Date() },
  });

  return { ok: true, emailId };
}

/**
 * Rejects an email discovery. Record is kept for audit.
 */
export async function rejectEmailDiscovery(
  discoveryId: string,
  tenantId: string,
): Promise<{ ok: true }> {
  const discovery = await db.crmLeadDiscoveredEmail.findFirst({
    where: { id: discoveryId, tenantId },
    select: { id: true, status: true },
  });

  if (!discovery) {
    throw new ContactDiscoveryError("not_found", "Discovery not found for this tenant.");
  }
  if (discovery.status === "ACCEPTED") {
    throw new ContactDiscoveryError("already_accepted", "Accepted discoveries cannot be rejected.");
  }

  await db.crmLeadDiscoveredEmail.update({
    where: { id: discoveryId },
    data: { status: "REJECTED", updatedAt: new Date() },
  });

  return { ok: true };
}

// ── Batch discovery status ────────────────────────────────────────────────────

export type BatchDiscoveryStatus = {
  phones: { pending: number; accepted: number; rejected: number };
  emails: { pending: number; accepted: number; rejected: number };
};

export async function getBatchDiscoveryStatus(
  batchId: string,
  tenantId: string,
): Promise<BatchDiscoveryStatus> {
  const batch = await db.crmImportBatch.findFirst({
    where: { id: batchId, tenantId },
    select: { id: true },
  });
  if (!batch) {
    throw new ContactDiscoveryError("batch_not_found", "Import batch not found for this tenant.");
  }

  const [phoneRows, emailRows] = await Promise.all([
    db.crmLeadDiscoveredPhone.groupBy({
      by: ["status"],
      where: {
        tenantId,
        document: { importBatchId: batchId },
      },
      _count: { id: true },
    }),
    db.crmLeadDiscoveredEmail.groupBy({
      by: ["status"],
      where: {
        tenantId,
        document: { importBatchId: batchId },
      },
      _count: { id: true },
    }),
  ]);

  const countBy = (rows: { status: string; _count: { id: number } }[], s: string) =>
    rows.find((r) => r.status === s)?._count.id ?? 0;

  return {
    phones: {
      pending: countBy(phoneRows, "PENDING"),
      accepted: countBy(phoneRows, "ACCEPTED"),
      rejected: countBy(phoneRows, "REJECTED"),
    },
    emails: {
      pending: countBy(emailRows, "PENDING"),
      accepted: countBy(emailRows, "ACCEPTED"),
      rejected: countBy(emailRows, "REJECTED"),
    },
  };
}
