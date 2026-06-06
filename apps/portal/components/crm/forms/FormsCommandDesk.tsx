"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, CheckCircle, Eye, FileSignature, GripVertical, Layers, Pencil, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { CRMPageHeader } from "../CRMPageHeader";
import {
  CRMWorkspaceBody,
  CRMWorkspaceChrome,
  CRMWorkspaceHeader,
  CRMWorkspaceMain,
  CRMWorkspaceRightRail,
  CRMWorkspaceScrollRegion,
  CRMWorkspaceShell,
  CRMWorkspaceToolbar,
} from "../CRMWorkspaceShell";
import { ConnectSelect } from "../../ConnectSelect";
import { ApiError, apiGet, apiPost, apiPut, getPortalApiBaseUrl } from "../../../services/apiClient";
import { CRM_FORM_MERGE_FIELDS } from "@connect/shared";

type FormStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";
type FieldType = "TEXT" | "DATE" | "CHECKBOX" | "SIGNATURE" | "INITIALS";

type FormTemplate = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  status: FormStatus;
  pageCount: number | null;
  pdfMetadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  timesSent: number;
  completedCount: number;
};

type FormField = {
  id?: string;
  fieldType: FieldType;
  label: string;
  /** Token from CRM_FORM_MERGE_FIELDS, e.g. "contact.fullName". null = no auto-fill. */
  autoFillToken?: string | null;
  required: boolean;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type FormsResponse = {
  forms: FormTemplate[];
  stats: Partial<Record<FormStatus, number>>;
};

type FormDetailResponse = {
  form: FormTemplate;
  fields: FormField[];
};

const FIELD_TYPES: FieldType[] = ["TEXT", "DATE", "CHECKBOX", "SIGNATURE", "INITIALS"];

// ── Token picker options — grouped from the shared CRM_FORM_MERGE_FIELDS list ─
const TOKEN_OPTION_GROUPS = (() => {
  const map = new Map<string, { value: string; label: string }[]>();
  for (const f of CRM_FORM_MERGE_FIELDS) {
    const grp = map.get(f.group) ?? [];
    grp.push({ value: f.token.replace(/^\{\{\s*|\s*\}\}$/g, ""), label: f.label });
    map.set(f.group, grp);
  }
  // Prepend a "clear" entry so users can unset the token via the dropdown
  const groups = Array.from(map.entries()).map(([label, options]) => ({ label, options }));
  return [{ label: "No auto-fill", options: [{ value: "", label: "— Manual entry only" }] }, ...groups];
})();

// Flat map of token key → sample value for preview
const TOKEN_SAMPLE: Record<string, string> = Object.fromEntries(
  CRM_FORM_MERGE_FIELDS.map((f) => [f.token.replace(/^\{\{\s*|\s*\}\}$/g, ""), f.sample]),
);
const TOKEN_LABEL: Record<string, string> = Object.fromEntries(
  CRM_FORM_MERGE_FIELDS.map((f) => [f.token.replace(/^\{\{\s*|\s*\}\}$/g, ""), f.label]),
);

function tokenFromStorage(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
}

function tenantContextFromStorage(): string {
  if (typeof window === "undefined") return "";
  const scope = localStorage.getItem("cc-admin-scope") || "TENANT";
  return scope === "GLOBAL" ? "" : localStorage.getItem("cc-tenant-id") || "";
}

function fmtDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function statusClass(status: FormStatus) {
  if (status === "ACTIVE") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-200";
  if (status === "ARCHIVED") return "bg-slate-500/10 text-slate-600 dark:text-slate-300";
  return "bg-amber-500/10 text-amber-700 dark:text-amber-200";
}

function openFormPreview(formId: string) {
  const params = new URLSearchParams();
  const token = tokenFromStorage();
  if (token) params.set("token", token);
  const tenantContext = tenantContextFromStorage();
  if (tenantContext) params.set("tenantContext", tenantContext);
  const qs = params.toString() ? `?${params.toString()}` : "";
  const opened = window.open(
    `${getPortalApiBaseUrl()}/crm/forms/${encodeURIComponent(formId)}/preview${qs}`,
    "_blank",
    "noopener,noreferrer",
  );
  if (!opened) {
    window.alert("Allow pop-ups for this site to open the PDF preview.");
  }
}

function emptyField(index: number): FormField {
  return {
    fieldType: "TEXT",
    label: `Field ${index + 1}`,
    autoFillToken: null,
    required: false,
    pageNumber: 1,
    x: 72,
    y: 120 + index * 34,
    width: 180,
    height: 28,
  };
}

export function FormsCommandDesk() {
  const [forms, setForms] = useState<FormTemplate[]>([]);
  const [stats, setStats] = useState<FormsResponse["stats"]>({});
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"ALL" | FormStatus>("ALL");
  const [loading, setLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadForms = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (status !== "ALL") params.set("status", status);
      const data = await apiGet<FormsResponse>(`/crm/forms?${params}`);
      setForms(data.forms);
      setStats(data.stats || {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load forms.");
      setForms([]);
    } finally {
      setLoading(false);
    }
  }, [search, status]);

  useEffect(() => { loadForms(); }, [loadForms]);

  const totals = useMemo(() => ({
    all: forms.length,
    active: stats.ACTIVE || 0,
    draft: stats.DRAFT || 0,
    archived: stats.ARCHIVED || 0,
    sent: forms.reduce((sum, form) => sum + form.timesSent, 0),
    completed: forms.reduce((sum, form) => sum + form.completedCount, 0),
  }), [forms, stats]);

  return (
    <CRMWorkspaceShell>
      <CRMWorkspaceChrome>
        <CRMWorkspaceHeader>
          <CRMPageHeader
            icon={<FileSignature className="h-5 w-5" />}
            title="Forms"
            subtitle="Reusable PDF forms for secure lead completion, signatures, and CRM submissions."
            className="tasks-page-header"
            actions={
              <button type="button" onClick={() => setUploadOpen(true)} className="tasks-primary-action">
                <Plus className="h-4 w-4" />
                Upload Form
              </button>
            }
          />
        </CRMWorkspaceHeader>

        <CRMWorkspaceToolbar className="flex flex-col gap-3">
          <div className="tasks-kpi-grid grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {[
              ["Templates", totals.all],
              ["Active", totals.active],
              ["Draft", totals.draft],
              ["Times sent", totals.sent],
              ["Completed", totals.completed],
            ].map(([label, value]) => (
              <div key={label} className="tasks-kpi-card">
                <div className="flex min-w-0 flex-col gap-2">
                  <span className="text-[11px] font-semibold leading-none text-crm-muted">{label}</span>
                  <span className="text-3xl font-semibold leading-none tracking-tight tabular-nums text-crm-text">{value}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="tasks-filter-bar flex flex-col gap-3 md:flex-row md:items-center">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search forms by name, category, or description"
              className="min-w-0 flex-1 rounded-xl border border-crm-border bg-crm-surface px-3 py-2 text-sm text-crm-text outline-none"
            />
            <ConnectSelect
              value={status}
              onChange={(value) => setStatus(value as typeof status)}
              size="sm"
              options={[
                { value: "ALL", label: "All statuses" },
                { value: "ACTIVE", label: "Active" },
                { value: "DRAFT", label: "Draft" },
                { value: "ARCHIVED", label: "Archived" },
              ]}
            />
            <button type="button" onClick={loadForms} className="rounded-xl border border-crm-border px-3 py-2 text-sm text-crm-text">
              <RefreshCw className="mr-2 inline h-4 w-4" />
              Refresh
            </button>
          </div>
          {error ? <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">{error}</div> : null}
        </CRMWorkspaceToolbar>
      </CRMWorkspaceChrome>

      <CRMWorkspaceBody split>
        <CRMWorkspaceMain>
          <CRMWorkspaceScrollRegion>
            <div className="tasks-list-card overflow-hidden">
              {loading ? (
                <div className="p-6 text-sm text-crm-muted">Loading forms…</div>
              ) : forms.length === 0 ? (
                <div className="p-8 text-center">
                  <FileSignature className="mx-auto h-10 w-10 text-crm-muted" />
                  <h3 className="mt-3 text-lg font-semibold text-crm-text">No forms yet</h3>
                  <p className="mt-1 text-sm text-crm-muted">Upload a reusable PDF form to start sending secure signing links.</p>
                </div>
              ) : (
                <div className="divide-y divide-crm-border/60">
                  {forms.map((form) => (
                    <div key={form.id} className="grid gap-3 p-4 lg:grid-cols-[1.4fr_.8fr_.6fr_.7fr_.7fr_.7fr_auto] lg:items-center">
                      <div>
                        <div className="font-semibold text-crm-text">{form.name}</div>
                        <div className="text-xs text-crm-muted">{form.originalFileName}</div>
                      </div>
                      <div className="text-sm text-crm-text">{form.category || "Uncategorized"}</div>
                      <span className={`w-fit rounded-full px-2 py-1 text-xs font-medium ${statusClass(form.status)}`}>{form.status}</span>
                      <div className="text-sm text-crm-muted">{fmtDate(form.createdAt)}</div>
                      <div className="text-sm text-crm-muted">{fmtDate(form.updatedAt)}</div>
                      <div className="text-sm text-crm-muted">{form.timesSent} sent · {form.completedCount} done</div>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => setEditingId(form.id)} className="rounded-lg border border-crm-border px-2 py-1 text-xs text-crm-text">
                          <Pencil className="mr-1 inline h-3.5 w-3.5" /> Edit
                        </button>
                        <button type="button" onClick={() => openFormPreview(form.id)} className="rounded-lg border border-crm-border px-2 py-1 text-xs text-crm-text">
                          <Eye className="mr-1 inline h-3.5 w-3.5" /> View
                        </button>
                        {form.status === "DRAFT" ? (
                          <button type="button" onClick={async () => { await apiPut(`/crm/forms/${form.id}`, { status: "ACTIVE" }); loadForms(); }} className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                            <CheckCircle className="mr-1 inline h-3.5 w-3.5" /> Activate
                          </button>
                        ) : null}
                        {form.status !== "ARCHIVED" ? (
                          <button type="button" onClick={async () => { await apiPost(`/crm/forms/${form.id}/archive`); loadForms(); }} className="rounded-lg border border-crm-border px-2 py-1 text-xs text-crm-text">
                            <Archive className="mr-1 inline h-3.5 w-3.5" /> Archive
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CRMWorkspaceScrollRegion>
        </CRMWorkspaceMain>
        <CRMWorkspaceRightRail>
          <div className="flex flex-col gap-4">
            <section className="tasks-sidebar-card">
              <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-crm-text">Phase 1 editor</h3>
              <p className="mt-2 text-sm leading-relaxed text-crm-muted">Add fields as a structured list now. Coordinates are stored so a drag/drop PDF overlay can be added later without a data migration.</p>
            </section>
          </div>
        </CRMWorkspaceRightRail>
      </CRMWorkspaceBody>

      {uploadOpen ? <UploadFormModal onClose={() => setUploadOpen(false)} onUploaded={() => { setUploadOpen(false); loadForms(); }} /> : null}
      {editingId ? <FormEditorDrawer formId={editingId} onClose={() => setEditingId(null)} onSaved={loadForms} /> : null}
    </CRMWorkspaceShell>
  );
}

function UploadFormModal({ onClose, onUploaded }: { onClose: () => void; onUploaded: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return setError("Choose a PDF file.");
    setBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      if (name) formData.append("name", name);
      if (category) formData.append("category", category);
      if (description) formData.append("description", description);
      const token = tokenFromStorage();
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const tenantContext = tenantContextFromStorage();
      if (tenantContext) headers["x-tenant-context"] = tenantContext;
      const res = await fetch(`${getPortalApiBaseUrl()}/crm/forms/upload`, { method: "POST", headers, body: formData });
      if (!res.ok) throw new ApiError((await res.json().catch(() => ({}))).detail || "Upload failed", res.status);
      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-crm-border bg-crm-surface p-5 shadow-2xl">
        <h2 className="text-lg font-semibold text-crm-text">Upload PDF form</h2>
        <div className="mt-4 space-y-3">
          <input ref={fileRef} type="file" accept="application/pdf,.pdf" className="block w-full text-sm text-crm-text" />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Form name" className="w-full rounded-xl border border-crm-border bg-crm-surface px-3 py-2 text-sm text-crm-text" />
          <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Category" className="w-full rounded-xl border border-crm-border bg-crm-surface px-3 py-2 text-sm text-crm-text" />
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" rows={3} className="w-full rounded-xl border border-crm-border bg-crm-surface px-3 py-2 text-sm text-crm-text" />
          {error ? <div className="text-sm text-red-600">{error}</div> : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-crm-border px-4 py-2 text-sm text-crm-text">Cancel</button>
          <button type="button" disabled={busy} onClick={upload} className="tasks-primary-action">
            <Upload className="h-4 w-4" />
            {busy ? "Uploading…" : "Upload"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Field type colours ───────────────────────────────────────────────────────

const FIELD_COLOR: Record<FieldType, { bg: string; border: string; text: string }> = {
  SIGNATURE: { bg: "rgba(99,102,241,0.18)", border: "#6366f1", text: "#4f46e5" },
  INITIALS:  { bg: "rgba(168,85,247,0.18)", border: "#a855f7", text: "#7c3aed" },
  TEXT:      { bg: "rgba(14,165,233,0.18)", border: "#0ea5e9", text: "#0284c7" },
  DATE:      { bg: "rgba(245,158,11,0.18)", border: "#f59e0b", text: "#b45309" },
  CHECKBOX:  { bg: "rgba(34,197,94,0.18)",  border: "#22c55e", text: "#15803d" },
};

// ─── PDF page renderer (uses pdfjs-dist lazily) ───────────────────────────────

type PageSize = { width: number; height: number; scale: number };

function PdfPageCanvas({
  pdfUrl,
  pageNumber,
  authToken,
  onSize,
  onError,
}: {
  pdfUrl: string;
  pageNumber: number;
  authToken: string;
  onSize: (s: PageSize) => void;
  onError: (msg: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Use refs for callbacks so changing them never re-triggers the render effect
  const onSizeRef  = useRef(onSize);
  const onErrorRef = useRef(onError);
  useEffect(() => { onSizeRef.current  = onSize;  });
  useEffect(() => { onErrorRef.current = onError; });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // pdfjs-dist v4 — explicit build path avoids Next.js bundler issues
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pdfjsLib = await import("pdfjs-dist/build/pdf.mjs" as any);
        // Worker served from /public — no bundler involvement
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pdfjsLib as any).GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

        const headers: Record<string, string> = {};
        if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
        if (typeof window !== "undefined") {
          const scope = localStorage.getItem("cc-admin-scope") || "TENANT";
          const tenantId = scope === "GLOBAL" ? "" : localStorage.getItem("cc-tenant-id") || "";
          if (tenantId) headers["x-tenant-context"] = tenantId;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const loadingTask = (pdfjsLib as any).getDocument({ url: pdfUrl, httpHeaders: headers });
        const pdf = await loadingTask.promise;
        if (cancelled) return;
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;

        const containerWidth = canvasRef.current?.parentElement?.clientWidth || 700;
        const vp0 = page.getViewport({ scale: 1 });
        const scale = Math.min((containerWidth - 2) / vp0.width, 2.2);
        const viewport = page.getViewport({ scale });

        const canvas = canvasRef.current!;
        canvas.width  = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d")!;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await page.render({ canvasContext: ctx as any, viewport }).promise;
        if (!cancelled) onSizeRef.current({ width: viewport.width, height: viewport.height, scale });
      } catch (err) {
        if (!cancelled) onErrorRef.current(err instanceof Error ? err.message : "Unable to render PDF.");
      }
    })();
    return () => { cancelled = true; };
    // Only re-render when the actual PDF content changes, not when callbacks change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfUrl, pageNumber, authToken]);

  return <canvas ref={canvasRef} className="block w-full rounded-sm" />;
}

// ─── Visual field placement editor ────────────────────────────────────────────

const FIELD_DEFAULT_SIZE: Record<FieldType, { w: number; h: number }> = {
  SIGNATURE: { w: 200, h: 60 },
  INITIALS:  { w: 90,  h: 40 },
  TEXT:      { w: 180, h: 28 },
  DATE:      { w: 130, h: 28 },
  CHECKBOX:  { w: 24,  h: 24 },
};

function FormEditorDrawer({ formId, onClose, onSaved }: { formId: string; onClose: () => void; onSaved: () => void }) {
  const [detail, setDetail]       = useState<FormDetailResponse | null>(null);
  const [fields, setFields]       = useState<FormField[]>([]);
  const [error, setError]         = useState<string | null>(null);
  const [pdfError, setPdfError]   = useState<string | null>(null);
  const [saving, setSaving]       = useState(false);
  const [activeTool, setActiveTool] = useState<FieldType>("TEXT");
  // Pre-configured label + token for the NEXT field to be placed
  const [activeLabel, setActiveLabel]  = useState("Full name");
  const [activeToken, setActiveToken]  = useState<string | null>("contact.fullName");
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [pageCount, setPageCount] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSizes, setPageSizes] = useState<Record<number, PageSize>>({});
  const authToken = typeof window !== "undefined" ? tokenFromStorage() : "";
  // drag state for moving placed fields
  const dragRef = useRef<{ idx: number; startX: number; startY: number; origX: number; origY: number } | null>(null);
  // remembers the last placed field's size + X so subsequent fields snap to the same alignment
  const lastPlacedRef = useRef<{ width: number; height: number; x: number } | null>(null);
  const [lastPlacedSize, setLastPlacedSize] = useState<{ width: number; height: number; x: number } | null>(null);
  // alignment guide lines shown while dragging
  const [alignLines, setAlignLines] = useState<{ type: "v" | "h"; pos: number }[]>([]);
  // resize state for resizing placed fields
  const resizeRef = useRef<{
    idx: number; startX: number; startY: number;
    origW: number; origH: number; origX: number; origY: number;
    dir: string; // e.g. "se", "e", "s", "sw", "n", "ne", "nw", "w"
  } | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const pdfUrl = `${getPortalApiBaseUrl()}/crm/forms/${formId}/preview`;

  useEffect(() => {
    apiGet<FormDetailResponse>(`/crm/forms/${formId}`)
      .then((data) => {
        setDetail(data);
        setFields(data.fields);
        setPageCount(data.form.pageCount ?? 1);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load form."));
  }, [formId]);

  const handlePageSize = useCallback((page: number, size: PageSize) => {
    setPageSizes((prev) => ({ ...prev, [page]: size }));
  }, []);

  // Default label + token when the user switches field types
  const switchTool = (type: FieldType) => {
    setActiveTool(type);
    const defaults: Record<FieldType, { label: string; token: string | null }> = {
      SIGNATURE: { label: "Authorized signature",      token: null },
      INITIALS:  { label: "Initials",                  token: null },
      TEXT:      { label: "Full name",                 token: "contact.fullName" },
      DATE:      { label: "Effective date",            token: "form.date" },
      CHECKBOX:  { label: "I have read and agree",     token: null },
    };
    setActiveLabel(defaults[type].label);
    setActiveToken(defaults[type].token);
  };

  // ── Arrow-key nudge selected field ───────────────────────────────────────
  useEffect(() => {
    if (selectedIdx === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      // Don't interfere with text inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      setFields((prev) => {
        const next = prev.map((f, i) => {
          if (i !== selectedIdx) return f;
          switch (e.key) {
            case "ArrowLeft":  return { ...f, x: Math.max(0, f.x - step) };
            case "ArrowRight": return { ...f, x: f.x + step };
            case "ArrowUp":    return { ...f, y: Math.max(0, f.y - step) };
            case "ArrowDown":  return { ...f, y: f.y + step };
            default:           return f;
          }
        });
        setAlignLines(computeAlignLines(selectedIdx, next));
        return next;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      setAlignLines([]);
    };
  }, [selectedIdx]);

  // ── Compute alignment guide lines for dragging / nudging ──────────────────
  const SNAP_THRESHOLD = 5; // PDF units

  function computeAlignLines(
    movingIdx: number,
    allFields: FormField[],
  ): { type: "v" | "h"; pos: number }[] {
    const f = allFields[movingIdx];
    if (!f) return [];
    const lines: { type: "v" | "h"; pos: number }[] = [];
    const fLeft   = f.x;
    const fCx     = f.x + f.width  / 2;
    const fRight  = f.x + f.width;
    const fTop    = f.y;
    const fCy     = f.y + f.height / 2;
    const fBottom = f.y + f.height;

    for (let i = 0; i < allFields.length; i++) {
      if (i === movingIdx) continue;
      const o = allFields[i];
      const oLeft   = o.x;
      const oCx     = o.x + o.width  / 2;
      const oRight  = o.x + o.width;
      const oTop    = o.y;
      const oCy     = o.y + o.height / 2;
      const oBottom = o.y + o.height;

      for (const fp of [fLeft, fCx, fRight]) {
        for (const op of [oLeft, oCx, oRight]) {
          if (Math.abs(fp - op) < SNAP_THRESHOLD) lines.push({ type: "v", pos: op });
        }
      }
      for (const fp of [fTop, fCy, fBottom]) {
        for (const op of [oTop, oCy, oBottom]) {
          if (Math.abs(fp - op) < SNAP_THRESHOLD) lines.push({ type: "h", pos: op });
        }
      }
    }
    // Deduplicate
    return lines.filter((l, i, a) => a.findIndex((x) => x.type === l.type && Math.abs(x.pos - l.pos) < 1) === i);
  }

  // ── Click on the PDF overlay to drop a field ─────────────────────────────
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (dragRef.current) return; // was a drag, not a click
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const pxX = e.clientX - rect.left;
    const pxY = e.clientY - rect.top;
    const ps = pageSizes[currentPage];
    if (!ps) return;
    // Convert pixel coords → PDF-space coords (unscaled)
    const x = Math.round(pxX / ps.scale);
    const y = Math.round(pxY / ps.scale);
    const def = FIELD_DEFAULT_SIZE[activeTool];
    // Reuse last placed field's size + X alignment, or fall back to type defaults
    const last = lastPlacedRef.current;
    const fieldWidth  = last ? last.width  : def.w;
    const fieldHeight = last ? last.height : def.h;
    const fieldX      = last ? last.x      : x;   // snap X to last placed field; use click X for first ever
    const newField: FormField = {
      fieldType: activeTool,
      label: activeLabel || (activeTool === "SIGNATURE" ? "Authorized signature" : activeTool === "INITIALS" ? "Initials" : "Field"),
      autoFillToken: activeToken,
      required: activeTool !== "TEXT" && activeTool !== "CHECKBOX",
      pageNumber: currentPage,
      x: fieldX,
      y,
      width: fieldWidth,
      height: fieldHeight,
    };
    // Remember this placement's size + X for the next field
    const snap = { width: fieldWidth, height: fieldHeight, x: fieldX };
    lastPlacedRef.current = snap;
    setLastPlacedSize(snap);
    setFields((prev) => {
      const next = [...prev, newField];
      setSelectedIdx(next.length - 1);
      return next;
    });
  };

  // ── Drag to reposition a field ────────────────────────────────────────────
  const startDrag = (e: React.MouseEvent, idx: number) => {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = {
      idx,
      startX: e.clientX,
      startY: e.clientY,
      origX: fields[idx].x,
      origY: fields[idx].y,
    };
    setSelectedIdx(idx);
    const onMove = (mv: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const ps = pageSizes[currentPage];
      if (!ps) return;
      const dx = (mv.clientX - drag.startX) / ps.scale;
      const dy = (mv.clientY - drag.startY) / ps.scale;
      let newX = Math.max(0, Math.round(drag.origX + dx));
      let newY = Math.max(0, Math.round(drag.origY + dy));
      setFields((prev) => {
        // Snap to alignment
        const tentative = prev.map((f, i) => i === drag.idx ? { ...f, x: newX, y: newY } : f);
        const lines = computeAlignLines(drag.idx, tentative);
        setAlignLines(lines);
        // Apply snap: pull to nearest matching guide within threshold
        for (const line of lines) {
          const f = tentative[drag.idx];
          if (!f) break;
          if (line.type === "v") {
            const candidates = [f.x, f.x + f.width / 2, f.x + f.width];
            const closest = candidates.reduce((a, b) => Math.abs(a - line.pos) < Math.abs(b - line.pos) ? a : b);
            const offset = closest === f.x ? 0 : closest === f.x + f.width ? -f.width : -f.width / 2;
            newX = Math.round(line.pos + offset);
          } else {
            const candidates = [f.y, f.y + f.height / 2, f.y + f.height];
            const closest = candidates.reduce((a, b) => Math.abs(a - line.pos) < Math.abs(b - line.pos) ? a : b);
            const offset = closest === f.y ? 0 : closest === f.y + f.height ? -f.height : -f.height / 2;
            newY = Math.round(line.pos + offset);
          }
        }
        return prev.map((f, i) => i === drag.idx ? { ...f, x: newX, y: newY } : f);
      });
    };
    const onUp = () => {
      dragRef.current = null;
      setAlignLines([]);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ── Drag corner/edge handles to resize a field ────────────────────────────
  const startResize = (e: React.MouseEvent, idx: number, dir: string) => {
    e.stopPropagation();
    e.preventDefault();
    const f = fields[idx];
    resizeRef.current = {
      idx, dir,
      startX: e.clientX, startY: e.clientY,
      origW: f.width, origH: f.height,
      origX: f.x, origY: f.y,
    };
    setSelectedIdx(idx);
    const onMove = (mv: MouseEvent) => {
      const rd = resizeRef.current;
      if (!rd) return;
      const ps = pageSizes[currentPage];
      if (!ps) return;
      const dx = (mv.clientX - rd.startX) / ps.scale;
      const dy = (mv.clientY - rd.startY) / ps.scale;
      setFields((prev) => prev.map((f, i) => {
        if (i !== rd.idx) return f;
        let newW = rd.origW, newH = rd.origH, newX = rd.origX, newY = rd.origY;
        if (rd.dir.includes("e")) newW = Math.max(16, Math.round(rd.origW + dx));
        if (rd.dir.includes("s")) newH = Math.max(10, Math.round(rd.origH + dy));
        if (rd.dir.includes("w")) { newW = Math.max(16, Math.round(rd.origW - dx)); newX = Math.max(0, Math.round(rd.origX + dx)); }
        if (rd.dir.includes("n")) { newH = Math.max(10, Math.round(rd.origH - dy)); newY = Math.max(0, Math.round(rd.origY + dy)); }
        return { ...f, width: newW, height: newH, x: newX, y: newY };
      }));
    };
    const onUp = () => {
      const rd2 = resizeRef.current;
      resizeRef.current = null;
      // After resize, update the "last placed" memory so next field inherits the new size
      if (rd2) {
        setFields((prev) => {
          const f = prev[rd2.idx];
          if (f) {
            const snap = { width: f.width, height: f.height, x: f.x };
            lastPlacedRef.current = snap;
            setLastPlacedSize(snap);
          }
          return prev;
        });
      }
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiPut(`/crm/forms/${formId}/fields`, { fields });
      await apiPut(`/crm/forms/${formId}`, { status: "ACTIVE" });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save fields.");
    } finally {
      setSaving(false);
    }
  };

  const pageFields = fields.filter((f) => f.pageNumber === currentPage);
  const ps = pageSizes[currentPage];

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "#0f172a" }}>
      {/* Top bar */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 px-4" style={{ background: "#1e293b" }}>
        <div className="flex items-center gap-3">
          <Layers className="h-5 w-5 text-indigo-400" />
            <div>
            <p className="text-xs font-bold uppercase tracking-widest text-slate-400">Field Placement Editor</p>
            <p className="text-sm font-semibold text-white">{detail?.form.name || "Loading…"}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-slate-300 hover:border-white/20 hover:text-white">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving} className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">
            {saving ? "Saving…" : "Save & activate"}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Left panel — context-aware: "place" mode OR "edit selected field" mode */}
        <div className="flex w-72 shrink-0 flex-col border-r border-white/10" style={{ background: "#1e293b" }}>
          {/* Sticky save button — always visible at the top of the left panel */}
          <div className="shrink-0 border-b border-white/10 p-3">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="w-full rounded-xl bg-indigo-600 py-2 text-sm font-bold text-white hover:bg-indigo-500 disabled:opacity-60"
            >
              {saving ? "Saving…" : "💾 Save & activate"}
            </button>
            {error ? <p className="mt-1.5 text-center text-[11px] text-red-400">{error}</p> : null}
          </div>

          {selectedIdx !== null && fields[selectedIdx] ? (

            /* ── EDIT MODE — editing a placed field ────────────────────────── */
            <div className="flex flex-1 flex-col overflow-y-auto p-3">
              <button
                type="button"
                onClick={() => setSelectedIdx(null)}
                className="mb-3 flex items-center gap-1.5 text-xs text-slate-500 hover:text-white"
              >
                ← Back to place new field
              </button>

              <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">Editing field</p>
              <p className="mb-3 flex items-center gap-1 text-[10px] text-slate-500">
                <span className="rounded border border-slate-600 bg-slate-700 px-1 py-0 font-mono text-[9px] text-slate-300">↑ ↓ ← →</span>
                nudge &nbsp;·&nbsp;
                <span className="rounded border border-slate-600 bg-slate-700 px-1 py-0 font-mono text-[9px] text-slate-300">⇧</span>
                +arrow = 10px
              </p>

              {/* Auto-fill token — always visible */}
              <div className="mb-4 rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-indigo-300">🔗 Auto-fill token</span>
                  {fields[selectedIdx].autoFillToken ? (
                    <button type="button" onClick={() => setFields((prev) => prev.map((f, i) => i === selectedIdx ? { ...f, autoFillToken: null } : f))} className="text-[10px] text-slate-500 underline hover:text-red-400">clear</button>
                  ) : null}
                </div>
                {fields[selectedIdx].fieldType === "SIGNATURE" || fields[selectedIdx].fieldType === "INITIALS" ? (
                  <p className="text-[11px] text-indigo-200/40">Signature &amp; Initials are drawn — no token needed.</p>
                ) : (
                  <>
                    <ConnectSelect
                      value={fields[selectedIdx].autoFillToken ?? ""}
                      onChange={(v) => setFields((prev) => prev.map((f, i) => {
                        if (i !== selectedIdx) return f;
                        const newLabel = v ? (TOKEN_LABEL[v] ?? f.label) : f.label;
                        return { ...f, autoFillToken: v || null, label: newLabel };
                      }))}
                      groups={TOKEN_OPTION_GROUPS}
                      placeholder="Select contact field…"
                      searchable
                    />
                    {fields[selectedIdx].autoFillToken ? (
                      <div className="mt-2 rounded-lg bg-indigo-600/20 px-2 py-1.5">
                        <p className="font-mono text-[11px] font-semibold text-indigo-200">{`{{${fields[selectedIdx].autoFillToken}}}`}</p>
                        <p className="mt-0.5 text-[10px] text-indigo-200/50">Pre-fills with: <span className="italic">{TOKEN_SAMPLE[fields[selectedIdx].autoFillToken!] || "—"}</span></p>
                      </div>
                    ) : (
                      <p className="mt-1 text-[10px] text-indigo-200/40">No token — signer fills in manually.</p>
                    )}
                  </>
                )}
              </div>

              {/* Type */}
              <label className="mb-3 block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Type</span>
                  <ConnectSelect
                  value={fields[selectedIdx].fieldType}
                  onChange={(v) => setFields((prev) => prev.map((f, i) => i === selectedIdx ? { ...f, fieldType: v as FieldType } : f))}
                  options={FIELD_TYPES.map((t) => ({ value: t, label: t.charAt(0) + t.slice(1).toLowerCase() }))}
                />
              </label>

              {/* Label */}
              <label className="mb-3 block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Label</span>
                <input
                  value={fields[selectedIdx].label}
                  onChange={(e) => setFields((prev) => prev.map((f, i) => i === selectedIdx ? { ...f, label: e.target.value } : f))}
                  className="w-full rounded-lg border border-white/10 bg-slate-800 px-2.5 py-1.5 text-sm text-white outline-none focus:border-indigo-400"
                />
              </label>

              {/* Required */}
              <label className="mb-4 flex items-center gap-2">
                <input type="checkbox" checked={fields[selectedIdx].required} onChange={(e) => setFields((prev) => prev.map((f, i) => i === selectedIdx ? { ...f, required: e.target.checked } : f))} className="accent-indigo-500" />
                <span className="text-sm text-slate-300">Required field</span>
              </label>

              {/* Size */}
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Size (or drag edges on PDF)</p>
              <div className="mb-3 grid grid-cols-2 gap-2">
                {(["width", "height"] as const).map((key) => (
                  <label key={key} className="block">
                    <span className="block text-[10px] text-slate-500">{key}</span>
                    <input type="number" value={fields[selectedIdx][key]} onChange={(e) => setFields((prev) => prev.map((f, i) => i === selectedIdx ? { ...f, [key]: Number(e.target.value) } : f))} className="w-full rounded-lg border border-white/10 bg-slate-800 px-2 py-1.5 text-sm text-white outline-none focus:border-indigo-400" />
                  </label>
                ))}
              </div>

              <button
                type="button"
                onClick={() => { setFields((prev) => prev.filter((_, i) => i !== selectedIdx)); setSelectedIdx(null); }}
                className="mt-auto flex items-center justify-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-400 hover:bg-red-500/20"
              >
                <Trash2 className="h-4 w-4" />
                Remove field
              </button>
            </div>

          ) : (

            /* ── PLACE MODE — configure before clicking ────────────────────── */
            <div className="flex flex-1 flex-col overflow-y-auto p-3">

              {/* Step 1 — type */}
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500">① Field type</p>
              <div className="mb-4 grid grid-cols-2 gap-1">
                {FIELD_TYPES.map((type) => {
                  const c = FIELD_COLOR[type];
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => switchTool(type)}
                      className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs font-semibold transition-colors"
                      style={{
                        background: activeTool === type ? c.bg : "transparent",
                        border: `1.5px solid ${activeTool === type ? c.border : "rgba(255,255,255,0.06)"}`,
                        color: activeTool === type ? c.text : "#94a3b8",
                      }}
                    >
                      <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border" style={{ background: c.bg, borderColor: c.border }} />
                      {type.charAt(0) + type.slice(1).toLowerCase()}
                    </button>
                  );
                })}
              </div>

              {/* Step 2 — label */}
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500">② Label</p>
              <input
                value={activeLabel}
                onChange={(e) => setActiveLabel(e.target.value)}
                className="mb-4 w-full rounded-lg border border-white/10 bg-slate-800 px-2.5 py-1.5 text-sm text-white outline-none focus:border-indigo-400"
                placeholder="Field label…"
              />

              {/* Step 3 — token (always visible; disabled for signature/initials) */}
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500">③ Auto-fill token</p>
              {activeTool === "SIGNATURE" || activeTool === "INITIALS" ? (
                <div className="mb-3 rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-[11px] text-slate-600">
                  Signature &amp; Initials fields are drawn by the signer — no token needed.
                </div>
              ) : (
                <>
                  <ConnectSelect
                    value={activeToken ?? ""}
                    onChange={(v) => {
                      setActiveToken(v || null);
                      if (v) setActiveLabel(TOKEN_LABEL[v] ?? activeLabel);
                    }}
                    groups={TOKEN_OPTION_GROUPS}
                    placeholder="Select contact field…"
                    searchable
                  />
                  {activeToken ? (
                    <div className="mt-1.5 mb-3 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-2">
                      <p className="font-mono text-[11px] font-semibold text-indigo-300">{`{{${activeToken}}}`}</p>
                      <p className="mt-0.5 text-[10px] text-indigo-200/50">
                        Pre-fills with: <span className="italic">{TOKEN_SAMPLE[activeToken] || "—"}</span>
                      </p>
                    </div>
                  ) : (
                    <p className="mb-3 mt-1 text-[10px] text-slate-600">No token — signer fills in manually.</p>
                  )}
                </>
              )}

              {/* Place CTA */}
              <div
                className="mb-4 rounded-xl p-3 text-center"
                style={{ background: FIELD_COLOR[activeTool].bg, border: `1.5px dashed ${FIELD_COLOR[activeTool].border}` }}
              >
                <p className="text-xs font-bold" style={{ color: FIELD_COLOR[activeTool].text }}>Click on the document to place</p>
                <p className="mt-0.5 font-mono text-[10px] opacity-60" style={{ color: FIELD_COLOR[activeTool].text }}>{activeLabel || activeTool.toLowerCase()}</p>
                {lastPlacedSize ? (
                  <p className="mt-1 text-[10px] opacity-50" style={{ color: FIELD_COLOR[activeTool].text }}>
                    ↔ Matching last: {Math.round(lastPlacedSize.width)}w × {Math.round(lastPlacedSize.height)}h
                  </p>
                ) : (
                  <p className="mt-1 text-[10px] opacity-40" style={{ color: FIELD_COLOR[activeTool].text }}>
                    First placement sets the size for all fields
                  </p>
                )}
              </div>

              {/* Placed fields list */}
              <div className="my-1 border-t border-white/10" />
              <p className="mb-1.5 mt-3 text-[10px] font-bold uppercase tracking-widest text-slate-500">Placed fields ({fields.length})</p>
              <div className="space-y-1">
                {fields.map((f, i) => {
                  const c = FIELD_COLOR[f.fieldType];
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => { setSelectedIdx(i); setCurrentPage(f.pageNumber); }}
                      className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px] transition-colors"
                      style={{
                        background: "transparent",
                        border: `1px solid rgba(255,255,255,0.05)`,
                        color: "#94a3b8",
                      }}
                    >
                      <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ background: c.border }} />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate">{f.label}</span>
                        {f.autoFillToken ? (
                          <span className="truncate font-mono text-[9px] opacity-50">{`{{${f.autoFillToken}}}`}</span>
                        ) : null}
                      </div>
                      <span className="shrink-0 text-[10px] opacity-40">p{f.pageNumber}</span>
                    </button>
                  );
                })}
                {fields.length === 0 && <p className="text-[10px] text-slate-700">No fields placed yet.</p>}
              </div>
            </div>
          )}
        </div>

        {/* Centre — PDF with overlay */}
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4" style={{ background: "#0f172a" }}>
          {/* Page nav */}
          {pageCount > 1 && (
            <div className="mb-3 flex items-center justify-center gap-3">
              <button type="button" disabled={currentPage <= 1} onClick={() => setCurrentPage((p) => p - 1)} className="rounded-lg bg-white/10 px-3 py-1 text-sm text-white disabled:opacity-30">←</button>
              <span className="text-sm text-slate-300">Page {currentPage} of {pageCount}</span>
              <button type="button" disabled={currentPage >= pageCount} onClick={() => setCurrentPage((p) => p + 1)} className="rounded-lg bg-white/10 px-3 py-1 text-sm text-white disabled:opacity-30">→</button>
            </div>
          )}

          {/* Click hint */}
          {selectedIdx === null ? (
            <p className="mb-2 text-center text-xs text-slate-400">
              Click to place a <span className="font-semibold" style={{ color: FIELD_COLOR[activeTool].border }}>{activeTool.toLowerCase()}</span> field · Drag to move · Hover edges to resize
            </p>
          ) : (
            <p className="mb-2 text-center text-xs text-slate-400">
              <span className="font-semibold text-white">{fields[selectedIdx]?.label}</span> selected · Drag to move · Hover edges to resize · <button type="button" onClick={() => setSelectedIdx(null)} className="underline hover:text-white">done</button>
            </p>
          )}

          {/* PDF render error */}
          {pdfError ? (
            <div className="mx-auto mb-3 max-w-3xl rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              PDF render error: {pdfError}
              <button type="button" onClick={() => setPdfError(null)} className="ml-3 underline">dismiss</button>
            </div>
          ) : null}

          {/* PDF canvas + overlay */}
          <div className="relative mx-auto w-full max-w-3xl">
            <PdfPageCanvas
              pdfUrl={pdfUrl}
              pageNumber={currentPage}
              authToken={authToken}
              onSize={(s) => handlePageSize(currentPage, s)}
              onError={(msg) => setPdfError(msg)}
            />

            {/* Click-capture overlay */}
            {ps ? (
              <div
                ref={overlayRef}
                className="absolute inset-0 cursor-crosshair"
                style={{ width: ps.width, height: ps.height }}
                onClick={handleOverlayClick}
              >
                {pageFields.map((f, localIdx) => {
                  const globalIdx = fields.indexOf(f);
                  const c = FIELD_COLOR[f.fieldType];
                  const isSelected = selectedIdx === globalIdx;
                  return (
                    <div
                      key={globalIdx}
                      onMouseDown={(e) => startDrag(e, globalIdx)}
                      onClick={(e) => { e.stopPropagation(); setSelectedIdx(globalIdx); }}
                      className="group absolute select-none"
                      style={{
                        left:   f.x * ps.scale,
                        top:    f.y * ps.scale,
                        width:  f.width  * ps.scale,
                        height: f.height * ps.scale,
                        background: c.bg,
                        border: `2px solid ${c.border}`,
                        borderRadius: 4,
                        cursor: "move",
                        boxShadow: isSelected ? `0 0 0 2px white, 0 0 0 4px ${c.border}` : undefined,
                        zIndex: isSelected ? 10 : 5,
                      }}
                    >
                      <span
                        className="pointer-events-none absolute left-0.5 top-0.5 max-w-full truncate text-[9px] font-bold leading-none"
                        style={{ color: c.text }}
                      >
                        {f.label}{f.required ? " *" : ""}
                        {f.autoFillToken ? (
                          <span className="ml-1 rounded-sm bg-black/20 px-0.5 font-mono text-[7px]">{`{}`}</span>
                        ) : null}
                      </span>
                      {/* Delete button */}
                      <button
                        type="button"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); setFields((prev) => prev.filter((_, i) => i !== globalIdx)); if (selectedIdx === globalIdx) setSelectedIdx(null); }}
                        className="absolute -right-2.5 -top-2.5 hidden h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white shadow group-hover:flex"
                      >
                        <X className="h-3 w-3" />
                      </button>
                      {/* Resize handles — E edge, S edge, SE corner */}
                      <div
                        className="absolute right-0 top-[20%] h-[60%] w-2 cursor-e-resize opacity-0 transition-opacity group-hover:opacity-100"
                        style={{ background: c.border, borderRadius: "2px 0 0 2px", zIndex: 20 }}
                        onMouseDown={(e) => { e.stopPropagation(); startResize(e, globalIdx, "e"); }}
                      />
                      <div
                        className="absolute bottom-0 left-[20%] h-2 w-[60%] cursor-s-resize opacity-0 transition-opacity group-hover:opacity-100"
                        style={{ background: c.border, borderRadius: "0 0 2px 2px", zIndex: 20 }}
                        onMouseDown={(e) => { e.stopPropagation(); startResize(e, globalIdx, "s"); }}
                      />
                      <div
                        className="absolute bottom-0 right-0 h-3 w-3 cursor-se-resize opacity-0 transition-opacity group-hover:opacity-100"
                        style={{ background: c.border, borderRadius: "2px 0 0 2px", zIndex: 21 }}
                        onMouseDown={(e) => { e.stopPropagation(); startResize(e, globalIdx, "se"); }}
                      />
                    </div>
                  );
                })}

                {/* Alignment guide lines */}
                {ps && alignLines.map((line, i) => (
                  line.type === "v" ? (
                    <div
                      key={`v-${i}`}
                      className="pointer-events-none absolute top-0 bottom-0"
                      style={{
                        left: line.pos * ps.scale,
                        width: 1,
                        background: "rgba(99,210,255,0.9)",
                        boxShadow: "0 0 4px rgba(99,210,255,0.8)",
                        zIndex: 50,
                      }}
                    />
                  ) : (
                    <div
                      key={`h-${i}`}
                      className="pointer-events-none absolute left-0 right-0"
                      style={{
                        top: line.pos * ps.scale,
                        height: 1,
                        background: "rgba(99,210,255,0.9)",
                        boxShadow: "0 0 4px rgba(99,210,255,0.8)",
                        zIndex: 50,
                      }}
                    />
                  )
                  ))}
                </div>
            ) : !pdfError ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <div className="h-7 w-7 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-400" />
                <p className="text-sm text-slate-400">Rendering PDF…</p>
              </div>
            ) : null}
          </div>
        </div>

        </div>
    </div>
  );
}
