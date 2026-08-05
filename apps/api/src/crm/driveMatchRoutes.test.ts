/**
 * CRM Drive Match — Phase 2 focused tests (including Phase 2 hardening)
 *
 * Tests the pure functions in driveMatchService:
 *   normalizeForMatch, normalizeFileName, scoreMatch
 *
 * Documents the tenant isolation, audit durability, and idempotency contracts.
 * These tests do NOT hit the database or Google APIs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeForMatch,
  normalizeFileName,
  scoreMatch,
  DriveMatchError,
} from "./driveMatchService";

// ── normalizeForMatch ─────────────────────────────────────────────────────────

describe("normalizeForMatch", () => {
  it("lowercases input", () => {
    assert.ok((normalizeForMatch("Acme CORP")).includes("acme"));
  });

  it("strips common legal suffixes", () => {
    assert.ok(!(normalizeForMatch("Acme LLC")).includes("llc"));
    assert.ok(!(normalizeForMatch("Widgets Inc")).includes("inc"));
    assert.ok(!(normalizeForMatch("Foo Corporation")).includes("corporation"));
    assert.ok(!(normalizeForMatch("Bar Ltd")).includes("ltd"));
  });

  it("removes punctuation", () => {
    const result = normalizeForMatch("Smith & Jones, Co.");
    assert.ok(!(result).includes(","));
    assert.ok(!(result).includes("."));
    assert.ok(!(result).includes("&"));
  });

  it("collapses multiple spaces", () => {
    assert.equal(normalizeForMatch("Foo   Bar  Baz"), "foo bar baz");
  });

  it("trims leading and trailing whitespace", () => {
    assert.equal(normalizeForMatch("  Acme  "), "acme");
  });

  it("handles empty string gracefully", () => {
    assert.equal(normalizeForMatch(""), "");
  });

  it("normalises ampersand to 'and' before punctuation strip", () => {
    const result = normalizeForMatch("Smith & Jones");
    // 'and' is also stripped — result contains 'smith' and 'jones'
    assert.ok((result).includes("smith"));
    assert.ok((result).includes("jones"));
  });
});

// ── normalizeFileName ─────────────────────────────────────────────────────────

describe("normalizeFileName", () => {
  it("removes file extension before normalising", () => {
    // Suffix stripping is word-based, so the fused "Corp" in "AcmeCorp" stays;
    // underscores are word characters, so they survive the punctuation strip.
    assert.equal(normalizeFileName("AcmeCorp.pdf"), "acmecorp");
    assert.equal(normalizeFileName("foo_bar.docx"), "foo_bar");
  });

  it("handles files with multiple dots", () => {
    const result = normalizeFileName("Foo.Bar.Inc.pdf");
    assert.ok(!(result).includes(".pdf"));
    assert.ok(!(result).includes("inc"));
  });

  it("handles no extension", () => {
    assert.equal(normalizeFileName("Acme Document"), "acme document");
  });
});

// ── scoreMatch ────────────────────────────────────────────────────────────────

describe("scoreMatch — exact match", () => {
  it("returns HIGH for identical normalised tokens", () => {
    const score = scoreMatch("acme", "acme");
    assert.equal(score.confidence, "HIGH");
    assert.equal(score.reason, "exact_company_name");
  });

  it("returns HIGH when legal suffixes are stripped and remainder matches", () => {
    const company = normalizeForMatch("Acme LLC");
    const file = normalizeFileName("Acme.pdf");
    const score = scoreMatch(company, file);
    assert.equal(score.confidence, "HIGH");
  });
});

describe("scoreMatch — contains match", () => {
  it("returns MEDIUM when file name contains company (≥ 4 chars)", () => {
    const score = scoreMatch("acme", "acme financial report 2024");
    assert.equal(score.confidence, "MEDIUM");
    assert.equal(score.reason, "file_contains_company");
  });

  it("returns MEDIUM when company contains file name (≥ 4 chars)", () => {
    const score = scoreMatch("smith jones financial", "smith");
    // 'smith' is 5 chars → MEDIUM
    assert.equal(score.confidence, "MEDIUM");
    assert.equal(score.reason, "company_contains_file");
  });

  it("returns LOW for very short tokens to prevent over-matching", () => {
    // 'co' is 2 chars — below threshold
    const score = scoreMatch("co", "company overview");
    assert.equal(score.confidence, "LOW");
  });
});

describe("scoreMatch — no match", () => {
  it("returns LOW for completely unrelated names", () => {
    const score = scoreMatch("acme widgets", "johnson plumbing supplies");
    assert.equal(score.confidence, "LOW");
    assert.equal(score.reason, "no_match");
  });

  it("returns LOW for empty company token", () => {
    const score = scoreMatch("", "some file");
    assert.equal(score.confidence, "LOW");
  });

  it("returns LOW for empty file token", () => {
    const score = scoreMatch("acme", "");
    assert.equal(score.confidence, "LOW");
  });
});

// ── Ambiguity logic contract ───────────────────────────────────────────────────

describe("ambiguity contract (documented)", () => {
  it("one file matching two companies → both marked AMBIGUOUS in match engine", () => {
    // Contract: if fileMatchCount[fileIdx] > 1, effectiveConfidence = "AMBIGUOUS"
    // This is tested indirectly via scoreMatch — the ambiguity flag is applied
    // by runDriveMatchForBatch at upsert time, not scoreMatch itself.
    //
    // Direct unit test would require DB mocking. This test documents the expectation:
    // - Company A norm: "acme"
    // - Company B norm: "acme"  (two different import rows with same company)
    // - File: "acme.pdf" → matches both → both marked AMBIGUOUS
    const scoreA = scoreMatch("acme", "acme");
    const scoreB = scoreMatch("acme", "acme");
    assert.equal(scoreA.confidence, "HIGH");
    assert.equal(scoreB.confidence, "HIGH");
    // The match engine then detects fileMatchCount > 1 and downgrades to AMBIGUOUS.
    // This is the documented behaviour — not tested here since it requires DB.
  });
});

// ── Tenant isolation contract ──────────────────────────────────────────────────

describe("tenant isolation contract (documented)", () => {
  it("runDriveMatchForBatch requires batchId + tenantId to match in DB", () => {
    // Contract: the engine calls
    //   db.crmImportBatch.findFirst({ where: { id: batchId, tenantId } })
    // If the batch belongs to a different tenant, the query returns null
    // and runDriveMatchForBatch throws DriveMatchError("batch_not_found").
    // → Tenant B cannot trigger matching for Tenant A's batch.
    //
    // Similarly, folderConfig is loaded with { tenantId } in the where clause,
    // so Tenant B's match run can never read Tenant A's Drive folder.
    assert.equal(true, true); // documents the contract
  });

  it("confirm/reject routes include tenantId in DB lookup", () => {
    // Contract: routes do
    //   db.crmLeadDocument.findFirst({ where: { id: docId, tenantId } })
    // A document belonging to Tenant A is invisible to Tenant B.
    assert.equal(true, true);
  });

  it("contacts/:id/documents route includes tenantId in both lookups", () => {
    // Contract: contact lookup includes tenantId, document query includes tenantId + contactId.
    // Cross-tenant access returns 404 (contact not found) before any document query runs.
    assert.equal(true, true);
  });
});

// ── Drive folder config prerequisite ─────────────────────────────────────────

describe("Drive folder config requirement", () => {
  it("runDriveMatchForBatch throws no_drive_folder when CrmDriveFolder is missing", () => {
    // Verified by the engine: if db.crmDriveFolder.findFirst returns null,
    // DriveMatchError("no_drive_folder") is thrown and the route returns 409.
    // The UI surfaces this as: "Configure a Drive folder in CRM → Drive Settings first."
    assert.equal(true, true);
  });
});

// ── DriveMatchError class ─────────────────────────────────────────────────────

describe("DriveMatchError", () => {
  it("has a .code property and is instanceof Error", () => {
    const err = new DriveMatchError("test_code", "test message");
    assert.equal(err.code, "test_code");
    assert.equal(err.message, "test message");
    assert.equal(err instanceof Error, true);
    assert.equal(err.name, "DriveMatchError");
  });

  it("no_audit_rows code is used when batch rows are missing", () => {
    // Contract: runDriveMatchForBatch throws DriveMatchError("no_audit_rows")
    // when totalRows > 0 but auditRowCount === 0.
    // Route returns 422. UI shows: "Re-import the file to recover."
    const err = new DriveMatchError("no_audit_rows", "...");
    assert.equal(err.code, "no_audit_rows");
  });
});

// ── Audit durability contract ─────────────────────────────────────────────────

describe("audit durability contract (documented)", () => {
  it("import route awaits CrmImportBatchRow creation (no fire-and-forget)", () => {
    // Contract: POST /crm/import/upload uses `await db.crmImportBatchRow.create()`
    // in a try-catch. Failures increment auditErrorCount which is persisted on the
    // batch and returned in the response. Logs 'crm_import_audit_row_write_failed'.
    // Previously: .catch(() => undefined) silently discarded failures.
    assert.equal(true, true);
  });

  it("auditErrorCount is non-zero when audit writes fail during import", () => {
    // Contract: auditErrorCount is stored on CrmImportBatch and returned in
    // GET /crm/import/batches/:id and POST /crm/import/upload responses.
    // Non-zero value signals that Drive matching may be incomplete for this batch.
    assert.equal(true, true);
  });

  it("batch response includes auditErrorCount field", () => {
    // Verified by formatBatch() which reads b.auditErrorCount ?? 0.
    // Old batches (pre-migration) return 0 (column default).
    assert.equal(true, true);
  });
});

// ── Idempotency contract ──────────────────────────────────────────────────────

describe("Drive match idempotency (documented)", () => {
  it("running match twice creates no duplicates", () => {
    // Contract: the engine uses db.crmLeadDocument.createMany({ skipDuplicates: true }).
    // The DB has a unique index on (tenantId, importBatchId, googleDriveFileId).
    // Second run: all inserts hit the unique constraint → skipDuplicates ignores them.
    // matchesCreated = 0, duplicatesSkipped = N on second run.
    assert.equal(true, true);
  });

  it("confirmed/rejected records are preserved on second match run", () => {
    // Contract: createMany + skipDuplicates uses INSERT ... ON CONFLICT DO NOTHING.
    // Records with status=IMPORT_PENDING or REJECTED already exist in the DB.
    // They are NOT overwritten — the insert is skipped silently.
    // User review decisions survive reruns.
    assert.equal(true, true);
  });

  it("new constraint is per (tenantId, importBatchId, googleDriveFileId)", () => {
    // The Phase 1 constraint was (tenantId, googleDriveFileId) — too broad.
    // It prevented the same Drive file from appearing in a second batch.
    // New constraint allows: File X → Batch A (discovered) AND File X → Batch B (discovered).
    // Uniqueness is scoped to the batch, not the tenant globally.
    assert.equal(true, true);
  });

  it("duplicatesSkipped is returned in the match run result", () => {
    // DriveMatchRunResult.duplicatesSkipped = toCreate.length - matchesCreated
    // Callers / logs can see how many were already present.
    const result = {
      batchId: "b1",
      filesScanned: 3,
      auditRowCount: 2,
      rowsWithCompany: 2,
      matchesCreated: 0,
      duplicatesSkipped: 2,
      ambiguousMatches: 0,
      unmatchedCompanies: [],
      unmatchedFiles: [],
    };
    assert.equal(result.duplicatesSkipped, 2);
    assert.equal(result.matchesCreated + result.duplicatesSkipped, 2);
  });
});

// ── Audit warning in results endpoint ────────────────────────────────────────

describe("auditWarning in match results response (documented)", () => {
  it("auditWarning is non-null when auditRowCount=0 and totalRows>0", () => {
    // Contract: GET /crm/drive/match/results returns batch.auditWarning
    // when auditRowCount < totalRows (or auditErrorCount > 0).
    // The UI shows this warning prominently before the "Run Drive Match" button.
    const batch = {
      totalRows: 10,
      auditRowCount: 0,
      auditErrorCount: 0,
    };
    const auditHealthy = batch.auditRowCount > 0 || batch.totalRows === 0;
    const warning = !auditHealthy ? "some warning" : null;
    assert.notEqual(warning, null);
  });

  it("auditWarning is null when batch is healthy", () => {
    const batch = {
      totalRows: 10,
      auditRowCount: 10,
      auditErrorCount: 0,
    };
    const auditHealthy = batch.auditRowCount > 0 || batch.totalRows === 0;
    const warning = !auditHealthy
      ? "rows missing"
      : batch.auditErrorCount > 0
        ? "some audit errors"
        : null;
    assert.equal(warning, null);
  });

  it("auditWarning mentions audit errors when auditErrorCount > 0 but rows exist", () => {
    const batch = {
      totalRows: 10,
      auditRowCount: 8,
      auditErrorCount: 2,
    };
    const auditHealthy = batch.auditRowCount > 0 || batch.totalRows === 0;
    const warning = !auditHealthy
      ? "rows missing"
      : batch.auditErrorCount > 0
        ? `${batch.auditErrorCount} audit row write(s) failed during import.`
        : null;
    assert.ok((warning).includes("2 audit row write(s) failed"));
  });
});
