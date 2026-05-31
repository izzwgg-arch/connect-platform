"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft, Phone, Mail, Clock, User, MessageSquareDot, Trash2,
  Circle, Plus, CheckCheck, GitMerge, AlertTriangle, Calendar,
  ChevronRight, Sparkles, Star, MoreVertical, Voicemail, NotebookPen,
  FileText, Files, ListTodo, ClipboardCheck, Activity, ScanText, Brain,
} from "lucide-react";
import {
  CRMPageShell,
  CRMCard,
  crm,
  ContactContextBar,
  ContactCampaignStickyHeader,
  ContactWorkspaceTabBar,
  ContactCampaignLeadNav,
  ContactCollapsibleSection,
  CRM_PHONE_TYPE_OPTIONS,
  workspaceTabLabel,
  buildCampaignContactHref,
  campaignLeadNeighbors,
  findCampaignMemberIndex,
  phoneSummaryLabel,
  phoneTypeLabel,
  resolvePhoneAction,
  sortCampaignNavMembers,
  type CampaignNavMember,
  type WorkspacePhone,
  LiveWorkspaceScriptPanel,
  LiveWorkspaceChecklistPanel,
  ContactTimeline,
  ContactSmsPanel,
  ContactRelationshipHealth,
  type CrmContactDetail,
  type CrmStage,
  type CrmTask,
  type DuplicateContact,
  type QueueContextMember,
  type TimelineEvent,
  STAGE_OPTIONS,
  TASK_PRIORITY_COLOR,
  formatDate,
  formatTimeAgo,
  stageColor,
  stageLabel,
  cn,
} from "../../../../../components/crm";
import { leadTimezoneDetailLabel, leadTimezoneBadgeTitle } from "../../../../../components/crm/contact/leadTimezoneDisplay";
import { ContactDocumentSummary } from "../../../../../components/crm/contact/ContactDocumentSummary";
import { DISPOSITION_OPTIONS, type Checklist, type ScriptSummary } from "../../../../../components/crm/live";
import { CrmEmailComposeDrawer } from "../../../../../components/crm/email/CrmEmailComposeDrawer";
import { CrmVoicemailDropDrawer } from "../../../../../components/crm/voicemail-drops/CrmVoicemailDropDrawer";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { apiGet, apiPatch, apiPost, apiDelete, apiFetchBlob } from "../../../../../services/apiClient";
import { useAppContext } from "../../../../../hooks/useAppContext";
import { useSipPhone } from "../../../../../hooks/useSipPhone";
import { useTelephony } from "../../../../../contexts/TelephonyContext";
import type { QueueMember } from "../../../../../components/crm/queue/queueTypes";

// ── Shared form styles (edit panels) ─────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.4375rem 0.625rem",
  border: "1px solid var(--border)",
  borderRadius: "0.375rem",
  background: "var(--surface-hover)",
  color: "var(--text)",
  fontSize: "0.875rem",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "var(--text-dim)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  marginBottom: "0.3rem",
};

const btnSmall: React.CSSProperties = {
  padding: "0.25rem 0.625rem",
  fontSize: "0.8125rem",
  borderRadius: "0.3rem",
  border: "1px solid var(--border)",
  cursor: "pointer",
  background: "var(--surface-hover)",
  color: "var(--text-dim)",
};

type ContactWorkspaceTab =
  | "timeline"
  | "script"
  | "checklist"
  | "email"
  | "sms"
  | "notes"
  | "files"
  | "discoveries"
  | "intelligence"
  | "tasks";

function HeaderMetric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone: "violet" | "emerald" | "slate";
}) {
  const toneClass =
    tone === "violet"
      ? "bg-violet-500/10 text-violet-500"
      : tone === "emerald"
        ? "bg-emerald-500/10 text-emerald-600"
        : "bg-crm-surface-2 text-crm-text";
  return (
    <div className="min-w-0 rounded-[1.1rem] border border-crm-border/70 bg-crm-surface-2/45 px-3 py-2.5">
      <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-crm-muted">{label}</p>
      <p className={cn("mt-1 truncate rounded-full px-2 py-0.5 text-sm font-black tabular-nums", toneClass)}>
        {value}
      </p>
      {sub ? <p className="mt-1 truncate text-[11px] font-semibold text-crm-muted">{sub}</p> : null}
    </div>
  );
}

function CommandButton({
  icon,
  label,
  active,
  disabled,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-bold transition-colors",
        active
          ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-600"
          : "border-crm-border bg-crm-surface-2 text-crm-text hover:bg-crm-surface",
        "disabled:cursor-not-allowed disabled:border-crm-border/60 disabled:bg-crm-surface-2/50 disabled:text-crm-muted",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function phoneDigits(value: string | null | undefined): string {
  return String(value || "").replace(/\D/g, "");
}

export default function CrmContactDetailPage() {
  return (
    <Suspense fallback={<ContactPageFallback />}>
      <CrmContactDetailInner />
    </Suspense>
  );
}

function ContactPageFallback() {
  return <div className="py-24 text-center text-sm text-crm-muted">Loading contact…</div>;
}

// ── Drive Documents panel (files tab) ─────────────────────────────────────────

type DriveLeadDoc = {
  id: string;
  googleDriveFileId: string | null;
  originalFileName: string;
  mimeType: string | null;
  importedMimeType: string | null;
  sizeBytes: number | null;
  status: string;
  matchConfidence: string | null;
  driveViewUrl: string | null;
  importedAt: string | null;
  importError: string | null;
  textExtractionStatus: string | null;
  textExtractionError: string | null;
  createdAt: string;
};

function fmtDocSize(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function ContactDriveDocuments({ contactId }: { contactId: string }) {
  const [docs, setDocs] = useState<DriveLeadDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [extractingId, setExtractingId] = useState<string | null>(null);
  const [viewTextDoc, setViewTextDoc] = useState<{
    id: string;
    fileName: string;
    text: string;
    charCount: number;
    pageCount: number | null;
    provider: string | null;
    confidence: number | null;
    ocrLang: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    apiGet<{ documents: DriveLeadDoc[] }>(`/crm/contacts/${contactId}/documents`)
      .then((res) => {
        if (!cancelled) setDocs(res.documents);
      })
      .catch((e: any) => {
        if (!cancelled) setErr(e?.message ?? "Failed to load documents.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [contactId]);

  const handleDocOpen = async (docId: string) => {
    const doc = docs.find((d) => d.id === docId);
    if (doc?.status === "IMPORTED") {
      try {
        // Fetch a short-lived signed URL (requires JWT auth), then fetch the
        // document binary with auth headers, and open as a blob URL.
        // window.open(signedUrl) alone drops the Authorization header and is denied.
        const res = await apiGet<{ signedUrl: string }>(`/crm/documents/${docId}/open-url`);
        const blob = await apiFetchBlob(res.signedUrl);
        const blobUrl = URL.createObjectURL(blob);
        window.open(blobUrl, "_blank", "noopener,noreferrer");
        setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
      } catch (e: any) {
        alert(`Could not open document: ${e?.message ?? "error"}`);
      }
      return;
    }
    setImportingId(docId);
    try {
      const result = await apiPost<{ status: string; errorMessage?: string; importedMimeType?: string }>(
        `/crm/documents/${docId}/import`,
        {},
      );
      setDocs((prev) =>
        prev.map((d) =>
          d.id === docId
            ? {
                ...d,
                status: result.status === "IMPORTED" ? "IMPORTED" : "IMPORT_FAILED",
                importedAt: result.status === "IMPORTED" ? new Date().toISOString() : null,
                importError: result.errorMessage ?? null,
                importedMimeType: result.importedMimeType ?? null,
              }
            : d,
        ),
      );
    } catch (e: any) {
      alert(`Import failed: ${e?.message ?? "error"}`);
    } finally {
      setImportingId(null);
    }
  };

  const handleExtract = async (docId: string) => {
    setExtractingId(docId);
    try {
      await apiPost(`/crm/documents/${docId}/text-extraction`, {});
      // Refresh the doc list to pick up new textExtractionStatus
      const res = await apiGet<{ documents: DriveLeadDoc[] }>(`/crm/contacts/${contactId}/documents`);
      setDocs(res.documents);
    } catch (e: any) {
      alert(`Text extraction failed: ${e?.message ?? "error"}`);
    } finally {
      setExtractingId(null);
    }
  };

  const handleViewText = async (docId: string) => {
    const doc = docs.find((d) => d.id === docId);
    try {
      const res = await apiGet<{
        text: string | null;
        charCount: number | null;
        pageCount: number | null;
        extractionProvider: string | null;
        extractionConfidence: number | null;
        extractionMetadata: Record<string, unknown> | null;
        originalFileName: string;
      }>(`/crm/documents/${docId}/text-extraction`);
      setViewTextDoc({
        id: docId,
        fileName: res.originalFileName ?? doc?.originalFileName ?? "Document",
        text: res.text ?? "",
        charCount: res.charCount ?? 0,
        pageCount: res.pageCount ?? null,
        provider: res.extractionProvider ?? null,
        confidence: res.extractionConfidence ?? null,
        ocrLang: typeof res.extractionMetadata?.language === "string"
          ? (res.extractionMetadata.language as string)
          : null,
      });
    } catch (e: any) {
      alert(`Could not load extracted text: ${e?.message ?? "error"}`);
    }
  };

  if (loading) {
    return (
      <div className="rounded-[1.35rem] border border-crm-border/70 bg-crm-surface-2/45 p-6 text-center text-sm text-crm-muted">
        Loading documents…
      </div>
    );
  }

  if (err) {
    return (
      <div className="rounded-[1.35rem] border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-400">
        {err}
      </div>
    );
  }

  if (docs.length === 0) {
    return (
      <div className="rounded-[1.35rem] border border-dashed border-crm-border/80 bg-crm-surface-2/40 p-8 text-center">
        <Files className="mx-auto h-8 w-8 text-crm-muted" />
        <p className="mt-3 text-sm font-semibold text-crm-text">No Drive documents attached yet.</p>
        <p className="mt-1 text-sm text-crm-muted">
          Upload a lead sheet and run Drive Match to automatically find and attach files from Google Drive.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-[1.35rem] border border-crm-border/70 bg-crm-surface-2/45 p-4">
      <div className="mb-3">
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-crm-accent">
          Google Drive Documents
        </p>
        <h3 className="text-lg font-bold text-crm-text">
          {docs.length} attached file{docs.length !== 1 ? "s" : ""}
        </h3>
      </div>
      <div className="flex flex-col gap-2">
        {docs.map((doc) => (
          <div
            key={doc.id}
            className="flex items-start gap-3 rounded-xl border border-crm-border/60 bg-crm-surface p-3"
          >
            <FileText className="h-4 w-4 shrink-0 text-crm-muted mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-crm-text">
                {doc.originalFileName}
              </p>
              <p className="mt-0.5 text-xs text-crm-muted">
                {fmtDocSize(doc.sizeBytes)}
                {(doc.importedMimeType || doc.mimeType)
                  ? ` · ${(doc.importedMimeType || doc.mimeType)!.split("/").pop()}`
                  : ""}
                {" · "}
                {new Date(doc.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
                {" · "}
                <span
                  className={cn(
                    "font-medium",
                    doc.status === "IMPORTED"
                      ? "text-crm-success"
                      : doc.status === "IMPORT_PENDING"
                        ? "text-crm-accent"
                        : doc.status === "IMPORT_FAILED"
                          ? "text-red-400"
                          : doc.status === "REJECTED"
                            ? "text-red-400"
                            : "text-crm-muted",
                  )}
                >
                  {doc.status === "DISCOVERED"
                    ? "Pending review"
                    : doc.status === "IMPORT_PENDING"
                      ? "Confirmed — ready to import"
                      : doc.status === "IMPORTING"
                        ? "Importing…"
                        : doc.status === "IMPORTED"
                          ? "Imported"
                          : doc.status === "IMPORT_FAILED"
                            ? "Import failed"
                            : doc.status === "REJECTED"
                              ? "Ignored"
                              : doc.status}
                </span>
                {doc.importError && (
                  <span className="ml-1 text-red-400" title={doc.importError}>
                    (see error)
                  </span>
                )}
                {doc.status === "IMPORTED" && doc.textExtractionStatus === "TEXT_COMPLETE" && (
                  <span className="ml-2 text-purple-400">· Text extracted</span>
                )}
                {doc.status === "IMPORTED" && doc.textExtractionStatus === "TEXT_FAILED" && (
                  <span
                    className="ml-2 text-amber-400"
                    title={
                      doc.textExtractionError?.includes("scanned_pdf") || doc.textExtractionError?.includes("Scanned PDF")
                        ? "Scanned PDF — PDF OCR not configured. Import the document as an image (PNG/JPG) to use OCR."
                        : doc.textExtractionError?.includes("ocr_not_enabled") || doc.textExtractionError?.includes("OCR is not enabled")
                          ? "OCR is not enabled. Set CRM_OCR_ENABLED=true in the API environment."
                          : doc.textExtractionError?.includes("ocr_file_too_large") || doc.textExtractionError?.includes("exceeds OCR limit")
                            ? "File too large for OCR."
                            : doc.textExtractionError ?? "Extraction failed"
                    }
                  >
                    · Extraction failed
                  </span>
                )}
                {doc.status === "IMPORTED" && doc.textExtractionStatus === "TEXT_PROCESSING" && (
                  <span className="ml-2 text-blue-400">· Extracting…</span>
                )}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {doc.status === "IMPORTED" && (
                <button
                  type="button"
                  onClick={() => handleDocOpen(doc.id)}
                  disabled={importingId === doc.id}
                  className="rounded-lg border border-crm-border/60 bg-crm-surface-2/50 px-2.5 py-1 text-xs font-semibold text-crm-muted hover:text-crm-text transition-colors"
                >
                  Open document
                </button>
              )}
              {doc.status === "IMPORTED" && doc.textExtractionStatus === "TEXT_COMPLETE" && (
                <button
                  type="button"
                  onClick={() => handleViewText(doc.id)}
                  className="rounded-lg border border-purple-500/30 bg-purple-500/10 px-2.5 py-1 text-xs font-semibold text-purple-400 hover:bg-purple-500/20 transition-colors"
                >
                  View text
                </button>
              )}
              {doc.status === "IMPORTED" &&
                (doc.textExtractionStatus == null ||
                  doc.textExtractionStatus === "TEXT_PENDING" ||
                  doc.textExtractionStatus === "TEXT_FAILED") && (
                <button
                  type="button"
                  onClick={() => handleExtract(doc.id)}
                  disabled={extractingId === doc.id}
                  title={
                    doc.textExtractionStatus === "TEXT_FAILED"
                      ? doc.textExtractionError
                        ? doc.textExtractionError.includes("scanned_pdf") || doc.textExtractionError.includes("Scanned PDF")
                          ? "Scanned PDF — PDF page rasterization not configured. Only image files (PNG/JPG) support OCR."
                          : doc.textExtractionError.includes("ocr_not_enabled") || doc.textExtractionError.includes("OCR is not enabled")
                            ? "OCR is not enabled. Set CRM_OCR_ENABLED=true in the API environment to process image files."
                            : doc.textExtractionError.includes("ocr_file_too_large") || doc.textExtractionError.includes("exceeds OCR limit")
                              ? "File is too large for OCR. Adjust CRM_OCR_MAX_FILE_BYTES in the API environment."
                              : doc.textExtractionError
                        : "Retry text extraction"
                      : "Extract text from document"
                  }
                  className="rounded-lg border border-purple-500/30 bg-purple-500/8 px-2.5 py-1 text-xs font-semibold text-purple-400 hover:bg-purple-500/20 transition-colors"
                >
                  {extractingId === doc.id
                    ? "Extracting…"
                    : doc.textExtractionStatus === "TEXT_FAILED"
                      ? "Retry extraction"
                      : "Extract text"}
                </button>
              )}
              {(doc.status === "IMPORT_PENDING" || doc.status === "IMPORT_FAILED") && (
                <button
                  type="button"
                  onClick={() => handleDocOpen(doc.id)}
                  disabled={importingId === doc.id}
                  className="rounded-lg border border-crm-border/60 bg-crm-accent/10 px-2.5 py-1 text-xs font-semibold text-crm-accent hover:bg-crm-accent/20 transition-colors"
                >
                  {importingId === doc.id
                    ? "Importing…"
                    : doc.status === "IMPORT_FAILED"
                      ? "Retry import"
                      : "Import document"}
                </button>
              )}
              {doc.driveViewUrl && (
                <a
                  href={doc.driveViewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-lg border border-crm-border/60 bg-crm-surface-2/50 px-2.5 py-1 text-xs font-semibold text-crm-muted hover:text-crm-text transition-colors"
                >
                  View in Drive
                </a>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Extracted text view modal */}
      {viewTextDoc && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setViewTextDoc(null)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-2xl flex-col gap-4 rounded-[0.875rem] border border-crm-border bg-crm-surface p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-purple-400">Extracted Text</p>
                <p className="mt-0.5 text-sm font-semibold text-crm-text">{viewTextDoc.fileName}</p>
                <p className="text-xs text-crm-muted">
                  {viewTextDoc.charCount > 0 && `${viewTextDoc.charCount.toLocaleString()} chars`}
                  {viewTextDoc.pageCount != null && ` · ${viewTextDoc.pageCount} page${viewTextDoc.pageCount !== 1 ? "s" : ""}`}
                  {viewTextDoc.provider && ` · ${viewTextDoc.provider}`}
                  {viewTextDoc.ocrLang && ` · lang: ${viewTextDoc.ocrLang}`}
                  {viewTextDoc.confidence !== null && (
                    <span
                      className={
                        viewTextDoc.confidence >= 70
                          ? " · OCR confidence: " + Math.round(viewTextDoc.confidence) + "% ✓"
                          : viewTextDoc.confidence >= 40
                            ? " · OCR confidence: " + Math.round(viewTextDoc.confidence) + "% (medium)"
                            : " · OCR confidence: " + Math.round(viewTextDoc.confidence) + "% (low — review carefully)"
                      }
                      style={{
                        color: viewTextDoc.confidence >= 70 ? "#10b981" : viewTextDoc.confidence >= 40 ? "#f59e0b" : "#ef4444",
                      }}
                    >
                      {" · OCR confidence: " + Math.round(viewTextDoc.confidence) + "%"}
                    </span>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setViewTextDoc(null)}
                className="shrink-0 text-xl leading-none text-crm-muted hover:text-crm-text"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto rounded-lg border border-crm-border/60 bg-crm-surface-2/60 p-4 font-mono text-[0.8125rem] leading-relaxed text-crm-text whitespace-pre-wrap break-words">
              {viewTextDoc.text || (
                <span className="italic text-crm-muted">No text content available.</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── ContactDiscoveries panel (discoveries tab) ────────────────────────────────

type DiscoveredPhoneItem = {
  id: string;
  phoneNumber: string;
  normalizedPhone: string;
  confidence: string;
  sourceSnippet: string | null;
  status: "PENDING" | "ACCEPTED" | "REJECTED";
  createdAt: string;
  document: { id: string; originalFileName: string } | null;
};

type DiscoveredEmailItem = {
  id: string;
  email: string;
  confidence: string;
  sourceSnippet: string | null;
  status: "PENDING" | "ACCEPTED" | "REJECTED";
  createdAt: string;
  document: { id: string; originalFileName: string } | null;
};

function ContactDiscoveries({ contactId }: { contactId: string }) {
  const [phones, setPhones] = useState<DiscoveredPhoneItem[]>([]);
  const [emails, setEmails] = useState<DiscoveredEmailItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [runningDiscovery, setRunningDiscovery] = useState(false);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await apiGet<{ phones: DiscoveredPhoneItem[]; emails: DiscoveredEmailItem[] }>(
        `/crm/contacts/${contactId}/discoveries`,
      );
      setPhones(res.phones ?? []);
      setEmails(res.emails ?? []);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load discoveries.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [contactId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAcceptPhone = async (id: string) => {
    setWorking(id);
    try {
      await apiPost(`/crm/discoveries/phones/${id}/accept`, {});
      setPhones((prev) => prev.filter((p) => p.id !== id));
    } catch (e: any) {
      alert(`Could not accept: ${e?.message ?? "error"}`);
    } finally {
      setWorking(null);
    }
  };

  const handleRejectPhone = async (id: string) => {
    setWorking(id);
    try {
      await apiPost(`/crm/discoveries/phones/${id}/reject`, {});
      setPhones((prev) => prev.filter((p) => p.id !== id));
    } catch (e: any) {
      alert(`Could not reject: ${e?.message ?? "error"}`);
    } finally {
      setWorking(null);
    }
  };

  const handleAcceptEmail = async (id: string) => {
    setWorking(id);
    try {
      await apiPost(`/crm/discoveries/emails/${id}/accept`, {});
      setEmails((prev) => prev.filter((e) => e.id !== id));
    } catch (e: any) {
      alert(`Could not accept: ${e?.message ?? "error"}`);
    } finally {
      setWorking(null);
    }
  };

  const handleRejectEmail = async (id: string) => {
    setWorking(id);
    try {
      await apiPost(`/crm/discoveries/emails/${id}/reject`, {});
      setEmails((prev) => prev.filter((e) => e.id !== id));
    } catch (e: any) {
      alert(`Could not reject: ${e?.message ?? "error"}`);
    } finally {
      setWorking(null);
    }
  };

  if (loading) {
    return (
      <div className="rounded-[1.35rem] border border-crm-border/70 bg-crm-surface-2/45 p-6 text-center text-sm text-crm-muted">
        Loading discoveries…
      </div>
    );
  }

  if (err) {
    return (
      <div className="rounded-[1.35rem] border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-400">
        {err}
      </div>
    );
  }

  const hasDiscoveries = phones.length > 0 || emails.length > 0;

  if (!hasDiscoveries) {
    return (
      <div className="rounded-[1.35rem] border border-dashed border-crm-border/80 bg-crm-surface-2/40 p-8 text-center">
        <ScanText className="mx-auto h-8 w-8 text-crm-muted" />
        <p className="mt-3 text-sm font-semibold text-crm-text">No pending discoveries.</p>
        <p className="mt-1 text-sm text-crm-muted">
          Import documents, extract their text, then click{" "}
          <strong>Run Discovery</strong> on the document to find phones and emails.
        </p>
      </div>
    );
  }

  const confidenceBadge = (c: string) =>
    c === "HIGH"
      ? "inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-400"
      : "inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-400";

  return (
    <div className="flex flex-col gap-4">
      {phones.length > 0 && (
        <div className="rounded-[1.35rem] border border-crm-border/70 bg-crm-surface-2/45 p-4">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.16em] text-purple-400">
            Discovered Phone Numbers ({phones.length})
          </p>
          <div className="flex flex-col gap-2">
            {phones.map((p) => (
              <div
                key={p.id}
                className="flex items-start gap-3 rounded-xl border border-crm-border/60 bg-crm-surface p-3"
              >
                <Phone className="h-4 w-4 shrink-0 text-crm-muted mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-crm-text">{p.phoneNumber}</span>
                    <span className={confidenceBadge(p.confidence)}>{p.confidence}</span>
                  </div>
                  {p.document && (
                    <p className="mt-0.5 text-xs text-crm-muted truncate">
                      From: {p.document.originalFileName}
                    </p>
                  )}
                  {p.sourceSnippet && (
                    <p className="mt-1 rounded bg-crm-surface-2/60 px-2 py-1 text-xs text-crm-muted italic leading-relaxed">
                      …{p.sourceSnippet.slice(0, 150)}…
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    type="button"
                    disabled={working === p.id}
                    onClick={() => handleAcceptPhone(p.id)}
                    className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                  >
                    {working === p.id ? "…" : "Accept"}
                  </button>
                  <button
                    type="button"
                    disabled={working === p.id}
                    onClick={() => handleRejectPhone(p.id)}
                    className="rounded-lg border border-red-500/25 bg-red-500/8 px-2.5 py-1 text-xs font-semibold text-red-400 hover:bg-red-500/15 transition-colors"
                  >
                    {working === p.id ? "…" : "Reject"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {emails.length > 0 && (
        <div className="rounded-[1.35rem] border border-crm-border/70 bg-crm-surface-2/45 p-4">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.16em] text-purple-400">
            Discovered Emails ({emails.length})
          </p>
          <div className="flex flex-col gap-2">
            {emails.map((e) => (
              <div
                key={e.id}
                className="flex items-start gap-3 rounded-xl border border-crm-border/60 bg-crm-surface p-3"
              >
                <Mail className="h-4 w-4 shrink-0 text-crm-muted mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-crm-text">{e.email}</span>
                    <span className={confidenceBadge(e.confidence)}>{e.confidence}</span>
                  </div>
                  {e.document && (
                    <p className="mt-0.5 text-xs text-crm-muted truncate">
                      From: {e.document.originalFileName}
                    </p>
                  )}
                  {e.sourceSnippet && (
                    <p className="mt-1 rounded bg-crm-surface-2/60 px-2 py-1 text-xs text-crm-muted italic leading-relaxed">
                      …{e.sourceSnippet.slice(0, 150)}…
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    type="button"
                    disabled={working === e.id}
                    onClick={() => handleAcceptEmail(e.id)}
                    className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                  >
                    {working === e.id ? "…" : "Accept"}
                  </button>
                  <button
                    type="button"
                    disabled={working === e.id}
                    onClick={() => handleRejectEmail(e.id)}
                    className="rounded-lg border border-red-500/25 bg-red-500/8 px-2.5 py-1 text-xs font-semibold text-red-400 hover:bg-red-500/15 transition-colors"
                  >
                    {working === e.id ? "…" : "Reject"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── ContactIntelligence panel (AI Intelligence tab) ───────────────────────────

type IntelligenceReport = {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETE" | "FAILED";
  summary: string | null;
  businessOverview: string | null;
  keyFindings: Record<string, unknown> | null;
  discoveredEntities: Record<string, unknown> | null;
  riskFlags: string[] | null;
  missingInformation: string[] | null;
  confidenceScore: number | null;
  modelName: string | null;
  providerName: string | null;
  generatedAt: string | null;
  error: string | null;
  sourceDocumentCount: number;
  sourceTextCount: number;
  sourceDiscoveryCount: number;
  promptCharCount: number | null;
  documentsIncluded: number | null;
  documentsExcluded: number | null;
  generationDurationMs: number | null;
  updatedAt: string;
};

const RISK_FLAG_LABELS: Record<string, string> = {
  missing_primary_phone: "No confirmed phone number",
  missing_primary_email: "No confirmed email address",
  conflicting_phone_numbers: "Multiple phones, no clear primary",
  conflicting_addresses: "Multiple conflicting addresses",
  insufficient_documentation: "Fewer than 2 documents imported",
  extraction_failures: "One or more documents could not be extracted",
  scanned_documents: "Documents appear to be scanned/image-only",
  no_company_identified: "No company name found in documents",
  stale_contact_data: "Contact information may be outdated",
};

const MISSING_INFO_LABELS: Record<string, string> = {
  missing_owner: "Owner/principal name not found",
  missing_address: "Business address not found",
  missing_email: "No email address",
  missing_phone: "No phone number",
  missing_financial_docs: "No financial documentation imported",
  missing_business_description: "Cannot determine business type",
  missing_website: "No website found",
};

function ConfidenceMeter({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = score >= 0.7 ? "#10b981" : score >= 0.4 ? "#f59e0b" : "#ef4444";
  return (
    <div className="flex items-center gap-3">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-crm-surface-2/60">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="w-10 shrink-0 text-right text-xs font-bold" style={{ color }}>
        {pct}%
      </span>
    </div>
  );
}

function ContactIntelligence({ contactId }: { contactId: string }) {
  const [report, setReport] = useState<IntelligenceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [cooldownMsg, setCooldownMsg] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await apiGet<{ report: IntelligenceReport | null }>(
        `/crm/contacts/${contactId}/intelligence`,
      );
      setReport(res.report);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load intelligence report.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [contactId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleGenerate = async (force = false) => {
    setGenerating(true);
    setErr(null);
    setCooldownMsg(null);
    try {
      await apiPost(`/crm/contacts/${contactId}/intelligence`, { force });
      await load();
    } catch (e: any) {
      const code = e?.responseBody?.error ?? e?.code;
      if (code === "cooldown_active") {
        setCooldownMsg(e?.responseBody?.detail ?? e?.message ?? "Regeneration cooldown active. Try again later.");
      } else {
        setErr(e?.message ?? "Failed to generate intelligence report.");
      }
    } finally {
      setGenerating(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-[1.35rem] border border-crm-border/70 bg-crm-surface-2/45 p-6 text-center text-sm text-crm-muted">
        Loading…
      </div>
    );
  }

  if (!report) {
    return (
      <div className="rounded-[1.35rem] border border-dashed border-crm-border/80 bg-crm-surface-2/40 p-8 text-center">
        <Brain className="mx-auto h-8 w-8 text-crm-muted" />
        <p className="mt-3 text-sm font-semibold text-crm-text">No intelligence report yet.</p>
        <p className="mt-1 text-sm text-crm-muted">
          Import documents, extract their text, then generate an AI advisory report.
        </p>
        {err && <p className="mt-3 text-xs text-red-400">{err}</p>}
        <button
          type="button"
          disabled={generating}
          onClick={() => handleGenerate(false)}
          className="mt-4 inline-flex items-center gap-2 rounded-xl bg-crm-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          <Sparkles className="h-4 w-4" />
          {generating ? "Generating…" : "Generate Intelligence"}
        </button>
      </div>
    );
  }

  if (report.status === "PROCESSING") {
    return (
      <div className="rounded-[1.35rem] border border-crm-border/70 bg-crm-surface-2/45 p-8 text-center">
        <Brain className="mx-auto h-8 w-8 animate-pulse text-crm-accent" />
        <p className="mt-3 text-sm font-semibold text-crm-text">Generating intelligence report…</p>
        <p className="mt-1 text-sm text-crm-muted">This may take 10–30 seconds.</p>
      </div>
    );
  }

  if (report.status === "FAILED") {
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded-[1.35rem] border border-red-500/20 bg-red-500/5 p-4">
          <p className="text-sm font-semibold text-red-400">Intelligence generation failed</p>
          {report.error && <p className="mt-1 text-xs text-red-300">{report.error}</p>}
        </div>
        <button
          type="button"
          disabled={generating}
          onClick={() => handleGenerate(true)}
          className="self-start inline-flex items-center gap-2 rounded-xl bg-crm-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          <Sparkles className="h-4 w-4" />
          {generating ? "Generating…" : "Retry"}
        </button>
      </div>
    );
  }

  // COMPLETE
  const kf = (report.keyFindings ?? {}) as Record<string, unknown>;
  const de = (report.discoveredEntities ?? {}) as Record<string, unknown>;
  const riskFlags = report.riskFlags ?? [];
  const missingInfo = report.missingInformation ?? [];

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 rounded-[1.35rem] border border-crm-border/70 bg-crm-surface-2/45 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <Brain className="h-4 w-4 text-crm-accent" />
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-crm-accent">AI Intelligence Report</p>
          </div>
          {report.summary && (
            <p className="text-sm text-crm-text leading-relaxed">{report.summary}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-3 text-xs text-crm-muted">
            {report.documentsIncluded !== null && (
              <span>{report.documentsIncluded} doc{report.documentsIncluded !== 1 ? "s" : ""} analyzed</span>
            )}
            {report.documentsIncluded === null && (
              <span>{report.sourceDocumentCount} doc{report.sourceDocumentCount !== 1 ? "s" : ""} analyzed</span>
            )}
            <span>{report.sourceTextCount} with text</span>
            <span>{report.sourceDiscoveryCount} discoveries</span>
            {report.promptCharCount !== null && (
              <span>{report.promptCharCount.toLocaleString()} chars processed</span>
            )}
            {report.providerName && <span>Provider: {report.providerName}</span>}
            {report.modelName && <span>Model: {report.modelName}</span>}
            {report.generationDurationMs !== null && (
              <span>{(report.generationDurationMs / 1000).toFixed(1)}s generation time</span>
            )}
            {report.generatedAt && (
              <span>Generated: {new Date(report.generatedAt).toLocaleString()}</span>
            )}
          </div>
          {/* Exclusion warning — shown when documents were dropped due to tenant limits */}
          {report.documentsExcluded !== null && report.documentsExcluded > 0 && (
            <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-400">
              <span>⚠</span>
              <span>
                {report.documentsExcluded} document{report.documentsExcluded !== 1 ? "s were" : " was"} excluded due
                to AI document limits. Adjust limits in CRM Settings → AI Intelligence Settings.
              </span>
            </div>
          )}
          {report.confidenceScore !== null && (
            <div className="mt-3 max-w-xs">
              <p className="mb-1 text-xs text-crm-muted">Confidence</p>
              <ConfidenceMeter score={report.confidenceScore} />
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            disabled={generating}
            onClick={() => handleGenerate(true)}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-xl border border-crm-accent/30 bg-crm-accent/10 px-3 py-1.5 text-xs font-semibold text-crm-accent hover:bg-crm-accent/20 transition-colors disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {generating ? "…" : "Regenerate"}
          </button>
          {cooldownMsg && (
            <p className="text-xs text-amber-400 max-w-[200px] text-right">{cooldownMsg}</p>
          )}
        </div>
      </div>

      {/* Business Overview */}
      {report.businessOverview && (
        <div className="rounded-[1.35rem] border border-crm-border/70 bg-crm-surface-2/45 p-4">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-crm-muted">Business Overview</p>
          <p className="text-sm text-crm-text leading-relaxed">{report.businessOverview}</p>
        </div>
      )}

      {/* Key Findings */}
      {Object.keys(kf).length > 0 && (
        <div className="rounded-[1.35rem] border border-crm-border/70 bg-crm-surface-2/45 p-4">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.16em] text-crm-muted">Key Findings</p>
          <div className="grid grid-cols-3 gap-3 mb-3">
            {typeof kf.phoneCount === "number" && (
              <div className="rounded-xl bg-crm-surface/60 p-3 text-center">
                <p className="text-xl font-bold text-crm-text">{kf.phoneCount}</p>
                <p className="text-[10px] text-crm-muted mt-0.5">Phone{kf.phoneCount !== 1 ? "s" : ""}</p>
              </div>
            )}
            {typeof kf.emailCount === "number" && (
              <div className="rounded-xl bg-crm-surface/60 p-3 text-center">
                <p className="text-xl font-bold text-crm-text">{kf.emailCount}</p>
                <p className="text-[10px] text-crm-muted mt-0.5">Email{kf.emailCount !== 1 ? "s" : ""}</p>
              </div>
            )}
            {typeof kf.documentCount === "number" && (
              <div className="rounded-xl bg-crm-surface/60 p-3 text-center">
                <p className="text-xl font-bold text-crm-text">{kf.documentCount}</p>
                <p className="text-[10px] text-crm-muted mt-0.5">Document{kf.documentCount !== 1 ? "s" : ""}</p>
              </div>
            )}
          </div>
          {Array.isArray(kf.namesFound) && kf.namesFound.length > 0 && (
            <div className="mb-2">
              <p className="text-xs text-crm-muted mb-1">Names found:</p>
              <div className="flex flex-wrap gap-1.5">
                {(kf.namesFound as string[]).map((n, i) => (
                  <span key={i} className="rounded-full bg-crm-accent/10 px-2.5 py-0.5 text-xs text-crm-accent">{n}</span>
                ))}
              </div>
            </div>
          )}
          {Array.isArray(kf.addressesFound) && kf.addressesFound.length > 0 && (
            <div className="mb-2">
              <p className="text-xs text-crm-muted mb-1">Addresses found:</p>
              <div className="flex flex-col gap-1">
                {(kf.addressesFound as string[]).map((a, i) => (
                  <p key={i} className="text-xs text-crm-text">{a}</p>
                ))}
              </div>
            </div>
          )}
          {Array.isArray(kf.additionalNotes) && kf.additionalNotes.length > 0 && (
            <div>
              <p className="text-xs text-crm-muted mb-1">Notes:</p>
              <ul className="flex flex-col gap-0.5">
                {(kf.additionalNotes as string[]).map((n, i) => (
                  <li key={i} className="text-xs text-crm-text">• {n}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Discovered Entities */}
      {Object.values(de).some((v) => Array.isArray(v) && v.length > 0) && (
        <div className="rounded-[1.35rem] border border-crm-border/70 bg-crm-surface-2/45 p-4">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.16em] text-purple-400">Discovered Entities</p>
          {(["phones", "emails", "websites", "names", "addresses"] as const).map((key) => {
            const items = Array.isArray(de[key]) ? (de[key] as string[]) : [];
            if (items.length === 0) return null;
            const label = key.charAt(0).toUpperCase() + key.slice(1);
            return (
              <div key={key} className="mb-2">
                <p className="text-xs text-crm-muted mb-1">{label}:</p>
                <div className="flex flex-wrap gap-1.5">
                  {items.map((v, i) => (
                    <span key={i} className="rounded-full bg-purple-500/10 px-2.5 py-0.5 text-xs text-purple-300">{v}</span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Risk Flags */}
      {riskFlags.length > 0 && (
        <div className="rounded-[1.35rem] border border-amber-500/20 bg-amber-500/5 p-4">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-amber-400">Risk Flags</p>
          <ul className="flex flex-col gap-1.5">
            {riskFlags.map((flag, i) => (
              <li key={i} className="flex items-center gap-2 text-xs text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                {RISK_FLAG_LABELS[flag] ?? flag}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Missing Information */}
      {missingInfo.length > 0 && (
        <div className="rounded-[1.35rem] border border-crm-border/70 bg-crm-surface-2/45 p-4">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.16em] text-crm-muted">Missing Information</p>
          <ul className="flex flex-col gap-1.5">
            {missingInfo.map((item, i) => (
              <li key={i} className="text-xs text-crm-muted">
                • {MISSING_INFO_LABELS[item] ?? item}
              </li>
            ))}
          </ul>
        </div>
      )}

      {err && <p className="text-xs text-red-400">{err}</p>}
    </div>
  );
}

function PhoneActionPicker({
  intent,
  phones,
  onSelect,
  onClose,
}: {
  intent: "call" | "sms";
  phones: WorkspacePhone[];
  onSelect: (phone: WorkspacePhone) => void;
  onClose: () => void;
}) {
  const sortedPhones = resolvePhoneAction(phones);
  const choices = sortedPhones.kind === "pick" ? sortedPhones.phones : phones;
  const title = intent === "call" ? "Choose number to call" : "Choose SMS number";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-3 sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="crm-contact-phone-picker w-full max-w-sm rounded-[1.1rem] border border-crm-border bg-crm-surface p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-crm-accent">
              {intent === "call" ? "Call" : "SMS"}
            </p>
            <h3 className="text-sm font-bold text-crm-text">{title}</h3>
          </div>
          <button type="button" onClick={onClose} className={cn(crm.btnGhost, "px-2 py-1 text-xs")}>
            Close
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          {choices.map((phoneChoice) => (
            <button
              key={phoneChoice.id}
              type="button"
              onClick={() => onSelect(phoneChoice)}
              className="flex items-center justify-between gap-3 rounded-xl border border-crm-border/70 bg-crm-surface-2/45 px-3 py-2.5 text-left hover:border-crm-accent/40 hover:bg-crm-accent/8"
            >
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-bold text-crm-text">
                  {phoneTypeLabel(phoneChoice.type)}
                  {phoneChoice.isPrimary ? (
                    <span className="rounded-full bg-crm-accent/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-crm-accent">
                      Primary
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-sm text-crm-muted">{phoneChoice.numberRaw}</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-crm-muted" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function CrmContactDetailInner() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { backendJwtRole, user: appUser } = useAppContext();
  const phone = useSipPhone();
  const telephony = useTelephony();
  const sipReady = phone.regState === "registered";

  const returnTo = searchParams.get("returnTo");
  const urlMemberId = searchParams.get("memberId");
  const urlCampaignId = searchParams.get("campaignId");

  const [campaignNavMembers, setCampaignNavMembers] = useState<CampaignNavMember[]>([]);
  const [campaignNavLoading, setCampaignNavLoading] = useState(false);
  const [outreachStarting, setOutreachStarting] = useState(false);
  const [workspaceToast, setWorkspaceToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const workspaceToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [queueMember, setQueueMember] = useState<QueueContextMember | null>(null);
  const [campaignName, setCampaignName] = useState<string | null>(null);

  const isAdmin =
    backendJwtRole === "ADMIN" ||
    backendJwtRole === "TENANT_ADMIN" ||
    backendJwtRole === "SUPER_ADMIN";

  // ── Contact state ──────────────────────────────────────────────────────────
  const [contact, setContact] = useState<CrmContactDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summaryRefreshToken, setSummaryRefreshToken] = useState(0);

  // Compose email state
  const [composeOpen, setComposeOpen] = useState(false);
  const [voicemailDropOpen, setVoicemailDropOpen] = useState(false);

  // Edit state
  const [editing, setEditing] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editFirstName, setEditFirstName] = useState("");
  const [editLastName, setEditLastName] = useState("");
  const [editCompany, setEditCompany] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editStage, setEditStage] = useState<CrmStage>("LEAD");
  const [editDoNotCall, setEditDoNotCall] = useState(false);
  const [editDoNotSms, setEditDoNotSms] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Duplicate detection + merge state
  const [duplicates, setDuplicates] = useState<DuplicateContact[]>([]);
  const [mergeTarget, setMergeTarget] = useState<DuplicateContact | null>(null);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [archivePosting, setArchivePosting] = useState(false);
  const [restorePosting, setRestorePosting] = useState(false);

  // ── Timeline state ─────────────────────────────────────────────────────────
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(true);

  // ── Tasks state ────────────────────────────────────────────────────────────
  const [tasks, setTasks] = useState<CrmTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [addingTask, setAddingTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskDueAt, setNewTaskDueAt] = useState("");
  const [newTaskPosting, setNewTaskPosting] = useState(false);

  // Script/checklist workspace state reuses existing CRM live-workspace APIs.
  const [scriptSummaries, setScriptSummaries] = useState<ScriptSummary[]>([]);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [workspaceTab, setWorkspaceTab] = useState<ContactWorkspaceTab>("timeline");
  const workspacePanelRef = useRef<HTMLDivElement>(null);

  // Note composer
  const [noteText, setNoteText] = useState("");
  const [notePosting, setNotePosting] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteTextareaRef = useRef<HTMLTextAreaElement>(null);
  const noteComposerRef = useRef<HTMLDivElement>(null);
  const smsPanelRef = useRef<HTMLDivElement>(null);
  const tasksPanelRef = useRef<HTMLDivElement>(null);
  const outcomePanelRef = useRef<HTMLDivElement>(null);
  const [noteSavedAt, setNoteSavedAt] = useState<Date | null>(null);

  // Live outcome workflow state (unified with live-call workspace)
  const [disposition, setDisposition] = useState("");
  const [outcomeNote, setOutcomeNote] = useState("");
  const [followUpOption, setFollowUpOption] = useState<"" | "today" | "tomorrow" | "nextweek" | "custom">("");
  const [followUpCustom, setFollowUpCustom] = useState("");
  const [nextStage, setNextStage] = useState<CrmStage | "">("");
  const [savingOutcome, setSavingOutcome] = useState(false);
  const [outcomeSaved, setOutcomeSaved] = useState(false);
  const [outcomeError, setOutcomeError] = useState("");
  const saveOutcomeRef = useRef<() => Promise<void>>(async () => {});

  // Inline note edit
  const [editingNoteLinkedId, setEditingNoteLinkedId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState("");
  const [editingNoteSaving, setEditingNoteSaving] = useState(false);

  // Phone add / remove
  const [addingPhone, setAddingPhone] = useState(false);
  const [newPhoneRaw, setNewPhoneRaw] = useState("");
  const [newPhoneType, setNewPhoneType] = useState<string>("MOBILE");
  const [newPhonePosting, setNewPhonePosting] = useState(false);
  const [phonePickerIntent, setPhonePickerIntent] = useState<"call" | "sms" | null>(null);

  // Email add / remove
  const [addingEmail, setAddingEmail] = useState(false);
  const [newEmailAddress, setNewEmailAddress] = useState("");
  const [newEmailType, setNewEmailType] = useState<"WORK" | "PERSONAL" | "OTHER">("WORK");
  const [newEmailPosting, setNewEmailPosting] = useState(false);

  // SMS panel state
  const [smsPhone, setSmsPhone] = useState<string>("");
  const [smsMessage, setSmsMessage] = useState("");
  const [smsSending, setSmsSending] = useState(false);
  const [smsError, setSmsError] = useState<string | null>(null);
  const [smsSuccess, setSmsSuccess] = useState(false);

  // Caller-ID workflow (must be declared before any early return — Rules of Hooks)
  const [callerIdSelected, setCallerIdSelected] = useState<string | null>(null);
  const [callerIdChecked, setCallerIdChecked] = useState(false);
  const [callerIdLoading, setCallerIdLoading] = useState(false);

  // Outcome save ref + keyboard shortcuts — hoisted before any early return
  // so React sees a consistent hook order on every render.
  useEffect(() => {
    saveOutcomeRef.current = saveOutcome;
  });

  useEffect(() => {
    function onAnyKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tgt.tagName)) return;
      if (tgt.getAttribute("contenteditable") === "true") return;
      if (!savingOutcome && !disabledOutcome()) {
        if (e.key >= "1" && e.key <= "6") {
          const idx = parseInt(e.key, 10) - 1;
          const d = (DISPOSITION_OPTIONS as readonly string[])[idx];
          if (d) {
            e.preventDefault();
            setDisposition(d);
            return;
          }
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        if (!savingOutcome && disposition) {
          e.preventDefault();
          void saveOutcomeRef.current();
        }
      }
    }
    window.addEventListener("keydown", onAnyKey);
    return () => window.removeEventListener("keydown", onAnyKey);
  }, [disposition, savingOutcome]);

  // ── Loaders ────────────────────────────────────────────────────────────────

  const loadContact = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const c = await apiGet<CrmContactDetail>(`/crm/contacts/${id}`);
      setContact(c);
      setSummaryRefreshToken((token) => token + 1);
      setEditDisplayName(c.displayName);
      setEditFirstName(c.firstName ?? "");
      setEditLastName(c.lastName ?? "");
      setEditCompany(c.company ?? "");
      setEditTitle(c.title ?? "");
      setEditNotes(c.notes ?? "");
      setEditStage(c.crmStage ?? "LEAD");
      setEditDoNotCall(c.doNotCall);
      setEditDoNotSms(c.doNotSms);
      if (c.archivedAt != null || c.active === false) setEditing(false);
    } catch (e: any) {
      setError(e?.message || "Failed to load contact");
    } finally {
      setLoading(false);
    }
  }, [id]);

  const loadDuplicates = useCallback(async () => {
    try {
      const data = await apiGet<{ duplicates: DuplicateContact[] }>(`/crm/contacts/${id}/duplicates`);
      setDuplicates(data.duplicates ?? []);
    } catch {
      // Non-fatal — duplicate detection failure must not block the contact view
    }
  }, [id]);

  const loadTimeline = useCallback(async () => {
    setTimelineLoading(true);
    try {
      const data = await apiGet<{ contactId: string; events: TimelineEvent[] }>(
        `/crm/contacts/${id}/timeline`
      );
      setTimeline(data.events);
    } catch {
      // Non-fatal — timeline failure should not block the contact view
    } finally {
      setTimelineLoading(false);
    }
  }, [id]);

  const loadTasks = useCallback(async () => {
    setTasksLoading(true);
    try {
      const data = await apiGet<{ contactId: string; tasks: CrmTask[] }>(
        `/crm/contacts/${id}/tasks?status=open`
      );
      setTasks(data.tasks);
    } catch {
      // Non-fatal
    } finally {
      setTasksLoading(false);
    }
  }, [id]);

  const loadWorkspaceGuides = useCallback(async () => {
    const [scriptsRes, checklistRes] = await Promise.allSettled([
      apiGet<{ scripts: ScriptSummary[] }>("/crm/scripts"),
      apiGet<{ checklists: Checklist[] }>("/crm/checklists"),
    ]);
    if (scriptsRes.status === "fulfilled") setScriptSummaries(scriptsRes.value.scripts ?? []);
    if (checklistRes.status === "fulfilled") setChecklists(checklistRes.value.checklists ?? []);
  }, []);

  useEffect(() => {
    loadContact();
    loadTimeline();
    loadTasks();
    loadDuplicates();
    void loadWorkspaceGuides();
  }, [loadContact, loadTimeline, loadTasks, loadDuplicates, loadWorkspaceGuides]);

  // Draft note autosave keyed by contact id (shared UX with live workspace)
  useEffect(() => {
    if (!id || noteText) return;
    try {
      const v = localStorage.getItem(`crm:live:note:${id}`);
      if (v) setNoteText(v);
    } catch {}
  }, [id]);
  useEffect(() => {
    if (!id) return;
    try {
      if (noteText) localStorage.setItem(`crm:live:note:${id}`, noteText);
      else localStorage.removeItem(`crm:live:note:${id}`);
    } catch {}
  }, [id, noteText]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<{ queue: QueueMember[] }>("/crm/queue?filter=all&limit=200");
        if (cancelled) return;
        const match =
          (urlMemberId ? data.queue.find((m) => m.id === urlMemberId) : null) ??
          data.queue.find((m) => m.contactId === id) ??
          null;
        if (match) {
          setQueueMember({
            id: match.id,
            contactId: match.contactId,
            status: match.status,
            attemptCount: match.attemptCount,
            callbackAt: match.callbackAt,
            callbackNote: match.callbackNote,
            campaign: match.campaign,
          });
        }
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, urlMemberId]);

  useEffect(() => {
    const cid = urlCampaignId ?? queueMember?.campaign?.id;
    if (!cid) {
      setCampaignNavMembers([]);
      return;
    }
    let cancelled = false;
    setCampaignNavLoading(true);
    (async () => {
      try {
        const data = await apiGet<{ members: { id: string; contactId: string; sortOrder: number }[] }>(
          `/crm/campaigns/${cid}/members?limit=500`,
        );
        if (cancelled) return;
        setCampaignNavMembers(sortCampaignNavMembers(data.members ?? []));
      } catch {
        if (!cancelled) setCampaignNavMembers([]);
      } finally {
        if (!cancelled) setCampaignNavLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [urlCampaignId, queueMember?.campaign?.id]);

  useEffect(() => {
    const cid = urlCampaignId ?? queueMember?.campaign?.id;
    if (!cid) {
      setCampaignName(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<{ campaign: { name: string } }>(`/crm/campaigns/${cid}`);
        if (!cancelled) setCampaignName(data.campaign?.name ?? null);
      } catch {
        if (!cancelled) setCampaignName(queueMember?.campaign?.name ?? null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [urlCampaignId, queueMember?.campaign?.id, queueMember?.campaign?.name]);

  const campaignIdForNav = urlCampaignId ?? queueMember?.campaign?.id ?? null;
  const campaignMemberIndex = useMemo(
    () => findCampaignMemberIndex(campaignNavMembers, { memberId: urlMemberId, contactId: id }),
    [campaignNavMembers, urlMemberId, id],
  );
  const campaignNav = useMemo(
    () => campaignLeadNeighbors(campaignNavMembers, campaignMemberIndex),
    [campaignNavMembers, campaignMemberIndex],
  );

  const navigateCampaignLead = useCallback(
    (target: CampaignNavMember | null) => {
      if (!target || !campaignIdForNav) return;
      router.push(buildCampaignContactHref(target.contactId, campaignIdForNav, target.id, returnTo));
    },
    [campaignIdForNav, returnTo, router],
  );

  const showWorkspaceToast = useCallback((kind: "ok" | "err", text: string) => {
    if (workspaceToastTimer.current) clearTimeout(workspaceToastTimer.current);
    setWorkspaceToast({ kind, text });
    workspaceToastTimer.current = setTimeout(() => setWorkspaceToast(null), 3200);
  }, []);

  useEffect(() => {
    return () => {
      if (workspaceToastTimer.current) clearTimeout(workspaceToastTimer.current);
    };
  }, []);

  useEffect(() => {
    function onLeadNavKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tgt.tagName)) return;
      if (tgt.getAttribute("contenteditable") === "true") return;
      if (!campaignIdForNav || campaignNavMembers.length <= 1) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        navigateCampaignLead(campaignNav.previous);
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        navigateCampaignLead(campaignNav.next);
      }
    }
    window.addEventListener("keydown", onLeadNavKey);
    return () => window.removeEventListener("keydown", onLeadNavKey);
  }, [
    campaignIdForNav,
    campaignNavMembers.length,
    campaignNav.previous,
    campaignNav.next,
    navigateCampaignLead,
  ]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!editDisplayName.trim()) {
      setSaveError("Display name is required");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await apiPatch<CrmContactDetail>(`/crm/contacts/${id}`, {
        displayName: editDisplayName.trim(),
        firstName: editFirstName.trim() || undefined,
        lastName: editLastName.trim() || undefined,
        company: editCompany.trim() || undefined,
        title: editTitle.trim() || undefined,
        notes: editNotes,
        stage: editStage,
        doNotCall: editDoNotCall,
        doNotSms: editDoNotSms,
      });
      setContact(updated);
      setEditing(false);
      // Reload timeline in case stage changed
      loadTimeline();
    } catch (e: any) {
      setSaveError(e?.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleMerge = async (dupId: string) => {
    setMerging(true);
    setMergeError(null);
    try {
      await apiPost("/crm/contacts/merge", {
        keepContactId: id,
        mergeContactId: dupId,
      });
      setMergeTarget(null);
      setDuplicates([]);
      // Refresh contact (phones/emails may have been added) + timeline
      await loadContact();
      loadTimeline();
    } catch (e: any) {
      setMergeError(e?.message || "Merge failed");
    } finally {
      setMerging(false);
    }
  };

  const handleArchiveContact = async () => {
    if (
      !window.confirm(
        "Archive this contact? They will be removed from active CRM lists and search. Timeline, tasks, and campaign history are preserved.",
      )
    ) {
      return;
    }
    setArchivePosting(true);
    setError(null);
    try {
      await apiDelete(`/crm/contacts/${id}`);
      await loadContact();
      loadTimeline();
      loadTasks();
      loadDuplicates();
    } catch (e: any) {
      setError(e?.message || "Archive failed");
    } finally {
      setArchivePosting(false);
    }
  };

  const handleRestoreContact = async () => {
    if (!window.confirm("Restore this contact to the active CRM list?")) return;
    setRestorePosting(true);
    setError(null);
    try {
      await apiPost(`/crm/contacts/${id}/restore`, {});
      await loadContact();
      loadTimeline();
      loadTasks();
      loadDuplicates();
    } catch (e: any) {
      setError(e?.message || "Restore failed");
    } finally {
      setRestorePosting(false);
    }
  };

  const handlePostNote = async () => {
    if (!noteText.trim()) return;
    setNotePosting(true);
    setNoteError(null);
    try {
      await apiPost(`/crm/contacts/${id}/notes`, { body: noteText.trim() });
      setNoteText("");
      setNoteSavedAt(new Date());
      await loadTimeline();
    } catch (e: any) {
      setNoteError(e?.message || "Failed to post note");
    } finally {
      setNotePosting(false);
    }
  };

  const handleEditNote = (linkedId: string, currentBody: string) => {
    setEditingNoteLinkedId(linkedId);
    setEditingNoteText(currentBody);
  };

  const handleSaveEditedNote = async () => {
    if (!editingNoteLinkedId || !editingNoteText.trim()) return;
    setEditingNoteSaving(true);
    try {
      await apiPatch(`/crm/contacts/${id}/notes/${editingNoteLinkedId}`, {
        body: editingNoteText.trim(),
      });
      setEditingNoteLinkedId(null);
      setEditingNoteText("");
      await loadTimeline();
    } catch (e: any) {
      alert(e?.message || "Failed to update note");
    } finally {
      setEditingNoteSaving(false);
    }
  };

  const handleCompleteTask = async (taskId: string) => {
    await apiPatch(`/crm/contacts/${id}/tasks/${taskId}`, { status: "DONE" });
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    loadTimeline();
  };

  const handleCreateTask = async () => {
    if (!newTaskTitle.trim()) return;
    setNewTaskPosting(true);
    try {
      await apiPost(`/crm/contacts/${id}/tasks`, {
        title: newTaskTitle.trim(),
        dueAt: newTaskDueAt || undefined,
      });
      setNewTaskTitle("");
      setNewTaskDueAt("");
      setAddingTask(false);
      await loadTasks();
      loadTimeline();
    } catch { /* silent */ } finally {
      setNewTaskPosting(false);
    }
  };

  const handleDeleteNote = async (linkedId: string) => {
    if (!confirm("Delete this note?")) return;
    try {
      await apiDelete(`/crm/contacts/${id}/notes/${linkedId}`);
      await loadTimeline();
    } catch (e: any) {
      alert(e?.message || "Failed to delete note");
    }
  };

  const handleAddPhone = async () => {
    if (!newPhoneRaw.trim()) return;
    setNewPhonePosting(true);
    try {
      const updated = await apiPost<CrmContactDetail>(`/crm/contacts/${id}/phones`, {
        numberRaw: newPhoneRaw.trim(),
        type: newPhoneType,
        isPrimary: false,
      });
      setContact(updated);
      setNewPhoneRaw("");
      setAddingPhone(false);
    } catch (e: any) {
      alert(e?.message || "Failed to add phone");
    } finally {
      setNewPhonePosting(false);
    }
  };

  const handleRemovePhone = async (phoneId: string) => {
    if (!confirm("Remove this phone number?")) return;
    try {
      await apiDelete(`/crm/contacts/${id}/phones/${phoneId}`);
      setContact((prev) => prev ? { ...prev, phones: prev.phones.filter((p) => p.id !== phoneId) } : prev);
    } catch (e: any) {
      alert(e?.message || "Failed to remove phone");
    }
  };

  const handleAddEmail = async () => {
    if (!newEmailAddress.trim()) return;
    setNewEmailPosting(true);
    try {
      const updated = await apiPost<CrmContactDetail>(`/crm/contacts/${id}/emails`, {
        email: newEmailAddress.trim(),
        type: newEmailType,
        isPrimary: false,
      });
      setContact(updated);
      setNewEmailAddress("");
      setAddingEmail(false);
    } catch (e: any) {
      alert(e?.message || "Failed to add email");
    } finally {
      setNewEmailPosting(false);
    }
  };

  const handleRemoveEmail = async (emailId: string) => {
    if (!confirm("Remove this email address?")) return;
    try {
      await apiDelete(`/crm/contacts/${id}/emails/${emailId}`);
      setContact((prev) => prev ? { ...prev, emails: prev.emails.filter((e) => e.id !== emailId) } : prev);
    } catch (e: any) {
      alert(e?.message || "Failed to remove email");
    }
  };

  const handleSendSms = async () => {
    if (!smsMessage.trim() || smsSending) return;
    setSmsSending(true);
    setSmsError(null);
    setSmsSuccess(false);
    try {
      await apiPost(`/crm/contacts/${id}/sms`, {
        message: smsMessage.trim(),
        ...(smsPhone ? { phone: smsPhone } : {}),
      });
      setSmsSuccess(true);
      setSmsMessage("");
      await loadTimeline();
      setTimeout(() => setSmsSuccess(false), 3000);
    } catch (e: any) {
      setSmsError(e?.message || "Failed to send SMS");
    } finally {
      setSmsSending(false);
    }
  };

  // ── Memos (must come before all early returns — Rules of Hooks) ───────────

  const nextStep = useMemo((): {
    title: string;
    detail: string;
    actionLabel?: string;
    action: "none" | "add_phone" | "scroll_tasks" | "scroll_notes";
  } => {
    if (!contact) return { title: "Loading…", detail: "", action: "none" };
    const archived = !!(contact.archivedAt != null || contact.active === false);
    if (archived) {
      return {
        title: "Archived — read-only",
        detail:
          "This record is out of active CRM rotation. Review the timeline below; restore from the banner when you need to edit or message again.",
        action: "none",
      };
    }
    if (contact.phones.length === 0) {
      return {
        title: "Add a phone number",
        detail: "Voice and SMS both need a number on file. Add one under Contact info.",
        actionLabel: "Add phone",
        action: "add_phone",
      };
    }
    const open = tasks.filter((t) => t.status !== "DONE" && t.status !== "CANCELED");
    const sorted = [...open].sort((a, b) => {
      const ta = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
      const tb = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
      return ta - tb;
    });
    const dueSoon = sorted.find((t) => t.dueAt);
    const overdue = sorted.find((t) => t.dueAt && new Date(t.dueAt) < new Date());
    if (overdue || dueSoon) {
      const t = overdue ?? dueSoon;
      if (t) {
        const late = t.dueAt && new Date(t.dueAt) < new Date();
        return {
          title: late ? "Overdue follow-up" : "Open task",
          detail: `${t.title}${t.dueAt ? ` · Due ${formatDate(t.dueAt)}` : ""}`,
          actionLabel: "View tasks",
          action: "scroll_tasks",
        };
      }
    }
    if (contact.doNotSms) {
      return {
        title: "SMS opted out",
        detail: "This contact cannot receive SMS. Use voice or email, and log updates in the timeline.",
        actionLabel: "Add note",
        action: "scroll_notes",
      };
    }
    return {
      title: "Keep the record current",
      detail: "Review recent activity, add a note, or schedule a follow-up so the next touch is intentional.",
      actionLabel: "Add note",
      action: "scroll_notes",
    };
  }, [contact, tasks]);

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ padding: "2rem" }}>
        <LoadingSkeleton rows={8} />
      </div>
    );
  }

  if (error || !contact) {
    return (
      <div style={{ padding: "2rem" }}>
        <button
          onClick={() => router.push("/crm/contacts")}
          style={{ display: "flex", alignItems: "center", gap: "0.375rem", background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", fontSize: "0.875rem", marginBottom: "1rem", padding: 0 }}
        >
          <ArrowLeft size={14} /> Back to Contacts
        </button>
        <p style={{ color: "#ef4444", fontSize: "0.875rem" }}>{error || "Contact not found"}</p>
      </div>
    );
  }

  const stage = contact.crmStage ?? "LEAD";
  const isArchived = !!(contact.archivedAt != null || contact.active === false);

  // Derive SMS conversation from timeline — newest-first, capped at 25.
  // No new API call; reuses the timeline already loaded for the Activity feed.
  const smsEvents = timeline
    .filter((e) => e.type === "SMS_SENT" || e.type === "SMS_RECEIVED")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 25);

  const lastSmsIn = smsEvents.find((e) => e.type === "SMS_RECEIVED") ?? null;

  const primaryPhoneRow = contact.phones.find((p) => p.isPrimary) ?? contact.phones[0] ?? null;
  const primaryEmailRow = contact.emails.find((e) => e.isPrimary) ?? contact.emails[0] ?? null;

  const focusNoteComposer = () => {
    noteComposerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    window.setTimeout(() => noteTextareaRef.current?.focus(), 200);
  };

  const handleStartOutreach = () => {
    if (isArchived) {
      showWorkspaceToast("err", "Archived contacts are read-only.");
      return;
    }
    setOutreachStarting(true);
    setWorkspaceTab("notes");
    window.setTimeout(() => {
      if (noteComposerRef.current) {
        focusNoteComposer();
        showWorkspaceToast("ok", "Ready to log your first outreach note.");
        setOutreachStarting(false);
        return;
      }
      showWorkspaceToast("err", "Could not open the note composer. Try the Notes tab.");
      setOutreachStarting(false);
    }, 0);
  };

  const scrollToNoteComposer = () => {
    setWorkspaceTab("notes");
    window.setTimeout(() => focusNoteComposer(), 0);
  };

  const scrollToTasks = () => {
    tasksPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const focusWorkspace = (tab: ContactWorkspaceTab) => {
    setWorkspaceTab(tab);
    workspacePanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const primaryPhone = primaryPhoneRow?.numberRaw ?? null;
  const contactPhoneDigits = contact.phones.map((p) => phoneDigits(p.numberRaw)).filter(Boolean);
  const activeContactCall = telephony.activeCalls.find((call) => {
    if (call.state !== "up" && call.state !== "held") return false;
    const candidates = [call.to, call.from, call.connectedLine].map(phoneDigits).filter(Boolean);
    return contactPhoneDigits.some((digits) => candidates.some((candidate) => candidate.endsWith(digits) || digits.endsWith(candidate)));
  }) ?? null;
  const sipNotice = sipReady || !primaryPhone
    ? null
    : (phone.regState === "connecting" || phone.regState === "registering")
      ? "Phone connecting — call will dial once ready"
      : "Phone not registered — open the dialer to reconnect";

  const handleCall = async (phoneTarget?: WorkspacePhone | string | null) => {
    const num = typeof phoneTarget === "string"
      ? phoneTarget
      : phoneTarget?.numberRaw ?? primaryPhone;
    if (!num) return;
    if (!callerIdChecked) {
      setCallerIdLoading(true);
      try {
        const res = await apiPost<{ callerId: string | null }>(`/crm/calls/originate`, {
          destination: num,
          contactId: id,
        });
        setCallerIdSelected(res.callerId ?? null);
      } catch {
        setCallerIdSelected(null);
      } finally {
        setCallerIdChecked(true);
        setCallerIdLoading(false);
      }
    }
    window.dispatchEvent(new CustomEvent("crm:dial", { detail: { target: num } }));
  };

  const beginCall = () => {
    const resolution = resolvePhoneAction(contact.phones);
    if (resolution.kind === "disabled") return;
    if (resolution.kind === "execute") {
      void handleCall(resolution.phone);
      return;
    }
    setPhonePickerIntent("call");
  };

  const beginSms = () => {
    const resolution = resolvePhoneAction(contact.phones);
    if (resolution.kind === "disabled") return;
    if (resolution.kind === "execute") {
      setSmsPhone(resolution.phone.isPrimary ? "" : resolution.phone.numberRaw);
      focusWorkspace("sms");
      return;
    }
    setPhonePickerIntent("sms");
  };

  const selectPhoneForAction = (phoneChoice: WorkspacePhone) => {
    if (phonePickerIntent === "call") {
      void handleCall(phoneChoice);
    } else if (phonePickerIntent === "sms") {
      setSmsPhone(phoneChoice.isPrimary ? "" : phoneChoice.numberRaw);
      focusWorkspace("sms");
    }
    setPhonePickerIntent(null);
  };

  const handleBack = () => {
    if (returnTo) router.push(returnTo);
    else router.push("/crm/contacts");
  };

  function disabledOutcome() {
    return !id || !!(contact?.archivedAt != null || contact?.active === false);
  }

  async function saveOutcome() {
    if (disabledOutcome() || !disposition) return;
    setSavingOutcome(true);
    setOutcomeError("");

    let followUpAt: string | null = null;
    if (followUpOption === "today") {
      const d = new Date();
      d.setHours(17, 0, 0, 0);
      followUpAt = d.toISOString();
    } else if (followUpOption === "tomorrow") {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      followUpAt = d.toISOString();
    } else if (followUpOption === "nextweek") {
      const d = new Date();
      const day = d.getDay();
      const daysToMonday = day === 0 ? 1 : 8 - day;
      d.setDate(d.getDate() + daysToMonday);
      d.setHours(9, 0, 0, 0);
      followUpAt = d.toISOString();
    } else if (followUpOption === "custom" && followUpCustom) {
      followUpAt = new Date(followUpCustom).toISOString();
    }

    try {
      await apiPost(`/crm/contacts/${id}/disposition`, {
        disposition,
        note: outcomeNote.trim() || undefined,
        followUpAt: followUpAt ?? undefined,
        nextStage: nextStage || undefined,
      });
      setOutcomeSaved(true);
      setOutcomeNote("");
      setFollowUpOption("");
      setFollowUpCustom("");
      await loadContact();
      await loadTasks();
      await loadTimeline();
      setTimeout(() => setOutcomeSaved(false), 4000);
    } catch {
      setOutcomeError("Save failed — please try again.");
    } finally {
      setSavingOutcome(false);
    }
  }

  const lastTimelineEvent = timeline[0] ?? null;
  const lastInteractionLabel =
    lastTimelineEvent?.title ?? contact.lastDisposition ?? null;
  const lastInteractionAt =
    lastTimelineEvent?.createdAt ?? contact.lastActivityAt ?? null;

  const weekAgo = Date.now() - 7 * 86400000;
  const recentActivityCount = timeline.filter(
    (e) => new Date(e.createdAt).getTime() >= weekAgo,
  ).length;
  const overdueTasks = tasks.filter(
    (t) => t.dueAt && new Date(t.dueAt) < new Date(),
  ).length;
  const lastComm = timeline.find(
    (e) => e.type.startsWith("CDR_") || e.type.startsWith("SMS_"),
  );
  const daysSinceComm = lastComm
    ? Math.floor((Date.now() - new Date(lastComm.createdAt).getTime()) / 86400000)
    : null;
  const callbackUrgent = queueMember?.callbackAt
    ? new Date(queueMember.callbackAt) < new Date()
    : false;
  const contactInitials = contact.displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "?";
  const ownerLabel =
    contact.assignedTo?.displayName ||
    contact.assignedTo?.email ||
    "Unassigned";
  const relationshipScore = Math.max(
    0,
    Math.min(
      100,
      54 +
        Math.min(recentActivityCount, 5) * 7 +
        (contact.phones.length > 0 ? 6 : 0) +
        (contact.emails.length > 0 ? 6 : 0) -
        overdueTasks * 9 -
        (daysSinceComm != null && daysSinceComm > 14 ? 14 : 0),
    ),
  );
  const relationshipTone =
    relationshipScore >= 75 ? "High" : relationshipScore >= 50 ? "Medium" : "Low";
  const activeSectionLabel = workspaceTabLabel(workspaceTab);

  const runNextStepAction = () => {
    if (nextStep.action === "add_phone") setAddingPhone(true);
    if (nextStep.action === "scroll_tasks") scrollToTasks();
    if (nextStep.action === "scroll_notes") scrollToNoteComposer();
  };

  function TaskPanelContent() {
    return (
      <div ref={tasksPanelRef} className="flex flex-col gap-3">
        {!isArchived && addingTask ? (
          <div className="rounded-xl border border-crm-border/70 bg-crm-surface p-3">
            <input
              value={newTaskTitle}
              onChange={(e) => setNewTaskTitle(e.target.value)}
              placeholder="Follow-up title..."
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateTask();
                if (e.key === "Escape") setAddingTask(false);
              }}
              className={crm.input}
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[
                { label: "Today", days: 0 },
                { label: "Tomorrow", days: 1 },
                { label: "Next week", days: 7 },
              ].map(({ label, days }) => {
                const d = new Date();
                d.setDate(d.getDate() + days);
                const val = d.toISOString().slice(0, 10);
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setNewTaskDueAt(val)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs font-semibold",
                      newTaskDueAt === val
                        ? "border-crm-accent bg-crm-accent text-white"
                        : "border-crm-border bg-crm-surface-2 text-crm-muted",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
              <input
                type="date"
                value={newTaskDueAt}
                onChange={(e) => setNewTaskDueAt(e.target.value)}
                className={cn(crm.input, "w-auto py-1 text-xs")}
              />
            </div>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={handleCreateTask} disabled={newTaskPosting || !newTaskTitle.trim()} className={crm.btnPrimary}>
                {newTaskPosting ? "Adding..." : "Add"}
              </button>
              <button type="button" onClick={() => { setAddingTask(false); setNewTaskDueAt(""); setNewTaskTitle(""); }} className={crm.btnGhost}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {tasksLoading ? (
          <LoadingSkeleton rows={2} />
        ) : tasks.length === 0 && !addingTask ? (
          <p className="rounded-xl border border-dashed border-crm-border/70 bg-crm-surface/60 px-4 py-6 text-center text-sm text-crm-muted">
            No open tasks.
          </p>
        ) : (
          tasks.map((task) => {
            const isDue = task.dueAt && new Date(task.dueAt) < new Date();
            return (
              <div key={task.id} className="flex items-start gap-3 rounded-xl border border-crm-border/70 bg-crm-surface px-3 py-2.5">
                {!isArchived ? (
                  <button
                    type="button"
                    onClick={() => handleCompleteTask(task.id)}
                    title="Mark done"
                    className="mt-0.5 text-crm-muted hover:text-crm-success"
                  >
                    <Circle className="h-4 w-4" />
                  </button>
                ) : null}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-crm-text">{task.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-crm-muted">
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase"
                      style={{
                        background: `${TASK_PRIORITY_COLOR[task.priority]}22`,
                        color: TASK_PRIORITY_COLOR[task.priority],
                      }}
                    >
                      {task.priority}
                    </span>
                    {task.dueAt ? (
                      <span className={cn("inline-flex items-center gap-1", isDue ? "text-crm-danger" : "")}>
                        <Clock className="h-3 w-3" />
                        {formatDate(task.dueAt)}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    );
  }

  return (<>
    <CRMPageShell innerClassName={`${crm.pageInnerContact} ${crm.contactDetailWorkspace}`} className={crm.contactDetailWorkspace}>
      <div className="crm-contact-workspace-frame">
        <ContactContextBar
          returnTo={returnTo}
          queueMember={queueMember}
          campaignName={campaignName}
          onBack={handleBack}
        />

        <ContactCampaignStickyHeader
          displayName={contact.displayName}
          company={contact.company ?? null}
          phone={primaryPhoneRow?.numberRaw ?? null}
          phoneLabel={primaryPhoneRow ? phoneTypeLabel(primaryPhoneRow.type) : null}
          email={primaryEmailRow?.email ?? null}
          stage={stage}
          campaignName={campaignName}
          isArchived={isArchived}
          onCall={beginCall}
          onSms={beginSms}
          onEmail={() => focusWorkspace("email")}
          onNote={scrollToNoteComposer}
          callDisabled={!primaryPhone || isArchived}
          smsDisabled={contact.doNotSms || contact.phones.length === 0 || isArchived}
          emailDisabled={!primaryEmailRow || isArchived}
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <HeaderMetric label="Stage" value={stageLabel(stage)} tone="violet" />
            <HeaderMetric label="Lead Score" value={relationshipScore} sub={relationshipTone} tone="emerald" />
            <HeaderMetric label="Last Touch" value={lastInteractionAt ? formatTimeAgo(lastInteractionAt) : "None"} tone="slate" />
            <HeaderMetric label="Owner" value={ownerLabel} tone="slate" />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {sipNotice ? <span className="text-xs font-medium text-crm-warning">{sipNotice}</span> : null}
            {!isArchived ? (
              <>
                <button type="button" className={cn(crm.btnSecondary, "py-1 text-xs")} onClick={() => setVoicemailDropOpen(true)} disabled={contact.doNotCall || contact.phones.length === 0}>
                  <Voicemail className="h-3.5 w-3.5" />
                  Voicemail drop
                </button>
                <button type="button" className={cn(crm.btnSecondary, "py-1 text-xs")} onClick={() => setEditing(true)}>
                  Edit
                </button>
                <button type="button" className={cn(crm.btnGhost, "py-1 text-xs")} onClick={handleArchiveContact} disabled={archivePosting}>
                  {archivePosting ? "Archiving..." : "Archive"}
                </button>
              </>
            ) : (
              <button type="button" className={cn(crm.btnSecondary, "py-1 text-xs")} onClick={handleRestoreContact} disabled={restorePosting}>
                {restorePosting ? "Restoring..." : "Restore"}
              </button>
            )}
          </div>
        </ContactCampaignStickyHeader>

      {editing && !isArchived && (
        <div className="panel" style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.875rem" }}>
          <h3 style={{ margin: 0, fontSize: "0.875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-dim)" }}>Edit Contact</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={labelStyle}>Display Name *</label>
              <input value={editDisplayName} onChange={(e) => setEditDisplayName(e.target.value)} style={inputStyle} placeholder="Full name or company name" />
            </div>
            <div>
              <label style={labelStyle}>First Name</label>
              <input value={editFirstName} onChange={(e) => setEditFirstName(e.target.value)} style={inputStyle} placeholder="First" />
            </div>
            <div>
              <label style={labelStyle}>Last Name</label>
              <input value={editLastName} onChange={(e) => setEditLastName(e.target.value)} style={inputStyle} placeholder="Last" />
            </div>
            <div>
              <label style={labelStyle}>Company</label>
              <input value={editCompany} onChange={(e) => setEditCompany(e.target.value)} style={inputStyle} placeholder="Company name" />
            </div>
            <div>
              <label style={labelStyle}>Title</label>
              <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} style={inputStyle} placeholder="Job title" />
            </div>
          </div>
        </div>
      )}

      {saveError && (
        <p style={{ color: "#ef4444", fontSize: "0.875rem", margin: "0 0 0.5rem" }}>{saveError}</p>
      )}

      {/* ── Three-column contact workspace ───────────────────────────────────── */}
      <div className="crm-contact-workspace-body">
        <aside className="crm-contact-workspace-panel order-1 flex min-w-0 flex-col gap-3">
          <CRMCard padding="md" className="border-crm-border/70">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-crm-muted">Communicate</p>
            <div className="mt-3 flex flex-col gap-1.5">
              {([
                ["timeline", "Timeline", Activity],
                ["script", "Script", FileText],
                ["checklist", "Checklist", ClipboardCheck],
                ["email", "Email", Mail],
                ["sms", "SMS", MessageSquareDot],
                ["notes", "Notes", NotebookPen],
                ["files", "Files", Files],
                ["discoveries", "Discoveries", ScanText],
                ["intelligence", "AI Intelligence", Brain],
                ["tasks", "Tasks", ListTodo],
              ] as const).map(([tab, label, Icon]) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => {
                    setWorkspaceTab(tab);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left text-sm font-semibold transition-colors",
                    workspaceTab === tab
                      ? "border-crm-accent/35 bg-crm-accent/10 text-crm-accent"
                      : "border-transparent bg-transparent text-crm-text hover:border-crm-border/70 hover:bg-crm-surface-2/55",
                  )}
                >
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{label}</span>
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 text-crm-muted" />
                </button>
              ))}
            </div>
          </CRMCard>

          <CRMCard padding="md" className="border-crm-border/70 bg-crm-surface-2/35">
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-crm-muted">Quick Disposition</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {(DISPOSITION_OPTIONS as readonly string[]).slice(0, 6).map((option, index) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setDisposition(option)}
                  disabled={disabledOutcome()}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs font-semibold",
                    disposition === option
                      ? "border-crm-accent bg-crm-accent text-white"
                      : "border-crm-border bg-crm-surface text-crm-muted hover:text-crm-text",
                  )}
                >
                  {index + 1}. {option}
                </button>
              ))}
            </div>
            <input
              value={outcomeNote}
              onChange={(e) => setOutcomeNote(e.target.value)}
              disabled={disabledOutcome()}
              placeholder="Outcome note..."
              className={cn(crm.input, "mt-3 py-2")}
            />
            <button
              type="button"
              onClick={() => void saveOutcomeRef.current()}
              disabled={!disposition || savingOutcome || disabledOutcome()}
              className={cn(crm.btnPrimary, "mt-3 w-full")}
            >
              {savingOutcome ? "Saving..." : "Save Disposition"}
            </button>
            {outcomeSaved ? <p className="mt-2 text-xs font-semibold text-crm-success">Disposition saved.</p> : null}
            {outcomeError ? <p className="mt-2 text-xs font-semibold text-crm-danger">{outcomeError}</p> : null}
          </CRMCard>
        </aside>

        <div className="crm-contact-workspace-panel order-2 flex min-w-0 flex-col gap-4" ref={workspacePanelRef}>
          <CRMCard padding="lg" className="overflow-hidden border-crm-border/70">
            <div className="mb-4 flex flex-col gap-3 border-b border-crm-border/60 pb-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-crm-accent">Workspace</p>
                <h3 className="mt-1 text-xl font-bold tracking-tight text-crm-text">{activeSectionLabel}</h3>
              </div>
              <ContactWorkspaceTabBar activeTab={workspaceTab} onSelect={setWorkspaceTab} />
            </div>

            {workspaceTab === "timeline" ? (
              <ContactTimeline
                events={timeline}
                loading={timelineLoading}
                currentUserId={appUser?.id}
                editingNoteLinkedId={editingNoteLinkedId}
                editingNoteText={editingNoteText}
                allowNoteMutations={!isArchived}
                onEditNote={handleEditNote}
                onDeleteNote={handleDeleteNote}
                isArchived={isArchived}
                onStartOutreach={handleStartOutreach}
                outreachStarting={outreachStarting}
              />
            ) : workspaceTab === "script" ? (
              <LiveWorkspaceScriptPanel
                scriptSummaries={scriptSummaries}
                defaultScriptId={null}
              />
            ) : workspaceTab === "checklist" ? (
              <LiveWorkspaceChecklistPanel
                checklists={checklists}
                contactId={contact.id}
                linkedId={null}
                defaultChecklistId={null}
                onSaved={() => void loadTimeline()}
              />
            ) : workspaceTab === "sms" ? (
              <ContactSmsPanel
                ref={smsPanelRef}
                phones={contact.phones}
                smsEvents={smsEvents}
                timelineLoading={timelineLoading}
                isArchived={isArchived}
                doNotSms={contact.doNotSms}
                smsPhone={smsPhone}
                setSmsPhone={setSmsPhone}
                smsMessage={smsMessage}
                setSmsMessage={setSmsMessage}
                smsSending={smsSending}
                smsError={smsError}
                smsSuccess={smsSuccess}
                onSend={handleSendSms}
              />
            ) : workspaceTab === "email" ? (
              <div className="rounded-[1.35rem] border border-crm-border/70 bg-crm-surface-2/45 p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-crm-accent">Email</p>
                    <h3 className="mt-1 text-lg font-bold text-crm-text">Compose without leaving context</h3>
                    <p className="mt-1 max-w-xl text-sm text-crm-muted">
                      Uses the existing CRM email composer and records sent mail back into the contact timeline.
                    </p>
                  </div>
                  <button type="button" onClick={() => setComposeOpen(true)} disabled={!primaryEmailRow || isArchived} className={crm.btnPrimary}>
                    <Mail className="h-4 w-4" />
                    Compose
                  </button>
                </div>
              </div>
            ) : workspaceTab === "files" ? (
              <ContactDriveDocuments contactId={id} />
            ) : workspaceTab === "discoveries" ? (
              <ContactDiscoveries contactId={id} />
            ) : workspaceTab === "intelligence" ? (
              <ContactIntelligence contactId={id} />
            ) : workspaceTab === "tasks" ? (
              <div className="rounded-[1.35rem] border border-crm-border/70 bg-crm-surface-2/45 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-crm-accent">Open Tasks</p>
                    <h3 className="text-lg font-bold text-crm-text">{tasks.length} active follow-up{tasks.length === 1 ? "" : "s"}</h3>
                  </div>
                  {!isArchived ? (
                    <button type="button" onClick={() => setAddingTask((v) => !v)} className={crm.btnSecondary}>
                      <Plus className="h-4 w-4" />
                      Add Task
                    </button>
                  ) : null}
                </div>
                <TaskPanelContent />
              </div>
            ) : workspaceTab === "notes" ? (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
                <div ref={noteComposerRef}>
                  <CRMCard padding="md" className="border-crm-border/70 bg-crm-surface-2/45">
                    <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-crm-accent">Quick Note</p>
                    <textarea
                      ref={noteTextareaRef}
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      rows={7}
                      disabled={isArchived}
                      placeholder="Add a note to the contact timeline..."
                      className={cn(crm.input, "mt-3 min-h-[9rem] resize-none")}
                    />
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <span className="text-xs text-crm-muted">
                        {noteSavedAt ? `Last saved ${formatTimeAgo(noteSavedAt.toISOString())}` : "Saved notes appear in the timeline"}
                      </span>
                      <button type="button" onClick={handlePostNote} disabled={notePosting || !noteText.trim() || isArchived} className={crm.btnPrimary}>
                        {notePosting ? "Saving..." : "Save Note"}
                      </button>
                    </div>
                  </CRMCard>
                  {noteError ? (
                    <p className="mt-1 text-xs text-crm-danger">{noteError}</p>
                  ) : null}
                </div>
                <div className="rounded-2xl border border-crm-border/70 bg-crm-surface-2/45 p-4">
                  <h3 className="text-sm font-bold uppercase tracking-wide text-crm-muted">Scratch notes</h3>
                  {editing && !isArchived ? (
                    <textarea
                      value={editNotes}
                      onChange={(e) => setEditNotes(e.target.value)}
                      rows={8}
                      placeholder="Quick scratch pad for this contact…"
                      style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
                    />
                  ) : (
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-crm-text">
                      {contact.notes || "No scratch notes."}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-[1.35rem] border border-dashed border-crm-border/70 bg-crm-surface/60 px-4 py-6 text-center text-sm text-crm-muted">
                Select a workspace tab to get started.
              </div>
            )}
          </CRMCard>

        </div>

        <div className="crm-contact-workspace-panel crm-contact-workspace-panel-right order-3 flex flex-col gap-4">
          <CRMCard padding="md" className="border-crm-accent/25 bg-crm-accent/5">
            <p className="text-xs font-bold uppercase tracking-wide text-crm-accent">Next step</p>
            <p className="mt-1 text-base font-semibold text-crm-text">{nextStep.title}</p>
            <p className="mt-1 text-sm text-crm-muted">{nextStep.detail}</p>
            {nextStep.actionLabel && nextStep.action !== "none" && (
              <button type="button" onClick={runNextStepAction} className={cn(crm.btnPrimary, "mt-3 w-full justify-center")}>
                {nextStep.actionLabel}
                <ChevronRight className="h-4 w-4" />
              </button>
            )}
          </CRMCard>
          <ContactCollapsibleSection
            id="right-rail-relationship"
            title="Relationship health"
            summary={`${recentActivityCount} touch${recentActivityCount === 1 ? "" : "es"} in 7d · ${tasks.length} open task${tasks.length === 1 ? "" : "s"}`}
          >
            <ContactRelationshipHealth
              timeline={timeline}
              openTasks={tasks}
              overdueTasks={overdueTasks}
              lastTouchAt={contact.lastActivityAt ?? null}
              daysSinceComm={daysSinceComm}
              callbackUrgent={callbackUrgent}
              recentActivityCount={recentActivityCount}
            />
          </ContactCollapsibleSection>
          <ContactCollapsibleSection
            id="right-rail-activity"
            title="Activity summary"
            summary={lastInteractionLabel ?? "No interactions yet"}
          >
          <CRMCard padding="md" className="border-crm-border/70">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-crm-muted">Activity summary</p>
                <p className="mt-1 text-sm font-semibold text-crm-text">{lastInteractionLabel ?? "No interactions yet"}</p>
              </div>
              <Sparkles className="h-4 w-4 text-crm-accent" />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-crm-border/70 bg-crm-surface-2/50 p-2">
                <p className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">Last touch</p>
                <p className="mt-1 truncate text-xs font-semibold text-crm-text">
                  {lastInteractionAt ? formatTimeAgo(lastInteractionAt) : "None"}
                </p>
              </div>
              <div className="rounded-xl border border-crm-border/70 bg-crm-surface-2/50 p-2">
                <p className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">Recent events</p>
                <p className="mt-1 text-xs font-semibold text-crm-text">{recentActivityCount} in 7d</p>
              </div>
              <div className="rounded-xl border border-crm-border/70 bg-crm-surface-2/50 p-2">
                <p className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">Callbacks</p>
                <p className={cn("mt-1 text-xs font-semibold", callbackUrgent ? "text-crm-danger" : "text-crm-text")}>
                  {callbackUrgent ? "Overdue" : queueMember?.callbackAt ? formatDate(queueMember.callbackAt) : "None due"}
                </p>
              </div>
              <div className="rounded-xl border border-crm-border/70 bg-crm-surface-2/50 p-2">
                <p className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">Open tasks</p>
                <p className="mt-1 text-xs font-semibold text-crm-text">{tasks.length}</p>
              </div>
            </div>
          </CRMCard>
          </ContactCollapsibleSection>
        <div className="flex flex-col gap-4">

          {/* CRM fields */}
          <ContactCollapsibleSection
            id="right-rail-outreach-rules"
            title="Outreach rules"
            summary={`${stageLabel(stage)} · DNC ${contact.doNotCall ? "on" : "off"} · SMS opt-out ${contact.doNotSms ? "on" : "off"}`}
          >
          <div className="panel rounded-crm-lg border border-crm-border/60 shadow-crm" style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
            <h3 style={{ margin: 0, fontSize: "0.875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-dim)" }}>
              Outreach rules &amp; signal
            </h3>

            <div>
              <label style={labelStyle}>Stage</label>
              {editing ? (
                <select
                  value={editStage}
                  onChange={(e) => setEditStage(e.target.value as CrmStage)}
                  style={inputStyle}
                >
                  {STAGE_OPTIONS.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              ) : (
                <span style={{
                  display: "inline-block",
                  padding: "0.2rem 0.6rem",
                  borderRadius: "0.25rem",
                  fontSize: "0.8125rem",
                  fontWeight: 600,
                  background: stageColor(stage) + "22",
                  color: stageColor(stage),
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}>
                  {stageLabel(stage)}
                </span>
              )}
            </div>

            <div>
              <label style={labelStyle}>Do Not Call</label>
              {editing ? (
                <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={editDoNotCall}
                    onChange={(e) => setEditDoNotCall(e.target.checked)}
                  />
                  <span style={{ fontSize: "0.875rem" }}>Do Not Call</span>
                </label>
              ) : (
                <span style={{ fontSize: "0.875rem", color: contact.doNotCall ? "#ef4444" : "var(--text-dim)" }}>
                  {contact.doNotCall ? "Yes" : "No"}
                </span>
              )}
            </div>

            <div>
              <label style={labelStyle}>Do Not SMS</label>
              {editing ? (
                <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={editDoNotSms}
                    onChange={(e) => setEditDoNotSms(e.target.checked)}
                  />
                  <span style={{ fontSize: "0.875rem" }}>Do Not SMS</span>
                </label>
              ) : (
                <span style={{ fontSize: "0.875rem", color: contact.doNotSms ? "#ef4444" : "var(--text-dim)" }}>
                  {contact.doNotSms ? "Yes" : "No"}
                </span>
              )}
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem 1.5rem", fontSize: "0.8125rem", color: "var(--text-dim)", paddingTop: "0.375rem", borderTop: "1px solid var(--border)" }}>
              <span style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                <Clock size={12} /> Added {formatDate(contact.createdAt)}
              </span>
              {contact.lastActivityAt && (
                <span style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                  <User size={12} /> Last activity {formatDate(contact.lastActivityAt)}
                </span>
              )}
              {contact.lastDisposition && (
                <span style={{ display: "flex", alignItems: "center", gap: "0.3rem", color: "#0ea5e9" }}>
                  <CheckCheck size={12} />
                  Last disposition: <strong style={{ fontWeight: 600 }}>{contact.lastDisposition}</strong>
                  {contact.lastDispositionAt && (
                    <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>
                      &nbsp;· {formatDate(contact.lastDispositionAt)}
                    </span>
                  )}
                </span>
              )}
              {lastSmsIn && (
                <span style={{ display: "flex", alignItems: "center", gap: "0.3rem", color: "#7c3aed" }}>
                  <MessageSquareDot size={12} />
                  Last SMS in: {formatTimeAgo(lastSmsIn.createdAt)}
                </span>
              )}
            </div>
          </div>
          </ContactCollapsibleSection>

          {/* ── Open tasks panel ──────────────────────────────────────────── */}
          <ContactCollapsibleSection
            id="right-rail-open-tasks"
            title="Open tasks"
            summary={`${tasks.length} active follow-up${tasks.length === 1 ? "" : "s"}`}
          >
          <div ref={tasksPanelRef} className="panel rounded-crm-lg border border-crm-border/60 shadow-crm" style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.625rem" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h3 style={{ margin: 0, fontSize: "0.875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-dim)" }}>
                Open Tasks {tasks.length > 0 && <span style={{ fontWeight: 400, color: "var(--accent)" }}>({tasks.length})</span>}
              </h3>
              {!isArchived && (
                <button
                  onClick={() => setAddingTask((v) => !v)}
                  title="Add follow-up"
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent)", padding: "0.125rem", display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.8125rem", fontWeight: 600 }}
                >
                  <Plus size={13} /> Add
                </button>
              )}
            </div>

            {/* Inline add form */}
            {!isArchived && addingTask && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
                <input
                  value={newTaskTitle}
                  onChange={(e) => setNewTaskTitle(e.target.value)}
                  placeholder="Follow-up title…"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreateTask(); if (e.key === "Escape") setAddingTask(false); }}
                  style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
                />
                {/* Date presets */}
                <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
                  {[
                    { label: "Today", days: 0 },
                    { label: "Tomorrow", days: 1 },
                    { label: "Next week", days: 7 },
                  ].map(({ label, days }) => {
                    const d = new Date();
                    d.setDate(d.getDate() + days);
                    const val = d.toISOString().slice(0, 10);
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() => setNewTaskDueAt(val)}
                        style={{
                          padding: "0.2rem 0.5rem",
                          borderRadius: "0.25rem",
                          border: `1px solid ${newTaskDueAt === val ? "var(--accent)" : "var(--border)"}`,
                          background: newTaskDueAt === val ? "var(--accent)" : "var(--surface-hover)",
                          color: newTaskDueAt === val ? "#fff" : "var(--text-dim)",
                          fontSize: "0.75rem",
                          cursor: "pointer",
                          display: "flex", alignItems: "center", gap: "0.2rem",
                        }}
                      >
                        <Calendar size={10} /> {label}
                      </button>
                    );
                  })}
                  <input
                    type="date"
                    value={newTaskDueAt}
                    onChange={(e) => setNewTaskDueAt(e.target.value)}
                    style={{ ...inputStyle, width: "auto", fontSize: "0.75rem", padding: "0.2rem 0.4rem" }}
                    title="Custom date"
                  />
                </div>
                <div style={{ display: "flex", gap: "0.375rem" }}>
                  <button
                    onClick={handleCreateTask}
                    disabled={newTaskPosting || !newTaskTitle.trim()}
                    style={{ padding: "0.4rem 0.75rem", borderRadius: "0.3rem", border: "none", cursor: "pointer", background: "var(--accent)", color: "#fff", fontSize: "0.8125rem", fontWeight: 600, opacity: !newTaskTitle.trim() ? 0.5 : 1 }}
                  >
                    {newTaskPosting ? "…" : "Add"}
                  </button>
                  <button
                    onClick={() => { setAddingTask(false); setNewTaskDueAt(""); setNewTaskTitle(""); }}
                    style={{ padding: "0.4rem 0.75rem", borderRadius: "0.3rem", border: "1px solid var(--border)", cursor: "pointer", background: "var(--surface-hover)", color: "var(--text-dim)", fontSize: "0.8125rem" }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Task list */}
            {tasksLoading ? (
              <LoadingSkeleton rows={2} />
            ) : tasks.length === 0 && !addingTask ? (
              <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--text-dim)" }}>No open tasks.</p>
            ) : (
              tasks.map((task) => {
                const isDue = task.dueAt && new Date(task.dueAt) < new Date();
                return (
                  <div key={task.id} style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", paddingTop: "0.375rem" }}>
                    {!isArchived ? (
                      <button
                        onClick={() => handleCompleteTask(task.id)}
                        title="Mark done"
                        style={{ background: "none", border: "none", cursor: "pointer", padding: "0.1rem", color: "var(--text-dim)", flexShrink: 0, marginTop: "0.1rem" }}
                      >
                        <Circle size={14} />
                      </button>
                    ) : (
                      <span style={{ width: 14, flexShrink: 0, marginTop: "0.1rem" }} aria-hidden />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "0.875rem", fontWeight: 500 }}>{task.title}</div>
                      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.15rem", alignItems: "center" }}>
                        <span style={{ fontSize: "0.7rem", fontWeight: 700, padding: "0.1rem 0.35rem", borderRadius: "0.2rem", background: TASK_PRIORITY_COLOR[task.priority] + "22", color: TASK_PRIORITY_COLOR[task.priority], textTransform: "uppercase" }}>
                          {task.priority}
                        </span>
                        {task.dueAt && (
                          <span style={{ fontSize: "0.75rem", color: isDue ? "#ef4444" : "var(--text-dim)", display: "flex", alignItems: "center", gap: "0.2rem" }}>
                            <Clock size={10} />
                            {(() => {
                              const d = new Date(task.dueAt as any);
                              return isNaN(d.getTime())
                                ? String(task.dueAt).slice(0, 10)
                                : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                            })()}
                            {isDue && " · overdue"}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          </ContactCollapsibleSection>

          {/* Scratch notes (Contact.notes — single text field) */}
          <ContactCollapsibleSection
            id="right-rail-scratch-notes"
            title="Scratch notes"
            summary={contact.notes ? "Notes on file" : "No scratch notes"}
          >
          <div className="panel" style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.625rem" }}>
            <h3 style={{ margin: 0, fontSize: "0.875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-dim)" }}>Scratch Notes</h3>
            {editing && !isArchived ? (
              <textarea
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                rows={4}
                placeholder="Quick scratch pad for this contact…"
                style={{ ...inputStyle, resize: "vertical", lineHeight: 1.5 }}
              />
            ) : (
              <p style={{ margin: 0, fontSize: "0.875rem", color: contact.notes ? "var(--text)" : "var(--text-dim)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                {contact.notes || "No scratch notes."}
              </p>
            )}
          </div>
          </ContactCollapsibleSection>

          <ContactCollapsibleSection
            id="right-rail-business-profile"
            title="Extracted business profile"
            summary="Verified CRM fields, extracted document data, and phone discoveries"
          >
            <ContactDocumentSummary contactId={id} refreshToken={summaryRefreshToken} />
          </ContactCollapsibleSection>

          {/* All phones & emails */}
          <ContactCollapsibleSection
            id="right-rail-contact-info"
            title="Contact info"
            summary={`${contact.phones.length} phone${contact.phones.length === 1 ? "" : "s"} · ${contact.emails.length} email${contact.emails.length === 1 ? "" : "s"}`}
          >
          <div className="panel" style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.625rem" }}>
            <h3 style={{ margin: 0, fontSize: "0.875rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-dim)" }}>Contact Info</h3>

            {contact.phones.length === 0 && contact.emails.length === 0 && !addingPhone && !addingEmail && (
              <p style={{ margin: 0, fontSize: "0.875rem", color: "var(--text-dim)" }}>No contact info yet.</p>
            )}

            {/* Phones */}
            {contact.phones.map((p) => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <Phone size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "0.875rem", fontWeight: p.isPrimary ? 600 : 400 }}>{p.numberRaw}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", textTransform: "capitalize" }}>
                    {phoneSummaryLabel(p)}
                  </div>
                </div>
                {!isArchived && (
                  <button
                    onClick={() => handleRemovePhone(p.id)}
                    title="Remove phone"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: "0.1rem", lineHeight: 1, flexShrink: 0 }}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            ))}

            {/* Add phone inline form */}
            {!isArchived && (addingPhone ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem", paddingTop: "0.25rem" }}>
                <div style={{ display: "flex", gap: "0.375rem" }}>
                  <input
                    autoFocus
                    value={newPhoneRaw}
                    onChange={(e) => setNewPhoneRaw(e.target.value)}
                    placeholder="Phone number"
                    onKeyDown={(e) => { if (e.key === "Enter") handleAddPhone(); if (e.key === "Escape") { setAddingPhone(false); setNewPhoneRaw(""); } }}
                    style={{ ...inputStyle, flex: 1, fontSize: "0.8125rem" }}
                  />
                  <select
                    value={newPhoneType}
                    onChange={(e) => setNewPhoneType(e.target.value)}
                    style={{ ...inputStyle, width: "auto", fontSize: "0.8125rem" }}
                  >
                    {CRM_PHONE_TYPE_OPTIONS.map((type) => (
                      <option key={type} value={type}>{phoneTypeLabel(type)}</option>
                    ))}
                  </select>
                </div>
                <div style={{ display: "flex", gap: "0.375rem" }}>
                  <button
                    onClick={handleAddPhone}
                    disabled={newPhonePosting || !newPhoneRaw.trim()}
                    style={{ padding: "0.3rem 0.625rem", borderRadius: "0.3rem", border: "none", cursor: "pointer", background: "var(--accent)", color: "#fff", fontSize: "0.75rem", fontWeight: 600 }}
                  >
                    {newPhonePosting ? "…" : "Add"}
                  </button>
                  <button
                    onClick={() => { setAddingPhone(false); setNewPhoneRaw(""); }}
                    style={{ padding: "0.3rem 0.625rem", borderRadius: "0.3rem", border: "1px solid var(--border)", cursor: "pointer", background: "var(--surface-hover)", color: "var(--text-dim)", fontSize: "0.75rem" }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAddingPhone(true)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: "0.8125rem", fontWeight: 600, padding: 0, textAlign: "left", display: "flex", alignItems: "center", gap: "0.25rem" }}
              >
                <Plus size={12} /> Add phone
              </button>
            ))}

            {/* Divider */}
            <div style={{ borderTop: "1px solid var(--border)", margin: "0.25rem 0" }} />

            {/* Emails */}
            {contact.emails.map((e) => (
              <div key={e.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <Mail size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "0.875rem", fontWeight: e.isPrimary ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.email}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", textTransform: "capitalize" }}>
                    {e.type.toLowerCase()}{e.isPrimary ? " · primary" : ""}
                  </div>
                </div>
                {!isArchived && (
                  <button
                    onClick={() => handleRemoveEmail(e.id)}
                    title="Remove email"
                    style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: "0.1rem", lineHeight: 1, flexShrink: 0 }}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            ))}

            {/* Add email inline form */}
            {!isArchived && (addingEmail ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem", paddingTop: "0.25rem" }}>
                <div style={{ display: "flex", gap: "0.375rem" }}>
                  <input
                    autoFocus
                    type="email"
                    value={newEmailAddress}
                    onChange={(e) => setNewEmailAddress(e.target.value)}
                    placeholder="Email address"
                    onKeyDown={(e) => { if (e.key === "Enter") handleAddEmail(); if (e.key === "Escape") { setAddingEmail(false); setNewEmailAddress(""); } }}
                    style={{ ...inputStyle, flex: 1, fontSize: "0.8125rem" }}
                  />
                  <select
                    value={newEmailType}
                    onChange={(e) => setNewEmailType(e.target.value as typeof newEmailType)}
                    style={{ ...inputStyle, width: "auto", fontSize: "0.8125rem" }}
                  >
                    <option value="WORK">Work</option>
                    <option value="PERSONAL">Personal</option>
                    <option value="OTHER">Other</option>
                  </select>
                </div>
                <div style={{ display: "flex", gap: "0.375rem" }}>
                  <button
                    onClick={handleAddEmail}
                    disabled={newEmailPosting || !newEmailAddress.trim()}
                    style={{ padding: "0.3rem 0.625rem", borderRadius: "0.3rem", border: "none", cursor: "pointer", background: "var(--accent)", color: "#fff", fontSize: "0.75rem", fontWeight: 600 }}
                  >
                    {newEmailPosting ? "…" : "Add"}
                  </button>
                  <button
                    onClick={() => { setAddingEmail(false); setNewEmailAddress(""); }}
                    style={{ padding: "0.3rem 0.625rem", borderRadius: "0.3rem", border: "1px solid var(--border)", cursor: "pointer", background: "var(--surface-hover)", color: "var(--text-dim)", fontSize: "0.75rem" }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAddingEmail(true)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: "0.8125rem", fontWeight: 600, padding: 0, textAlign: "left", display: "flex", alignItems: "center", gap: "0.25rem" }}
              >
                <Plus size={12} /> Add email
              </button>
            ))}

            {/* Addresses — display read-only (imported from CSV or set via API) */}
            {(contact.addresses ?? []).length > 0 && (
              <>
                <div style={{ borderTop: "1px solid var(--border)", margin: "0.25rem 0" }} />
                {(contact.addresses ?? []).map((addr) => {
                  const line1 = addr.street ?? "";
                  const line2 = [addr.city, addr.state, addr.zip].filter(Boolean).join(", ");
                  if (!line1 && !line2) return null;
                  return (
                    <div key={addr.id} style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem" }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--accent)", flexShrink: 0, marginTop: "0.2rem" }}><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {line1 && <div style={{ fontSize: "0.875rem" }}>{line1}</div>}
                        {line2 && <div style={{ fontSize: "0.8125rem", color: "var(--text-dim)" }}>{line2}</div>}
                        {(contact.timezoneIana || contact.timezoneLabel || contact.timezoneResolutionStatus) && (
                          <div style={{ marginTop: "0.25rem" }}>
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                borderRadius: "999px",
                                padding: "0.1rem 0.45rem",
                                fontSize: "0.6875rem",
                                fontWeight: 600,
                                letterSpacing: "0.02em",
                                background: "var(--surface-hover)",
                                color: "var(--text-dim)",
                              }}
                              title={leadTimezoneBadgeTitle(contact) ?? undefined}
                            >
                              {leadTimezoneDetailLabel(contact)}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
          </ContactCollapsibleSection>

          {/* Possible duplicates panel — shown when the API finds matches */}
          {duplicates.length > 0 && !isArchived && (
            <ContactCollapsibleSection
              id="right-rail-duplicates"
              title="Possible duplicates"
              summary={`${duplicates.length} possible match${duplicates.length === 1 ? "" : "es"}`}
            >
            <div className="panel" style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "0.625rem", borderLeft: "3px solid #f59e0b" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.375rem" }}>
                <AlertTriangle size={13} style={{ color: "#d97706" }} />
                <h3 style={{ margin: 0, fontSize: "0.875rem", fontWeight: 700, color: "#92400e" }}>
                  Possible Duplicates ({duplicates.length})
                </h3>
              </div>
              <p style={{ margin: 0, fontSize: "0.75rem", color: "#92400e" }}>
                These contacts share phone, email, or name with this record.
              </p>
              {duplicates.map((dup) => (
                <div key={dup.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.5rem 0", borderTop: "1px solid var(--border)" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "0.875rem", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {dup.displayName}
                    </div>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
                      {[dup.company, dup.primaryPhone].filter(Boolean).join(" · ")}
                    </div>
                    <div style={{ fontSize: "0.6875rem", color: "#d97706", marginTop: "0.1rem" }}>
                      Match: {dup.matchReasons.join(", ")}
                    </div>
                  </div>
                  <a
                    href={`/crm/contacts/${dup.id}`}
                    style={{ ...btnSmall, textDecoration: "none", fontSize: "0.75rem" }}
                  >
                    View
                  </a>
                  {isAdmin && (
                    <button
                      onClick={() => { setMergeTarget(dup); setMergeError(null); }}
                      style={{ ...btnSmall, color: "#b45309", borderColor: "#fde68a", background: "#fffbeb", fontSize: "0.75rem", display: "flex", alignItems: "center", gap: "0.2rem" }}
                    >
                      <GitMerge size={11} /> Merge
                    </button>
                  )}
                </div>
              ))}
            </div>
            </ContactCollapsibleSection>
          )}
        </div>
        </div>
      </div>
      </div>

      <ContactCampaignLeadNav
        visible={!!campaignIdForNav}
        position={campaignNav.position}
        total={campaignNav.total}
        previousLabel={null}
        nextLabel={null}
        onPrevious={() => navigateCampaignLead(campaignNav.previous)}
        onNext={() => navigateCampaignLead(campaignNav.next)}
        previousDisabled={!campaignNav.previous}
        nextDisabled={!campaignNav.next}
        loading={campaignNavLoading}
      />

      {phonePickerIntent ? (
        <PhoneActionPicker
          intent={phonePickerIntent}
          phones={contact.phones}
          onSelect={selectPhoneForAction}
          onClose={() => setPhonePickerIntent(null)}
        />
      ) : null}

      {workspaceToast ? (
        <p
          role="status"
          className={cn(
            "crm-contact-workspace-toast",
            workspaceToast.kind === "ok" ? "crm-contact-workspace-toast-success" : "crm-contact-workspace-toast-error",
          )}
        >
          {workspaceToast.text}
        </p>
      ) : null}
    </CRMPageShell>
      {mergeTarget && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 10000,
            display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem",
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setMergeTarget(null); }}
        >
          <div style={{
            background: "var(--surface, #fff)", borderRadius: "0.75rem",
            padding: "1.5rem", maxWidth: 420, width: "100%",
            boxShadow: "0 8px 32px rgba(0,0,0,0.22)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem" }}>
              <GitMerge size={18} style={{ color: "#7c3aed" }} />
              <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 700 }}>Merge Contact</h3>
            </div>
            <p style={{ margin: "0 0 0.75rem", fontSize: "0.875rem", color: "var(--text)" }}>
              Merge <strong>{mergeTarget.displayName}</strong> into <strong>{contact?.displayName}</strong>?
            </p>
            <div style={{ background: "#fef3c7", border: "1px solid #fde68a", borderRadius: "0.5rem", padding: "0.625rem 0.875rem", marginBottom: "1rem" }}>
              <p style={{ margin: 0, fontSize: "0.8125rem", color: "#92400e" }}>
                <strong>This cannot be undone.</strong> All activity, tasks, notes, and campaign memberships from <em>{mergeTarget.displayName}</em> will be moved to this contact. <em>{mergeTarget.displayName}</em> will be archived.
              </p>
            </div>
            {mergeError && (
              <p style={{ margin: "0 0 0.75rem", fontSize: "0.8125rem", color: "#ef4444" }}>{mergeError}</p>
            )}
            <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
              <button
                onClick={() => { setMergeTarget(null); setMergeError(null); }}
                disabled={merging}
                style={{ ...btnSmall, padding: "0.4375rem 0.875rem" }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleMerge(mergeTarget.id)}
                disabled={merging}
                style={{ padding: "0.4375rem 0.875rem", borderRadius: "0.375rem", border: "none", cursor: "pointer", background: "#7c3aed", color: "#fff", fontSize: "0.875rem", fontWeight: 700 }}
              >
                {merging ? "Merging…" : "Confirm Merge"}
              </button>
            </div>
          </div>
        </div>
      )}
    {contact ? (
      <CrmEmailComposeDrawer
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        contactId={contact.id}
        contactName={contact.displayName}
        contactEmail={(contact.emails.find((e) => e.isPrimary) ?? contact.emails[0])?.email ?? null}
        mergeFields={{
          firstName: contact.firstName ?? null,
          lastName: contact.lastName ?? null,
          displayName: contact.displayName,
          company: contact.company ?? null,
          email: (contact.emails.find((e) => e.isPrimary) ?? contact.emails[0])?.email ?? null,
        }}
        onSent={() => { void loadTimeline(); }}
      />
    ) : null}
    {contact ? (
      <CrmVoicemailDropDrawer
        open={voicemailDropOpen}
        onClose={() => setVoicemailDropOpen(false)}
        contactId={contact.id}
        contactName={contact.displayName}
        activeCallId={activeContactCall?.linkedId ?? activeContactCall?.id ?? null}
        onDropped={() => { void loadTimeline(); }}
      />
    ) : null}
    </>
  );
}
