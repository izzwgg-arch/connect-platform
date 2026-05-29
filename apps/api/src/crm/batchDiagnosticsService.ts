/**
 * CRM Batch Diagnostics Service
 *
 * Provides a unified, read-only diagnostics view for a single import batch.
 * Aggregates data from all pipeline-related tables without adding new DB models.
 *
 * Sources:
 *   CrmImportBatch              — batch overview
 *   CrmLeadDocument             — document/import/extraction status counts
 *   CrmLeadDocumentText         — text extraction provider + OCR detail
 *   CrmLeadDiscoveredPhone/Email— discovery counts by status
 *   CrmLeadIntelligenceReport   — AI report counts by status
 *   CrmImportBatchPipelineRun   — latest pipeline run state
 *   CrmAiSettings               — whether AI is enabled (warnings)
 *
 * Security:
 *   - Every query is tenant-scoped.
 *   - No document text, AI prompts, storage keys, or tokens in any response.
 *   - Failure messages are safe error codes / short summaries only.
 */

import { db } from "@connect/db";
import { getTenantAiSettings } from "./leadIntelligenceService";
import { loadPipelineConfig } from "./batchPipelineService";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BatchDiagnostics {
  generatedAt: string;
  batch: BatchOverview;
  pipeline: PipelineSummary;
  documents: DocumentCounts;
  extraction: ExtractionCounts;
  discovery: DiscoveryCounts;
  ai: AiCounts;
  healthScore: number;
  warnings: DiagnosticsWarning[];
  failures: DiagnosticsFailure[];
}

export interface BatchOverview {
  batchId: string;
  tenantId: string;
  fileName: string;
  status: string;
  totalRows: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  createdAt: string;
  completedAt: string | null;
}

export interface PipelineSummary {
  latestRunId: string | null;
  latestRunStatus: string | null;
  overallProgressPercent: number;
  currentStep: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  staleRecoveries: number;
  totalRuns: number;
}

export interface DocumentCounts {
  total: number;
  matched: number;
  imported: number;
  importPending: number;
  importFailed: number;
  importSkipped: number;
}

export interface ExtractionCounts {
  total: number;
  complete: number;
  failed: number;
  pending: number;
  processing: number;
  ocrComplete: number;
  ocrFailed: number;
  totalCharsExtracted: number;
}

export interface DiscoveryCounts {
  phonesTotal: number;
  phonesPending: number;
  phonesAccepted: number;
  phonesRejected: number;
  emailsTotal: number;
  emailsPending: number;
  emailsAccepted: number;
  emailsRejected: number;
}

export interface AiCounts {
  total: number;
  complete: number;
  failed: number;
  pending: number;
  processing: number;
}

export type WarningCode =
  | "no_drive_folder"
  | "ocr_disabled"
  | "ai_disabled"
  | "batch_ai_disabled"
  | "stale_run_recovered"
  | "documents_excluded_by_ai_limits"
  | "scanned_pdfs_unsupported"
  | "import_failures_present"
  | "extraction_failures_present";

export interface DiagnosticsWarning {
  code: WarningCode;
  message: string;
  count?: number;
}

export type FailureCategory =
  | "CONFIGURATION"
  | "DOCUMENT"
  | "OCR"
  | "AI"
  | "PIPELINE"
  | "SECURITY";

export interface DiagnosticsFailure {
  category: FailureCategory;
  count: number;
  latestOccurrence: string | null;
  exampleMessage: string;
}

export interface DiagnosticsTimeline {
  steps: TimelineStep[];
}

export interface TimelineStep {
  name: string;
  displayName: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export interface SupportBundle {
  generatedAt: string;
  version: string;
  batch: BatchOverview;
  pipeline: PipelineSummary;
  documents: DocumentCounts;
  extraction: ExtractionCounts;
  discovery: DiscoveryCounts;
  ai: AiCounts;
  healthScore: number;
  warnings: DiagnosticsWarning[];
  failures: DiagnosticsFailure[];
  timeline: DiagnosticsTimeline;
  // Meta — safe operational context only
  config: {
    ocrEnabled: boolean;
    aiEnabled: boolean;
    batchAiEnabled: boolean;
    pipelineStaleMinutes: number;
    maxStepItems: number;
  };
  // Intentionally omitted: document text, AI prompts, storage paths, API keys, tokens
}

export class DiagnosticsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DiagnosticsError";
  }
}

// ── Health score ──────────────────────────────────────────────────────────────

/**
 * Deterministic health score (0–100) for a batch.
 *
 * Starts at 100 and subtracts penalties for failures/issues:
 *   - No Drive folder configured:  -20 (configuration)
 *   - Failed imports:              -5 each, max -30
 *   - Failed extractions:          -5 each, max -20
 *   - OCR failures:                -5 each, max -10
 *   - AI generation failures:      -5 each, max -10
 *   - Stale run recoveries:        -15 each, max -30
 *
 * Clamped to 0–100.
 */
export function calculateHealthScore(params: {
  noDriveFolder: boolean;
  importFailed: number;
  extractionFailed: number;
  ocrFailed: number;
  aiFailed: number;
  staleRecoveries: number;
}): number {
  let score = 100;
  if (params.noDriveFolder) score -= 20;
  score -= Math.min(30, params.importFailed * 5);
  score -= Math.min(20, params.extractionFailed * 5);
  score -= Math.min(10, params.ocrFailed * 5);
  score -= Math.min(10, params.aiFailed * 5);
  score -= Math.min(30, params.staleRecoveries * 15);
  return Math.max(0, Math.min(100, score));
}

// ── Timeline builder ──────────────────────────────────────────────────────────

const STEP_DISPLAY: Record<string, string> = {
  drive_match: "Drive Match",
  document_import: "Document Import",
  text_extraction: "Text Extraction",
  contact_discovery: "Contact Discovery",
  ai_intelligence: "AI Intelligence",
};

const PIPELINE_STEP_NAMES = [
  "drive_match",
  "document_import",
  "text_extraction",
  "contact_discovery",
  "ai_intelligence",
] as const;

function buildTimeline(stepsJson: unknown): DiagnosticsTimeline {
  const steps =
    stepsJson && typeof stepsJson === "object" && !Array.isArray(stepsJson)
      ? (stepsJson as Record<string, unknown>)
      : {};

  return {
    steps: PIPELINE_STEP_NAMES.map((name) => {
      const raw = steps[name] as
        | {
            status?: string;
            startedAt?: string | null;
            completedAt?: string | null;
            attempted?: number;
            succeeded?: number;
            failed?: number;
            skipped?: number;
          }
        | undefined;

      return {
        name,
        displayName: STEP_DISPLAY[name] ?? name,
        status: raw?.status ?? "pending",
        startedAt: raw?.startedAt ?? null,
        completedAt: raw?.completedAt ?? null,
        attempted: raw?.attempted ?? 0,
        succeeded: raw?.succeeded ?? 0,
        failed: raw?.failed ?? 0,
        skipped: raw?.skipped ?? 0,
      };
    }),
  };
}

// ── Warnings builder ──────────────────────────────────────────────────────────

function buildWarnings(params: {
  noDriveFolder: boolean;
  ocrEnabled: boolean;
  aiEnabled: boolean;
  batchAiEnabled: boolean;
  staleRecoveries: number;
  importFailed: number;
  extractionFailed: number;
  scannedPdfFailed: number;
}): DiagnosticsWarning[] {
  const warnings: DiagnosticsWarning[] = [];

  if (params.noDriveFolder) {
    warnings.push({
      code: "no_drive_folder",
      message:
        "No Google Drive folder is configured for this tenant. Drive match and document import will fail until a folder is set up.",
    });
  }
  if (!params.ocrEnabled) {
    warnings.push({
      code: "ocr_disabled",
      message:
        "OCR is disabled (CRM_OCR_ENABLED=false). Image documents (PNG, JPG) will fail text extraction. Set CRM_OCR_ENABLED=true to enable.",
    });
  }
  if (!params.aiEnabled) {
    warnings.push({
      code: "ai_disabled",
      message:
        "AI Lead Intelligence is disabled for this tenant. The AI intelligence pipeline step will be skipped.",
    });
  } else if (!params.batchAiEnabled) {
    warnings.push({
      code: "batch_ai_disabled",
      message:
        "Batch AI generation is disabled for this tenant. The AI intelligence pipeline step will be skipped.",
    });
  }
  if (params.staleRecoveries > 0) {
    warnings.push({
      code: "stale_run_recovered",
      message: `${params.staleRecoveries} pipeline run(s) were automatically recovered after a server crash. Check pipeline logs for details.`,
      count: params.staleRecoveries,
    });
  }
  if (params.importFailed > 0) {
    warnings.push({
      code: "import_failures_present",
      message: `${params.importFailed} document(s) failed to import. Check document statuses for details.`,
      count: params.importFailed,
    });
  }
  if (params.extractionFailed > 0) {
    warnings.push({
      code: "extraction_failures_present",
      message: `${params.extractionFailed} document(s) failed text extraction. Scanned PDFs may need OCR support.`,
      count: params.extractionFailed,
    });
  }
  if (params.scannedPdfFailed > 0) {
    warnings.push({
      code: "scanned_pdfs_unsupported",
      message: `${params.scannedPdfFailed} document(s) failed because scanned PDF OCR is not supported. Only image files (PNG, JPG) support OCR.`,
      count: params.scannedPdfFailed,
    });
  }

  return warnings;
}

// ── Failures builder ──────────────────────────────────────────────────────────

async function buildFailures(
  batchId: string,
  tenantId: string,
  stepsJson: unknown,
): Promise<DiagnosticsFailure[]> {
  const failures: DiagnosticsFailure[] = [];

  // Document import failures
  const importFailedDocs = await db.crmLeadDocument.findMany({
    where: { tenantId, importBatchId: batchId, status: "IMPORT_FAILED" },
    select: { importError: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: 5,
  });
  if (importFailedDocs.length > 0) {
    const countTotal = await db.crmLeadDocument.count({
      where: { tenantId, importBatchId: batchId, status: "IMPORT_FAILED" },
    });
    failures.push({
      category: "DOCUMENT",
      count: countTotal,
      latestOccurrence: importFailedDocs[0]?.updatedAt?.toISOString() ?? null,
      exampleMessage: importFailedDocs[0]?.importError ?? "import_failed",
    });
  }

  // Text extraction failures
  const extractFailedTexts = await db.crmLeadDocumentText.findMany({
    where: {
      tenantId,
      importBatchId: batchId,
      extractionStatus: "TEXT_FAILED",
    },
    select: { extractionError: true, updatedAt: true, extractionProvider: true },
    orderBy: { updatedAt: "desc" },
    take: 5,
  });
  const ocrExtractFailed = extractFailedTexts.filter(
    (t) => t.extractionProvider === "tesseract_js" || t.extractionProvider === "future_ocr",
  );
  const regularExtractFailed = extractFailedTexts.filter(
    (t) => t.extractionProvider !== "tesseract_js" && t.extractionProvider !== "future_ocr",
  );

  if (regularExtractFailed.length > 0) {
    const countTotal = await db.crmLeadDocumentText.count({
      where: {
        tenantId,
        importBatchId: batchId,
        extractionStatus: "TEXT_FAILED",
        extractionProvider: { notIn: ["tesseract_js", "future_ocr"] },
      },
    });
    failures.push({
      category: "DOCUMENT",
      count: countTotal,
      latestOccurrence: regularExtractFailed[0]?.updatedAt?.toISOString() ?? null,
      exampleMessage: regularExtractFailed[0]?.extractionError ?? "text_extraction_failed",
    });
  }

  if (ocrExtractFailed.length > 0) {
    const countTotal = await db.crmLeadDocumentText.count({
      where: {
        tenantId,
        importBatchId: batchId,
        extractionStatus: "TEXT_FAILED",
        extractionProvider: { in: ["tesseract_js", "future_ocr"] },
      },
    });
    failures.push({
      category: "OCR",
      count: countTotal,
      latestOccurrence: ocrExtractFailed[0]?.updatedAt?.toISOString() ?? null,
      exampleMessage: ocrExtractFailed[0]?.extractionError ?? "ocr_extraction_failed",
    });
  }

  // AI intelligence failures
  const aiFailedReports = await db.crmLeadIntelligenceReport.findMany({
    where: { tenantId, importBatchId: batchId, status: "FAILED" },
    select: { error: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: 5,
  });
  if (aiFailedReports.length > 0) {
    const countTotal = await db.crmLeadIntelligenceReport.count({
      where: { tenantId, importBatchId: batchId, status: "FAILED" },
    });
    failures.push({
      category: "AI",
      count: countTotal,
      latestOccurrence: aiFailedReports[0]?.updatedAt?.toISOString() ?? null,
      exampleMessage: aiFailedReports[0]?.error ?? "ai_generation_failed",
    });
  }

  // Pipeline failures from step errors
  const steps =
    stepsJson && typeof stepsJson === "object" && !Array.isArray(stepsJson)
      ? (stepsJson as Record<string, { status?: string; errorSummary?: string | null; completedAt?: string | null } | undefined>)
      : {};

  const pipelineStepFailed = PIPELINE_STEP_NAMES.filter(
    (s) => steps[s]?.status === "failed",
  );
  if (pipelineStepFailed.length > 0) {
    const firstFailed = steps[pipelineStepFailed[0]!]!;
    failures.push({
      category: "PIPELINE",
      count: pipelineStepFailed.length,
      latestOccurrence: firstFailed.completedAt ?? null,
      exampleMessage:
        firstFailed.errorSummary ?? `Pipeline step '${pipelineStepFailed[0]}' failed`,
    });
  }

  return failures;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get full diagnostics for a single import batch.
 * Throws DiagnosticsError("batch_not_found") if batch does not belong to tenant.
 */
export async function getBatchDiagnostics(
  batchId: string,
  tenantId: string,
): Promise<BatchDiagnostics> {
  const batch = await db.crmImportBatch.findFirst({
    where: { id: batchId, tenantId },
    select: {
      id: true,
      tenantId: true,
      fileName: true,
      status: true,
      totalRows: true,
      createdCount: true,
      updatedCount: true,
      skippedCount: true,
      errorCount: true,
      createdAt: true,
      completedAt: true,
    },
  });
  if (!batch) {
    throw new DiagnosticsError("batch_not_found", "Import batch not found for this tenant.");
  }

  const config = loadPipelineConfig();
  const staleThreshold = new Date(Date.now() - config.staleMinutes * 60 * 1000);

  const [
    // Pipeline runs
    latestRun,
    totalRuns,
    staleRecoveryCount,
    // Document counts
    docTotal,
    docMatched,
    docImported,
    docImportPending,
    docImportFailed,
    // Extraction counts
    extractComplete,
    extractFailed,
    extractPending,
    extractProcessing,
    ocrComplete,
    ocrFailed,
    totalCharsExtracted,
    // Discovery counts
    phonesTotal,
    phonesPending,
    phonesAccepted,
    phonesRejected,
    emailsTotal,
    emailsPending,
    emailsAccepted,
    emailsRejected,
    // AI counts
    aiTotal,
    aiComplete,
    aiFailed,
    aiPending,
    aiProcessing,
    // Scanned PDF failures (for warning)
    scannedPdfFailed,
  ] = await Promise.all([
    // Latest pipeline run
    db.crmImportBatchPipelineRun.findFirst({
      where: { tenantId, importBatchId: batchId },
      orderBy: { createdAt: "desc" },
    }),
    // Total run count
    db.crmImportBatchPipelineRun.count({
      where: { tenantId, importBatchId: batchId },
    }),
    // Stale recoveries
    db.crmImportBatchPipelineRun.count({
      where: {
        tenantId,
        importBatchId: batchId,
        recoveredAt: { not: null },
      },
    }),
    // Document total
    db.crmLeadDocument.count({ where: { tenantId, importBatchId: batchId } }),
    // Matched (any status other than DISCOVERED/unmatched — IMPORT_PENDING, IMPORTED, IMPORT_FAILED)
    db.crmLeadDocument.count({
      where: { tenantId, importBatchId: batchId, status: { in: ["IMPORT_PENDING", "IMPORTED", "IMPORT_FAILED"] } },
    }),
    // Imported
    db.crmLeadDocument.count({ where: { tenantId, importBatchId: batchId, status: "IMPORTED" } }),
    // Import pending
    db.crmLeadDocument.count({ where: { tenantId, importBatchId: batchId, status: "IMPORT_PENDING" } }),
    // Import failed
    db.crmLeadDocument.count({ where: { tenantId, importBatchId: batchId, status: "IMPORT_FAILED" } }),
    // Extraction complete
    db.crmLeadDocumentText.count({
      where: { tenantId, importBatchId: batchId, extractionStatus: "TEXT_COMPLETE" },
    }),
    // Extraction failed
    db.crmLeadDocumentText.count({
      where: { tenantId, importBatchId: batchId, extractionStatus: "TEXT_FAILED" },
    }),
    // Extraction pending
    db.crmLeadDocumentText.count({
      where: { tenantId, importBatchId: batchId, extractionStatus: "TEXT_PENDING" },
    }),
    // Extraction processing
    db.crmLeadDocumentText.count({
      where: { tenantId, importBatchId: batchId, extractionStatus: "TEXT_PROCESSING" },
    }),
    // OCR complete
    db.crmLeadDocumentText.count({
      where: {
        tenantId,
        importBatchId: batchId,
        extractionStatus: "TEXT_COMPLETE",
        extractionProvider: { in: ["tesseract_js", "future_ocr"] },
      },
    }),
    // OCR failed
    db.crmLeadDocumentText.count({
      where: {
        tenantId,
        importBatchId: batchId,
        extractionStatus: "TEXT_FAILED",
        extractionProvider: { in: ["tesseract_js", "future_ocr"] },
      },
    }),
    // Total chars extracted
    db.crmLeadDocumentText
      .aggregate({
        where: { tenantId, importBatchId: batchId },
        _sum: { charCount: true },
      })
      .then((r) => r._sum.charCount ?? 0),
    // Phones
    db.crmLeadDiscoveredPhone.count({
      where: { tenantId, document: { importBatchId: batchId } },
    }),
    db.crmLeadDiscoveredPhone.count({
      where: { tenantId, status: "PENDING", document: { importBatchId: batchId } },
    }),
    db.crmLeadDiscoveredPhone.count({
      where: { tenantId, status: "ACCEPTED", document: { importBatchId: batchId } },
    }),
    db.crmLeadDiscoveredPhone.count({
      where: { tenantId, status: "REJECTED", document: { importBatchId: batchId } },
    }),
    // Emails
    db.crmLeadDiscoveredEmail.count({
      where: { tenantId, document: { importBatchId: batchId } },
    }),
    db.crmLeadDiscoveredEmail.count({
      where: { tenantId, status: "PENDING", document: { importBatchId: batchId } },
    }),
    db.crmLeadDiscoveredEmail.count({
      where: { tenantId, status: "ACCEPTED", document: { importBatchId: batchId } },
    }),
    db.crmLeadDiscoveredEmail.count({
      where: { tenantId, status: "REJECTED", document: { importBatchId: batchId } },
    }),
    // AI reports
    db.crmLeadIntelligenceReport.count({ where: { tenantId, importBatchId: batchId } }),
    db.crmLeadIntelligenceReport.count({
      where: { tenantId, importBatchId: batchId, status: "COMPLETE" },
    }),
    db.crmLeadIntelligenceReport.count({
      where: { tenantId, importBatchId: batchId, status: "FAILED" },
    }),
    db.crmLeadIntelligenceReport.count({
      where: { tenantId, importBatchId: batchId, status: "PENDING" },
    }),
    db.crmLeadIntelligenceReport.count({
      where: { tenantId, importBatchId: batchId, status: "PROCESSING" },
    }),
    // Scanned PDF failures (failed AND not OCR provider = likely scanned PDF)
    db.crmLeadDocumentText.count({
      where: {
        tenantId,
        importBatchId: batchId,
        extractionStatus: "TEXT_FAILED",
        extractionProvider: "pdf_text_layer",
        extractionError: { contains: "scanned" },
      },
    }),
  ]);

  // AI settings for warnings
  const aiSettings = await getTenantAiSettings(tenantId);

  // Check Drive folder config (noDriveFolder = pipeline run ended in drive_match FAILED with no_drive_folder)
  const stepsJson = latestRun?.steps;
  const noDriveFolder = (() => {
    if (!stepsJson || typeof stepsJson !== "object" || Array.isArray(stepsJson)) return false;
    const s = stepsJson as Record<string, { status?: string; errorSummary?: string | null } | undefined>;
    const dm = s["drive_match"];
    return dm?.status === "failed" && (dm?.errorSummary?.includes("no_drive_folder") ?? false);
  })();

  // Pipeline summary
  let durationMs: number | null = null;
  if (latestRun?.startedAt && latestRun?.completedAt) {
    durationMs = latestRun.completedAt.getTime() - latestRun.startedAt.getTime();
  }

  const progressPercent = latestRun ? calcProgressFromSteps(latestRun.steps) : 0;

  const pipeline: PipelineSummary = {
    latestRunId: latestRun?.id ?? null,
    latestRunStatus: latestRun?.status ?? null,
    overallProgressPercent: progressPercent,
    currentStep: latestRun?.currentStep ?? null,
    startedAt: latestRun?.startedAt?.toISOString() ?? null,
    completedAt: latestRun?.completedAt?.toISOString() ?? null,
    durationMs,
    staleRecoveries: staleRecoveryCount,
    totalRuns,
  };

  const documents: DocumentCounts = {
    total: docTotal,
    matched: docMatched,
    imported: docImported,
    importPending: docImportPending,
    importFailed: docImportFailed,
    importSkipped: docTotal - docMatched - docImportFailed,
  };

  const extraction: ExtractionCounts = {
    total: extractComplete + extractFailed + extractPending + extractProcessing,
    complete: extractComplete,
    failed: extractFailed,
    pending: extractPending,
    processing: extractProcessing,
    ocrComplete,
    ocrFailed,
    totalCharsExtracted,
  };

  const discovery: DiscoveryCounts = {
    phonesTotal,
    phonesPending,
    phonesAccepted,
    phonesRejected,
    emailsTotal,
    emailsPending,
    emailsAccepted,
    emailsRejected,
  };

  const ai: AiCounts = {
    total: aiTotal,
    complete: aiComplete,
    failed: aiFailed,
    pending: aiPending,
    processing: aiProcessing,
  };

  const healthScore = calculateHealthScore({
    noDriveFolder,
    importFailed: docImportFailed,
    extractionFailed: extractFailed,
    ocrFailed,
    aiFailed,
    staleRecoveries: staleRecoveryCount,
  });

  const warnings = buildWarnings({
    noDriveFolder,
    ocrEnabled: process.env.CRM_OCR_ENABLED === "true",
    aiEnabled: aiSettings.aiEnabled,
    batchAiEnabled: aiSettings.allowBatchGeneration,
    staleRecoveries: staleRecoveryCount,
    importFailed: docImportFailed,
    extractionFailed: extractFailed,
    scannedPdfFailed,
  });

  const failures = await buildFailures(batchId, tenantId, stepsJson);

  return {
    generatedAt: new Date().toISOString(),
    batch: {
      batchId: batch.id,
      tenantId: batch.tenantId,
      fileName: batch.fileName,
      status: batch.status,
      totalRows: batch.totalRows,
      createdCount: batch.createdCount,
      updatedCount: batch.updatedCount,
      skippedCount: batch.skippedCount,
      errorCount: batch.errorCount,
      createdAt: batch.createdAt.toISOString(),
      completedAt: batch.completedAt?.toISOString() ?? null,
    },
    pipeline,
    documents,
    extraction,
    discovery,
    ai,
    healthScore,
    warnings,
    failures,
  };
}

/**
 * Get only the categorized failures for a batch.
 */
export async function getBatchFailures(
  batchId: string,
  tenantId: string,
): Promise<DiagnosticsFailure[]> {
  const batch = await db.crmImportBatch.findFirst({
    where: { id: batchId, tenantId },
    select: { id: true },
  });
  if (!batch) {
    throw new DiagnosticsError("batch_not_found", "Import batch not found for this tenant.");
  }
  const latestRun = await db.crmImportBatchPipelineRun.findFirst({
    where: { tenantId, importBatchId: batchId },
    orderBy: { createdAt: "desc" },
    select: { steps: true },
  });
  return buildFailures(batchId, tenantId, latestRun?.steps);
}

/**
 * Get the timeline (step-by-step status from latest pipeline run).
 */
export async function getBatchTimeline(
  batchId: string,
  tenantId: string,
): Promise<DiagnosticsTimeline> {
  const batch = await db.crmImportBatch.findFirst({
    where: { id: batchId, tenantId },
    select: { id: true },
  });
  if (!batch) {
    throw new DiagnosticsError("batch_not_found", "Import batch not found for this tenant.");
  }
  const latestRun = await db.crmImportBatchPipelineRun.findFirst({
    where: { tenantId, importBatchId: batchId },
    orderBy: { createdAt: "desc" },
    select: { steps: true },
  });
  return buildTimeline(latestRun?.steps);
}

/**
 * Generate a support bundle — safe JSON export for internal support.
 *
 * NEVER includes: document text, AI prompts, storage paths, API keys, tokens.
 */
export async function getSupportBundle(
  batchId: string,
  tenantId: string,
): Promise<SupportBundle> {
  const diag = await getBatchDiagnostics(batchId, tenantId);
  const timeline = await getBatchTimeline(batchId, tenantId);
  const pipelineConfig = loadPipelineConfig();
  const aiSettings = await getTenantAiSettings(tenantId);

  return {
    generatedAt: diag.generatedAt,
    version: "1",
    batch: diag.batch,
    pipeline: diag.pipeline,
    documents: diag.documents,
    extraction: diag.extraction,
    discovery: diag.discovery,
    ai: diag.ai,
    healthScore: diag.healthScore,
    warnings: diag.warnings,
    failures: diag.failures,
    timeline,
    config: {
      ocrEnabled: process.env.CRM_OCR_ENABLED === "true",
      aiEnabled: aiSettings.aiEnabled,
      batchAiEnabled: aiSettings.allowBatchGeneration,
      pipelineStaleMinutes: pipelineConfig.staleMinutes,
      maxStepItems: pipelineConfig.maxStepItems,
    },
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Derive progress percent from a steps JSON blob (mirrors batchPipelineService). */
function calcProgressFromSteps(stepsJson: unknown): number {
  if (!stepsJson || typeof stepsJson !== "object" || Array.isArray(stepsJson)) return 0;
  const steps = stepsJson as Record<string, { status?: string } | undefined>;
  const stepWeight = 100 / PIPELINE_STEP_NAMES.length;
  let progress = 0;
  for (const name of PIPELINE_STEP_NAMES) {
    const s = steps[name];
    if (!s) continue;
    switch (s.status) {
      case "complete":
      case "skipped":
        progress += stepWeight;
        break;
      case "partial":
        progress += stepWeight * 0.5;
        break;
      case "running":
        progress += stepWeight * 0.25;
        break;
    }
  }
  return Math.min(100, Math.round(progress));
}
