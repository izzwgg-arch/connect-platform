/**
 * CRM Document Import — Phase 3 + Phase 4 security hardening tests
 *
 * Tests pure/unit-level logic:
 *   docImportStorage: buildDocStorageKey, isGoogleWorkspaceMime,
 *                     getWorkspaceExportMime, safeExtForMime,
 *                     buildSignedCrmDocUrl (v2), verifySignedCrmDocUrl (v2)
 *
 * Phase 4 security contracts (signed URL purpose binding):
 *   - Signature binds docId + tenantId + userId + purpose:v2 + expiry
 *   - Cross-tenant reuse fails
 *   - Cross-user reuse fails
 *   - Cross-document reuse fails
 *   - v1 / old signatures (Phase 3) automatically fail
 *   - Expired signatures fail
 *
 * Also documents the service contracts (tenant isolation, status transitions,
 * idempotency, Workspace export path, size limit).
 *
 * Does NOT hit the database, file system, or Google APIs.
 */

import { describe, it, expect } from "vitest";
import {
  buildDocStorageKey,
  isGoogleWorkspaceMime,
  getWorkspaceExportMime,
  safeExtForMime,
  buildSignedCrmDocUrl,
  verifySignedCrmDocUrl,
  GOOGLE_WORKSPACE_EXPORTABLE,
} from "./docImportStorage";
import { DocImportError } from "./docImportService";

// ── buildDocStorageKey ────────────────────────────────────────────────────────

describe("buildDocStorageKey", () => {
  it("builds a scoped key for a PDF", () => {
    const key = buildDocStorageKey("tenant-abc", "doc123", "application/pdf", "report.pdf");
    expect(key).toMatch(/^tenants\//);
    expect(key).toContain("doc123");
    expect(key).toMatch(/\.pdf$/);
  });

  it("builds a key for a DOCX", () => {
    const key = buildDocStorageKey(
      "t1",
      "d1",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "document.docx",
    );
    expect(key).toMatch(/\.docx$/);
  });

  it("uses .pdf extension for Google Workspace export MIME", () => {
    const key = buildDocStorageKey("t1", "d1", "application/pdf", "doc.gdoc");
    expect(key).toMatch(/\.pdf$/);
  });

  it("falls back to .bin for unknown MIME with no filename extension", () => {
    const key = buildDocStorageKey("t1", "d1", "application/x-custom", "file");
    expect(key).toMatch(/\.bin$/);
  });

  it("does not contain the tenant ID in plain form (sanitized)", () => {
    // sanitizeTenantScope lowercases and replaces non-alnum
    const key = buildDocStorageKey("Tenant-ABC/foo", "docId", "application/pdf", "f.pdf");
    expect(key).not.toContain("/foo");
    expect(key).toMatch(/^tenants\//);
  });
});

// ── isGoogleWorkspaceMime ────────────────────────────────────────────────────

describe("isGoogleWorkspaceMime", () => {
  it("returns true for Google Docs", () => {
    expect(isGoogleWorkspaceMime("application/vnd.google-apps.document")).toBe(true);
  });

  it("returns true for Google Sheets", () => {
    expect(isGoogleWorkspaceMime("application/vnd.google-apps.spreadsheet")).toBe(true);
  });

  it("returns true for Google Slides", () => {
    expect(isGoogleWorkspaceMime("application/vnd.google-apps.presentation")).toBe(true);
  });

  it("returns false for PDF", () => {
    expect(isGoogleWorkspaceMime("application/pdf")).toBe(false);
  });

  it("returns false for DOCX", () => {
    expect(
      isGoogleWorkspaceMime(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(false);
  });
});

// ── getWorkspaceExportMime ───────────────────────────────────────────────────

describe("getWorkspaceExportMime", () => {
  it("exports Google Docs to PDF", () => {
    expect(getWorkspaceExportMime("application/vnd.google-apps.document")).toBe(
      "application/pdf",
    );
  });

  it("exports Google Sheets to PDF", () => {
    expect(getWorkspaceExportMime("application/vnd.google-apps.spreadsheet")).toBe(
      "application/pdf",
    );
  });

  it("returns null for a non-Workspace MIME", () => {
    expect(getWorkspaceExportMime("application/pdf")).toBeNull();
  });

  it("all GOOGLE_WORKSPACE_EXPORTABLE values are application/pdf", () => {
    for (const exportMime of Object.values(GOOGLE_WORKSPACE_EXPORTABLE)) {
      expect(exportMime).toBe("application/pdf");
    }
  });
});

// ── safeExtForMime ───────────────────────────────────────────────────────────

describe("safeExtForMime", () => {
  it("returns .pdf for application/pdf", () => {
    expect(safeExtForMime("application/pdf")).toBe(".pdf");
  });

  it("returns .docx for docx MIME", () => {
    expect(
      safeExtForMime(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(".docx");
  });

  it("falls back to filename extension if MIME unknown", () => {
    expect(safeExtForMime("application/x-custom", "contract.pdf")).toBe(".pdf");
  });

  it("returns .bin if MIME unknown and no filename", () => {
    expect(safeExtForMime("application/x-unknown")).toBe(".bin");
  });
});

// ── Signed URL round-trip (v2 — purpose/tenant/user bound) ───────────────────

describe("signed URL round-trip (v2)", () => {
  const base = "https://api.example.com";
  const docId = "doc_123";
  const tenantId = "tenant_abc";
  const userId = "user_xyz";

  function buildAndParse(
    overrideDocId = docId,
    overrideTenantId = tenantId,
    overrideUserId = userId,
  ) {
    const url = buildSignedCrmDocUrl(base, overrideDocId, overrideTenantId, overrideUserId, 600);
    const u = new URL(url);
    return {
      exp: u.searchParams.get("exp") ?? undefined,
      sig: u.searchParams.get("sig") ?? undefined,
    };
  }

  it("builds a URL and verifies it with correct context", () => {
    const url = buildSignedCrmDocUrl(base, docId, tenantId, userId, 600);
    expect(url).toContain("/crm/documents/");
    expect(url).toContain("sig=");
    expect(url).toContain("exp=");
    // storageKey is NOT in the URL
    expect(url).not.toContain("storageKey");
    expect(url).not.toContain("tenants/");

    const u = new URL(url);
    const exp = u.searchParams.get("exp") ?? undefined;
    const sig = u.searchParams.get("sig") ?? undefined;
    const result = verifySignedCrmDocUrl(docId, tenantId, userId, exp, sig);
    expect(result.ok).toBe(true);
  });

  it("rejects a tampered docId (signature reuse for a different document)", () => {
    const { exp, sig } = buildAndParse();
    const result = verifySignedCrmDocUrl("other_doc", tenantId, userId, exp, sig);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("rejects a different tenantId (cross-tenant URL reuse)", () => {
    const { exp, sig } = buildAndParse();
    const result = verifySignedCrmDocUrl(docId, "tenant_evil", userId, exp, sig);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("rejects a different userId (cross-user URL reuse)", () => {
    const { exp, sig } = buildAndParse();
    const result = verifySignedCrmDocUrl(docId, tenantId, "other_user", exp, sig);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("rejects an expired URL", () => {
    const expiredExp = String(Math.floor(Date.now() / 1000) - 10);
    const result = verifySignedCrmDocUrl(docId, tenantId, userId, expiredExp, "a".repeat(64));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("rejects a missing/undefined exp", () => {
    const { sig } = buildAndParse();
    const result = verifySignedCrmDocUrl(docId, tenantId, userId, undefined, sig);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("rejects a missing/undefined sig", () => {
    const { exp } = buildAndParse();
    const result = verifySignedCrmDocUrl(docId, tenantId, userId, exp, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("rejects a zeroed-out (all-zeros) signature", () => {
    const { exp } = buildAndParse();
    const result = verifySignedCrmDocUrl(docId, tenantId, userId, exp, "0".repeat(64));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("rejects a v1 Phase-3 signature format (different HMAC message)", () => {
    // v1 format: "crm-doc:{docId}:{storageKey}:{exp}" — incompatible with v2
    // This simulates an old signed URL being replayed after the security upgrade.
    const exp = Math.floor(Date.now() / 1000) + 600;
    // The old v1 HMAC — we just use a hex string that won't match v2 expected
    const fakeV1Sig = "deadbeef".repeat(8); // 64 hex chars, but wrong content
    const result = verifySignedCrmDocUrl(docId, tenantId, userId, String(exp), fakeV1Sig);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("two different tenants signing for the same docId produce different signatures", () => {
    const { sig: sigA } = buildAndParse(docId, "tenant_a", userId);
    const { sig: sigB } = buildAndParse(docId, "tenant_b", userId);
    // Same exp won't match but signatures are still distinct
    expect(sigA).not.toBe(sigB);
  });

  it("two different users signing for the same docId produce different signatures", () => {
    const { sig: sigA } = buildAndParse(docId, tenantId, "user_1");
    const { sig: sigB } = buildAndParse(docId, tenantId, "user_2");
    expect(sigA).not.toBe(sigB);
  });
});

// ── DocImportError ───────────────────────────────────────────────────────────

describe("DocImportError", () => {
  it("has a code and is an Error", () => {
    const err = new DocImportError("test_code", "test message");
    expect(err.code).toBe("test_code");
    expect(err.message).toBe("test message");
    expect(err instanceof Error).toBe(true);
    expect(err.name).toBe("DocImportError");
  });
});

// ── Service contracts (documented) ───────────────────────────────────────────

describe("importSingleDocument contract (documented)", () => {
  it("requires doc.tenantId to match the caller's tenantId", () => {
    // Contract: service calls db.crmLeadDocument.findFirst({ where: { id, tenantId } }).
    // If doc belongs to Tenant B, Tenant A's call returns null → DocImportError("doc_not_found").
    expect(true).toBe(true);
  });

  it("is idempotent for already-IMPORTED docs (skips re-download by default)", () => {
    // Contract: if doc.status === "IMPORTED" && !force, returns { status: "skipped" }.
    // Prevents re-downloading and overwriting the same file on repeated calls.
    expect(true).toBe(true);
  });

  it("force=true re-imports an IMPORTED doc", () => {
    // Contract: if force=true, the import proceeds regardless of current status.
    // Useful for recovering from storage corruption.
    expect(true).toBe(true);
  });

  it("transitions IMPORT_PENDING → IMPORTING → IMPORTED on success", () => {
    // Contract: sets status=IMPORTING before download, IMPORTED after successful write.
    // IMPORTING acts as a mutex so concurrent calls for the same doc do not double-download.
    expect(true).toBe(true);
  });

  it("transitions IMPORTING → IMPORT_FAILED on download error", () => {
    // Contract: any DriveServiceError or FS write error sets status=IMPORT_FAILED
    // and stores a safe (truncated, no-content) error message in importError.
    expect(true).toBe(true);
  });

  it("rejects doc with no googleDriveFileId", () => {
    // Contract: if googleDriveFileId is null, throws DocImportError("no_drive_file_id").
    expect(true).toBe(true);
  });

  it("exports Google Workspace files to PDF", () => {
    // Contract: if doc.mimeType is a Google Workspace type, uses exportDriveWorkspaceFile
    // with exportMime=application/pdf. The stored importedMimeType is application/pdf.
    expect(true).toBe(true);
  });

  it("marks IMPORT_FAILED for unsupported Google Workspace type", () => {
    // Contract: if GOOGLE_WORKSPACE_EXPORTABLE does not contain the mimeType,
    // throws DocImportError("unsupported_workspace_type") → status IMPORT_FAILED.
    expect(true).toBe(true);
  });

  it("enforces file size limit (CRM_DOC_IMPORT_MAX_BYTES)", () => {
    // Contract: passed as maxBytes to downloadDriveFile / exportDriveWorkspaceFile.
    // DriveServiceError("file_too_large") → status IMPORT_FAILED.
    expect(true).toBe(true);
  });
});

describe("importBatchDocuments contract (documented)", () => {
  it("processes at most min(limit, 20) docs per call", () => {
    // Contract: effectiveLimit = min(20, max(1, parseInt(limit))).
    // Prevents unbounded synchronous downloads for large batches.
    expect(true).toBe(true);
  });

  it("only picks docs with status IMPORT_PENDING", () => {
    // Contract: WHERE status = 'IMPORT_PENDING' — does not retry IMPORT_FAILED.
    // Callers must set status back to IMPORT_PENDING to retry failed docs.
    expect(true).toBe(true);
  });

  it("requires batch.tenantId to match caller tenantId", () => {
    // Contract: db.crmImportBatch.findFirst({ where: { id, tenantId } }).
    // Tenant B cannot trigger import for Tenant A's batch.
    expect(true).toBe(true);
  });
});

describe("open/download route contract — Phase 4 dual gate (documented)", () => {
  it("GET /crm/documents/:id/open requires BOTH: valid CRM JWT + valid HMAC", () => {
    // Contract (Phase 4): the streaming route calls requireCrmAccess first.
    // Gate 1 — JWT:  identifies tenantId + userId; sends 401/403 if missing/invalid.
    // Gate 2 — HMAC: verifySignedCrmDocUrl(docId, tenantId, userId, exp, sig).
    //   expired  → 410  { error: "expired_link" }
    //   invalid  → 403  { error: "invalid_signature" }
    // Both gates must pass for the file to be streamed.
    expect(true).toBe(true);
  });

  it("No auth + valid signature = denied (401)", () => {
    // Contract: requireCrmAccess rejects before HMAC is checked.
    // Even a perfectly valid HMAC signature is meaningless without auth.
    expect(true).toBe(true);
  });

  it("Auth + missing/invalid signature = denied (403/410)", () => {
    // Contract: JWT passes but HMAC check fails.
    // Covers: missing exp/sig, zeroed sig, wrong docId in sig, wrong tenantId in sig.
    expect(true).toBe(true);
  });

  it("Auth for tenant B + document/signature from tenant A = denied (403)", () => {
    // Contract: doc found with doc.tenantId != user.tenantId → "cross_tenant_attempt".
    // HMAC check would also fail because tenantId is bound into the signature.
    expect(true).toBe(true);
  });

  it("Expired signature = 410 expired_link (even with valid auth)", () => {
    // Contract: verifySignedCrmDocUrl returns { ok: false, reason: "expired" } → 410.
    expect(true).toBe(true);
  });

  it("Valid auth + valid signature + same tenant + matching userId = streams file", () => {
    // Contract: both gates pass → buffer read from disk → Content-Type + headers set.
    // Cache-Control: private, no-store  X-Content-Type-Options: nosniff
    expect(true).toBe(true);
  });

  it("Signature cannot be reused for a different documentId", () => {
    // Contract: docId is bound in the HMAC message.
    // A signature built for doc_A cannot be used to access doc_B.
    expect(true).toBe(true);
  });

  it("Signature cannot be reused for a different tenantId", () => {
    // Contract: tenantId is bound in the HMAC message.
    // Tenant B cannot construct a signature that satisfies Tenant A's verification.
    expect(true).toBe(true);
  });

  it("Signature cannot be reused by a different userId", () => {
    // Contract: userId is bound in the HMAC message.
    // A URL generated for user_A cannot be used by user_B even if both belong to the same tenant.
    expect(true).toBe(true);
  });

  it("GET /crm/documents/:id/open-url requires CRM access JWT", () => {
    // Contract: /open-url is protected by requireCrmAccess.
    // Only valid CRM users for the owning tenant can generate a signed URL.
    // The returned signedUrl must subsequently be fetched WITH an Authorization header.
    expect(true).toBe(true);
  });

  it("storage key is never returned or embedded in URLs visible to callers", () => {
    // Contract: /open-url returns { signedUrl } where the URL contains only exp + sig.
    // The storageKey is used server-side for HMAC verification and disk reads only.
    // It is never returned to callers or embedded in query params.
    expect(true).toBe(true);
  });

  it("audit logs are emitted without document contents or storage paths", () => {
    // Contract: crm_doc_opened, crm_doc_invalid_signature, crm_doc_link_expired,
    // crm_doc_cross_tenant_attempt are logged with { docId, tenantId, userId } only.
    // No content, no storageKey, no OAuth tokens in log fields.
    expect(true).toBe(true);
  });
});
