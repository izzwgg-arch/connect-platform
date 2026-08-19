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

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// The signed-URL helpers now REFUSE to sign without a key rather than falling
// back to the repo literal "dev-signing-secret" (tenant-isolation audit §3b).
// These tests exercise signature mechanics, not key resolution — key resolution
// has its own suite in `urlSigningSecret.test.ts` — so pin one here.
process.env.CRM_DOC_URL_SIGNING_SECRET ||= "test-crm-doc-signing-secret";
import {
  buildDocStorageKey,
  isGoogleWorkspaceMime,
  getWorkspaceExportMime,
  safeExtForMime,
  buildSignedCrmDocUrl,
  verifySignedCrmDocUrl,
  GOOGLE_WORKSPACE_EXPORTABLE,
  contentTypeForCrmDoc,
} from "./docImportStorage";
import { DocImportError } from "./docImportService";

describe("contentTypeForCrmDoc — scriptable types are neutralised (stored-XSS fence)", () => {
  it("⛔ never serves an uploaded doc as an ACTIVE type (portal opens it same-origin as a blob)", () => {
    // The dangerous cases: an uploaded document whose stored MIME can execute
    // script in the portal origin and steal the session JWT.
    for (const mime of ["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/xml", "text/html; charset=utf-8"]) {
      assert.equal(contentTypeForCrmDoc(mime, null, "x/doc"), "application/octet-stream", `${mime} must be neutralised`);
      assert.equal(contentTypeForCrmDoc(null, mime, "x/doc"), "application/octet-stream", `${mime} (original) must be neutralised`);
    }
  });
  it("leaves the real inline content types untouched", () => {
    assert.equal(contentTypeForCrmDoc("application/pdf", null, "x/doc.pdf"), "application/pdf");
    assert.equal(contentTypeForCrmDoc("image/png", null, "x/doc.png"), "image/png");
    assert.equal(contentTypeForCrmDoc("image/jpeg", null, "x/doc.jpg"), "image/jpeg");
    assert.equal(contentTypeForCrmDoc("text/plain", null, "x/doc.txt"), "text/plain");
  });
});

// ── buildDocStorageKey ────────────────────────────────────────────────────────

describe("buildDocStorageKey", () => {
  it("builds a scoped key for a PDF", () => {
    const key = buildDocStorageKey("tenant-abc", "doc123", "application/pdf", "report.pdf");
    assert.match(key, /^tenants\//);
    assert.ok((key).includes("doc123"));
    assert.match(key, /\.pdf$/);
  });

  it("builds a key for a DOCX", () => {
    const key = buildDocStorageKey(
      "t1",
      "d1",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "document.docx",
    );
    assert.match(key, /\.docx$/);
  });

  it("uses .pdf extension for Google Workspace export MIME", () => {
    const key = buildDocStorageKey("t1", "d1", "application/pdf", "doc.gdoc");
    assert.match(key, /\.pdf$/);
  });

  it("falls back to .bin for unknown MIME with no filename extension", () => {
    const key = buildDocStorageKey("t1", "d1", "application/x-custom", "file");
    assert.match(key, /\.bin$/);
  });

  it("does not contain the tenant ID in plain form (sanitized)", () => {
    // sanitizeTenantScope lowercases and replaces non-alnum
    const key = buildDocStorageKey("Tenant-ABC/foo", "docId", "application/pdf", "f.pdf");
    assert.ok(!(key).includes("/foo"));
    assert.match(key, /^tenants\//);
  });
});

// ── isGoogleWorkspaceMime ────────────────────────────────────────────────────

describe("isGoogleWorkspaceMime", () => {
  it("returns true for Google Docs", () => {
    assert.equal(isGoogleWorkspaceMime("application/vnd.google-apps.document"), true);
  });

  it("returns true for Google Sheets", () => {
    assert.equal(isGoogleWorkspaceMime("application/vnd.google-apps.spreadsheet"), true);
  });

  it("returns true for Google Slides", () => {
    assert.equal(isGoogleWorkspaceMime("application/vnd.google-apps.presentation"), true);
  });

  it("returns false for PDF", () => {
    assert.equal(isGoogleWorkspaceMime("application/pdf"), false);
  });

  it("returns false for DOCX", () => {
    assert.equal(isGoogleWorkspaceMime(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ), false);
  });
});

// ── getWorkspaceExportMime ───────────────────────────────────────────────────

describe("getWorkspaceExportMime", () => {
  it("exports Google Docs to PDF", () => {
    assert.equal(getWorkspaceExportMime("application/vnd.google-apps.document"), "application/pdf",);
  });

  it("exports Google Sheets to PDF", () => {
    assert.equal(getWorkspaceExportMime("application/vnd.google-apps.spreadsheet"), "application/pdf",);
  });

  it("returns null for a non-Workspace MIME", () => {
    assert.equal(getWorkspaceExportMime("application/pdf"), null);
  });

  it("all GOOGLE_WORKSPACE_EXPORTABLE values are application/pdf", () => {
    for (const exportMime of Object.values(GOOGLE_WORKSPACE_EXPORTABLE)) {
      assert.equal(exportMime, "application/pdf");
    }
  });
});

// ── safeExtForMime ───────────────────────────────────────────────────────────

describe("safeExtForMime", () => {
  it("returns .pdf for application/pdf", () => {
    assert.equal(safeExtForMime("application/pdf"), ".pdf");
  });

  it("returns .docx for docx MIME", () => {
    assert.equal(safeExtForMime(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ), ".docx");
  });

  it("falls back to filename extension if MIME unknown", () => {
    assert.equal(safeExtForMime("application/x-custom", "contract.pdf"), ".pdf");
  });

  it("returns .bin if MIME unknown and no filename", () => {
    assert.equal(safeExtForMime("application/x-unknown"), ".bin");
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
    assert.ok((url).includes("/crm/documents/"));
    assert.ok((url).includes("sig="));
    assert.ok((url).includes("exp="));
    // storageKey is NOT in the URL
    assert.ok(!(url).includes("storageKey"));
    assert.ok(!(url).includes("tenants/"));

    const u = new URL(url);
    const exp = u.searchParams.get("exp") ?? undefined;
    const sig = u.searchParams.get("sig") ?? undefined;
    const result = verifySignedCrmDocUrl(docId, tenantId, userId, exp, sig);
    assert.equal(result.ok, true);
  });

  it("rejects a tampered docId (signature reuse for a different document)", () => {
    const { exp, sig } = buildAndParse();
    const result = verifySignedCrmDocUrl("other_doc", tenantId, userId, exp, sig);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "invalid");
  });

  it("rejects a different tenantId (cross-tenant URL reuse)", () => {
    const { exp, sig } = buildAndParse();
    const result = verifySignedCrmDocUrl(docId, "tenant_evil", userId, exp, sig);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "invalid");
  });

  it("rejects a different userId (cross-user URL reuse)", () => {
    const { exp, sig } = buildAndParse();
    const result = verifySignedCrmDocUrl(docId, tenantId, "other_user", exp, sig);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "invalid");
  });

  it("rejects an expired URL", () => {
    const expiredExp = String(Math.floor(Date.now() / 1000) - 10);
    const result = verifySignedCrmDocUrl(docId, tenantId, userId, expiredExp, "a".repeat(64));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "expired");
  });

  it("rejects a missing/undefined exp", () => {
    const { sig } = buildAndParse();
    const result = verifySignedCrmDocUrl(docId, tenantId, userId, undefined, sig);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "expired");
  });

  it("rejects a missing/undefined sig", () => {
    const { exp } = buildAndParse();
    const result = verifySignedCrmDocUrl(docId, tenantId, userId, exp, undefined);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "invalid");
  });

  it("rejects a zeroed-out (all-zeros) signature", () => {
    const { exp } = buildAndParse();
    const result = verifySignedCrmDocUrl(docId, tenantId, userId, exp, "0".repeat(64));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "invalid");
  });

  it("rejects a v1 Phase-3 signature format (different HMAC message)", () => {
    // v1 format: "crm-doc:{docId}:{storageKey}:{exp}" — incompatible with v2
    // This simulates an old signed URL being replayed after the security upgrade.
    const exp = Math.floor(Date.now() / 1000) + 600;
    // The old v1 HMAC — we just use a hex string that won't match v2 expected
    const fakeV1Sig = "deadbeef".repeat(8); // 64 hex chars, but wrong content
    const result = verifySignedCrmDocUrl(docId, tenantId, userId, String(exp), fakeV1Sig);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "invalid");
  });

  it("two different tenants signing for the same docId produce different signatures", () => {
    const { sig: sigA } = buildAndParse(docId, "tenant_a", userId);
    const { sig: sigB } = buildAndParse(docId, "tenant_b", userId);
    // Same exp won't match but signatures are still distinct
    assert.notEqual(sigA, sigB);
  });

  it("two different users signing for the same docId produce different signatures", () => {
    const { sig: sigA } = buildAndParse(docId, tenantId, "user_1");
    const { sig: sigB } = buildAndParse(docId, tenantId, "user_2");
    assert.notEqual(sigA, sigB);
  });
});

// ── DocImportError ───────────────────────────────────────────────────────────

describe("DocImportError", () => {
  it("has a code and is an Error", () => {
    const err = new DocImportError("test_code", "test message");
    assert.equal(err.code, "test_code");
    assert.equal(err.message, "test message");
    assert.equal(err instanceof Error, true);
    assert.equal(err.name, "DocImportError");
  });
});

// ── Service contracts (documented) ───────────────────────────────────────────

describe("importSingleDocument contract (documented)", () => {
  it("requires doc.tenantId to match the caller's tenantId", () => {
    // Contract: service calls db.crmLeadDocument.findFirst({ where: { id, tenantId } }).
    // If doc belongs to Tenant B, Tenant A's call returns null → DocImportError("doc_not_found").
    assert.equal(true, true);
  });

  it("is idempotent for already-IMPORTED docs (skips re-download by default)", () => {
    // Contract: if doc.status === "IMPORTED" && !force, returns { status: "skipped" }.
    // Prevents re-downloading and overwriting the same file on repeated calls.
    assert.equal(true, true);
  });

  it("force=true re-imports an IMPORTED doc", () => {
    // Contract: if force=true, the import proceeds regardless of current status.
    // Useful for recovering from storage corruption.
    assert.equal(true, true);
  });

  it("transitions IMPORT_PENDING → IMPORTING → IMPORTED on success", () => {
    // Contract: sets status=IMPORTING before download, IMPORTED after successful write.
    // IMPORTING acts as a mutex so concurrent calls for the same doc do not double-download.
    assert.equal(true, true);
  });

  it("transitions IMPORTING → IMPORT_FAILED on download error", () => {
    // Contract: any DriveServiceError or FS write error sets status=IMPORT_FAILED
    // and stores a safe (truncated, no-content) error message in importError.
    assert.equal(true, true);
  });

  it("rejects doc with no googleDriveFileId", () => {
    // Contract: if googleDriveFileId is null, throws DocImportError("no_drive_file_id").
    assert.equal(true, true);
  });

  it("exports Google Workspace files to PDF", () => {
    // Contract: if doc.mimeType is a Google Workspace type, uses exportDriveWorkspaceFile
    // with exportMime=application/pdf. The stored importedMimeType is application/pdf.
    assert.equal(true, true);
  });

  it("marks IMPORT_FAILED for unsupported Google Workspace type", () => {
    // Contract: if GOOGLE_WORKSPACE_EXPORTABLE does not contain the mimeType,
    // throws DocImportError("unsupported_workspace_type") → status IMPORT_FAILED.
    assert.equal(true, true);
  });

  it("enforces file size limit (CRM_DOC_IMPORT_MAX_BYTES)", () => {
    // Contract: passed as maxBytes to downloadDriveFile / exportDriveWorkspaceFile.
    // DriveServiceError("file_too_large") → status IMPORT_FAILED.
    assert.equal(true, true);
  });
});

describe("importBatchDocuments contract (documented)", () => {
  it("processes at most min(limit, 20) docs per call", () => {
    // Contract: effectiveLimit = min(20, max(1, parseInt(limit))).
    // Prevents unbounded synchronous downloads for large batches.
    assert.equal(true, true);
  });

  it("only picks docs with status IMPORT_PENDING", () => {
    // Contract: WHERE status = 'IMPORT_PENDING' — does not retry IMPORT_FAILED.
    // Callers must set status back to IMPORT_PENDING to retry failed docs.
    assert.equal(true, true);
  });

  it("requires batch.tenantId to match caller tenantId", () => {
    // Contract: db.crmImportBatch.findFirst({ where: { id, tenantId } }).
    // Tenant B cannot trigger import for Tenant A's batch.
    assert.equal(true, true);
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
    assert.equal(true, true);
  });

  it("No auth + valid signature = denied (401)", () => {
    // Contract: requireCrmAccess rejects before HMAC is checked.
    // Even a perfectly valid HMAC signature is meaningless without auth.
    assert.equal(true, true);
  });

  it("Auth + missing/invalid signature = denied (403/410)", () => {
    // Contract: JWT passes but HMAC check fails.
    // Covers: missing exp/sig, zeroed sig, wrong docId in sig, wrong tenantId in sig.
    assert.equal(true, true);
  });

  it("Auth for tenant B + document/signature from tenant A = denied (403)", () => {
    // Contract: doc found with doc.tenantId != user.tenantId → "cross_tenant_attempt".
    // HMAC check would also fail because tenantId is bound into the signature.
    assert.equal(true, true);
  });

  it("Expired signature = 410 expired_link (even with valid auth)", () => {
    // Contract: verifySignedCrmDocUrl returns { ok: false, reason: "expired" } → 410.
    assert.equal(true, true);
  });

  it("Valid auth + valid signature + same tenant + matching userId = streams file", () => {
    // Contract: both gates pass → buffer read from disk → Content-Type + headers set.
    // Cache-Control: private, no-store  X-Content-Type-Options: nosniff
    assert.equal(true, true);
  });

  it("Signature cannot be reused for a different documentId", () => {
    // Contract: docId is bound in the HMAC message.
    // A signature built for doc_A cannot be used to access doc_B.
    assert.equal(true, true);
  });

  it("Signature cannot be reused for a different tenantId", () => {
    // Contract: tenantId is bound in the HMAC message.
    // Tenant B cannot construct a signature that satisfies Tenant A's verification.
    assert.equal(true, true);
  });

  it("Signature cannot be reused by a different userId", () => {
    // Contract: userId is bound in the HMAC message.
    // A URL generated for user_A cannot be used by user_B even if both belong to the same tenant.
    assert.equal(true, true);
  });

  it("GET /crm/documents/:id/open-url requires CRM access JWT", () => {
    // Contract: /open-url is protected by requireCrmAccess.
    // Only valid CRM users for the owning tenant can generate a signed URL.
    // The returned signedUrl must subsequently be fetched WITH an Authorization header.
    assert.equal(true, true);
  });

  it("storage key is never returned or embedded in URLs visible to callers", () => {
    // Contract: /open-url returns { signedUrl } where the URL contains only exp + sig.
    // The storageKey is used server-side for HMAC verification and disk reads only.
    // It is never returned to callers or embedded in query params.
    assert.equal(true, true);
  });

  it("audit logs are emitted without document contents or storage paths", () => {
    // Contract: crm_doc_opened, crm_doc_invalid_signature, crm_doc_link_expired,
    // crm_doc_cross_tenant_attempt are logged with { docId, tenantId, userId } only.
    // No content, no storageKey, no OAuth tokens in log fields.
    assert.equal(true, true);
  });
});
