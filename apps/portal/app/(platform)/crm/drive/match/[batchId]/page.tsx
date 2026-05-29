"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle,
  XCircle,
  AlertTriangle,
  FileText,
  Play,
  ExternalLink,
  RefreshCw,
  Building2,
  Clock,
  BookOpen,
  ScanText,
  Radar,
  Brain,
  Sparkles,
  Layers,
  ChevronRight,
  Info,
  SkipForward,
  Activity,
  Download,
} from "lucide-react";
import Link from "next/link";
import { apiGet, apiPost, apiFetchBlob } from "../../../../../../services/apiClient";

// ── Types ─────────────────────────────────────────────────────────────────────

type DocumentStatus =
  | "DISCOVERED"
  | "IMPORT_PENDING"
  | "IMPORTING"
  | "IMPORTED"
  | "IMPORT_FAILED"
  | "FAILED"
  | "REJECTED";

type MatchConfidence = "HIGH" | "MEDIUM" | "AMBIGUOUS" | null;

type TextExtractionStatus =
  | "TEXT_PENDING"
  | "TEXT_PROCESSING"
  | "TEXT_COMPLETE"
  | "TEXT_FAILED"
  | null;

type LeadDocument = {
  id: string;
  contactId: string | null;
  contact?: { id: string; displayName: string; company: string | null } | null;
  importBatchId: string | null;
  source: string;
  googleDriveFileId: string | null;
  originalFileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  status: DocumentStatus;
  matchConfidence: MatchConfidence;
  matchReason: string | null;
  reviewedAt: string | null;
  importedAt: string | null;
  importError: string | null;
  importedMimeType: string | null;
  textExtractionStatus: TextExtractionStatus;
  textExtractionError: string | null;
  createdAt: string;
  driveViewUrl: string | null;
};

// ── Pipeline types ────────────────────────────────────────────────────────────

type PipelineRunStatus = "PENDING" | "RUNNING" | "COMPLETE" | "PARTIAL" | "FAILED" | "CANCELLED";
type PipelineStepStatus = "pending" | "running" | "complete" | "partial" | "skipped" | "failed";

type PipelineStepRecord = {
  status: PipelineStepStatus;
  startedAt: string | null;
  completedAt: string | null;
  attempted: number;
  succeeded: number;
  skipped: number;
  failed: number;
  errorSummary: string | null;
};

type PipelineRun = {
  runId: string;
  batchId: string;
  status: PipelineRunStatus;
  currentStep: string | null;
  steps: Partial<Record<string, PipelineStepRecord>>;
  totals: {
    driveFilesScanned: number;
    documentsMatched: number;
    documentsImported: number;
    textExtracted: number;
    discoveriesFound: number;
    aiReportsGenerated: number;
  };
  errors: Array<{ step: string; error: string; at: string }>;
  overallProgressPercent: number;
  hasMore: boolean;
  nextAction: string | null;
  startedAt: string | null;
  completedAt: string | null;
  recoveredAt: string | null;
};

// ── Diagnostics types ─────────────────────────────────────────────────────────

type DiagnosticsWarning = { code: string; message: string; count?: number };
type DiagnosticsFailure = {
  category: string;
  count: number;
  latestOccurrence: string | null;
  exampleMessage: string;
};
type TimelineStep = {
  name: string;
  displayName: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
};
type BatchDiagnostics = {
  generatedAt: string;
  healthScore: number;
  warnings: DiagnosticsWarning[];
  failures: DiagnosticsFailure[];
  documents: {
    total: number;
    matched: number;
    imported: number;
    importPending: number;
    importFailed: number;
    importSkipped: number;
  };
  extraction: {
    total: number;
    complete: number;
    failed: number;
    pending: number;
    processing: number;
    ocrComplete: number;
    ocrFailed: number;
    totalCharsExtracted: number;
  };
  discovery: {
    phonesTotal: number;
    phonesPending: number;
    phonesAccepted: number;
    emailsTotal: number;
    emailsPending: number;
    emailsAccepted: number;
  };
  ai: { total: number; complete: number; failed: number; pending: number };
  timeline?: { steps: TimelineStep[] };
};

type MatchResultsResponse = {
  batch: {
    id: string;
    fileName: string;
    status: string;
    totalRows: number;
    auditRowCount: number;
    auditErrorCount: number;
    /** Non-null when Drive matching may be incomplete due to missing audit rows. */
    auditWarning: string | null;
    createdAt: string;
    completedAt: string | null;
  };
  documents: LeadDocument[];
  unmatchedCompanies: string[];
};

type MatchRunResult = {
  batchId: string;
  filesScanned: number;
  auditRowCount: number;
  rowsWithCompany: number;
  matchesCreated: number;
  duplicatesSkipped: number;
  ambiguousMatches: number;
  unmatchedCompanies: string[];
  unmatchedFiles: string[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtSize(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const CONFIDENCE_BADGE: Record<
  string,
  { label: string; className: string }
> = {
  HIGH: {
    label: "High confidence",
    className:
      "inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-400",
  },
  MEDIUM: {
    label: "Medium confidence",
    className:
      "inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-400",
  },
  AMBIGUOUS: {
    label: "Ambiguous — needs review",
    className:
      "inline-flex items-center rounded-full bg-orange-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-orange-400",
  },
};

// ── Process Batch panel ────────────────────────────────────────────────────────

const STEP_LABELS: Record<string, string> = {
  drive_match: "Drive Match",
  document_import: "Document Import",
  text_extraction: "Text Extraction",
  contact_discovery: "Contact Discovery",
  ai_intelligence: "AI Intelligence",
};

const STEP_ORDER = [
  "drive_match",
  "document_import",
  "text_extraction",
  "contact_discovery",
  "ai_intelligence",
] as const;

function stepStatusColor(s: PipelineStepStatus | undefined): string {
  switch (s) {
    case "complete": return "#10b981";
    case "partial": return "#f59e0b";
    case "failed": return "#ef4444";
    case "skipped": return "#6b7280";
    case "running": return "#3b82f6";
    default: return "var(--text-muted)";
  }
}

function pipelineStatusLabel(s: PipelineRunStatus): string {
  switch (s) {
    case "COMPLETE": return "Complete";
    case "PARTIAL": return "In progress";
    case "FAILED": return "Failed";
    case "RUNNING": return "Running…";
    case "CANCELLED": return "Cancelled";
    default: return "Pending";
  }
}

function pipelineStatusBg(s: PipelineRunStatus): { bg: string; color: string } {
  switch (s) {
    case "COMPLETE": return { bg: "rgba(16,185,129,0.12)", color: "#10b981" };
    case "PARTIAL": return { bg: "rgba(245,158,11,0.12)", color: "#f59e0b" };
    case "FAILED": return { bg: "rgba(239,68,68,0.12)", color: "#ef4444" };
    case "RUNNING": return { bg: "rgba(59,130,246,0.12)", color: "#3b82f6" };
    case "CANCELLED": return { bg: "rgba(107,114,128,0.12)", color: "#6b7280" };
    default: return { bg: "rgba(107,114,128,0.1)", color: "#6b7280" };
  }
}

function ProcessBatchPanel({
  batchId: _batchId,
  run,
  running,
  error,
  expanded,
  onToggleExpand,
  onStart,
  onContinue,
}: {
  batchId: string;
  run: PipelineRun | null;
  running: boolean;
  error: string | null;
  expanded: boolean;
  onToggleExpand: () => void;
  onStart: () => void;
  onContinue: () => void;
}) {
  const canStart =
    !running &&
    (!run ||
      run.status === "FAILED" ||
      run.status === "CANCELLED" ||
      run.status === "COMPLETE");
  const canContinue = !running && run?.status === "PARTIAL" && run.hasMore;
  const statusStyle = run ? pipelineStatusBg(run.status) : { bg: "transparent", color: "var(--text-muted)" };

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "0.875rem",
        marginBottom: "1.5rem",
        overflow: "hidden",
      }}
    >
      {/* Header row */}
      <div
        style={{
          padding: "1rem 1.25rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Layers size={17} style={{ color: "#8b5cf6", flexShrink: 0 }} />
          <div>
            <p style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--text)", margin: 0 }}>
              Process Batch
            </p>
            <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 2 }}>
              Runs all pipeline steps automatically: Drive match → import → extraction → discovery → AI.
            </p>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.625rem", flexShrink: 0 }}>
          {run && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "0.2rem 0.65rem",
                borderRadius: "9999px",
                background: statusStyle.bg,
                color: statusStyle.color,
                fontSize: "0.72rem",
                fontWeight: 700,
              }}
            >
              {running ? <RefreshCw size={10} className="animate-spin" /> : null}
              {running ? "Running…" : pipelineStatusLabel(run.status)}
            </span>
          )}

          {canStart && (
            <button
              type="button"
              disabled={running}
              onClick={onStart}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "0.45rem 1rem",
                borderRadius: "0.5rem",
                background: "#7c3aed",
                border: "none",
                color: "#fff",
                fontSize: "0.8rem",
                fontWeight: 600,
                cursor: running ? "not-allowed" : "pointer",
                opacity: running ? 0.7 : 1,
              }}
            >
              {running ? (
                <RefreshCw size={13} className="animate-spin" />
              ) : (
                <Play size={13} />
              )}
              {run && (run.status === "COMPLETE" || run.status === "FAILED" || run.status === "CANCELLED")
                ? "Start New Run"
                : "Start Processing"}
            </button>
          )}

          {canContinue && (
            <button
              type="button"
              disabled={running}
              onClick={onContinue}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "0.45rem 1rem",
                borderRadius: "0.5rem",
                background: "#f59e0b",
                border: "none",
                color: "#fff",
                fontSize: "0.8rem",
                fontWeight: 600,
                cursor: running ? "not-allowed" : "pointer",
                opacity: running ? 0.7 : 1,
              }}
            >
              {running ? (
                <RefreshCw size={13} className="animate-spin" />
              ) : (
                <ChevronRight size={13} />
              )}
              Continue Processing
            </button>
          )}

          {run && (
            <button
              type="button"
              onClick={onToggleExpand}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: "0.75rem",
                padding: "0.25rem",
              }}
              aria-label={expanded ? "Collapse details" : "Expand details"}
            >
              {expanded ? "▲" : "▼"}
            </button>
          )}
        </div>
      </div>

      {/* Overall progress bar */}
      {run && run.status !== "PENDING" && (
        <div style={{ padding: "0 1.25rem 0.875rem" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: "0.72rem",
              color: "var(--text-muted)",
              marginBottom: "0.3rem",
            }}
          >
            <span>Overall progress</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              {run.overallProgressPercent ?? 0}%
            </span>
          </div>
          <div
            style={{
              height: 6,
              borderRadius: 9999,
              background: "rgba(139,92,246,0.12)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${run.overallProgressPercent ?? 0}%`,
                borderRadius: 9999,
                background:
                  run.status === "COMPLETE"
                    ? "#10b981"
                    : run.status === "FAILED"
                      ? "#ef4444"
                      : "#8b5cf6",
                transition: "width 0.4s ease",
              }}
            />
          </div>
          {run.recoveredAt && (
            <p
              style={{
                fontSize: "0.68rem",
                color: "#f59e0b",
                marginTop: "0.3rem",
              }}
            >
              ⚠ Previous run was auto-recovered after a crash. A new run has been started.
            </p>
          )}
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div
          style={{
            margin: "0 1.25rem 0.875rem",
            padding: "0.65rem 0.9rem",
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.25)",
            borderRadius: "0.5rem",
            fontSize: "0.8rem",
            color: "#ef4444",
          }}
        >
          {error}
        </div>
      )}

      {/* Next action hint */}
      {run?.status === "PARTIAL" && run.nextAction && (
        <div
          style={{
            margin: "0 1.25rem 0.875rem",
            padding: "0.6rem 0.9rem",
            background: "rgba(245,158,11,0.08)",
            border: "1px solid rgba(245,158,11,0.25)",
            borderRadius: "0.5rem",
            fontSize: "0.8rem",
            color: "#92400e",
            display: "flex",
            alignItems: "flex-start",
            gap: 7,
          }}
        >
          <Info size={13} style={{ marginTop: 1, flexShrink: 0, color: "#f59e0b" }} />
          {run.nextAction}
        </div>
      )}

      {/* Expanded: step details */}
      {run && expanded && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            padding: "1rem 1.25rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.625rem",
          }}
        >
          {/* Step rows */}
          {STEP_ORDER.map((stepKey) => {
            const step = run.steps[stepKey];
            const color = stepStatusColor(step?.status);
            return (
              <div
                key={stepKey}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.75rem",
                  fontSize: "0.8rem",
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: color,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    width: 150,
                    fontWeight: step?.status === "running" ? 700 : 500,
                    color: step ? "var(--text)" : "var(--text-muted)",
                    flexShrink: 0,
                  }}
                >
                  {STEP_LABELS[stepKey] ?? stepKey}
                </span>
                <span style={{ color, fontWeight: 600, minWidth: 60, flexShrink: 0 }}>
                  {step?.status ?? "—"}
                </span>
                {step && step.attempted > 0 && (
                  <span style={{ color: "var(--text-muted)" }}>
                    {step.succeeded} succeeded
                    {step.skipped > 0 ? ` · ${step.skipped} skipped` : ""}
                    {step.failed > 0 ? ` · ${step.failed} failed` : ""}
                  </span>
                )}
                {step?.status === "skipped" && step.errorSummary && (
                  <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
                    <SkipForward size={11} style={{ verticalAlign: "middle", marginRight: 3 }} />
                    {step.errorSummary}
                  </span>
                )}
                {step?.status === "failed" && step.errorSummary && (
                  <span style={{ color: "#ef4444", fontStyle: "italic" }}>
                    {step.errorSummary}
                  </span>
                )}
              </div>
            );
          })}

          {/* Totals summary */}
          {run.totals && (
            <div
              style={{
                marginTop: "0.5rem",
                padding: "0.625rem 0.875rem",
                background: "var(--surface-hover)",
                border: "1px solid var(--border)",
                borderRadius: "0.5rem",
                display: "flex",
                flexWrap: "wrap",
                gap: "0.75rem 1.5rem",
                fontSize: "0.775rem",
              }}
            >
              {run.totals.driveFilesScanned > 0 && (
                <span style={{ color: "var(--text-muted)" }}>
                  <strong style={{ color: "var(--text)" }}>{run.totals.driveFilesScanned}</strong> Drive files scanned
                </span>
              )}
              {run.totals.documentsImported > 0 && (
                <span style={{ color: "var(--text-muted)" }}>
                  <strong style={{ color: "var(--text)" }}>{run.totals.documentsImported}</strong> docs imported
                </span>
              )}
              {run.totals.textExtracted > 0 && (
                <span style={{ color: "var(--text-muted)" }}>
                  <strong style={{ color: "var(--text)" }}>{run.totals.textExtracted}</strong> texts extracted
                </span>
              )}
              {run.totals.discoveriesFound > 0 && (
                <span style={{ color: "var(--text-muted)" }}>
                  <strong style={{ color: "var(--text)" }}>{run.totals.discoveriesFound}</strong> contacts discovered
                </span>
              )}
              {run.totals.aiReportsGenerated > 0 && (
                <span style={{ color: "var(--text-muted)" }}>
                  <strong style={{ color: "var(--text)" }}>{run.totals.aiReportsGenerated}</strong> AI reports generated
                </span>
              )}
            </div>
          )}

          {/* Run errors */}
          {run.errors.length > 0 && (
            <div
              style={{
                marginTop: "0.25rem",
                padding: "0.625rem 0.875rem",
                background: "rgba(239,68,68,0.06)",
                border: "1px solid rgba(239,68,68,0.2)",
                borderRadius: "0.5rem",
                fontSize: "0.775rem",
                color: "var(--text-muted)",
              }}
            >
              <p style={{ fontWeight: 700, color: "#ef4444", marginBottom: 4 }}>
                {run.errors.length} error{run.errors.length !== 1 ? "s" : ""} recorded:
              </p>
              {run.errors.map((e, i) => (
                <p key={i} style={{ margin: "2px 0" }}>
                  <span style={{ fontWeight: 600, color: "var(--text)" }}>
                    {STEP_LABELS[e.step] ?? e.step}:
                  </span>{" "}
                  {e.error}
                </p>
              ))}
            </div>
          )}

          {/* Last run time */}
          {run.startedAt && (
            <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.25rem" }}>
              Started {new Date(run.startedAt).toLocaleString()}
              {run.completedAt
                ? ` · Completed ${new Date(run.completedAt).toLocaleString()}`
                : ""}
            </p>
          )}

          {/* Disclaimers */}
          <div
            style={{
              marginTop: "0.25rem",
              padding: "0.6rem 0.875rem",
              background: "rgba(59,130,246,0.06)",
              border: "1px solid rgba(59,130,246,0.15)",
              borderRadius: "0.5rem",
              fontSize: "0.75rem",
              color: "var(--text-muted)",
              lineHeight: 1.55,
            }}
          >
            <p style={{ margin: 0 }}>
              <Info size={11} style={{ verticalAlign: "middle", marginRight: 4, color: "#3b82f6" }} />
              <strong>Discoveries still require manual review</strong> — no contact data is modified automatically.{" "}
              <strong>AI reports are advisory only.</strong>{" "}
              Scanned PDFs may not be text-extractable (image OCR applies to PNG/JPG only).
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── DocumentCard ──────────────────────────────────────────────────────────────

function DocumentCard({
  doc,
  onConfirm,
  onReject,
  onImport,
  onExtract,
  onViewText,
  onDiscover,
  working,
}: {
  doc: LeadDocument;
  onConfirm: (id: string) => void;
  onReject: (id: string) => void;
  onImport: (id: string) => void;
  onExtract: (id: string) => void;
  onViewText: (id: string) => void;
  onDiscover: (id: string) => void;
  working: boolean;
}) {
  const badge =
    doc.matchConfidence && CONFIDENCE_BADGE[doc.matchConfidence]
      ? CONFIDENCE_BADGE[doc.matchConfidence]
      : null;

  const isReviewed =
    doc.status === "IMPORT_PENDING" ||
    doc.status === "IMPORTING" ||
    doc.status === "IMPORTED" ||
    doc.status === "IMPORT_FAILED" ||
    doc.status === "REJECTED";

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "0.75rem",
        padding: "1rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        opacity: isReviewed ? 0.65 : 1,
      }}
    >
      {/* File + status row */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: "0.75rem" }}>
        <FileText
          size={18}
          style={{ color: "var(--text-muted)", flexShrink: 0, marginTop: 2 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              fontSize: "0.875rem",
              fontWeight: 600,
              color: "var(--text)",
              marginBottom: 2,
              wordBreak: "break-word",
            }}
          >
            {doc.originalFileName}
          </p>
          <p style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
            {fmtSize(doc.sizeBytes)}
            {doc.mimeType ? ` · ${doc.mimeType.split("/").pop()}` : ""}
            {" · "}found {fmtDate(doc.createdAt)}
          </p>
        </div>

        {/* Reviewed status badge */}
        {doc.status === "IMPORT_PENDING" && (
          <span
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              background: "rgba(16,185,129,0.12)",
              color: "#10b981",
              borderRadius: "9999px",
              padding: "0.2rem 0.6rem",
              fontSize: "0.7rem",
              fontWeight: 700,
            }}
          >
            <CheckCircle size={11} />
            Confirmed
          </span>
        )}
        {doc.status === "REJECTED" && (
          <span
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              background: "rgba(239,68,68,0.12)",
              color: "#ef4444",
              borderRadius: "9999px",
              padding: "0.2rem 0.6rem",
              fontSize: "0.7rem",
              fontWeight: 700,
            }}
          >
            <XCircle size={11} />
            Rejected
          </span>
        )}
        {doc.status === "IMPORTING" && (
          <span
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              background: "rgba(59,130,246,0.12)",
              color: "#3b82f6",
              borderRadius: "9999px",
              padding: "0.2rem 0.6rem",
              fontSize: "0.7rem",
              fontWeight: 700,
            }}
          >
            <RefreshCw size={11} className="animate-spin" />
            Importing…
          </span>
        )}
        {doc.status === "IMPORTED" && (
          <span
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              background: "rgba(16,185,129,0.18)",
              color: "#059669",
              borderRadius: "9999px",
              padding: "0.2rem 0.6rem",
              fontSize: "0.7rem",
              fontWeight: 700,
            }}
          >
            <CheckCircle size={11} />
            Imported
          </span>
        )}
        {doc.status === "IMPORT_FAILED" && (
          <span
            title={doc.importError ?? "Import failed"}
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              background: "rgba(239,68,68,0.12)",
              color: "#dc2626",
              borderRadius: "9999px",
              padding: "0.2rem 0.6rem",
              fontSize: "0.7rem",
              fontWeight: 700,
              cursor: "help",
            }}
          >
            <AlertTriangle size={11} />
            Import failed
          </span>
        )}
        {/* Text extraction status badge */}
        {doc.status === "IMPORTED" && doc.textExtractionStatus === "TEXT_COMPLETE" && (
          <span
            title="Text extracted"
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              background: "rgba(139,92,246,0.12)",
              color: "#7c3aed",
              borderRadius: "9999px",
              padding: "0.2rem 0.6rem",
              fontSize: "0.7rem",
              fontWeight: 700,
            }}
          >
            <ScanText size={11} />
            Text extracted
          </span>
        )}
        {doc.status === "IMPORTED" && doc.textExtractionStatus === "TEXT_PROCESSING" && (
          <span
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              background: "rgba(139,92,246,0.08)",
              color: "#7c3aed",
              borderRadius: "9999px",
              padding: "0.2rem 0.6rem",
              fontSize: "0.7rem",
              fontWeight: 700,
            }}
          >
            <RefreshCw size={11} className="animate-spin" />
            Extracting…
          </span>
        )}
        {doc.status === "IMPORTED" && doc.textExtractionStatus === "TEXT_FAILED" && (
          <span
            title={doc.textExtractionError ?? "Text extraction failed"}
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              background: "rgba(245,158,11,0.12)",
              color: "#d97706",
              borderRadius: "9999px",
              padding: "0.2rem 0.6rem",
              fontSize: "0.7rem",
              fontWeight: 700,
              cursor: "help",
            }}
          >
            <AlertTriangle size={11} />
            Text failed
          </span>
        )}
      </div>

      {/* Contact + confidence */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        {doc.contact && (
          <Link
            href={`/crm/contacts/${doc.contact.id}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              background: "var(--surface-hover)",
              border: "1px solid var(--border)",
              borderRadius: "0.5rem",
              padding: "0.2rem 0.6rem",
              fontSize: "0.75rem",
              color: "var(--text)",
              textDecoration: "none",
            }}
          >
            <Building2 size={11} />
            {doc.contact.company || doc.contact.displayName}
          </Link>
        )}
        {badge && <span className={badge.className}>{badge.label}</span>}
      </div>

      {/* Import error detail */}
      {doc.status === "IMPORT_FAILED" && doc.importError && (
        <p style={{ fontSize: "0.75rem", color: "#dc2626", margin: "0.25rem 0 0" }}>
          Error: {doc.importError}
        </p>
      )}
      {/* Text extraction failure detail */}
      {doc.textExtractionStatus === "TEXT_FAILED" && doc.textExtractionError && (
        <p style={{ fontSize: "0.75rem", color: "#d97706", margin: "0.25rem 0 0" }}>
          {doc.textExtractionError.includes("scanned_or_image_ocr_not_configured") ||
          doc.textExtractionError.toLowerCase().includes("no embedded text")
            ? "Scanned or image-only PDF — text extraction requires OCR which is not configured for this phase."
            : `Text extraction failed: ${doc.textExtractionError}`}
        </p>
      )}

      {/* Actions */}
      {!isReviewed && (
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem" }}>
          <button
            type="button"
            disabled={working}
            onClick={() => onConfirm(doc.id)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "0.375rem 0.875rem",
              borderRadius: "0.375rem",
              background: "rgba(16,185,129,0.15)",
              border: "1px solid rgba(16,185,129,0.3)",
              color: "#10b981",
              fontSize: "0.8rem",
              fontWeight: 600,
              cursor: working ? "not-allowed" : "pointer",
            }}
          >
            <CheckCircle size={13} />
            Attach
          </button>
          <button
            type="button"
            disabled={working}
            onClick={() => onReject(doc.id)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "0.375rem 0.875rem",
              borderRadius: "0.375rem",
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.25)",
              color: "#ef4444",
              fontSize: "0.8rem",
              fontWeight: 600,
              cursor: working ? "not-allowed" : "pointer",
            }}
          >
            <XCircle size={13} />
            Ignore
          </button>
          {doc.driveViewUrl && (
            <a
              href={doc.driveViewUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "0.375rem 0.875rem",
                borderRadius: "0.375rem",
                background: "transparent",
                border: "1px solid var(--border)",
                color: "var(--text-muted)",
                fontSize: "0.8rem",
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              <ExternalLink size={13} />
              Open
            </a>
          )}
        </div>
      )}

      {/* IMPORT_PENDING: show Import button */}
      {doc.status === "IMPORT_PENDING" && (
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem" }}>
          <button
            type="button"
            disabled={working}
            onClick={() => onImport(doc.id)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "0.375rem 0.875rem",
              borderRadius: "0.375rem",
              background: "rgba(59,130,246,0.12)",
              border: "1px solid rgba(59,130,246,0.3)",
              color: "#3b82f6",
              fontSize: "0.8rem",
              fontWeight: 600,
              cursor: working ? "not-allowed" : "pointer",
            }}
          >
            {working ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />}
            Import document
          </button>
          {doc.driveViewUrl && (
            <a
              href={doc.driveViewUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "0.375rem 0.875rem",
                borderRadius: "0.375rem",
                background: "transparent",
                border: "1px solid var(--border)",
                color: "var(--text-muted)",
                fontSize: "0.8rem",
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              <ExternalLink size={13} />
              View in Drive
            </a>
          )}
        </div>
      )}

      {/* IMPORTED: show Open + Extract text + View text buttons */}
      {doc.status === "IMPORTED" && (
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem", flexWrap: "wrap" }}>
          <button
            type="button"
            disabled={working}
            onClick={() => onImport(doc.id)}
            title="Open document"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "0.375rem 0.875rem",
              borderRadius: "0.375rem",
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--text-muted)",
              fontSize: "0.8rem",
              fontWeight: 600,
              cursor: working ? "not-allowed" : "pointer",
            }}
          >
            <ExternalLink size={13} />
            Open document
          </button>
          {/* Extract text — shown when not yet extracted or failed */}
          {(doc.textExtractionStatus == null ||
            doc.textExtractionStatus === "TEXT_PENDING" ||
            doc.textExtractionStatus === "TEXT_FAILED") && (
            <button
              type="button"
              disabled={working}
              onClick={() => onExtract(doc.id)}
              title={
                doc.textExtractionStatus === "TEXT_FAILED"
                  ? `Retry text extraction${doc.textExtractionError ? ` (${doc.textExtractionError})` : ""}`
                  : "Extract text from this document"
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "0.375rem 0.875rem",
                borderRadius: "0.375rem",
                background: doc.textExtractionStatus === "TEXT_FAILED"
                  ? "rgba(245,158,11,0.1)"
                  : "rgba(139,92,246,0.1)",
                border: doc.textExtractionStatus === "TEXT_FAILED"
                  ? "1px solid rgba(245,158,11,0.3)"
                  : "1px solid rgba(139,92,246,0.3)",
                color: doc.textExtractionStatus === "TEXT_FAILED" ? "#d97706" : "#7c3aed",
                fontSize: "0.8rem",
                fontWeight: 600,
                cursor: working ? "not-allowed" : "pointer",
              }}
            >
              {working ? <RefreshCw size={13} className="animate-spin" /> : <ScanText size={13} />}
              {doc.textExtractionStatus === "TEXT_FAILED" ? "Retry extraction" : "Extract text"}
            </button>
          )}
          {/* View extracted text */}
          {doc.textExtractionStatus === "TEXT_COMPLETE" && (
            <button
              type="button"
              disabled={working}
              onClick={() => onViewText(doc.id)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "0.375rem 0.875rem",
                borderRadius: "0.375rem",
                background: "rgba(139,92,246,0.1)",
                border: "1px solid rgba(139,92,246,0.3)",
                color: "#7c3aed",
                fontSize: "0.8rem",
                fontWeight: 600,
                cursor: working ? "not-allowed" : "pointer",
              }}
            >
              <BookOpen size={13} />
              View text
            </button>
          )}
          {/* Run Discovery — only for TEXT_COMPLETE docs */}
          {doc.textExtractionStatus === "TEXT_COMPLETE" && (
            <button
              type="button"
              disabled={working}
              onClick={() => onDiscover(doc.id)}
              title="Extract phones and emails from this document's text"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "0.375rem 0.875rem",
                borderRadius: "0.375rem",
                background: "rgba(16,185,129,0.1)",
                border: "1px solid rgba(16,185,129,0.3)",
                color: "#10b981",
                fontSize: "0.8rem",
                fontWeight: 600,
                cursor: working ? "not-allowed" : "pointer",
              }}
            >
              <Radar size={13} />
              Run Discovery
            </button>
          )}
        </div>
      )}

      {/* IMPORT_FAILED: show Retry button */}
      {doc.status === "IMPORT_FAILED" && (
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.25rem" }}>
          <button
            type="button"
            disabled={working}
            onClick={() => onImport(doc.id)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "0.375rem 0.875rem",
              borderRadius: "0.375rem",
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.25)",
              color: "#dc2626",
              fontSize: "0.8rem",
              fontWeight: 600,
              cursor: working ? "not-allowed" : "pointer",
            }}
          >
            <RefreshCw size={13} />
            Retry import
          </button>
        </div>
      )}
    </div>
  );
}

// ── Diagnostics panel ────────────────────────────────────────────────────────

function healthScoreColor(score: number): string {
  if (score >= 80) return "#10b981";
  if (score >= 50) return "#f59e0b";
  return "#ef4444";
}

function stepStatusIcon(status: string) {
  if (status === "complete" || status === "skipped")
    return <CheckCircle size={13} style={{ color: "#10b981", flexShrink: 0 }} />;
  if (status === "failed")
    return <XCircle size={13} style={{ color: "#ef4444", flexShrink: 0 }} />;
  if (status === "partial")
    return <AlertTriangle size={13} style={{ color: "#f59e0b", flexShrink: 0 }} />;
  if (status === "running")
    return <RefreshCw size={13} className="animate-spin" style={{ color: "#8b5cf6", flexShrink: 0 }} />;
  return <Clock size={13} style={{ color: "var(--text-muted)", flexShrink: 0 }} />;
}

function DiagnosticsPanel({
  batchId,
  diag,
  loading,
  expanded,
  onToggleExpand,
  onRefresh,
}: {
  batchId: string;
  diag: BatchDiagnostics | null;
  loading: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onRefresh: () => void;
}) {
  const handleDownloadBundle = async () => {
    try {
      const res = await fetch(
        `/api/crm/import/batches/${encodeURIComponent(batchId)}/diagnostics/support-bundle`,
        {
          headers: {
            Authorization: `Bearer ${typeof window !== "undefined" ? (document.cookie.match(/token=([^;]+)/)?.[1] ?? "") : ""}`,
          },
        },
      );
      if (!res.ok) throw new Error("Failed to generate bundle");
      const json = await res.json();
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `support-bundle-${batchId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("Could not generate support bundle.");
    }
  };

  const score = diag?.healthScore ?? null;

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "0.875rem",
        marginBottom: "1.5rem",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "0.875rem 1.25rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Activity size={16} style={{ color: "#6366f1", flexShrink: 0 }} />
          <div>
            <p style={{ fontSize: "0.875rem", fontWeight: 700, color: "var(--text)", margin: 0 }}>
              Batch Diagnostics
            </p>
            <p style={{ fontSize: "0.73rem", color: "var(--text-muted)", marginTop: 1 }}>
              Health score, warnings, failures, and timeline for this batch.
            </p>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          {score !== null && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "0.2rem 0.65rem",
                borderRadius: "9999px",
                background: `${healthScoreColor(score)}22`,
                color: healthScoreColor(score),
                fontSize: "0.72rem",
                fontWeight: 700,
              }}
            >
              Health: {score}/100
            </span>
          )}

          <button
            type="button"
            onClick={onRefresh}
            title="Refresh diagnostics"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              padding: "0.2rem",
            }}
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
          </button>

          <button
            type="button"
            onClick={onToggleExpand}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: "0.75rem",
              padding: "0.2rem",
            }}
            aria-label={expanded ? "Collapse diagnostics" : "Expand diagnostics"}
          >
            {expanded ? "▲" : "▼"}
          </button>
        </div>
      </div>

      {/* Body — only shown when expanded */}
      {expanded && diag && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "1rem 1.25rem" }}>
          {/* Warnings */}
          {diag.warnings.length > 0 && (
            <div style={{ marginBottom: "1rem" }}>
              <p style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--text-muted)", marginBottom: "0.4rem" }}>
                WARNINGS ({diag.warnings.length})
              </p>
              {diag.warnings.map((w, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    gap: 8,
                    padding: "0.5rem 0.75rem",
                    background: "rgba(245,158,11,0.07)",
                    border: "1px solid rgba(245,158,11,0.2)",
                    borderRadius: "0.5rem",
                    marginBottom: "0.35rem",
                    fontSize: "0.775rem",
                    color: "#92400e",
                  }}
                >
                  <AlertTriangle size={13} style={{ marginTop: 1, flexShrink: 0, color: "#f59e0b" }} />
                  <span>{w.message}</span>
                </div>
              ))}
            </div>
          )}

          {/* Failures */}
          {diag.failures.length > 0 && (
            <div style={{ marginBottom: "1rem" }}>
              <p style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--text-muted)", marginBottom: "0.4rem" }}>
                FAILURES ({diag.failures.reduce((s, f) => s + f.count, 0)})
              </p>
              {diag.failures.map((f, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    gap: 8,
                    padding: "0.5rem 0.75rem",
                    background: "rgba(239,68,68,0.06)",
                    border: "1px solid rgba(239,68,68,0.18)",
                    borderRadius: "0.5rem",
                    marginBottom: "0.35rem",
                    fontSize: "0.775rem",
                    color: "#991b1b",
                  }}
                >
                  <XCircle size={13} style={{ marginTop: 1, flexShrink: 0, color: "#ef4444" }} />
                  <div>
                    <span style={{ fontWeight: 600 }}>{f.category}</span>
                    {" · "}{f.count} failure{f.count !== 1 ? "s" : ""}
                    {f.exampleMessage && (
                      <span style={{ opacity: 0.7 }}> — {f.exampleMessage}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Counts grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
              gap: "0.5rem",
              marginBottom: "1rem",
            }}
          >
            {([
              ["Documents", `${diag.documents.imported} imported / ${diag.documents.total} total`, diag.documents.importFailed > 0 ? "#ef4444" : "#10b981"],
              ["Extraction", `${diag.extraction.complete} complete / ${diag.extraction.total} total`, diag.extraction.failed > 0 ? "#f59e0b" : "#10b981"],
              ["OCR", `${diag.extraction.ocrComplete} complete / ${diag.extraction.ocrFailed} failed`, diag.extraction.ocrFailed > 0 ? "#f59e0b" : undefined],
              ["Discoveries", `${diag.discovery.phonesTotal + diag.discovery.emailsTotal} found (${diag.discovery.phonesPending + diag.discovery.emailsPending} pending)`, undefined],
              ["AI Reports", `${diag.ai.complete} complete / ${diag.ai.total} total`, diag.ai.failed > 0 ? "#f59e0b" : undefined],
              ["Chars extracted", diag.extraction.totalCharsExtracted.toLocaleString(), undefined],
            ] as [string, string, string | undefined][]).map(([label, value, color]) => (
              <div
                key={label}
                style={{
                  padding: "0.5rem 0.75rem",
                  background: "var(--bg)",
                  borderRadius: "0.5rem",
                  border: "1px solid var(--border)",
                }}
              >
                <p style={{ fontSize: "0.68rem", color: "var(--text-muted)", margin: 0, fontWeight: 600 }}>
                  {label}
                </p>
                <p style={{ fontSize: "0.78rem", color: color ?? "var(--text)", margin: 0, fontWeight: 600, marginTop: 2 }}>
                  {value}
                </p>
              </div>
            ))}
          </div>

          {/* Timeline */}
          {diag.timeline && diag.timeline.steps.length > 0 && (
            <div style={{ marginBottom: "1rem" }}>
              <p style={{ fontSize: "0.75rem", fontWeight: 700, color: "var(--text-muted)", marginBottom: "0.5rem" }}>
                PIPELINE TIMELINE
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                {diag.timeline.steps.map((step) => (
                  <div
                    key={step.name}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "0.4rem 0.75rem",
                      background: "var(--bg)",
                      borderRadius: "0.4rem",
                      fontSize: "0.775rem",
                    }}
                  >
                    {stepStatusIcon(step.status)}
                    <span style={{ fontWeight: 600, color: "var(--text)", minWidth: 140 }}>
                      {step.displayName}
                    </span>
                    <span style={{ color: "var(--text-muted)", fontSize: "0.7rem" }}>
                      {step.status}
                      {step.attempted > 0 && ` · ${step.succeeded}/${step.attempted}`}
                      {step.failed > 0 && ` · ${step.failed} failed`}
                    </span>
                    {step.completedAt && (
                      <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: "0.7rem" }}>
                        {new Date(step.completedAt).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Footer */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "0.5rem",
            }}
          >
            <p style={{ fontSize: "0.68rem", color: "var(--text-muted)", margin: 0 }}>
              Generated {new Date(diag.generatedAt).toLocaleTimeString()}
            </p>
            <button
              type="button"
              onClick={handleDownloadBundle}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "0.35rem 0.75rem",
                background: "transparent",
                border: "1px solid var(--border)",
                borderRadius: "0.4rem",
                color: "var(--text-muted)",
                fontSize: "0.75rem",
                cursor: "pointer",
              }}
            >
              <Download size={12} />
              Download Support Bundle
            </button>
          </div>
        </div>
      )}

      {/* Empty state when collapsed and no diag loaded yet */}
      {!expanded && !diag && !loading && (
        <div
          style={{
            padding: "0.6rem 1.25rem",
            borderTop: "1px solid var(--border)",
            fontSize: "0.75rem",
            color: "var(--text-muted)",
          }}
        >
          Expand to view diagnostics
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DriveMatchReviewPage() {
  const { batchId } = useParams<{ batchId: string }>();
  const router = useRouter();

  const [results, setResults] = useState<MatchResultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<MatchRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [workingDocId, setWorkingDocId] = useState<string | null>(null);

  // Pipeline state
  const [pipelineRun, setPipelineRun] = useState<PipelineRun | null>(null);
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [pipelineExpanded, setPipelineExpanded] = useState(false);

  // Diagnostics state
  const [diagnostics, setDiagnostics] = useState<BatchDiagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);

  // Text extraction state
  const [extractingDocId, setExtractingDocId] = useState<string | null>(null);
  const [viewTextDoc, setViewTextDoc] = useState<{
    id: string;
    fileName: string;
    text: string;
    charCount: number;
    pageCount: number | null;
    provider: string | null;
  } | null>(null);

  const loadResults = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<MatchResultsResponse>(
        `/crm/drive/match/results?batchId=${encodeURIComponent(batchId)}`,
      );
      setResults(data);
    } catch (err: any) {
      setError(err?.message ?? "Failed to load match results.");
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  const loadPipelineStatus = useCallback(async () => {
    if (!batchId) return;
    try {
      const res = await apiGet<{ run: PipelineRun | null }>(
        `/crm/import/batches/${encodeURIComponent(batchId)}/pipeline/status`,
      );
      setPipelineRun(res.run);
    } catch {
      // Silently ignore — status panel is optional
    }
  }, [batchId]);

  const loadDiagnostics = useCallback(async () => {
    if (!batchId) return;
    setDiagnosticsLoading(true);
    try {
      const data = await apiGet<BatchDiagnostics>(
        `/crm/import/batches/${encodeURIComponent(batchId)}/diagnostics`,
      );
      setDiagnostics(data);
    } catch {
      // Silently ignore — diagnostics are optional supplemental info
    } finally {
      setDiagnosticsLoading(false);
    }
  }, [batchId]);

  useEffect(() => {
    loadResults();
    loadPipelineStatus();
    loadDiagnostics();
  }, [loadResults, loadPipelineStatus, loadDiagnostics]);

  const handleStartPipeline = async () => {
    if (!batchId) return;
    setPipelineRunning(true);
    setPipelineError(null);
    try {
      const res = await apiPost<PipelineRun>(
        `/crm/import/batches/${encodeURIComponent(batchId)}/pipeline/start`,
        {},
      );
      setPipelineRun(res);
      setPipelineExpanded(true);
      await loadResults();
      await loadDiagnostics();
    } catch (err: any) {
      setPipelineError(err?.message ?? "Pipeline failed to start.");
    } finally {
      setPipelineRunning(false);
    }
  };

  const handleContinuePipeline = async () => {
    if (!batchId) return;
    setPipelineRunning(true);
    setPipelineError(null);
    try {
      const res = await apiPost<PipelineRun>(
        `/crm/import/batches/${encodeURIComponent(batchId)}/pipeline/continue`,
        {},
      );
      setPipelineRun(res);
      await loadResults();
      await loadDiagnostics();
    } catch (err: any) {
      setPipelineError(err?.message ?? "Pipeline continuation failed.");
    } finally {
      setPipelineRunning(false);
    }
  };

  const handleRunMatch = async () => {
    setRunning(true);
    setRunError(null);
    setRunResult(null);
    try {
      const res = await apiPost<MatchRunResult>("/crm/drive/match/run", {
        batchId,
      });
      setRunResult(res);
      await loadResults();
    } catch (err: any) {
      setRunError(
        err?.message ?? "Drive match failed. Make sure a Drive folder is configured.",
      );
    } finally {
      setRunning(false);
    }
  };

  const handleConfirm = async (docId: string) => {
    setWorkingDocId(docId);
    try {
      await apiPost(`/crm/drive/match/${docId}/confirm`, {});
      setResults((prev) =>
        prev
          ? {
              ...prev,
              documents: prev.documents.map((d) =>
                d.id === docId
                  ? { ...d, status: "IMPORT_PENDING" as const, reviewedAt: new Date().toISOString() }
                  : d,
              ),
            }
          : prev,
      );
    } catch (err: any) {
      alert(`Could not confirm: ${err?.message ?? "unknown error"}`);
    } finally {
      setWorkingDocId(null);
    }
  };

  const handleImport = async (docId: string) => {
    const doc = results?.documents.find((d) => d.id === docId);
    // For IMPORTED docs: open the document with auth-aware blob flow.
    // Both the /open-url fetch and the subsequent /open stream require the
    // Bearer JWT. window.open(signedUrl) alone would drop the auth header.
    if (doc?.status === "IMPORTED") {
      try {
        const res = await apiGet<{ signedUrl: string }>(`/crm/documents/${docId}/open-url`);
        const blob = await apiFetchBlob(res.signedUrl);
        const blobUrl = URL.createObjectURL(blob);
        window.open(blobUrl, "_blank", "noopener,noreferrer");
        // Revoke after the browser has had time to initiate the render
        setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
      } catch (err: any) {
        alert(`Could not open document: ${err?.message ?? "unknown error"}`);
      }
      return;
    }
    setWorkingDocId(docId);
    try {
      const result = await apiPost(`/crm/documents/${docId}/import`, {});
      setResults((prev) =>
        prev
          ? {
              ...prev,
              documents: prev.documents.map((d) =>
                d.id === docId
                  ? {
                      ...d,
                      status: (result as any).status === "IMPORTED" ? "IMPORTED" : "IMPORT_FAILED",
                      importedAt: (result as any).status === "IMPORTED" ? new Date().toISOString() : null,
                      importError: (result as any).errorMessage ?? null,
                      importedMimeType: (result as any).importedMimeType ?? null,
                    }
                  : d,
              ),
            }
          : prev,
      );
    } catch (err: any) {
      alert(`Import failed: ${err?.message ?? "unknown error"}`);
    } finally {
      setWorkingDocId(null);
    }
  };

  const handleBatchImport = async () => {
    if (!batchId) return;
    setRunning(true);
    setRunError(null);
    try {
      await apiPost(`/crm/import/batches/${batchId}/import-documents`, { limit: 20 });
      await loadResults();
    } catch (err: any) {
      setRunError(err?.message ?? "Batch import failed");
    } finally {
      setRunning(false);
    }
  };

  const handleExtract = async (docId: string) => {
    setExtractingDocId(docId);
    try {
      await apiPost(`/crm/documents/${docId}/text-extraction`, {});
      // Reload to pick up new textExtractionStatus
      await loadResults();
    } catch (err: any) {
      alert(`Text extraction failed: ${err?.message ?? "unknown error"}`);
    } finally {
      setExtractingDocId(null);
    }
  };

  const handleBatchExtract = async () => {
    if (!batchId) return;
    setRunning(true);
    setRunError(null);
    try {
      // Loop until no docs are left to process (max 5 per call)
      let remaining = true;
      while (remaining) {
        const res = await apiPost<{ attempted: number }>(`/crm/import/batches/${batchId}/text-extraction`, { limit: 5 });
        remaining = res.attempted > 0;
      }
      await loadResults();
    } catch (err: any) {
      setRunError(err?.message ?? "Batch text extraction failed");
    } finally {
      setRunning(false);
    }
  };

  const handleViewText = async (docId: string) => {
    const doc = results?.documents.find((d) => d.id === docId);
    try {
      const res = await apiGet<{
        text: string | null;
        charCount: number | null;
        pageCount: number | null;
        extractionProvider: string | null;
        originalFileName: string;
      }>(`/crm/documents/${docId}/text-extraction`);
      setViewTextDoc({
        id: docId,
        fileName: res.originalFileName ?? doc?.originalFileName ?? "Document",
        text: res.text ?? "",
        charCount: res.charCount ?? 0,
        pageCount: res.pageCount ?? null,
        provider: res.extractionProvider ?? null,
      });
    } catch (err: any) {
      alert(`Could not load extracted text: ${err?.message ?? "unknown error"}`);
    }
  };

  const handleDiscover = async (docId: string) => {
    setWorkingDocId(docId);
    try {
      await apiPost(`/crm/documents/${docId}/discover`, {});
    } catch (err: any) {
      alert(`Discovery failed: ${err?.message ?? "unknown error"}`);
    } finally {
      setWorkingDocId(null);
    }
  };

  const handleBatchDiscover = async () => {
    if (!batchId) return;
    setRunning(true);
    setRunError(null);
    try {
      // Loop until no more docs to process (max 10 per call)
      let remaining = true;
      while (remaining) {
        const res = await apiPost<{ documentsProcessed: number }>(
          `/crm/import/batches/${batchId}/discover`,
          { limit: 10 },
        );
        remaining = res.documentsProcessed > 0;
      }
      await loadResults();
    } catch (err: any) {
      setRunError(err?.message ?? "Batch discovery failed");
    } finally {
      setRunning(false);
    }
  };

  const handleBatchIntelligence = async () => {
    if (!batchId) return;
    setRunning(true);
    setRunError(null);
    try {
      let remaining = true;
      while (remaining) {
        const res = await apiPost<{ contactsProcessed: number }>(
          `/crm/import/batches/${batchId}/intelligence`,
          { limit: 5 },
        );
        remaining = res.contactsProcessed > 0;
      }
      await loadResults();
    } catch (err: any) {
      setRunError(err?.message ?? "Batch intelligence generation failed");
    } finally {
      setRunning(false);
    }
  };

  const handleReject = async (docId: string) => {
    setWorkingDocId(docId);
    try {
      await apiPost(`/crm/drive/match/${docId}/reject`, {});
      setResults((prev) =>
        prev
          ? {
              ...prev,
              documents: prev.documents.map((d) =>
                d.id === docId
                  ? { ...d, status: "REJECTED" as const, reviewedAt: new Date().toISOString() }
                  : d,
              ),
            }
          : prev,
      );
    } catch (err: any) {
      alert(`Could not reject: ${err?.message ?? "unknown error"}`);
    } finally {
      setWorkingDocId(null);
    }
  };

  // Partition documents
  const pendingReview =
    results?.documents.filter((d) => d.status === "DISCOVERED") ?? [];
  const ambiguous = pendingReview.filter(
    (d) => d.matchConfidence === "AMBIGUOUS",
  );
  const clear = pendingReview.filter((d) => d.matchConfidence !== "AMBIGUOUS");
  const confirmed =
    results?.documents.filter((d) =>
      ["IMPORT_PENDING", "IMPORTING", "IMPORTED", "IMPORT_FAILED"].includes(d.status),
    ) ?? [];
  const rejected =
    results?.documents.filter((d) => d.status === "REJECTED") ?? [];

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 240,
          color: "var(--text-muted)",
          fontSize: "0.875rem",
        }}
      >
        <RefreshCw size={16} className="animate-spin" style={{ marginRight: 8 }} />
        Loading match results…
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: "2rem", maxWidth: 640, margin: "0 auto" }}>
        <button
          type="button"
          onClick={() => router.back()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            marginBottom: "1.5rem",
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: "0.875rem",
          }}
        >
          <ArrowLeft size={15} />
          Back
        </button>
        <div
          style={{
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.25)",
            borderRadius: "0.75rem",
            padding: "1rem",
            color: "#ef4444",
            fontSize: "0.875rem",
          }}
        >
          {error}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "1.5rem", maxWidth: 780, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: "1.5rem" }}>
        <Link
          href="/crm/import"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            color: "var(--text-muted)",
            textDecoration: "none",
            fontSize: "0.8rem",
            marginBottom: "0.75rem",
          }}
        >
          <ArrowLeft size={13} />
          Import batches
        </Link>
        <h1
          style={{
            fontSize: "1.375rem",
            fontWeight: 700,
            color: "var(--text)",
            margin: 0,
          }}
        >
          Drive Match Review
        </h1>
        {results?.batch && (
          <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 4 }}>
            <span style={{ fontWeight: 600 }}>
              {results.batch.fileName}
            </span>{" "}
            · imported {fmtDate(results.batch.createdAt)}
            {" · "}{results.batch.auditRowCount} of {results.batch.totalRows} rows captured for Drive match
          </p>
        )}
      </div>

      {/* Audit health warning — shown when Drive matching may be incomplete */}
      {results?.batch.auditWarning && (
        <div
          style={{
            padding: "0.7rem 0.9rem",
            background: "#fef2f2",
            border: "1px solid #fca5a5",
            borderRadius: "0.75rem",
            marginBottom: "1.25rem",
            fontSize: "0.8375rem",
            color: "#991b1b",
            display: "flex",
            alignItems: "flex-start",
            gap: "0.5rem",
          }}
        >
          <AlertTriangle size={15} style={{ marginTop: 1, flexShrink: 0 }} />
          <span>
            <strong>Drive match warning:</strong> {results.batch.auditWarning}
          </span>
        </div>
      )}

      {/* ── Process Batch panel ─────────────────────────────────────────── */}
      <ProcessBatchPanel
        batchId={batchId}
        run={pipelineRun}
        running={pipelineRunning}
        error={pipelineError}
        expanded={pipelineExpanded}
        onToggleExpand={() => setPipelineExpanded((v) => !v)}
        onStart={handleStartPipeline}
        onContinue={handleContinuePipeline}
      />

      {/* ── Diagnostics panel ───────────────────────────────────────── */}
      <DiagnosticsPanel
        batchId={batchId}
        diag={diagnostics}
        loading={diagnosticsLoading}
        expanded={diagnosticsExpanded}
        onToggleExpand={() => setDiagnosticsExpanded((v) => !v)}
        onRefresh={loadDiagnostics}
      />

      {/* Run Drive Match button */}
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "0.875rem",
          padding: "1rem 1.25rem",
          marginBottom: "1.5rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <div>
          <p style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--text)", margin: 0 }}>
            Google Drive Match
          </p>
          <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 2 }}>
            Scans your configured Drive folder and matches files to imported companies.
            {results && results.documents.length > 0
              ? ` ${results.documents.length} match${results.documents.length !== 1 ? "es" : ""} found so far.`
              : ""}
          </p>
        </div>
        <button
          type="button"
          disabled={running}
          onClick={handleRunMatch}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "0.5rem 1.25rem",
            borderRadius: "0.5rem",
            background: "var(--accent)",
            border: "none",
            color: "#fff",
            fontSize: "0.875rem",
            fontWeight: 600,
            cursor: running ? "not-allowed" : "pointer",
            opacity: running ? 0.7 : 1,
            flexShrink: 0,
          }}
        >
          {running ? (
            <RefreshCw size={14} className="animate-spin" />
          ) : (
            <Play size={14} />
          )}
          {running ? "Matching…" : "Run Drive Match"}
        </button>
      </div>

      {/* Run result toast */}
      {runResult && (
        <div
          style={{
            background: "rgba(16,185,129,0.08)",
            border: "1px solid rgba(16,185,129,0.25)",
            borderRadius: "0.75rem",
            padding: "0.875rem 1rem",
            marginBottom: "1.5rem",
            fontSize: "0.875rem",
            color: "var(--text)",
          }}
        >
          <p style={{ fontWeight: 600, color: "#10b981", marginBottom: 4 }}>
            Match run complete
          </p>
          <p style={{ margin: 0 }}>
            Scanned {runResult.filesScanned} files · {runResult.matchesCreated} match
            {runResult.matchesCreated !== 1 ? "es" : ""} created
            {runResult.duplicatesSkipped > 0 ? ` · ${runResult.duplicatesSkipped} already matched (skipped)` : ""}
            {runResult.ambiguousMatches > 0
              ? ` · ${runResult.ambiguousMatches} need review`
              : ""}
          </p>
        </div>
      )}
      {runError && (
        <div
          style={{
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.25)",
            borderRadius: "0.75rem",
            padding: "0.875rem 1rem",
            marginBottom: "1.5rem",
            fontSize: "0.875rem",
            color: "#ef4444",
          }}
        >
          {runError}
        </div>
      )}

      {/* Ambiguous matches — top priority */}
      {ambiguous.length > 0 && (
        <section style={{ marginBottom: "2rem" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: "0.875rem",
            }}
          >
            <AlertTriangle size={16} style={{ color: "#f59e0b" }} />
            <h2
              style={{
                fontSize: "0.875rem",
                fontWeight: 700,
                color: "var(--text)",
                margin: 0,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
              }}
            >
              Ambiguous Matches — Review Required ({ambiguous.length})
            </h2>
          </div>
          <p
            style={{
              fontSize: "0.8rem",
              color: "var(--text-muted)",
              marginBottom: "0.875rem",
            }}
          >
            These files matched multiple companies (or vice-versa). Attach or
            ignore each one.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {ambiguous.map((doc) => (
              <DocumentCard
                key={doc.id}
                doc={doc}
                onConfirm={handleConfirm}
                onReject={handleReject}
                onImport={handleImport}
                onExtract={handleExtract}
                onViewText={handleViewText}
                onDiscover={handleDiscover}
                working={workingDocId === doc.id}
              />
            ))}
          </div>
        </section>
      )}

      {/* Clear matches */}
      {clear.length > 0 && (
        <section style={{ marginBottom: "2rem" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: "0.875rem",
            }}
          >
            <CheckCircle size={16} style={{ color: "#10b981" }} />
            <h2
              style={{
                fontSize: "0.875rem",
                fontWeight: 700,
                color: "var(--text)",
                margin: 0,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
              }}
            >
              Matched Documents — Pending Review ({clear.length})
            </h2>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {clear.map((doc) => (
              <DocumentCard
                key={doc.id}
                doc={doc}
                onConfirm={handleConfirm}
                onReject={handleReject}
                onImport={handleImport}
                onExtract={handleExtract}
                onViewText={handleViewText}
                onDiscover={handleDiscover}
                working={workingDocId === doc.id}
              />
            ))}
          </div>
        </section>
      )}

      {/* Confirmed + imported */}
      {confirmed.length > 0 && (() => {
        const pendingImport = confirmed.filter((d) => d.status === "IMPORT_PENDING").length;
        const importedCount = confirmed.filter((d) => d.status === "IMPORTED").length;
        const failedCount = confirmed.filter((d) => d.status === "IMPORT_FAILED").length;
        const textComplete = confirmed.filter((d) => d.textExtractionStatus === "TEXT_COMPLETE").length;
        const textFailed = confirmed.filter((d) => d.textExtractionStatus === "TEXT_FAILED").length;
        const textPending = confirmed.filter(
          (d) => d.status === "IMPORTED" && (d.textExtractionStatus == null || d.textExtractionStatus === "TEXT_PENDING"),
        ).length;
        return (
          <section style={{ marginBottom: "2rem" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.875rem" }}>
              <h2
                style={{
                  fontSize: "0.875rem",
                  fontWeight: 700,
                  color: "var(--text)",
                  margin: 0,
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                }}
              >
                Confirmed ({confirmed.length})
                {importedCount > 0 && <span style={{ color: "#059669", marginLeft: "0.5rem" }}>· {importedCount} imported</span>}
                {failedCount > 0 && <span style={{ color: "#dc2626", marginLeft: "0.5rem" }}>· {failedCount} failed</span>}
                {textComplete > 0 && <span style={{ color: "#7c3aed", marginLeft: "0.5rem" }}>· {textComplete} text extracted</span>}
                {textFailed > 0 && <span style={{ color: "#d97706", marginLeft: "0.5rem" }}>· {textFailed} extraction failed</span>}
              </h2>
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                {pendingImport > 0 && (
                  <button
                    type="button"
                    disabled={running}
                    onClick={handleBatchImport}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "0.4rem 1rem",
                      borderRadius: "0.5rem",
                      background: "var(--accent)",
                      border: "none",
                      color: "#fff",
                      fontSize: "0.8125rem",
                      fontWeight: 600,
                      cursor: running ? "not-allowed" : "pointer",
                      opacity: running ? 0.7 : 1,
                    }}
                  >
                    {running ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />}
                    Import all ({pendingImport})
                  </button>
                )}
                {(textPending > 0 || textFailed > 0) && importedCount > 0 && (
                  <button
                    type="button"
                    disabled={running}
                    onClick={handleBatchExtract}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "0.4rem 1rem",
                      borderRadius: "0.5rem",
                      background: "rgba(139,92,246,0.12)",
                      border: "1px solid rgba(139,92,246,0.3)",
                      color: "#7c3aed",
                      fontSize: "0.8125rem",
                      fontWeight: 600,
                      cursor: running ? "not-allowed" : "pointer",
                      opacity: running ? 0.7 : 1,
                    }}
                  >
                    {running ? <RefreshCw size={13} className="animate-spin" /> : <ScanText size={13} />}
                    Extract text ({textPending + textFailed})
                  </button>
                )}
                {textComplete > 0 && (
                  <button
                    type="button"
                    disabled={running}
                    onClick={handleBatchDiscover}
                    title="Run contact discovery on extracted documents to find phones and emails"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "0.4rem 1rem",
                      borderRadius: "0.5rem",
                      background: "rgba(16,185,129,0.1)",
                      border: "1px solid rgba(16,185,129,0.3)",
                      color: "#10b981",
                      fontSize: "0.8125rem",
                      fontWeight: 600,
                      cursor: running ? "not-allowed" : "pointer",
                      opacity: running ? 0.7 : 1,
                    }}
                  >
                    {running ? <RefreshCw size={13} className="animate-spin" /> : <Radar size={13} />}
                    Run Discovery ({textComplete})
                  </button>
                )}
                {importedCount > 0 && (
                  <button
                    type="button"
                    disabled={running}
                    onClick={handleBatchIntelligence}
                    title="Generate AI lead intelligence reports for contacts in this batch"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "0.4rem 1rem",
                      borderRadius: "0.5rem",
                      background: "rgba(99,102,241,0.1)",
                      border: "1px solid rgba(99,102,241,0.3)",
                      color: "#818cf8",
                      fontSize: "0.8125rem",
                      fontWeight: 600,
                      cursor: running ? "not-allowed" : "pointer",
                      opacity: running ? 0.7 : 1,
                    }}
                  >
                    {running ? <RefreshCw size={13} className="animate-spin" /> : <Sparkles size={13} />}
                    Generate Intelligence
                  </button>
                )}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {confirmed.map((doc) => (
                <DocumentCard
                  key={doc.id}
                  doc={doc}
                  onConfirm={handleConfirm}
                  onReject={handleReject}
                  onImport={handleImport}
                  onExtract={handleExtract}
                  onViewText={handleViewText}
                  onDiscover={handleDiscover}
                  working={workingDocId === doc.id}
                />
              ))}
            </div>
          </section>
        );
      })()}

      {/* Unmatched companies */}
      {results && results.unmatchedCompanies.length > 0 && (
        <section style={{ marginBottom: "2rem" }}>
          <h2
            style={{
              fontSize: "0.875rem",
              fontWeight: 700,
              color: "var(--text)",
              margin: "0 0 0.875rem",
              textTransform: "uppercase",
              letterSpacing: "0.12em",
            }}
          >
            Unmatched Companies ({results.unmatchedCompanies.length})
          </h2>
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "0.75rem",
              overflow: "hidden",
            }}
          >
            {results.unmatchedCompanies.map((name, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "0.625rem 1rem",
                  borderBottom:
                    i < results.unmatchedCompanies.length - 1
                      ? "1px solid var(--border)"
                      : "none",
                  fontSize: "0.875rem",
                  color: "var(--text-muted)",
                }}
              >
                <Building2 size={13} />
                {name}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Rejected */}
      {rejected.length > 0 && (
        <section style={{ marginBottom: "2rem" }}>
          <h2
            style={{
              fontSize: "0.875rem",
              fontWeight: 700,
              color: "var(--text-muted)",
              margin: "0 0 0.875rem",
              textTransform: "uppercase",
              letterSpacing: "0.12em",
            }}
          >
            Ignored ({rejected.length})
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {rejected.map((doc) => (
              <DocumentCard
                key={doc.id}
                doc={doc}
                onConfirm={handleConfirm}
                onReject={handleReject}
                onImport={handleImport}
                onExtract={handleExtract}
                onViewText={handleViewText}
                onDiscover={handleDiscover}
                working={workingDocId === doc.id}
              />
            ))}
          </div>
        </section>
      )}

      {/* Empty state */}
      {results &&
        results.documents.length === 0 &&
        results.unmatchedCompanies.length === 0 && (
          <div
            style={{
              textAlign: "center",
              padding: "3rem 1rem",
              color: "var(--text-muted)",
            }}
          >
            <Clock size={32} style={{ margin: "0 auto 1rem", opacity: 0.4 }} />
            <p style={{ fontSize: "0.9rem", fontWeight: 600, marginBottom: 4 }}>
              No matches yet
            </p>
            <p style={{ fontSize: "0.8rem" }}>
              Click <strong>Run Drive Match</strong> to scan your Drive folder
              for files matching this import.
            </p>
          </div>
        )}

      {/* Extracted text view modal */}
      {viewTextDoc && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
          }}
          onClick={() => setViewTextDoc(null)}
        >
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "0.875rem",
              padding: "1.5rem",
              maxWidth: 680,
              width: "100%",
              maxHeight: "80vh",
              display: "flex",
              flexDirection: "column",
              gap: "1rem",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <ScanText size={16} style={{ color: "#7c3aed" }} />
                  <h3 style={{ fontSize: "1rem", fontWeight: 700, margin: 0 }}>
                    Extracted Text
                  </h3>
                </div>
                <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", margin: 0 }}>
                  {viewTextDoc.fileName}
                  {viewTextDoc.charCount > 0 && ` · ${viewTextDoc.charCount.toLocaleString()} chars`}
                  {viewTextDoc.pageCount != null && ` · ${viewTextDoc.pageCount} page${viewTextDoc.pageCount !== 1 ? "s" : ""}`}
                  {viewTextDoc.provider && ` · via ${viewTextDoc.provider}`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setViewTextDoc(null)}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "var(--text-muted)",
                  fontSize: "1.25rem",
                  lineHeight: 1,
                  flexShrink: 0,
                }}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                background: "var(--surface-hover)",
                border: "1px solid var(--border)",
                borderRadius: "0.5rem",
                padding: "1rem",
                fontSize: "0.8125rem",
                lineHeight: 1.6,
                color: "var(--text)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                maxHeight: "50vh",
              }}
            >
              {viewTextDoc.text || (
                <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
                  No text content available.
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
