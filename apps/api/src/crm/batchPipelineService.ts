/**
 * CRM Import Batch Pipeline Orchestration Service — Phase 8 (hardened)
 *
 * Coordinates the five pipeline steps for a CRM import batch:
 *   1. drive_match        — Drive file matching (idempotent, fast)
 *   2. document_import    — Import IMPORT_PENDING docs from Drive
 *   3. text_extraction    — Extract text from IMPORTED docs
 *   4. contact_discovery  — Discover phones/emails from TEXT_COMPLETE docs
 *   5. ai_intelligence    — Generate AI lead intelligence (only if AI enabled)
 *
 * Hardening guarantees:
 *  - Stale RUNNING recovery: runs stuck in RUNNING longer than CRM_PIPELINE_STALE_MINUTES
 *    are automatically marked FAILED with a safe error on the next start/continue call.
 *  - Single active run: only one RUNNING run per (tenant, batch) is allowed. New starts
 *    return 409 if a non-stale RUNNING run exists.
 *  - Bounded execution: per-step limits respected; CRM_PIPELINE_MAX_STEP_ITEMS provides
 *    a global ceiling so no single call can loop indefinitely.
 *  - Progress tracking: overallProgressPercent is derived from step states.
 *  - Audit logging: pipeline lifecycle events written to stdout (no doc text, no keys).
 *  - Safe cancellation: PENDING, RUNNING, and PARTIAL may be cancelled; COMPLETE/FAILED/
 *    CANCELLED cannot.
 *
 * No fake async: pipeline runs synchronously per call. hasMore=true means Continue is needed.
 * Clean seam for future worker queue: service is stateless aside from DB record.
 */

import { db } from "@connect/db";
import type { CrmPipelineRunStatus } from "@connect/db";
import { runDriveMatchForBatch, DriveMatchError } from "./driveMatchService";
import { importBatchDocuments } from "./docImportService";
import { extractBatchDocumentText } from "./docTextExtractionService";
import { extractDiscoveriesForBatch } from "./contactDiscoveryService";
import {
  generateBatchIntelligence,
  LeadIntelligenceError,
  getTenantAiSettings,
} from "./leadIntelligenceService";

// ── Config ────────────────────────────────────────────────────────────────────

/**
 * Load pipeline configuration from environment variables.
 * All values are validated and bounded to safe ranges at load time.
 */
export function loadPipelineConfig(): PipelineConfig {
  const staleMinutes = Math.max(
    1,
    parseInt(process.env.CRM_PIPELINE_STALE_MINUTES ?? "30", 10) || 30,
  );
  const maxStepItems = Math.max(
    1,
    Math.min(50, parseInt(process.env.CRM_PIPELINE_MAX_STEP_ITEMS ?? "20", 10) || 20),
  );
  return { staleMinutes, maxStepItems };
}

export interface PipelineConfig {
  /** Minutes before a RUNNING run is considered stale and recovered. Default: 30. */
  staleMinutes: number;
  /**
   * Global ceiling for items processed per step per call.
   * Per-step natural limits (5 for extraction, 10 for discovery, etc.) still apply
   * as lower-level caps. This provides an additional emergency ceiling. Default: 20.
   */
  maxStepItems: number;
}

// Natural per-step limits (conservative; keeps each API call bounded).
// Effective limit per step = min(natural_limit, config.maxStepItems).
const NATURAL_LIMITS = {
  document_import: 20,
  text_extraction: 5,
  contact_discovery: 10,
  ai_intelligence: 5,
} as const;

// Maximum safe error entries to store on the run record.
const MAX_ERROR_ENTRIES = 10;

// ── Step types ────────────────────────────────────────────────────────────────

export type PipelineStepName =
  | "drive_match"
  | "document_import"
  | "text_extraction"
  | "contact_discovery"
  | "ai_intelligence";

export const PIPELINE_STEPS: PipelineStepName[] = [
  "drive_match",
  "document_import",
  "text_extraction",
  "contact_discovery",
  "ai_intelligence",
];

export type StepStatus = "pending" | "running" | "complete" | "partial" | "skipped" | "failed";

export interface StepRecord {
  status: StepStatus;
  startedAt: string | null;
  completedAt: string | null;
  attempted: number;
  succeeded: number;
  skipped: number;
  failed: number;
  errorSummary: string | null;
}

export type StepsJson = Partial<Record<PipelineStepName, StepRecord>>;

export interface PipelineTotals {
  driveFilesScanned: number;
  documentsMatched: number;
  documentsImported: number;
  textExtracted: number;
  discoveriesFound: number;
  aiReportsGenerated: number;
}

export interface PipelineErrorEntry {
  step: PipelineStepName | "system";
  error: string;
  at: string;
}

export interface PipelineRunResult {
  runId: string;
  batchId: string;
  status: CrmPipelineRunStatus;
  currentStep: PipelineStepName | null;
  steps: StepsJson;
  totals: PipelineTotals;
  errors: PipelineErrorEntry[];
  /** 0–100 integer derived from step completion states. */
  overallProgressPercent: number;
  hasMore: boolean;
  nextAction: string | null;
  startedAt: string | null;
  completedAt: string | null;
  recoveredAt: string | null;
}

// ── Audit logging ─────────────────────────────────────────────────────────────

/**
 * Writes a safe structured pipeline audit event to stdout.
 * Captured by Pino/Fastify logger in production.
 * NEVER includes document text, AI prompts, storage paths, or API keys.
 */
function pipelineAuditLog(
  event: string,
  fields: {
    tenantId: string;
    batchId: string;
    runId?: string;
    durationMs?: number;
    staleMinutes?: number;
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

// ── Progress calculation ──────────────────────────────────────────────────────

/**
 * Calculate overall pipeline progress as an integer 0–100.
 *
 * Each of the 5 steps is worth 20 points:
 *   complete / skipped → full 20 pts
 *   partial            → 10 pts (half credit, work is ongoing)
 *   running            → 5 pts  (just started)
 *   failed / pending   → 0 pts
 *
 * Result is rounded to nearest integer and capped at 100.
 */
export function calculateProgressPercent(steps: StepsJson): number {
  const stepWeight = 100 / PIPELINE_STEPS.length; // 20
  let progress = 0;
  for (const stepName of PIPELINE_STEPS) {
    const step = steps[stepName];
    if (!step) continue;
    switch (step.status) {
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
      default:
        break;
    }
  }
  return Math.min(100, Math.round(progress));
}

// ── Utility ───────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function blankStep(): StepRecord {
  return {
    status: "pending",
    startedAt: null,
    completedAt: null,
    attempted: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    errorSummary: null,
  };
}

function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "unknown_error";
}

function emptyTotals(): PipelineTotals {
  return {
    driveFilesScanned: 0,
    documentsMatched: 0,
    documentsImported: 0,
    textExtracted: 0,
    discoveriesFound: 0,
    aiReportsGenerated: 0,
  };
}

// ── Stale run recovery ────────────────────────────────────────────────────────

/**
 * Detect and recover any stale RUNNING runs for (batchId, tenantId).
 * A run is considered stale when it has been RUNNING for longer than staleMinutes
 * without a DB update — indicating the API process crashed or was killed mid-run.
 *
 * Recovery action: mark as FAILED, append stale_run_recovered to errors,
 * set recoveredAt. This frees the slot so a new run can start.
 *
 * Returns the number of runs recovered.
 */
export async function recoverStaleRuns(
  batchId: string,
  tenantId: string,
  config: PipelineConfig,
): Promise<number> {
  const staleThreshold = new Date(Date.now() - config.staleMinutes * 60 * 1000);

  const staleRuns = await db.crmImportBatchPipelineRun.findMany({
    where: {
      tenantId,
      importBatchId: batchId,
      status: "RUNNING",
      updatedAt: { lt: staleThreshold },
    },
    select: { id: true, errors: true },
  });

  if (staleRuns.length === 0) return 0;

  for (const staleRun of staleRuns) {
    const existingErrors = Array.isArray(staleRun.errors) ? (staleRun.errors as unknown) as PipelineErrorEntry[] : [];
    const updatedErrors: PipelineErrorEntry[] = [
      ...existingErrors.slice(0, MAX_ERROR_ENTRIES - 1),
      {
        step: "system",
        error: "stale_run_recovered",
        at: now(),
      },
    ];

    await db.crmImportBatchPipelineRun.update({
      where: { id: staleRun.id },
      data: {
        status: "FAILED",
        errors: updatedErrors as object[],
        recoveredAt: new Date(),
        completedAt: new Date(),
      },
    });

    pipelineAuditLog("crm_pipeline_stale_recovered", {
      tenantId,
      batchId,
      runId: staleRun.id,
      staleMinutes: config.staleMinutes,
    });
  }

  return staleRuns.length;
}

// ── Remaining work count ──────────────────────────────────────────────────────

/**
 * Count pending work remaining per step (used to determine hasMore and nextAction).
 *
 * Discovery is intentionally excluded because extractDiscoveriesForBatch is
 * fully idempotent and re-processes all TEXT_COMPLETE docs on every call.
 * Including discovery would cause hasMore=true forever after the first full pass.
 */
async function countRemainingWork(
  batchId: string,
  tenantId: string,
): Promise<{ import: number; extract: number; ai: number }> {
  const [importCount, extractCount, aiCount] = await Promise.all([
    db.crmLeadDocument.count({
      where: { tenantId, importBatchId: batchId, status: "IMPORT_PENDING" },
    }),
    db.crmLeadDocument.count({
      where: {
        tenantId,
        importBatchId: batchId,
        status: "IMPORTED",
        OR: [
          { textExtractionStatus: null },
          { textExtractionStatus: "TEXT_PENDING" },
          { textExtractionStatus: "TEXT_FAILED" },
        ],
      },
    }),
    db.crmImportBatchRow.count({
      where: {
        tenantId,
        batchId,
        contactId: { not: null },
        contact: {
          intelligenceReport: { is: null },
        },
      },
    }),
  ]);

  return { import: importCount, extract: extractCount, ai: aiCount };
}

function buildHasMoreAndNextAction(
  remaining: { import: number; extract: number; ai: number },
  aiEnabled: boolean,
): { hasMore: boolean; nextAction: string | null } {
  if (remaining.import > 0) {
    return {
      hasMore: true,
      nextAction: `${remaining.import} document(s) still need importing. Click Continue to import the next batch.`,
    };
  }
  if (remaining.extract > 0) {
    return {
      hasMore: true,
      nextAction: `${remaining.extract} document(s) still need text extraction. Click Continue to extract the next batch.`,
    };
  }
  if (aiEnabled && remaining.ai > 0) {
    return {
      hasMore: true,
      nextAction: `${remaining.ai} contact(s) still need AI intelligence reports. Click Continue.`,
    };
  }
  return { hasMore: false, nextAction: null };
}

// ── Core pipeline executor ────────────────────────────────────────────────────

/**
 * Run all pipeline steps for the given run record.
 * Reads existing steps from the run so continue calls pick up where they left off.
 * Persists progress to DB after each step so a crash mid-run is recoverable.
 */
async function executePipelineSteps(
  runId: string,
  batchId: string,
  tenantId: string,
  stepsIn: StepsJson,
  totalsIn: PipelineTotals,
  errorsIn: PipelineErrorEntry[],
  config: PipelineConfig,
): Promise<{
  steps: StepsJson;
  totals: PipelineTotals;
  errors: PipelineErrorEntry[];
  fatalError: boolean;
}> {
  const steps: StepsJson = { ...stepsIn };
  const totals: PipelineTotals = { ...totalsIn };
  const errors: PipelineErrorEntry[] = [...errorsIn];
  let fatalError = false;

  function addError(step: PipelineStepName | "system", err: unknown) {
    if (errors.length < MAX_ERROR_ENTRIES) {
      errors.push({ step, error: safeErrorMessage(err), at: now() });
    }
  }

  async function saveProgress(currentStep: PipelineStepName) {
    await db.crmImportBatchPipelineRun.update({
      where: { id: runId },
      data: {
        currentStep,
        steps: steps as object,
        totals: totals as object,
        errors: errors as object[],
      },
    });
  }

  // ── Step 1: Drive match ──────────────────────────────────────────────────

  {
    const step = "drive_match";
    const rec: StepRecord = steps[step] ?? blankStep();
    rec.status = "running";
    rec.startedAt = rec.startedAt ?? now();
    steps[step] = rec;
    await saveProgress(step);

    try {
      const result = await runDriveMatchForBatch(batchId, tenantId);
      rec.status = "complete";
      rec.completedAt = now();
      rec.attempted = result.filesScanned;
      rec.succeeded = result.matchesCreated;
      rec.skipped = result.duplicatesSkipped;
      totals.driveFilesScanned = result.filesScanned;
      totals.documentsMatched = (totals.documentsMatched || 0) + result.matchesCreated;
    } catch (err) {
      rec.status = "failed";
      rec.completedAt = now();
      rec.errorSummary = safeErrorMessage(err);
      addError(step, err);
      steps[step] = rec;
      await saveProgress(step);

      if (err instanceof DriveMatchError && err.code === "no_drive_folder") {
        fatalError = true;
        return { steps, totals, errors, fatalError };
      }
    }
    steps[step] = rec;
    await saveProgress(step);
  }

  // ── Step 2: Document import ──────────────────────────────────────────────

  {
    const step = "document_import";
    const limit = Math.min(NATURAL_LIMITS.document_import, config.maxStepItems);
    const rec: StepRecord = steps[step] ?? blankStep();
    rec.status = "running";
    rec.startedAt = rec.startedAt ?? now();
    steps[step] = rec;
    await saveProgress(step);

    try {
      const result = await importBatchDocuments(batchId, tenantId, limit);
      rec.attempted += result.attempted;
      rec.succeeded += result.imported;
      rec.skipped += result.skipped;
      rec.failed += result.failed;
      rec.status = result.failed > 0 ? "partial" : "complete";
      rec.completedAt = now();
      totals.documentsImported = (totals.documentsImported || 0) + result.imported;
    } catch (err) {
      rec.status = "failed";
      rec.completedAt = now();
      rec.errorSummary = safeErrorMessage(err);
      addError(step, err);
    }
    steps[step] = rec;
    await saveProgress(step);
  }

  // ── Step 3: Text extraction ──────────────────────────────────────────────

  {
    const step = "text_extraction";
    const limit = Math.min(NATURAL_LIMITS.text_extraction, config.maxStepItems);
    const rec: StepRecord = steps[step] ?? blankStep();
    rec.status = "running";
    rec.startedAt = rec.startedAt ?? now();
    steps[step] = rec;
    await saveProgress(step);

    try {
      const result = await extractBatchDocumentText(batchId, tenantId, limit);
      rec.attempted += result.attempted;
      rec.succeeded += result.complete;
      rec.failed += result.failed;
      rec.status = result.failed > 0 ? "partial" : "complete";
      rec.completedAt = now();
      totals.textExtracted = (totals.textExtracted || 0) + result.complete;
    } catch (err) {
      rec.status = "failed";
      rec.completedAt = now();
      rec.errorSummary = safeErrorMessage(err);
      addError(step, err);
    }
    steps[step] = rec;
    await saveProgress(step);
  }

  // ── Step 4: Contact discovery ────────────────────────────────────────────

  {
    const step = "contact_discovery";
    const limit = Math.min(NATURAL_LIMITS.contact_discovery, config.maxStepItems);
    const rec: StepRecord = steps[step] ?? blankStep();
    rec.status = "running";
    rec.startedAt = rec.startedAt ?? now();
    steps[step] = rec;
    await saveProgress(step);

    try {
      const result = await extractDiscoveriesForBatch(batchId, tenantId, limit);
      rec.attempted += result.documentsProcessed;
      rec.succeeded += result.documentsProcessed;
      rec.status = "complete";
      rec.completedAt = now();
      totals.discoveriesFound =
        (totals.discoveriesFound || 0) + result.totalPhonesFound + result.totalEmailsFound;
    } catch (err) {
      rec.status = "failed";
      rec.completedAt = now();
      rec.errorSummary = safeErrorMessage(err);
      addError(step, err);
    }
    steps[step] = rec;
    await saveProgress(step);
  }

  // ── Step 5: AI intelligence ──────────────────────────────────────────────

  {
    const step = "ai_intelligence";
    const rec: StepRecord = steps[step] ?? blankStep();
    const settings = await getTenantAiSettings(tenantId);

    if (!settings.aiEnabled || !settings.allowBatchGeneration) {
      rec.status = "skipped";
      rec.completedAt = rec.completedAt ?? now();
      rec.errorSummary = !settings.aiEnabled
        ? "AI is disabled for this tenant."
        : "Batch AI generation is disabled for this tenant.";
      steps[step] = rec;
      await saveProgress(step);
    } else {
      const limit = Math.min(NATURAL_LIMITS.ai_intelligence, config.maxStepItems);
      rec.status = "running";
      rec.startedAt = rec.startedAt ?? now();
      steps[step] = rec;
      await saveProgress(step);

      try {
        const result = await generateBatchIntelligence(
          batchId,
          tenantId,
          limit,
          false, // force=false: never force-regenerate from pipeline
        );
        rec.attempted += result.contactsProcessed;
        rec.succeeded += result.complete;
        rec.failed += result.failed;
        rec.skipped += result.skipped_existing + result.skipped_limit;
        rec.status = result.failed > 0 ? "partial" : "complete";
        rec.completedAt = now();
        totals.aiReportsGenerated = (totals.aiReportsGenerated || 0) + result.complete;
      } catch (err) {
        if (
          err instanceof LeadIntelligenceError &&
          (err.code === "ai_disabled" || err.code === "batch_generation_disabled")
        ) {
          rec.status = "skipped";
          rec.errorSummary = safeErrorMessage(err);
        } else {
          rec.status = "failed";
          rec.errorSummary = safeErrorMessage(err);
          addError(step, err);
        }
        rec.completedAt = now();
      }
      steps[step] = rec;
      await saveProgress(step);
    }
  }

  return { steps, totals, errors, fatalError };
}

// ── Result builder ────────────────────────────────────────────────────────────

async function buildResult(
  run: {
    id: string;
    status: CrmPipelineRunStatus;
    currentStep: string | null;
    steps: unknown;
    totals: unknown;
    errors: unknown;
    startedAt: Date | null;
    completedAt: Date | null;
    recoveredAt: Date | null;
  },
  batchId: string,
  tenantId: string,
): Promise<PipelineRunResult> {
  const steps = (run.steps ?? {}) as StepsJson;
  const totals = (run.totals ?? emptyTotals()) as PipelineTotals;
  const errors = (run.errors ?? []) as PipelineErrorEntry[];
  const settings = await getTenantAiSettings(tenantId);
  const remaining = await countRemainingWork(batchId, tenantId);
  const { hasMore, nextAction } = buildHasMoreAndNextAction(remaining, settings.aiEnabled);

  return {
    runId: run.id,
    batchId,
    status: run.status,
    currentStep: (run.currentStep as PipelineStepName | null) ?? null,
    steps,
    totals,
    errors,
    overallProgressPercent: calculateProgressPercent(steps),
    hasMore: run.status === "PARTIAL" ? hasMore : false,
    nextAction: run.status === "PARTIAL" ? nextAction : null,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    recoveredAt: run.recoveredAt?.toISOString() ?? null,
  };
}

// ── Core execute pipeline ─────────────────────────────────────────────────────

async function executePipeline(
  runId: string,
  batchId: string,
  tenantId: string,
  priorSteps: StepsJson,
  priorTotals: PipelineTotals,
  priorErrors: PipelineErrorEntry[],
  config: PipelineConfig,
  startedAt: Date,
): Promise<PipelineRunResult> {
  const runStartMs = Date.now();

  const { steps, totals, errors, fatalError } = await executePipelineSteps(
    runId,
    batchId,
    tenantId,
    priorSteps,
    priorTotals,
    priorErrors,
    config,
  );

  // Determine final pipeline status
  let finalStatus: CrmPipelineRunStatus;
  if (fatalError) {
    finalStatus = "FAILED";
  } else {
    const settings = await getTenantAiSettings(tenantId);
    const remaining = await countRemainingWork(batchId, tenantId);
    const { hasMore } = buildHasMoreAndNextAction(remaining, settings.aiEnabled);
    const anyFailed = PIPELINE_STEPS.some((s) => steps[s]?.status === "failed");

    if (hasMore || anyFailed) {
      finalStatus = "PARTIAL";
    } else {
      finalStatus = "COMPLETE";
    }
  }

  const completedAt = finalStatus !== "PARTIAL" ? new Date() : null;
  const durationMs = Date.now() - runStartMs;

  const updatedRun = await db.crmImportBatchPipelineRun.update({
    where: { id: runId },
    data: {
      status: finalStatus,
      steps: steps as object,
      totals: totals as object,
      errors: errors as object[],
      completedAt,
    },
  });

  // Audit log
  const auditEvent =
    finalStatus === "COMPLETE"
      ? "crm_pipeline_completed"
      : finalStatus === "FAILED"
        ? "crm_pipeline_failed"
        : "crm_pipeline_partial";

  pipelineAuditLog(auditEvent, { tenantId, batchId, runId, durationMs });

  return buildResult(
    { ...updatedRun, startedAt, recoveredAt: null },
    batchId,
    tenantId,
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start a new pipeline run for the given batch.
 * 1. Recovers any stale RUNNING runs first.
 * 2. Returns 409 if a non-stale RUNNING run exists.
 * 3. Creates a fresh run and executes all steps.
 */
export async function startBatchPipeline(
  batchId: string,
  tenantId: string,
  userId: string,
): Promise<PipelineRunResult> {
  const config = loadPipelineConfig();

  const batch = await db.crmImportBatch.findFirst({
    where: { id: batchId, tenantId },
    select: { id: true },
  });
  if (!batch) {
    throw new PipelineError("batch_not_found", "Import batch not found for this tenant.");
  }

  // Recover stale RUNNING runs before checking for active ones
  await recoverStaleRuns(batchId, tenantId, config);

  // Prevent double-start when a non-stale RUNNING run exists
  const runningRun = await db.crmImportBatchPipelineRun.findFirst({
    where: { tenantId, importBatchId: batchId, status: "RUNNING" },
    select: { id: true },
  });
  if (runningRun) {
    throw new PipelineError(
      "already_running",
      "A pipeline run is already in progress for this batch. Wait for it to complete before starting a new one.",
    );
  }

  const startedAt = new Date();
  const run = await db.crmImportBatchPipelineRun.create({
    data: {
      tenantId,
      importBatchId: batchId,
      startedByUserId: userId,
      status: "RUNNING",
      startedAt,
    },
    select: { id: true },
  });

  pipelineAuditLog("crm_pipeline_started", { tenantId, batchId, runId: run.id });

  return executePipeline(run.id, batchId, tenantId, {}, emptyTotals(), [], config, startedAt);
}

/**
 * Continue the most recent pipeline run for a batch.
 * 1. Recovers any stale RUNNING runs first.
 * 2. If a PARTIAL or RUNNING run exists, resumes it.
 * 3. If no continuable run exists, starts fresh.
 */
export async function continueBatchPipeline(
  batchId: string,
  tenantId: string,
  userId: string,
): Promise<PipelineRunResult> {
  const config = loadPipelineConfig();

  const batch = await db.crmImportBatch.findFirst({
    where: { id: batchId, tenantId },
    select: { id: true },
  });
  if (!batch) {
    throw new PipelineError("batch_not_found", "Import batch not found for this tenant.");
  }

  await recoverStaleRuns(batchId, tenantId, config);

  const existingRun = await db.crmImportBatchPipelineRun.findFirst({
    where: {
      tenantId,
      importBatchId: batchId,
      status: { in: ["PARTIAL", "RUNNING"] },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!existingRun) {
    return startBatchPipeline(batchId, tenantId, userId);
  }

  const startedAt = existingRun.startedAt ?? new Date();

  await db.crmImportBatchPipelineRun.update({
    where: { id: existingRun.id },
    data: { status: "RUNNING", startedByUserId: userId },
  });

  const priorSteps = (existingRun.steps ?? {}) as unknown as StepsJson;
  const priorTotals = (existingRun.totals ?? emptyTotals()) as unknown as PipelineTotals;
  const priorErrors = ((existingRun.errors ?? []) as unknown) as PipelineErrorEntry[];

  return executePipeline(
    existingRun.id,
    batchId,
    tenantId,
    priorSteps,
    priorTotals,
    priorErrors,
    config,
    startedAt,
  );
}

/**
 * Cancel a pipeline run.
 * Only PENDING, RUNNING, and PARTIAL may be cancelled.
 * COMPLETE, FAILED, and CANCELLED cannot be cancelled.
 * Returns { cancelled: boolean, runId?: string, reason?: string }.
 */
export async function cancelBatchPipeline(
  batchId: string,
  tenantId: string,
): Promise<{ cancelled: boolean; runId?: string; reason?: string }> {
  const batch = await db.crmImportBatch.findFirst({
    where: { id: batchId, tenantId },
    select: { id: true },
  });
  if (!batch) {
    throw new PipelineError("batch_not_found", "Import batch not found for this tenant.");
  }

  const run = await db.crmImportBatchPipelineRun.findFirst({
    where: {
      tenantId,
      importBatchId: batchId,
      status: { in: ["PENDING", "RUNNING", "PARTIAL"] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true },
  });

  if (!run) {
    return { cancelled: false, reason: "no_cancellable_run" };
  }

  await db.crmImportBatchPipelineRun.update({
    where: { id: run.id },
    data: { status: "CANCELLED", completedAt: new Date() },
  });

  pipelineAuditLog("crm_pipeline_cancelled", { tenantId, batchId, runId: run.id });

  return { cancelled: true, runId: run.id };
}

/**
 * Get the status of the most recent pipeline run for a batch.
 * Returns null when no run has been created for this batch.
 */
export async function getBatchPipelineStatus(
  batchId: string,
  tenantId: string,
): Promise<PipelineRunResult | null> {
  const batch = await db.crmImportBatch.findFirst({
    where: { id: batchId, tenantId },
    select: { id: true },
  });
  if (!batch) {
    throw new PipelineError("batch_not_found", "Import batch not found for this tenant.");
  }

  const run = await db.crmImportBatchPipelineRun.findFirst({
    where: { tenantId, importBatchId: batchId },
    orderBy: { createdAt: "desc" },
  });

  if (!run) return null;
  return buildResult(run, batchId, tenantId);
}

/**
 * Get a specific pipeline run by id.
 */
export async function getPipelineRun(
  runId: string,
  batchId: string,
  tenantId: string,
): Promise<PipelineRunResult | null> {
  const run = await db.crmImportBatchPipelineRun.findFirst({
    where: { id: runId, importBatchId: batchId, tenantId },
  });
  if (!run) return null;
  return buildResult(run, batchId, tenantId);
}

/**
 * Get pipeline health summary for a batch.
 * No sensitive data is returned.
 */
export async function getBatchPipelineHealth(
  batchId: string,
  tenantId: string,
): Promise<PipelineHealthResult> {
  const config = loadPipelineConfig();

  const batch = await db.crmImportBatch.findFirst({
    where: { id: batchId, tenantId },
    select: { id: true },
  });
  if (!batch) {
    throw new PipelineError("batch_not_found", "Import batch not found for this tenant.");
  }

  const staleThreshold = new Date(Date.now() - config.staleMinutes * 60 * 1000);

  const [latestRun, activeRunCount, staleCount] = await Promise.all([
    db.crmImportBatchPipelineRun.findFirst({
      where: { tenantId, importBatchId: batchId },
      orderBy: { createdAt: "desc" },
      select: { status: true, updatedAt: true },
    }),
    db.crmImportBatchPipelineRun.count({
      where: { tenantId, importBatchId: batchId, status: "RUNNING" },
    }),
    db.crmImportBatchPipelineRun.count({
      where: {
        tenantId,
        importBatchId: batchId,
        status: "RUNNING",
        updatedAt: { lt: staleThreshold },
      },
    }),
  ]);

  const settings = await getTenantAiSettings(tenantId);
  const remaining = await countRemainingWork(batchId, tenantId);
  const { hasMore } = buildHasMoreAndNextAction(remaining, settings.aiEnabled);

  const healthy =
    activeRunCount <= 1 &&
    staleCount === 0 &&
    latestRun?.status !== "FAILED";

  return {
    healthy,
    latestRunStatus: latestRun?.status ?? null,
    staleDetected: staleCount > 0,
    activeRunCount,
    hasMore,
    lastUpdatedAt: latestRun?.updatedAt?.toISOString() ?? null,
  };
}

export interface PipelineHealthResult {
  healthy: boolean;
  latestRunStatus: CrmPipelineRunStatus | null;
  staleDetected: boolean;
  activeRunCount: number;
  hasMore: boolean;
  lastUpdatedAt: string | null;
}

// ── Error type ────────────────────────────────────────────────────────────────

export class PipelineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}
