"use client";

import { useCallback, useEffect, useRef, useState, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { FileUp, CheckCircle, AlertCircle, Clock, ChevronDown, ChevronUp, X } from "lucide-react";
import { PageHeader } from "../../../../components/PageHeader";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { apiGet, ApiError } from "../../../../services/apiClient";

// ── Types ─────────────────────────────────────────────────────────────────────

type BatchStatus = "PENDING" | "PROCESSING" | "DONE" | "PARTIAL" | "FAILED";

type ImportBatch = {
  id: string;
  fileName: string;
  /** Present on API ≥ Phase 17D; infer standalone when missing. */
  importSource?: "standalone" | "campaign";
  campaignId?: string | null;
  status: BatchStatus;
  totalRows: number;
  processedRows: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: { row: number; reason: string }[];
  mapping?: Record<string, string> | null;
  createdAt: string;
  completedAt?: string | null;
  createdBy?: { id: string; displayName: string } | null;
};

type UploadResult = ImportBatch & {
  detectedHeaders?: string[];
  mapping?: Record<string, string>;
};

// ── Status helpers ────────────────────────────────────────────────────────────

const STATUS_META: Record<BatchStatus, { label: string; color: string; icon: React.ReactNode }> = {
  PENDING: { label: "Pending", color: "#6b7280", icon: <Clock size={14} /> },
  PROCESSING: { label: "Processing…", color: "#3b82f6", icon: <Clock size={14} /> },
  DONE: { label: "Done", color: "#10b981", icon: <CheckCircle size={14} /> },
  PARTIAL: { label: "Partial", color: "#f59e0b", icon: <AlertCircle size={14} /> },
  FAILED: { label: "Failed", color: "#ef4444", icon: <AlertCircle size={14} /> },
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    " " + new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const btnBase: React.CSSProperties = {
  padding: "0.4375rem 1rem",
  borderRadius: "0.375rem",
  border: "1px solid var(--border)",
  cursor: "pointer",
  fontSize: "0.875rem",
  fontWeight: 600,
  background: "var(--surface-hover)",
  color: "var(--text)",
};

// ── Expected columns helper ───────────────────────────────────────────────────

const EXPECTED_COLUMNS = [
  { key: "phone / mobile / telephone", note: "Required — used for deduplication" },
  { key: "email / email address", note: "Required if no phone column" },
  { key: "first name / firstname", note: "Optional" },
  { key: "last name / lastname", note: "Optional" },
  { key: "name / full name", note: "Optional — used if first/last missing" },
  { key: "company / organization", note: "Optional" },
  { key: "title / job title", note: "Optional" },
  { key: "notes", note: "Optional — added as scratch notes" },
  { key: "tags", note: "Optional — comma-separated" },
];

// ── Batch result card ─────────────────────────────────────────────────────────

function BatchCard({ batch, showDetailLink }: { batch: ImportBatch; showDetailLink?: boolean }) {
  const [showErrors, setShowErrors] = useState(false);
  const meta = STATUS_META[batch.status] ?? STATUS_META.PENDING;
  const hasErrors = (batch.errors?.length ?? 0) > 0;
  const source = batch.importSource ?? (batch.campaignId ? "campaign" : "standalone");

  return (
    <div className="panel" style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.5rem" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.875rem", fontWeight: 700 }}>{batch.fileName}</span>
            <span style={{ display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.8125rem", fontWeight: 600, color: meta.color }}>
              {meta.icon} {meta.label}
            </span>
          </div>
          <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: "0.2rem" }}>
            {formatDate(batch.createdAt)}
            {batch.createdBy && ` · ${batch.createdBy.displayName}`}
          </div>
          <div style={{ fontSize: "0.7rem", color: "var(--text-dim)", marginTop: "0.25rem" }}>
            {source === "campaign" ? "Campaign CSV import" : "Standalone import"}
            {source === "campaign" && batch.campaignId && (
              <>
                {" · "}
                <Link
                  href={`/crm/campaigns/${encodeURIComponent(batch.campaignId)}`}
                  style={{ color: "var(--accent)", fontWeight: 600, textDecoration: "none" }}
                >
                  Campaign
                </Link>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Counts row */}
      {batch.totalRows > 0 && (
        <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.8125rem" }}><strong style={{ color: "var(--text)" }}>{batch.totalRows}</strong> <span style={{ color: "var(--text-dim)" }}>rows</span></span>
          {batch.createdCount > 0 && <span style={{ fontSize: "0.8125rem" }}><strong style={{ color: "#10b981" }}>{batch.createdCount}</strong> <span style={{ color: "var(--text-dim)" }}>created</span></span>}
          {batch.updatedCount > 0 && <span style={{ fontSize: "0.8125rem" }}><strong style={{ color: "#3b82f6" }}>{batch.updatedCount}</strong> <span style={{ color: "var(--text-dim)" }}>updated</span></span>}
          {batch.skippedCount > 0 && <span style={{ fontSize: "0.8125rem" }}><strong style={{ color: "#6b7280" }}>{batch.skippedCount}</strong> <span style={{ color: "var(--text-dim)" }}>skipped</span></span>}
          {batch.errorCount > 0 && <span style={{ fontSize: "0.8125rem" }}><strong style={{ color: "#ef4444" }}>{batch.errorCount}</strong> <span style={{ color: "var(--text-dim)" }}>errors</span></span>}
        </div>
      )}

      {/* Error toggle */}
      {hasErrors && (
        <div>
          <button
            onClick={() => setShowErrors((v) => !v)}
            style={{ ...btnBase, fontSize: "0.8125rem", padding: "0.25rem 0.625rem", display: "flex", alignItems: "center", gap: "0.25rem" }}
          >
            {showErrors ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {showErrors ? "Hide" : "Show"} {batch.errors.length} issue{batch.errors.length !== 1 ? "s" : ""}
          </button>
          {showErrors && (
            <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.25rem", maxHeight: 200, overflowY: "auto" }}>
              {batch.errors.map((e, i) => (
                <div key={i} style={{ fontSize: "0.8125rem", color: "#ef4444" }}>
                  Row {e.row}: {e.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center" }}>
        {showDetailLink && (
          <Link
            href={`/crm/import?batch=${encodeURIComponent(batch.id)}`}
            style={{ fontSize: "0.8125rem", color: "var(--accent)", fontWeight: 600, textDecoration: "none" }}
          >
            Batch detail →
          </Link>
        )}
        {/* Link to contacts after a successful import */}
        {(batch.status === "DONE" || batch.status === "PARTIAL") && (batch.createdCount + batch.updatedCount > 0) && (
          <Link
            href="/crm/contacts"
            style={{ fontSize: "0.8125rem", color: "var(--accent)", fontWeight: 600, textDecoration: "none" }}
          >
            View imported contacts →
          </Link>
        )}
      </div>
    </div>
  );
}

/** Full drilldown for `?batch=` — persisted fields only; honest when per-row JSON is missing. */
function ImportBatchDetailPanel({ batch }: { batch: ImportBatch }) {
  const meta = STATUS_META[batch.status] ?? STATUS_META.PENDING;
  const source = batch.importSource ?? (batch.campaignId ? "campaign" : "standalone");
  const errList = Array.isArray(batch.errors) ? batch.errors : [];
  const missingStoredRowDetails =
    (batch.errorCount > 0 || batch.skippedCount > 0) && errList.length === 0;
  const mappingEntries =
    batch.mapping && typeof batch.mapping === "object"
      ? Object.entries(batch.mapping as Record<string, string>)
      : [];

  return (
    <div
      className="panel"
      style={{
        padding: "1.25rem",
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
        border: "1px solid var(--border)",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" }}>
        <h2 style={{ margin: 0, fontSize: "1.0625rem", fontWeight: 700, color: "var(--text)" }}>Import batch detail</h2>
        <span
          style={{
            fontSize: "0.6875rem",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            padding: "0.2rem 0.5rem",
            borderRadius: "0.25rem",
            background: source === "campaign" ? "#dbeafe" : "var(--surface-hover)",
            color: source === "campaign" ? "#1d4ed8" : "var(--text-dim)",
          }}
        >
          {source === "campaign" ? "Campaign-linked" : "Standalone"}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.8125rem", fontWeight: 600, color: meta.color }}>
          {meta.icon} {meta.label}
        </span>
      </div>

      <div style={{ fontSize: "0.875rem", lineHeight: 1.5 }}>
        <p style={{ margin: "0 0 0.35rem", fontWeight: 600, color: "var(--text)" }}>{batch.fileName}</p>
        <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--text-dim)" }}>
          <strong style={{ color: "var(--text)" }}>Uploaded:</strong> {formatDate(batch.createdAt)}
          {batch.completedAt && (
            <>
              {" · "}
              <strong style={{ color: "var(--text)" }}>Finished:</strong> {formatDate(batch.completedAt)}
            </>
          )}
        </p>
        <p style={{ margin: "0.35rem 0 0", fontSize: "0.8125rem", color: "var(--text-dim)" }}>
          <strong style={{ color: "var(--text)" }}>By:</strong> {batch.createdBy?.displayName ?? "—"}
          {" · "}
          <strong style={{ color: "var(--text)" }}>Batch id:</strong>{" "}
          <code style={{ fontSize: "0.75rem" }}>{batch.id}</code>
        </p>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "1.25rem", fontSize: "0.8125rem" }}>
        <span><strong style={{ color: "var(--text)" }}>{batch.totalRows}</strong> <span style={{ color: "var(--text-dim)" }}>rows (file)</span></span>
        <span><strong style={{ color: "var(--text)" }}>{batch.processedRows}</strong> <span style={{ color: "var(--text-dim)" }}>processed</span></span>
        <span><strong style={{ color: "#10b981" }}>{batch.createdCount}</strong> <span style={{ color: "var(--text-dim)" }}>created</span></span>
        <span><strong style={{ color: "#3b82f6" }}>{batch.updatedCount}</strong> <span style={{ color: "var(--text-dim)" }}>updated</span></span>
        <span><strong style={{ color: "#6b7280" }}>{batch.skippedCount}</strong> <span style={{ color: "var(--text-dim)" }}>skipped</span></span>
        <span><strong style={{ color: "#ef4444" }}>{batch.errorCount}</strong> <span style={{ color: "var(--text-dim)" }}>row errors</span></span>
      </div>

      {source === "campaign" && batch.campaignId && (
        <Link
          href={`/crm/campaigns/${encodeURIComponent(batch.campaignId)}`}
          style={{ fontSize: "0.875rem", color: "var(--accent)", fontWeight: 600, textDecoration: "none", width: "fit-content" }}
        >
          Open campaign (where this CSV was imported) →
        </Link>
      )}

      {mappingEntries.length > 0 && (
        <div style={{ padding: "0.75rem 1rem", background: "var(--surface-hover)", borderRadius: "0.375rem", fontSize: "0.8125rem", color: "var(--text-dim)" }}>
          <strong style={{ color: "var(--text)" }}>Column mapping (persisted):</strong>{" "}
          {mappingEntries.slice(0, 24).map(([col, field], i) => (
            <span key={i} style={{ marginRight: "0.65rem" }}>
              <code style={{ fontFamily: "monospace", fontSize: "0.75rem" }}>col {col}</code> → <span style={{ color: "var(--accent)" }}>{field}</span>
            </span>
          ))}
          {mappingEntries.length > 24 && <span>…</span>}
        </div>
      )}

      {missingStoredRowDetails && (
        <div
          style={{
            padding: "0.65rem 0.85rem",
            background: "#fffbeb",
            border: "1px solid #fcd34d",
            borderRadius: "0.375rem",
            fontSize: "0.8125rem",
            color: "#92400e",
          }}
        >
        Row-level details are not stored for this batch—only totals above. This can happen for older imports or when per-row JSON was never written.
        </div>
      )}

      {errList.length > 0 && (
        <div>
          <p style={{ margin: "0 0 0.35rem", fontSize: "0.8125rem", fontWeight: 700, color: "var(--text-dim)" }}>Row issues (from stored batch)</p>
          <div
            style={{
              maxHeight: 220,
              overflowY: "auto",
              border: "1px solid var(--border)",
              borderRadius: "0.375rem",
              padding: "0.5rem 0.65rem",
              background: "var(--surface-hover)",
            }}
          >
            {errList.map((e, i) => (
              <div key={i} style={{ fontSize: "0.8125rem", color: "#b91c1c", padding: "0.15rem 0" }}>
                Row {e.row}: {e.reason}
              </div>
            ))}
          </div>
        </div>
      )}

      {(batch.status === "DONE" || batch.status === "PARTIAL") && (batch.createdCount + batch.updatedCount > 0) && (
        <Link href="/crm/contacts" style={{ fontSize: "0.8125rem", color: "var(--accent)", fontWeight: 600, textDecoration: "none", width: "fit-content" }}>
          View contacts →
        </Link>
      )}
    </div>
  );
}

export default function CrmImportPage() {
  return (
    <Suspense fallback={<div className="py-24 text-center text-gray-400 text-sm">Loading…</div>}>
      <CrmImportPageInner />
    </Suspense>
  );
}

function CrmImportPageInner() {
  const searchParams = useSearchParams();
  const batchFromQuery = searchParams.get("batch");

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Upload state
  const [dragging, setDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<UploadResult | null>(null);

  // History state
  const [history, setHistory] = useState<ImportBatch[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [showGuide, setShowGuide] = useState(false);

  // Batch highlighted from campaign import history (?batch=id)
  const [focusedBatch, setFocusedBatch] = useState<ImportBatch | null>(null);
  const [focusedBatchLoading, setFocusedBatchLoading] = useState(false);
  const [focusedBatchErr, setFocusedBatchErr] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const data = await apiGet<{ batches: ImportBatch[] }>("/crm/import/batches?limit=10");
      setHistory(data.batches);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  useEffect(() => {
    if (!batchFromQuery?.trim()) {
      setFocusedBatch(null);
      setFocusedBatchErr(null);
      setFocusedBatchLoading(false);
      return;
    }
    const id = batchFromQuery.trim();
    let cancelled = false;
    setFocusedBatchLoading(true);
    setFocusedBatchErr(null);
    (async () => {
      try {
        const b = await apiGet<ImportBatch>(`/crm/import/batches/${encodeURIComponent(id)}`);
        if (!cancelled) {
          setFocusedBatch(b);
          setFocusedBatchErr(null);
        }
      } catch (err) {
        if (!cancelled) {
          setFocusedBatch(null);
          if (err instanceof ApiError && err.status === 404) {
            setFocusedBatchErr("This import batch was not found, or you don't have access.");
          } else {
            setFocusedBatchErr("Could not load this import batch.");
          }
        }
      } finally {
        if (!cancelled) setFocusedBatchLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [batchFromQuery]);

  // ── File selection handlers ───────────────────────────────────────────────

  const handleFile = (file: File) => {
    setUploadError(null);
    setLastResult(null);
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setUploadError("Only CSV files are supported. XLSX support coming soon.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setUploadError("File must be under 5 MB.");
      return;
    }
    setSelectedFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  // ── Upload handler ────────────────────────────────────────────────────────

  const handleUpload = async () => {
    if (!selectedFile) return;
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);

      // Use fetch directly — apiPost doesn't handle multipart FormData.
      // Replicate the same token + base-url logic as apiClient.ts.
      const token =
        localStorage.getItem("token") ||
        localStorage.getItem("cc-token") ||
        localStorage.getItem("authToken") ||
        "";
      const apiBase = (() => {
        const baked = process.env.NEXT_PUBLIC_API_URL;
        const fromEnv = baked != null && String(baked).trim() !== "" ? String(baked).trim().replace(/\/$/, "") : "";
        if (fromEnv) return fromEnv;
        return `${window.location.origin.replace(/\/$/, "")}/api`;
      })();
      const res = await fetch(`${apiBase}/crm/import/upload`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });

      const json = await res.json();

      if (!res.ok) {
        setUploadError(json?.detail ?? json?.error ?? "Upload failed");
        return;
      }

      setLastResult(json as UploadResult);
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      loadHistory();
    } catch (err: any) {
      setUploadError(err?.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="stack compact-stack">
      <PageHeader
        title="Import Leads"
        subtitle="Upload a CSV to bulk-import or enroll contacts into CRM. Existing contacts are matched by phone or email and never duplicated."
      />

      {batchFromQuery?.trim() && (
        <div className="panel" style={{ padding: "0 0 1rem 0", marginBottom: "0.25rem", border: "none", boxShadow: "none", background: "transparent" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", marginBottom: "0.65rem" }}>
            <p style={{ margin: 0, fontSize: "0.8125rem", fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Linked import batch
            </p>
            <Link href="/crm/import" style={{ fontSize: "0.8125rem", color: "var(--accent)", fontWeight: 600, textDecoration: "none" }}>
              Clear link
            </Link>
          </div>
          {focusedBatchLoading && <p style={{ margin: 0, fontSize: "0.875rem", color: "var(--text-dim)" }}>Loading batch…</p>}
          {focusedBatchErr && !focusedBatchLoading && (
            <div
              className="panel"
              style={{
                padding: "1rem 1.25rem",
                borderLeft: "4px solid #ef4444",
                background: "#fef2f2",
                fontSize: "0.875rem",
                color: "#991b1b",
              }}
            >
              {focusedBatchErr}
            </div>
          )}
          {focusedBatch && !focusedBatchLoading && <ImportBatchDetailPanel batch={focusedBatch} />}
        </div>
      )}

      {/* ── Upload card ────────────────────────────────────────────────────── */}
      <div className="panel" style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}>

        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => !selectedFile && fileInputRef.current?.click()}
          style={{
            border: `2px dashed ${dragging ? "var(--accent)" : selectedFile ? "#10b981" : "var(--border)"}`,
            borderRadius: "0.625rem",
            padding: "2rem",
            textAlign: "center",
            cursor: selectedFile ? "default" : "pointer",
            background: dragging ? "var(--accent)10" : "var(--surface-hover)",
            transition: "border-color 0.15s, background 0.15s",
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            style={{ display: "none" }}
            onChange={handleInputChange}
          />

          {selectedFile ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "0.75rem" }}>
              <FileUp size={20} style={{ color: "#10b981" }} />
              <div style={{ textAlign: "left" }}>
                <div style={{ fontSize: "0.9375rem", fontWeight: 600 }}>{selectedFile.name}</div>
                <div style={{ fontSize: "0.8125rem", color: "var(--text-dim)" }}>
                  {(selectedFile.size / 1024).toFixed(1)} KB
                </div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: "0.25rem" }}
              >
                <X size={16} />
              </button>
            </div>
          ) : (
            <div>
              <FileUp size={32} style={{ color: "var(--text-dim)", margin: "0 auto 0.5rem", display: "block" }} />
              <p style={{ margin: "0 0 0.25rem", fontWeight: 600, fontSize: "0.9375rem" }}>
                Drop CSV here or click to browse
              </p>
              <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--text-dim)" }}>
                Max 5 MB · CSV only · up to 5,000 rows
              </p>
            </div>
          )}
        </div>

        {/* Error */}
        {uploadError && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", padding: "0.75rem 1rem", background: "#ef444415", borderRadius: "0.375rem", border: "1px solid #ef444430", fontSize: "0.875rem", color: "#ef4444" }}>
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: "0.1rem" }} />
            <span>{uploadError}</span>
          </div>
        )}

        {/* Actions row */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          <button
            onClick={handleUpload}
            disabled={!selectedFile || uploading}
            style={{ ...btnBase, background: "var(--accent)", color: "#fff", borderColor: "var(--accent)", opacity: (!selectedFile || uploading) ? 0.5 : 1 }}
          >
            {uploading ? "Importing…" : "Import CSV"}
          </button>
          {!selectedFile && (
            <button
              onClick={() => fileInputRef.current?.click()}
              style={btnBase}
            >
              Browse files
            </button>
          )}
          <button
            onClick={() => setShowGuide((v) => !v)}
            style={{ ...btnBase, background: "none", border: "none", color: "var(--text-dim)", fontWeight: 400, fontSize: "0.8125rem", padding: "0.4375rem 0" }}
          >
            {showGuide ? "Hide" : "Show"} expected column names
          </button>
        </div>

        {/* Column guide */}
        {showGuide && (
          <div style={{ background: "var(--surface-hover)", borderRadius: "0.5rem", padding: "1rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <p style={{ margin: "0 0 0.5rem", fontSize: "0.8125rem", fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Expected column names (case-insensitive)</p>
            {EXPECTED_COLUMNS.map((col) => (
              <div key={col.key} style={{ display: "flex", gap: "1rem", fontSize: "0.8125rem" }}>
                <code style={{ minWidth: 220, color: "var(--accent)", fontFamily: "monospace" }}>{col.key}</code>
                <span style={{ color: "var(--text-dim)" }}>{col.note}</span>
              </div>
            ))}
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.8125rem", color: "var(--text-dim)" }}>
              Column order doesn't matter. Headers must be in the first row.
              Duplicate contacts (matched by phone or email) are updated non-destructively — existing data is never overwritten.
            </p>
          </div>
        )}
      </div>

      {/* ── Last upload result ────────────────────────────────────────────────── */}
      {lastResult && (
        <div>
          <h3 style={{ margin: "0 0 0.5rem", fontSize: "0.875rem", fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Import Result
          </h3>
          <BatchCard batch={lastResult} />
          {lastResult.mapping && Object.keys(lastResult.mapping).length > 0 && (
            <div style={{ marginTop: "0.5rem", padding: "0.75rem 1rem", background: "var(--surface-hover)", borderRadius: "0.375rem", fontSize: "0.8125rem", color: "var(--text-dim)" }}>
              <strong>Column mapping detected: </strong>
              {lastResult.detectedHeaders?.map((h, i) => {
                const mapped = lastResult.mapping?.[i];
                return mapped ? (
                  <span key={i} style={{ marginRight: "0.75rem" }}>
                    <code style={{ fontFamily: "monospace" }}>{h}</code> → <span style={{ color: "var(--accent)" }}>{mapped}</span>
                  </span>
                ) : null;
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Import history ────────────────────────────────────────────────────── */}
      {history.length > 0 || historyLoading ? (
        <div>
          <h3 style={{ margin: "0 0 0.5rem", fontSize: "0.875rem", fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Recent Imports
          </h3>
          {historyLoading ? (
            <LoadingSkeleton rows={3} />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {history.map((b) => {
                const dim = batchFromQuery?.trim() === b.id;
                return (
                  <div
                    key={b.id}
                    style={
                      batchFromQuery?.trim()
                        ? {
                            borderRadius: "0.5rem",
                            outline: dim ? "2px solid var(--accent, #3b82f6)" : "none",
                            outlineOffset: dim ? "2px" : undefined,
                          }
                        : undefined
                    }
                  >
                    <BatchCard batch={b} showDetailLink />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
