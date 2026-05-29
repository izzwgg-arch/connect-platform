/**
 * CRM Drive Match Service — Phase 2
 *
 * Normalises company names and Drive file names, then scores matches between
 * import batch rows and Drive files in the tenant's configured LEAD_IMPORT_INBOX
 * folder. Writes CrmLeadDocument records for HIGH / MEDIUM confidence matches.
 *
 * Matching rules:
 *   HIGH     — normalised company name exactly equals normalised file name
 *   MEDIUM   — file name contains company name (or vice-versa), length ≥ 4 chars
 *   AMBIGUOUS — one file matches multiple companies, or one company matches
 *               multiple files with comparable confidence
 *   LOW      — no meaningful overlap; discarded (no record written)
 *
 * No OCR. No file download. No AI. Metadata only.
 * Tokens / Drive access tokens are NEVER logged.
 */

import { db } from "@connect/db";
import {
  listDriveFolderFiles,
} from "./driveService";

// ── Normalisation ─────────────────────────────────────────────────────────────

/**
 * Common legal / filler words stripped before comparison.
 * Order matters: "and" before "&" ensures the substitution chain is clean.
 */
const STRIP_RE =
  /\b(llc|inc|incorporated|corp|corporation|co|ltd|limited|company|group|the|and|of|a|an)\b/g;

/**
 * Normalise a company or file name for matching.
 * Lowercases → removes punctuation → strips common legal suffixes → collapses whitespace.
 */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\w\s]/g, " ")   // punctuation → space
    .replace(STRIP_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip file extension then normalise. */
export function normalizeFileName(fileName: string): string {
  const withoutExt = fileName.replace(/\.[^.]+$/, "");
  return normalizeForMatch(withoutExt);
}

// ── Scoring ───────────────────────────────────────────────────────────────────

export type MatchConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface MatchScore {
  confidence: MatchConfidence;
  reason: string;
}

/** Minimum token length for a "contains" match — prevents single-letter over-matching. */
const MIN_CONTAINS_LEN = 4;

/**
 * Score how well a Drive file matches a company name.
 * Both inputs MUST already be normalised via normalizeForMatch / normalizeFileName.
 */
export function scoreMatch(companyNorm: string, fileNorm: string): MatchScore {
  if (!companyNorm || !fileNorm) {
    return { confidence: "LOW", reason: "empty_token" };
  }
  if (companyNorm === fileNorm) {
    return { confidence: "HIGH", reason: "exact_company_name" };
  }
  if (
    fileNorm.includes(companyNorm) &&
    companyNorm.length >= MIN_CONTAINS_LEN
  ) {
    return { confidence: "MEDIUM", reason: "file_contains_company" };
  }
  if (
    companyNorm.includes(fileNorm) &&
    fileNorm.length >= MIN_CONTAINS_LEN
  ) {
    return { confidence: "MEDIUM", reason: "company_contains_file" };
  }
  return { confidence: "LOW", reason: "no_match" };
}

// ── Match engine ──────────────────────────────────────────────────────────────

export interface DriveMatchRunResult {
  batchId: string;
  filesScanned: number;
  /** How many CrmImportBatchRow rows exist for this batch (company rows only). */
  auditRowCount: number;
  rowsWithCompany: number;
  matchesCreated: number;
  /** Matches skipped because the (tenant, batch, file) record already exists in DB. */
  duplicatesSkipped: number;
  ambiguousMatches: number;
  unmatchedCompanies: string[];
  unmatchedFiles: string[];
}

/**
 * Main match engine. Lists Drive files from the tenant's LEAD_IMPORT_INBOX
 * folder, scores them against every import-batch row that has a company name,
 * and creates CrmLeadDocument records for HIGH / MEDIUM confidence matches.
 *
 * Idempotent: uses createMany with skipDuplicates=true. Running twice does not
 * produce duplicate records or overwrite user review decisions (IMPORT_PENDING /
 * REJECTED). The unique constraint is (tenantId, importBatchId, googleDriveFileId).
 *
 * If auditRowCount is 0 for a non-empty batch, the engine returns a
 * "no_audit_rows" warning — this means CrmImportBatchRow writes failed during
 * import and Drive matching cannot proceed meaningfully.
 */
export async function runDriveMatchForBatch(
  batchId: string,
  tenantId: string,
): Promise<DriveMatchRunResult> {
  // 1. Verify batch belongs to tenant
  const batch = await db.crmImportBatch.findFirst({
    where: { id: batchId, tenantId },
    select: { id: true, totalRows: true, auditErrorCount: true },
  });
  if (!batch) {
    throw new DriveMatchError(
      "batch_not_found",
      "Import batch not found for this tenant.",
    );
  }

  // 2. Load Drive folder config (LEAD_IMPORT_INBOX only)
  const folderConfig = await db.crmDriveFolder.findFirst({
    where: { tenantId, purpose: "LEAD_IMPORT_INBOX" },
    include: { googleConnection: true },
  });
  if (!folderConfig) {
    throw new DriveMatchError(
      "no_drive_folder",
      "No Drive folder configured. Go to CRM → Drive Settings and select a Lead Documents folder first.",
    );
  }

  // 3. List files — listDriveFolderFiles handles token refresh internally.
  //    Tokens are never logged.
  const connection = folderConfig.googleConnection as Parameters<
    typeof listDriveFolderFiles
  >[0];

  // 4. List files from Drive folder (up to 200)
  const { files } = await listDriveFolderFiles(
    connection,
    folderConfig.folderId,
    { maxResults: 200 },
  );

  // 5. Load import rows that have a normalised company name
  const importRows = await db.crmImportBatchRow.findMany({
    where: { batchId, tenantId, companyNameNormalized: { not: null } },
    select: {
      id: true,
      contactId: true,
      companyName: true,
      companyNameNormalized: true,
    },
  });

  const auditRowCount = importRows.length;

  if (files.length === 0) {
    return emptyResult(batchId, 0, auditRowCount);
  }

  // Warn when batch has rows but none have audit records (silent audit failure)
  if (auditRowCount === 0) {
    throw new DriveMatchError(
      "no_audit_rows",
      `Import batch has ${batch.totalRows} rows but no audit records were found. ` +
        "CrmImportBatchRow writes may have failed during import — re-import the file to recover, " +
        "or check server logs for 'crm_import_audit_row_write_failed'.",
    );
  }

  // 6. Score every (importRow × file) pair and keep HIGH/MEDIUM candidates
  type Candidate = {
    rowIdx: number;
    fileIdx: number;
    confidence: MatchConfidence;
    reason: string;
  };
  const candidates: Candidate[] = [];

  for (let ri = 0; ri < importRows.length; ri++) {
    const row = importRows[ri];
    const companyNorm = row.companyNameNormalized!;
    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi];
      const fileNorm = normalizeFileName(file.name);
      const score = scoreMatch(companyNorm, fileNorm);
      if (score.confidence !== "LOW") {
        candidates.push({
          rowIdx: ri,
          fileIdx: fi,
          confidence: score.confidence,
          reason: score.reason,
        });
      }
    }
  }

  // 7. Detect ambiguity
  //    fileIdx → how many rows matched it
  const fileMatchCount = new Map<number, number>();
  //    rowIdx  → how many files matched it
  const rowMatchCount = new Map<number, number>();
  for (const c of candidates) {
    fileMatchCount.set(c.fileIdx, (fileMatchCount.get(c.fileIdx) ?? 0) + 1);
    rowMatchCount.set(c.rowIdx, (rowMatchCount.get(c.rowIdx) ?? 0) + 1);
  }

  // 8. Build createMany payload — dedup within this run by (fileIdx, rowIdx)
  //    The DB unique index (tenantId, importBatchId, googleDriveFileId) provides
  //    cross-run idempotency via skipDuplicates=true.
  const seen = new Set<string>(); // "fileIdx:rowIdx" within this run
  const toCreate: Array<{
    tenantId: string;
    contactId: string | null;
    importBatchId: string;
    source: "GOOGLE_DRIVE";
    googleDriveFileId: string;
    googleDriveFolderId: string;
    originalFileName: string;
    mimeType: string | null;
    sizeBytes: bigint | null;
    matchConfidence: string;
    matchReason: string;
    status: "DISCOVERED";
  }> = [];

  let ambiguousMatches = 0;
  const matchedFileIdxs = new Set<number>();
  const matchedRowIdxs = new Set<number>();

  for (const c of candidates) {
    const key = `${c.fileIdx}:${c.rowIdx}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const file = files[c.fileIdx];
    const row = importRows[c.rowIdx];
    const isAmbiguous =
      (fileMatchCount.get(c.fileIdx) ?? 0) > 1 ||
      (rowMatchCount.get(c.rowIdx) ?? 0) > 1;

    const effectiveConfidence = isAmbiguous ? "AMBIGUOUS" : c.confidence;
    const matchReason = isAmbiguous ? `${c.reason}:ambiguous` : c.reason;

    toCreate.push({
      tenantId,
      contactId: row.contactId ?? null,
      importBatchId: batchId,
      source: "GOOGLE_DRIVE",
      googleDriveFileId: file.id,
      googleDriveFolderId: folderConfig.folderId,
      originalFileName: file.name,
      mimeType: file.mimeType || null,
      sizeBytes: file.size != null ? BigInt(file.size) : null,
      matchConfidence: effectiveConfidence,
      matchReason,
      status: "DISCOVERED",
    });

    if (isAmbiguous) ambiguousMatches++;
    matchedFileIdxs.add(c.fileIdx);
    matchedRowIdxs.add(c.rowIdx);
  }

  // 9. Bulk insert — skipDuplicates prevents re-creating records from a second run.
  //    Existing DISCOVERED records: skipped (no re-score; re-import file to re-score).
  //    Existing IMPORT_PENDING / REJECTED records: preserved — user decisions intact.
  const { count: matchesCreated } = toCreate.length > 0
    ? await db.crmLeadDocument.createMany({ data: toCreate, skipDuplicates: true })
    : { count: 0 };

  const duplicatesSkipped = toCreate.length - matchesCreated;

  const unmatchedCompanies = importRows
    .filter((_, i) => !matchedRowIdxs.has(i))
    .map((r) => r.companyName ?? "")
    .filter(Boolean);

  const unmatchedFiles = files
    .filter((_, i) => !matchedFileIdxs.has(i))
    .map((f) => f.name);

  return {
    batchId,
    filesScanned: files.length,
    auditRowCount,
    rowsWithCompany: auditRowCount,
    matchesCreated,
    duplicatesSkipped,
    ambiguousMatches,
    unmatchedCompanies,
    unmatchedFiles,
  };
}

// ── Error type ────────────────────────────────────────────────────────────────

export class DriveMatchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DriveMatchError";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptyResult(
  batchId: string,
  filesScanned: number,
  auditRowCount: number,
): DriveMatchRunResult {
  return {
    batchId,
    filesScanned,
    auditRowCount,
    rowsWithCompany: auditRowCount,
    matchesCreated: 0,
    duplicatesSkipped: 0,
    ambiguousMatches: 0,
    unmatchedCompanies: [],
    unmatchedFiles: [],
  };
}
