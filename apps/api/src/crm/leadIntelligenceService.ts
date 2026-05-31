/**
 * Lead Intelligence Service — Phase 7 / 7B (Governance hardening)
 *
 * All generation is governed by per-tenant CrmAiSettings.
 * Hard server caps apply regardless of tenant configuration.
 *
 * Guardrails (checked before every AI call):
 *   1. aiEnabled must be true
 *   2. Documents capped at min(maxDocumentsPerReport, HARD_MAX_DOCS)
 *   3. Chars per document capped at min(maxCharsPerDocument, HARD_MAX_CHARS_PER_DOC)
 *   4. Total prompt chars capped at min(maxTotalCharsPerReport, HARD_MAX_TOTAL_CHARS)
 *   5. Regeneration cooldown enforced; CRM admins can bypass
 *   6. Batch generation blocked if allowBatchGeneration=false
 *   7. Batch size capped at min(maxBatchReportsPerRun, HARD_MAX_BATCH)
 *
 * Audit events (structured JSON to stdout — never includes document text or API keys):
 *   crm_ai_report_generated
 *   crm_ai_report_regenerated
 *   crm_ai_report_failed
 *   crm_ai_batch_generation_started
 *   crm_ai_batch_generation_completed
 *   crm_ai_limit_blocked
 *
 * Report metadata stored (never raw prompt, never document content):
 *   promptCharCount, documentsIncluded, documentsExcluded,
 *   generationDurationMs, providerName, modelName
 */

import { db } from "@connect/db";
import { getLeadIntelligenceProvider } from "./leadIntelligenceProvider";
import { stripSsnFromAiDocumentProfile } from "./documentProfileExtractor";

// ── Hard server caps (override any tenant setting above these values) ──────────

const HARD_MAX_DOCS = 10;
const HARD_MAX_CHARS_PER_DOC = 5000;
const HARD_MAX_TOTAL_CHARS = 25000;
const HARD_MAX_BATCH = 25;
const MAX_ERROR_CHARS = 500;

// ── Default settings (used when no CrmAiSettings row exists) ──────────────────

const DEFAULT_SETTINGS = {
  aiEnabled: true,
  maxDocumentsPerReport: 5,
  maxCharsPerDocument: 2000,
  maxTotalCharsPerReport: 10000,
  allowBatchGeneration: true,
  maxBatchReportsPerRun: 25,
  regenerationCooldownMinutes: 60,
};

// ── Errors ────────────────────────────────────────────────────────────────────

export class LeadIntelligenceError extends Error {
  code: string;
  retryAfterMs?: number;
  detail?: string;
  constructor(code: string, message: string, opts?: { retryAfterMs?: number; detail?: string }) {
    super(message);
    this.name = "LeadIntelligenceError";
    this.code = code;
    this.retryAfterMs = opts?.retryAfterMs;
    this.detail = opts?.detail;
  }
}

// ── Audit logging ─────────────────────────────────────────────────────────────

/**
 * Writes a safe structured audit event to stdout.
 * Captured by Pino/Fastify logger in production.
 * NEVER includes document text, API keys, or raw prompt content.
 */
function auditLog(
  event: string,
  fields: {
    tenantId: string;
    contactId?: string;
    reportId?: string;
    provider?: string;
    model?: string;
    durationMs?: number;
    documentsIncluded?: number;
    documentsExcluded?: number;
    promptCharCount?: number;
    batchSize?: number;
    complete?: number;
    failed?: number;
    skippedExisting?: number;
    skippedLimit?: number;
    reason?: string;
  },
) {
  console.log(
    JSON.stringify({
      audit: true,
      event,
      timestamp: new Date().toISOString(),
      ...fields,
    }),
  );
}

// ── Settings loader ───────────────────────────────────────────────────────────

type AiSettings = typeof DEFAULT_SETTINGS;

async function loadTenantAiSettings(tenantId: string): Promise<AiSettings> {
  const row = await db.crmAiSettings.findUnique({
    where: { tenantId },
    select: {
      aiEnabled: true,
      maxDocumentsPerReport: true,
      maxCharsPerDocument: true,
      maxTotalCharsPerReport: true,
      allowBatchGeneration: true,
      maxBatchReportsPerRun: true,
      regenerationCooldownMinutes: true,
    },
  });
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    aiEnabled: row.aiEnabled,
    maxDocumentsPerReport: Math.min(row.maxDocumentsPerReport, HARD_MAX_DOCS),
    maxCharsPerDocument: Math.min(row.maxCharsPerDocument, HARD_MAX_CHARS_PER_DOC),
    maxTotalCharsPerReport: Math.min(row.maxTotalCharsPerReport, HARD_MAX_TOTAL_CHARS),
    allowBatchGeneration: row.allowBatchGeneration,
    maxBatchReportsPerRun: Math.min(row.maxBatchReportsPerRun, HARD_MAX_BATCH),
    regenerationCooldownMinutes: row.regenerationCooldownMinutes,
  };
}

// ── Generate report for a single contact ─────────────────────────────────────

export type GenerateReportOptions = {
  force?: boolean;
  importBatchId?: string;
  isAdmin?: boolean; // CRM admin — can bypass cooldown
};

export type GenerateReportResult = {
  reportId: string;
  status: string;
  skipped?: boolean;
  cooldownActive?: boolean;
  retryAfterMs?: number;
  retryAfterMessage?: string;
};

export async function generateIntelligenceReport(
  contactId: string,
  tenantId: string,
  options: GenerateReportOptions = {},
): Promise<GenerateReportResult> {
  const { force = false, importBatchId, isAdmin = false } = options;

  // ── Load settings ──────────────────────────────────────────────────────────
  const settings = await loadTenantAiSettings(tenantId);

  if (!settings.aiEnabled) {
    auditLog("crm_ai_limit_blocked", { tenantId, contactId, reason: "ai_disabled" });
    throw new LeadIntelligenceError(
      "ai_disabled",
      "AI Lead Intelligence is disabled for this tenant. Contact your administrator to enable it.",
    );
  }

  // ── Verify contact ─────────────────────────────────────────────────────────
  const contact = await (db as any).contact.findFirst({
    where: { id: contactId, tenantId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      displayName: true,
      company: true,
      phones: { select: { numberRaw: true } },
      emails: { select: { email: true } },
    },
  });
  if (!contact) {
    throw new LeadIntelligenceError("contact_not_found", "Contact not found for this tenant.");
  }

  // ── Check existing report ──────────────────────────────────────────────────
  const existing = await db.crmLeadIntelligenceReport.findUnique({
    where: { contactId },
    select: { id: true, status: true, generatedAt: true },
  });

  if (existing && existing.status === "COMPLETE" && !force) {
    return { reportId: existing.id, status: "COMPLETE", skipped: true };
  }
  if (existing && existing.status === "PROCESSING") {
    return { reportId: existing.id, status: "PROCESSING", skipped: true };
  }

  // ── Cooldown check (force regeneration) ───────────────────────────────────
  if (force && existing?.status === "COMPLETE" && existing.generatedAt && !isAdmin) {
    const cooldownMs = settings.regenerationCooldownMinutes * 60 * 1000;
    if (cooldownMs > 0) {
      const elapsedMs = Date.now() - new Date(existing.generatedAt).getTime();
      if (elapsedMs < cooldownMs) {
        const retryAfterMs = cooldownMs - elapsedMs;
        const retryMins = Math.ceil(retryAfterMs / 60000);
        const elapsedMins = Math.floor(elapsedMs / 60000);
        const message = `Report was generated ${elapsedMins} minute${elapsedMins !== 1 ? "s" : ""} ago. Retry allowed in ${retryMins} minute${retryMins !== 1 ? "s" : ""}.`;
        auditLog("crm_ai_limit_blocked", {
          tenantId,
          contactId,
          reportId: existing.id,
          reason: "cooldown_active",
        });
        throw new LeadIntelligenceError("cooldown_active", message, { retryAfterMs });
      }
    }
  }

  // ── Set PROCESSING ─────────────────────────────────────────────────────────
  const report = await db.crmLeadIntelligenceReport.upsert({
    where: { contactId },
    create: {
      tenantId,
      contactId,
      importBatchId: importBatchId ?? null,
      status: "PROCESSING",
    },
    update: {
      status: "PROCESSING",
      error: null,
      summary: null,
      businessOverview: null,
      keyFindings: undefined,
      discoveredEntities: undefined,
      riskFlags: undefined,
      missingInformation: undefined,
      confidenceScore: null,
      modelName: null,
      providerName: null,
      generatedAt: null,
      promptCharCount: null,
      documentsIncluded: null,
      documentsExcluded: null,
      generationDurationMs: null,
      ...(importBatchId ? { importBatchId } : {}),
    },
  });

  // ── Check provider ─────────────────────────────────────────────────────────
  const provider = getLeadIntelligenceProvider();
  if (!provider) {
    await db.crmLeadIntelligenceReport.update({
      where: { id: report.id },
      data: {
        status: "FAILED",
        error: "OPENAI_API_KEY is not configured. Set it in the API environment to enable AI lead intelligence.",
        updatedAt: new Date(),
      },
    });
    auditLog("crm_ai_report_failed", {
      tenantId,
      contactId,
      reportId: report.id,
      reason: "ai_not_configured",
    });
    throw new LeadIntelligenceError(
      "ai_not_configured",
      "OPENAI_API_KEY is not set. Contact your administrator to configure AI intelligence.",
    );
  }

  // ── Assemble input ─────────────────────────────────────────────────────────
  const [allDocs, phoneDiscoveries, emailDiscoveries] = await Promise.all([
    db.crmLeadDocument.findMany({
      where: { contactId, tenantId, status: "IMPORTED" },
      select: {
        id: true,
        originalFileName: true,
        importedMimeType: true,
        sizeBytes: true,
        textExtraction: {
          select: { text: true, extractionStatus: true },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    db.crmLeadDiscoveredPhone.findMany({
      where: { contactId, tenantId },
      select: { phoneNumber: true, status: true },
    }),
    db.crmLeadDiscoveredEmail.findMany({
      where: { contactId, tenantId },
      select: { email: true, status: true },
    }),
  ]);

  // Apply document limit
  const maxDocs = settings.maxDocumentsPerReport;
  const includedDocs = allDocs.slice(0, maxDocs);
  const excludedDocsCount = Math.max(0, allDocs.length - maxDocs);

  if (excludedDocsCount > 0) {
    auditLog("crm_ai_limit_blocked", {
      tenantId,
      contactId,
      reason: "document_limit_exceeded",
      documentsIncluded: includedDocs.length,
      documentsExcluded: excludedDocsCount,
    });
  }

  const contactName =
    (contact as any).displayName ||
    [(contact as any).firstName, (contact as any).lastName].filter(Boolean).join(" ") ||
    "(unknown)";

  const existingPhones = ((contact as any).phones as { numberRaw: string }[]).map((p) => p.numberRaw);
  const existingEmails = ((contact as any).emails as { email: string }[]).map((e) => e.email);
  const acceptedPhones = phoneDiscoveries.filter((p) => p.status === "ACCEPTED").map((p) => p.phoneNumber);
  const pendingPhones = phoneDiscoveries.filter((p) => p.status === "PENDING").map((p) => p.phoneNumber);
  const acceptedEmails = emailDiscoveries.filter((e) => e.status === "ACCEPTED").map((e) => e.email);
  const pendingEmails = emailDiscoveries.filter((e) => e.status === "PENDING").map((e) => e.email);

  const sourceDiscoveryCount = phoneDiscoveries.length + emailDiscoveries.length;
  const textDocs = includedDocs.filter(
    (d) => d.textExtraction?.extractionStatus === "TEXT_COMPLETE" && d.textExtraction.text,
  );

  // Apply char-per-doc and total-char limits
  let totalChars = 0;
  const inputDocs: { fileName: string; mimeType: string | null; sizeBytes: number | null; textSnippet: string }[] = [];

  for (const d of includedDocs) {
    const raw = d.textExtraction?.text ?? "";
    const capped = raw.slice(0, settings.maxCharsPerDocument);
    const remaining = settings.maxTotalCharsPerReport - totalChars;
    const snippet = capped.slice(0, remaining);
    totalChars += snippet.length;
    inputDocs.push({
      fileName: d.originalFileName,
      mimeType: d.importedMimeType ?? null,
      sizeBytes: d.sizeBytes != null ? Number(d.sizeBytes) : null,
      textSnippet: snippet,
    });
    if (totalChars >= settings.maxTotalCharsPerReport) break;
  }

  const promptCharCount = totalChars;

  // ── Call provider ──────────────────────────────────────────────────────────
  const isRegeneration = existing?.status === "COMPLETE";
  const startMs = Date.now();

  try {
    const output = await provider.generateReport({
      contactName,
      companyName: (contact as any).company ?? null,
      existingPhones,
      existingEmails,
      acceptedPhones,
      pendingPhones,
      acceptedEmails,
      pendingEmails,
      documents: inputDocs,
    });

    const generationDurationMs = Date.now() - startMs;

    const keyFindingsPayload = {
      ...output.keyFindings,
      documentProfile: stripSsnFromAiDocumentProfile(output.keyFindings.documentProfile ?? null),
    };

    await db.crmLeadIntelligenceReport.update({
      where: { id: report.id },
      data: {
        status: "COMPLETE",
        summary: output.summary,
        businessOverview: output.businessOverview,
        keyFindings: keyFindingsPayload as any,
        discoveredEntities: output.discoveredEntities as any,
        riskFlags: output.riskFlags as any,
        missingInformation: output.missingInformation as any,
        confidenceScore: output.confidenceScore,
        modelName: provider.name,
        providerName: "openai",
        generatedAt: new Date(),
        error: null,
        sourceDocumentCount: allDocs.length,
        sourceTextCount: textDocs.length,
        sourceDiscoveryCount,
        promptCharCount,
        documentsIncluded: includedDocs.length,
        documentsExcluded: excludedDocsCount,
        generationDurationMs,
        updatedAt: new Date(),
      },
    });

    auditLog(isRegeneration ? "crm_ai_report_regenerated" : "crm_ai_report_generated", {
      tenantId,
      contactId,
      reportId: report.id,
      provider: "openai",
      model: provider.name,
      durationMs: generationDurationMs,
      documentsIncluded: includedDocs.length,
      documentsExcluded: excludedDocsCount,
      promptCharCount,
    });

    return { reportId: report.id, status: "COMPLETE" };
  } catch (err: unknown) {
    const generationDurationMs = Date.now() - startMs;
    const rawMsg = err instanceof Error ? err.message : "Unknown AI error";
    const safeError = rawMsg.slice(0, MAX_ERROR_CHARS);

    await db.crmLeadIntelligenceReport.update({
      where: { id: report.id },
      data: {
        status: "FAILED",
        error: safeError,
        generationDurationMs,
        updatedAt: new Date(),
      },
    });

    auditLog("crm_ai_report_failed", {
      tenantId,
      contactId,
      reportId: report.id,
      provider: "openai",
      model: provider.name,
      durationMs: generationDurationMs,
      reason: "provider_error",
    });

    throw new LeadIntelligenceError("generation_failed", safeError);
  }
}

// ── Get existing report ───────────────────────────────────────────────────────

export async function getIntelligenceReport(contactId: string, tenantId: string) {
  const contact = await (db as any).contact.findFirst({
    where: { id: contactId, tenantId },
    select: { id: true },
  });
  if (!contact) {
    throw new LeadIntelligenceError("contact_not_found", "Contact not found for this tenant.");
  }

  return db.crmLeadIntelligenceReport.findUnique({
    where: { contactId },
    select: {
      id: true,
      status: true,
      summary: true,
      businessOverview: true,
      keyFindings: true,
      discoveredEntities: true,
      riskFlags: true,
      missingInformation: true,
      confidenceScore: true,
      modelName: true,
      providerName: true,
      generatedAt: true,
      error: true,
      sourceDocumentCount: true,
      sourceTextCount: true,
      sourceDiscoveryCount: true,
      promptCharCount: true,
      documentsIncluded: true,
      documentsExcluded: true,
      generationDurationMs: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

// ── Batch intelligence ────────────────────────────────────────────────────────

export type BatchIntelligenceResult = {
  contactsProcessed: number;
  complete: number;
  failed: number;
  skipped_existing: number;
  skipped_limit: number;
};

export async function generateBatchIntelligence(
  batchId: string,
  tenantId: string,
  requestedLimit: number = 5,
  force = false,
  isAdmin = false,
): Promise<BatchIntelligenceResult> {
  const settings = await loadTenantAiSettings(tenantId);

  if (!settings.aiEnabled) {
    auditLog("crm_ai_limit_blocked", { tenantId, reason: "ai_disabled" });
    throw new LeadIntelligenceError(
      "ai_disabled",
      "AI Lead Intelligence is disabled for this tenant.",
    );
  }
  if (!settings.allowBatchGeneration) {
    auditLog("crm_ai_limit_blocked", { tenantId, reason: "batch_generation_disabled" });
    throw new LeadIntelligenceError(
      "batch_generation_disabled",
      "Batch AI generation is disabled for this tenant. Contact your administrator.",
    );
  }

  const batch = await db.crmImportBatch.findFirst({
    where: { id: batchId, tenantId },
    select: { id: true },
  });
  if (!batch) {
    throw new LeadIntelligenceError("batch_not_found", "Import batch not found for this tenant.");
  }

  const effectiveLimit = Math.min(settings.maxBatchReportsPerRun, Math.max(1, requestedLimit));

  const batchRows = await db.crmImportBatchRow.findMany({
    where: { batchId, tenantId, contactId: { not: null } },
    select: { contactId: true },
    take: effectiveLimit * 3,
    orderBy: { createdAt: "asc" },
  });

  const contactIds = [...new Set(batchRows.map((r) => r.contactId).filter(Boolean) as string[])];

  auditLog("crm_ai_batch_generation_started", {
    tenantId,
    batchSize: Math.min(contactIds.length, effectiveLimit),
  });

  let processedCount = 0;
  const summary: BatchIntelligenceResult = {
    contactsProcessed: 0,
    complete: 0,
    failed: 0,
    skipped_existing: 0,
    skipped_limit: 0,
  };

  for (const contactId of contactIds) {
    if (processedCount >= effectiveLimit) {
      summary.skipped_limit += contactIds.length - processedCount;
      break;
    }
    processedCount++;
    summary.contactsProcessed++;

    try {
      const result = await generateIntelligenceReport(contactId, tenantId, {
        force,
        importBatchId: batchId,
        isAdmin,
      });
      if (result.skipped) {
        summary.skipped_existing++;
      } else if (result.status === "COMPLETE") {
        summary.complete++;
      } else {
        summary.failed++;
      }
    } catch {
      summary.failed++;
    }
  }

  auditLog("crm_ai_batch_generation_completed", {
    tenantId,
    complete: summary.complete,
    failed: summary.failed,
    skippedExisting: summary.skipped_existing,
    skippedLimit: summary.skipped_limit,
  });

  return summary;
}

// ── Batch status summary ──────────────────────────────────────────────────────

export type BatchIntelligenceStatus = {
  pending: number;
  processing: number;
  complete: number;
  failed: number;
  noReport: number;
};

export async function getBatchIntelligenceStatus(
  batchId: string,
  tenantId: string,
): Promise<BatchIntelligenceStatus> {
  const batch = await db.crmImportBatch.findFirst({
    where: { id: batchId, tenantId },
    select: { id: true },
  });
  if (!batch) {
    throw new LeadIntelligenceError("batch_not_found", "Import batch not found for this tenant.");
  }

  const batchRows = await db.crmImportBatchRow.findMany({
    where: { batchId, tenantId, contactId: { not: null } },
    select: { contactId: true },
  });
  const contactIds = [...new Set(batchRows.map((r) => r.contactId).filter(Boolean) as string[])];

  if (contactIds.length === 0) {
    return { pending: 0, processing: 0, complete: 0, failed: 0, noReport: 0 };
  }

  const reports = await db.crmLeadIntelligenceReport.groupBy({
    by: ["status"],
    where: { tenantId, contactId: { in: contactIds } },
    _count: { id: true },
  });

  const countBy = (s: string) => reports.find((r) => r.status === s)?._count.id ?? 0;
  const withReport = reports.reduce((acc, r) => acc + r._count.id, 0);

  return {
    pending: countBy("PENDING"),
    processing: countBy("PROCESSING"),
    complete: countBy("COMPLETE"),
    failed: countBy("FAILED"),
    noReport: contactIds.length - withReport,
  };
}

// ── Tenant AI settings helpers (used by settings routes) ─────────────────────

export type AiSettingsData = {
  aiEnabled: boolean;
  maxDocumentsPerReport: number;
  maxCharsPerDocument: number;
  maxTotalCharsPerReport: number;
  allowBatchGeneration: boolean;
  maxBatchReportsPerRun: number;
  regenerationCooldownMinutes: number;
};

export async function getTenantAiSettings(tenantId: string): Promise<AiSettingsData & { isDefault: boolean }> {
  const row = await db.crmAiSettings.findUnique({ where: { tenantId } });
  if (!row) {
    return { ...DEFAULT_SETTINGS, isDefault: true };
  }
  return {
    aiEnabled: row.aiEnabled,
    maxDocumentsPerReport: row.maxDocumentsPerReport,
    maxCharsPerDocument: row.maxCharsPerDocument,
    maxTotalCharsPerReport: row.maxTotalCharsPerReport,
    allowBatchGeneration: row.allowBatchGeneration,
    maxBatchReportsPerRun: row.maxBatchReportsPerRun,
    regenerationCooldownMinutes: row.regenerationCooldownMinutes,
    isDefault: false,
  };
}

export async function upsertTenantAiSettings(
  tenantId: string,
  data: Partial<AiSettingsData>,
): Promise<AiSettingsData> {
  // Apply hard caps on inbound values
  const sanitized: Partial<AiSettingsData> = {
    ...data,
    ...(data.maxDocumentsPerReport !== undefined
      ? { maxDocumentsPerReport: Math.min(HARD_MAX_DOCS, Math.max(1, data.maxDocumentsPerReport)) }
      : {}),
    ...(data.maxCharsPerDocument !== undefined
      ? { maxCharsPerDocument: Math.min(HARD_MAX_CHARS_PER_DOC, Math.max(100, data.maxCharsPerDocument)) }
      : {}),
    ...(data.maxTotalCharsPerReport !== undefined
      ? { maxTotalCharsPerReport: Math.min(HARD_MAX_TOTAL_CHARS, Math.max(500, data.maxTotalCharsPerReport)) }
      : {}),
    ...(data.maxBatchReportsPerRun !== undefined
      ? { maxBatchReportsPerRun: Math.min(HARD_MAX_BATCH, Math.max(1, data.maxBatchReportsPerRun)) }
      : {}),
    ...(data.regenerationCooldownMinutes !== undefined
      ? { regenerationCooldownMinutes: Math.max(0, data.regenerationCooldownMinutes) }
      : {}),
  };

  const row = await db.crmAiSettings.upsert({
    where: { tenantId },
    create: {
      tenantId,
      aiEnabled: sanitized.aiEnabled ?? DEFAULT_SETTINGS.aiEnabled,
      maxDocumentsPerReport: sanitized.maxDocumentsPerReport ?? DEFAULT_SETTINGS.maxDocumentsPerReport,
      maxCharsPerDocument: sanitized.maxCharsPerDocument ?? DEFAULT_SETTINGS.maxCharsPerDocument,
      maxTotalCharsPerReport: sanitized.maxTotalCharsPerReport ?? DEFAULT_SETTINGS.maxTotalCharsPerReport,
      allowBatchGeneration: sanitized.allowBatchGeneration ?? DEFAULT_SETTINGS.allowBatchGeneration,
      maxBatchReportsPerRun: sanitized.maxBatchReportsPerRun ?? DEFAULT_SETTINGS.maxBatchReportsPerRun,
      regenerationCooldownMinutes: sanitized.regenerationCooldownMinutes ?? DEFAULT_SETTINGS.regenerationCooldownMinutes,
    },
    update: sanitized,
  });

  return {
    aiEnabled: row.aiEnabled,
    maxDocumentsPerReport: row.maxDocumentsPerReport,
    maxCharsPerDocument: row.maxCharsPerDocument,
    maxTotalCharsPerReport: row.maxTotalCharsPerReport,
    allowBatchGeneration: row.allowBatchGeneration,
    maxBatchReportsPerRun: row.maxBatchReportsPerRun,
    regenerationCooldownMinutes: row.regenerationCooldownMinutes,
  };
}
