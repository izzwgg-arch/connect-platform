"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Calendar,
  CheckCircle,
  ChevronRight,
  ClipboardCheck,
  Eye,
  FileSignature,
  FileText,
  GripVertical,
  Layers,
  Pencil,
  Plus,
  Search,
  Send,
  SortAsc,
  Trash2,
  Upload,
  X,
} from "lucide-react";
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
import { cn } from "../cn";
import { crm } from "../crmClasses";

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

type FormPreviewRow = FormTemplate & {
  previewRowKey: string;
  isDevPreviewDuplicate: boolean;
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

type FormSortMode = "updated" | "created" | "name";

const FIELD_TYPES: FieldType[] = ["TEXT", "DATE", "CHECKBOX", "SIGNATURE", "INITIALS"];
const STATUS_OPTIONS: { value: "ALL" | FormStatus; label: string }[] = [
  { value: "ALL", label: "All statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "DRAFT", label: "Draft" },
  { value: "ARCHIVED", label: "Archived" },
];
const SORT_OPTIONS: { value: FormSortMode; label: string }[] = [
  { value: "updated", label: "Updated" },
  { value: "created", label: "Created" },
  { value: "name", label: "Name" },
];
const DEV_ROW_PREVIEW_COUNT = 20;

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
  if (status === "ACTIVE") return "tasks-status-completed";
  if (status === "ARCHIVED") return "tasks-status-muted";
  return "tasks-status-today";
}

function initialsFromName(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "FM"
  );
}

function fmtFileSize(bytes: number | null | undefined): string {
  const size = Number(bytes || 0);
  if (!size) return "Unknown size";
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function sortForms(forms: FormTemplate[], sortMode: FormSortMode) {
  return [...forms].sort((a, b) => {
    if (sortMode === "name") return a.name.localeCompare(b.name);
    const aTime = new Date(sortMode === "created" ? a.createdAt : a.updatedAt).getTime();
    const bTime = new Date(sortMode === "created" ? b.createdAt : b.updatedAt).getTime();
    return bTime - aTime;
  });
}

function expandRowsForDevPreview(forms: FormTemplate[], minRows = DEV_ROW_PREVIEW_COUNT): FormPreviewRow[] {
  if (process.env.NODE_ENV !== "development" || forms.length === 0 || forms.length >= minRows) {
    return forms.map((form) => ({
      ...form,
      previewRowKey: form.id,
      isDevPreviewDuplicate: false,
    }));
  }

  return Array.from({ length: minRows }, (_, index) => {
    const form = forms[index % forms.length];
    const cycle = Math.floor(index / forms.length);
    return {
      ...form,
      previewRowKey: cycle === 0 ? form.id : `${form.id}-dev-preview-${cycle}-${index}`,
      isDevPreviewDuplicate: cycle > 0,
    };
  });
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
  const [sortMode, setSortMode] = useState<FormSortMode>("updated");
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
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

  const displayedForms = useMemo(() => sortForms(forms, sortMode), [forms, sortMode]);
  const previewForms = useMemo(() => expandRowsForDevPreview(displayedForms), [displayedForms]);
  const usingDevPreview = previewForms.length > displayedForms.length;
  const selectedForm = useMemo(
    () => previewForms.find((form) => form.previewRowKey === selectedRowKey) ?? previewForms[0] ?? null,
    [previewForms, selectedRowKey],
  );

  useEffect(() => {
    if (selectedRowKey && previewForms.some((form) => form.previewRowKey === selectedRowKey)) return;
    setSelectedRowKey(previewForms[0]?.previewRowKey ?? null);
  }, [previewForms, selectedRowKey]);

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
            compact
            icon={<FileSignature className="h-6 w-6" aria-hidden />}
            title="Forms"
            subtitle="Reusable PDF forms for secure lead completion, signatures, and CRM submissions."
            className={cn(crm.contactsHeaderPanel, "campaigns-command-header")}
            actions={
              <div className="campaigns-hero-actions">
                <button type="button" onClick={() => setUploadOpen(true)} className="campaigns-btn-primary">
                  <Plus className="h-4 w-4" />
                  Upload Form
                </button>
              </div>
            }
          />
        </CRMWorkspaceHeader>

        <CRMWorkspaceToolbar className="flex flex-col gap-3">
          <section className="crm-queue-kpi-strip grid w-full grid-cols-2 items-stretch gap-3 md:grid-cols-4 xl:grid-cols-4" aria-label="Form metrics">
            <FormsKpiCard icon={<FileSignature className="h-4 w-4" />} label="Templates" value={String(totals.all)} micro={usingDevPreview ? `${previewForms.length} preview rows` : `${displayedForms.length} shown`} accent="blue" />
            <FormsKpiCard icon={<CheckCircle className="h-4 w-4" />} label="Active" value={String(totals.active)} micro="Ready to send" accent="green" />
            <FormsKpiCard icon={<FileText className="h-4 w-4" />} label="Draft" value={String(totals.draft)} micro="Needs setup" accent="amber" />
            <FormsKpiCard icon={<ClipboardCheck className="h-4 w-4" />} label="Completed" value={String(totals.completed)} micro={`${totals.sent} signer links`} accent="cyan" />
          </section>

          <div className="crm-queue-filter-bar tasks-filter-bar">
            <div className="crm-queue-filter-grid forms-filter-grid">
              <div className="crm-queue-filter-field crm-queue-filter-field-search">
                <Search className="crm-queue-filter-icon h-4 w-4 shrink-0 text-crm-muted" />
                <input
                  id="crm-forms-search"
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Name, category, description..."
                  className="crm-queue-filter-control min-w-[10rem] flex-1"
                  aria-label="Search forms"
                />
                {search ? (
                  <button type="button" onClick={() => setSearch("")} className="text-xs font-medium text-crm-accent hover:underline">
                    Clear
                  </button>
                ) : null}
              </div>

              <div className="crm-queue-filter-field">
                <label htmlFor="crm-forms-status" className="sr-only">Status</label>
                <ConnectSelect
                  id="crm-forms-status"
                  value={status}
                  onChange={(value) => setStatus(value as typeof status)}
                  className="min-w-[10rem] flex-1"
                  size="sm"
                  options={STATUS_OPTIONS}
                />
              </div>

              <div className="crm-queue-filter-field">
                <SortAsc className="h-4 w-4 shrink-0 text-crm-muted" />
                <label htmlFor="crm-forms-sort" className="sr-only">Sort</label>
                <ConnectSelect
                  id="crm-forms-sort"
                  value={sortMode}
                  onChange={(value) => setSortMode(value as FormSortMode)}
                  className="min-w-[10rem] flex-1"
                  size="sm"
                  options={SORT_OPTIONS}
                />
              </div>

              <div className="crm-queue-filter-field forms-filter-count">
                <span className="crm-queue-filter-control forms-filter-count-value" aria-label={`${previewForms.length} form rows shown`}>
                  {previewForms.length}
                </span>
              </div>
            </div>
          </div>
          {error ? <div className={cn(crm.bannerDanger, "rounded-xl px-3 py-2 text-sm")}>{error}</div> : null}
        </CRMWorkspaceToolbar>
      </CRMWorkspaceChrome>

      <CRMWorkspaceBody split>
        <CRMWorkspaceMain className="crm-queue-main-workspace">
          <CRMWorkspaceScrollRegion className="crm-queue-center-workspace flex min-w-0 flex-col gap-3">
            <section className="checklist-collection-shell crm-queue-list-panel forms-list-panel">
              {loading ? (
                <div className="py-24 text-center text-sm text-crm-muted" aria-busy="true">Loading forms...</div>
              ) : forms.length === 0 ? (
                <div className="tasks-empty-state px-6 py-14 text-center">
                  <FileSignature className="mx-auto h-10 w-10 text-crm-muted" />
                  <h3 className="mt-3 text-lg font-semibold text-crm-text">No forms yet</h3>
                  <p className="mt-1 text-sm text-crm-muted">Upload a reusable PDF form to start sending secure signing links.</p>
                  <button type="button" onClick={() => setUploadOpen(true)} className="tasks-primary-action mt-6">
                    <Plus className="h-4 w-4" />
                    Upload Form
                  </button>
                </div>
              ) : (
                <>
                  <div className="crm-queue-list-head">
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-crm-muted">
                      <input type="checkbox" readOnly checked={false} className={crm.checkbox} />
                      <span>Select form</span>
                    </label>
                    <span className="text-[10px] font-semibold text-crm-muted tabular-nums">
                      {previewForms.length} shown · {forms.length} total{usingDevPreview ? " · dev preview" : ""}
                    </span>
                  </div>
                  <div className="crm-queue-row-list">
                    {previewForms.map((form, index) => (
                      <FormTemplateRow
                        key={form.previewRowKey}
                        form={form}
                        rank={index + 1}
                        selected={selectedForm?.previewRowKey === form.previewRowKey}
                        onSelect={() => setSelectedRowKey(form.previewRowKey)}
                        onEdit={() => setEditingId(form.id)}
                        onView={() => openFormPreview(form.id)}
                        onActivate={async () => { await apiPut(`/crm/forms/${form.id}`, { status: "ACTIVE" }); void loadForms(); }}
                        onArchive={async () => { await apiPost(`/crm/forms/${form.id}/archive`); void loadForms(); }}
                      />
                    ))}
                  </div>
                </>
              )}
            </section>
          </CRMWorkspaceScrollRegion>
        </CRMWorkspaceMain>
        <CRMWorkspaceRightRail className="crm-queue-right-rail crm-queue-detail-rail forms-right-rail flex flex-col min-h-0">
          <FormsDetailPanel
            form={selectedForm}
            totals={totals}
            onUpload={() => setUploadOpen(true)}
            onEdit={(formId) => setEditingId(formId)}
            onView={(formId) => openFormPreview(formId)}
          />
        </CRMWorkspaceRightRail>
      </CRMWorkspaceBody>

      {uploadOpen ? <UploadFormModal onClose={() => setUploadOpen(false)} onUploaded={() => { setUploadOpen(false); loadForms(); }} /> : null}
      {editingId ? <FormEditorDrawer formId={editingId} onClose={() => setEditingId(null)} onSaved={loadForms} /> : null}
    </CRMWorkspaceShell>
  );
}

function FormsKpiCard({
  icon,
  label,
  value,
  micro,
  accent,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  micro: string;
  accent: "blue" | "violet" | "green" | "amber" | "rose" | "cyan";
}) {
  return (
    <div className={cn(crm.queueCountPill, `crm-queue-kpi-${accent}`, "relative overflow-hidden bg-crm-surface-2")}>
      <span className="flex w-full items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="crm-queue-kpi-label block text-[10px] font-bold uppercase tracking-wide text-crm-muted">{label}</span>
          <span className="crm-queue-kpi-value mt-1 block text-2xl font-bold tabular-nums leading-none tracking-tight text-crm-text">{value}</span>
        </span>
        <span className="crm-queue-kpi-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface/70 text-crm-accent">
          {icon}
        </span>
      </span>
      <span className="crm-queue-kpi-micro text-[10px] font-medium text-crm-muted">{micro}</span>
    </div>
  );
}

function FormTemplateRow({
  form,
  rank,
  selected,
  onSelect,
  onEdit,
  onView,
  onActivate,
  onArchive,
}: {
  form: FormTemplate;
  rank: number;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onView: () => void;
  onActivate: () => Promise<void>;
  onArchive: () => Promise<void>;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-selected={selected}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "crm-queue-row crm-contact-row crm-form-row group",
        selected && "crm-queue-row-selected",
        form.status === "ARCHIVED" && "crm-queue-row-readonly opacity-90",
      )}
    >
      <div className="crm-queue-row-grid">
        <label className="crm-contact-row-check" onClick={(event) => event.stopPropagation()} aria-label={`Select ${form.name}`}>
          <input type="checkbox" checked={selected} readOnly onChange={onSelect} className={crm.checkbox} />
        </label>
        <span className="crm-queue-row-rank tabular-nums">{rank}</span>

        <div className="crm-queue-row-avatar forms-row-avatar" aria-hidden>
          {initialsFromName(form.name)}
        </div>

        <div className="crm-queue-row-main min-w-0">
          <div className="crm-queue-row-title-line">
            <span className="crm-queue-row-name truncate">{form.name}</span>
            <span className={cn("tasks-status-pill", statusClass(form.status))}>{form.status}</span>
          </div>
          <p className="crm-queue-row-sub truncate">{form.description || form.originalFileName}</p>
        </div>

        <div className="crm-queue-row-phone hidden md:flex">
          <FileSignature className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{form.category || "Uncategorized"}</span>
        </div>

        <div className="crm-queue-row-email hidden lg:flex">
          <FileText className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{form.originalFileName}</span>
        </div>

        <div className="crm-queue-row-meta hidden xl:flex">
          <span className="crm-queue-pill crm-queue-pill-muted inline-flex items-center gap-0.5">
            <Calendar className="h-3 w-3" />
            {fmtDate(form.updatedAt)}
          </span>
        </div>

        <span className="crm-queue-row-status shrink-0 crm-queue-pill crm-queue-pill-stage">
          {form.timesSent} sent
        </span>

        <div className="forms-row-actions">
          <button type="button" onClick={(event) => { event.stopPropagation(); onEdit(); }} className="forms-row-action" aria-label={`Edit ${form.name}`}>
            <Pencil className="h-3.5 w-3.5" />
            <span>Edit</span>
          </button>
          <button type="button" onClick={(event) => { event.stopPropagation(); onView(); }} className="forms-row-action" aria-label={`Preview ${form.name}`}>
            <Eye className="h-3.5 w-3.5" />
            <span>View</span>
          </button>
          {form.status === "DRAFT" ? (
            <button type="button" onClick={(event) => { event.stopPropagation(); void onActivate(); }} className="forms-row-action forms-row-action-success" aria-label={`Activate ${form.name}`}>
              <CheckCircle className="h-3.5 w-3.5" />
              <span>Activate</span>
            </button>
          ) : null}
          {form.status !== "ARCHIVED" ? (
            <button type="button" onClick={(event) => { event.stopPropagation(); void onArchive(); }} className="forms-row-action" aria-label={`Archive ${form.name}`}>
              <Archive className="h-3.5 w-3.5" />
              <span>Archive</span>
            </button>
          ) : null}
        </div>

        <ChevronRight className="crm-queue-row-chevron h-4 w-4 shrink-0" />
      </div>
    </div>
  );
}

function FormsDetailPanel({
  form,
  totals,
  onUpload,
  onEdit,
  onView,
}: {
  form: FormTemplate | null;
  totals: { all: number; active: number; draft: number; archived: number; sent: number; completed: number };
  onUpload: () => void;
  onEdit: (formId: string) => void;
  onView: (formId: string) => void;
}) {
  if (!form) {
    return (
      <aside className="crm-queue-detail-panel crm-contact-detail-panel forms-detail-panel flex min-h-full flex-col gap-4 p-4" aria-label="Forms summary">
        <div className="crm-queue-detail-glow" aria-hidden />
        <FormsDetailHero icon={<FileSignature className="h-5 w-5" />} eyebrow="Forms library" title="Select a form" detail="Open a row to review setup status, sends, completions, and PDF metadata." />
        <FormsMetricGrid totals={totals} />
        <button type="button" onClick={onUpload} className="tasks-primary-action relative z-[1] mt-auto w-full justify-center">
          <Plus className="h-4 w-4" />
          Upload Form
        </button>
      </aside>
    );
  }

  return (
    <aside className="crm-queue-detail-panel crm-contact-detail-panel forms-detail-panel flex min-h-full flex-col gap-4 p-4" aria-label="Form details">
      <div className="crm-queue-detail-glow" aria-hidden />
      <FormsDetailHero
        icon={<FileSignature className="h-5 w-5" />}
        eyebrow={form.status}
        title={form.name}
        detail={form.description || "No description added yet."}
        status={form.status}
      />

      <section className="crm-queue-detail-actions-card forms-detail-card">
        <p className="crm-queue-detail-section-label">Form activity</p>
        <div className="grid grid-cols-2 gap-2">
          <FormsDetailMetric icon={<Send className="h-4 w-4" />} label="Sent" value={String(form.timesSent)} />
          <FormsDetailMetric icon={<ClipboardCheck className="h-4 w-4" />} label="Completed" value={String(form.completedCount)} />
          <FormsDetailMetric icon={<FileText className="h-4 w-4" />} label="Pages" value={String(form.pageCount ?? 1)} />
          <FormsDetailMetric icon={<Layers className="h-4 w-4" />} label="Size" value={fmtFileSize(form.sizeBytes)} />
        </div>
      </section>

      <section className="crm-queue-detail-actions-card forms-detail-card">
        <p className="crm-queue-detail-section-label">Metadata</p>
        <div className="space-y-2">
          <FormsMetadataRow label="Category" value={form.category || "Uncategorized"} />
          <FormsMetadataRow label="Original file" value={form.originalFileName} />
          <FormsMetadataRow label="Created" value={fmtDate(form.createdAt)} />
          <FormsMetadataRow label="Updated" value={fmtDate(form.updatedAt)} />
        </div>
      </section>

      <section className="crm-queue-detail-actions-card forms-detail-card">
        <p className="crm-queue-detail-section-label">Phase 1 editor</p>
        <p className="text-sm leading-relaxed text-crm-muted">
          Add fields as a structured list now. Coordinates are stored so a drag/drop PDF overlay can be added later without a data migration.
        </p>
      </section>

      <footer className="relative z-[1] mt-auto grid gap-2 border-t border-crm-border/60 pt-4">
        <button type="button" onClick={() => onEdit(form.id)} className="tasks-primary-action w-full justify-center">
          <Pencil className="h-4 w-4" />
          Edit Fields
        </button>
        <button type="button" onClick={() => onView(form.id)} className={crm.btnSecondary}>
          <Eye className="h-4 w-4" />
          Preview PDF
        </button>
      </footer>
    </aside>
  );
}

function FormsDetailHero({
  icon,
  eyebrow,
  title,
  detail,
  status,
}: {
  icon: ReactNode;
  eyebrow: string;
  title: string;
  detail: string;
  status?: FormStatus;
}) {
  return (
    <header className="forms-detail-hero relative z-[1] flex items-start gap-3">
      <div className="forms-detail-orb flex h-11 w-11 shrink-0 items-center justify-center rounded-crm border border-crm-border bg-crm-surface-2 text-crm-accent">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[11px] font-black uppercase tracking-wider text-crm-muted">{eyebrow}</p>
          {status ? <span className={cn("tasks-status-pill", statusClass(status))}>{status}</span> : null}
        </div>
        <h2 className="mt-1 truncate text-lg font-black text-crm-text">{title}</h2>
        <p className="mt-1 text-xs leading-relaxed text-crm-muted">{detail}</p>
      </div>
    </header>
  );
}

function FormsMetricGrid({ totals }: { totals: { all: number; active: number; draft: number; archived: number; sent: number; completed: number } }) {
  return (
    <div className="relative z-[1] grid grid-cols-2 gap-2">
      <FormsDetailMetric icon={<FileSignature className="h-4 w-4" />} label="Templates" value={String(totals.all)} />
      <FormsDetailMetric icon={<CheckCircle className="h-4 w-4" />} label="Active" value={String(totals.active)} />
      <FormsDetailMetric icon={<FileText className="h-4 w-4" />} label="Draft" value={String(totals.draft)} />
      <FormsDetailMetric icon={<Archive className="h-4 w-4" />} label="Archived" value={String(totals.archived)} />
    </div>
  );
}

function FormsDetailMetric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-crm border border-crm-border/50 bg-crm-surface/70 p-3">
      <div className="flex items-center gap-2 text-crm-muted">
        {icon}
        <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
      </div>
      <p className="mt-2 text-lg font-black tabular-nums text-crm-text">{value}</p>
    </div>
  );
}

function FormsMetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-t border-crm-border/45 py-2 first:border-t-0 first:pt-0 last:pb-0">
      <span className="text-[11px] font-bold uppercase tracking-wider text-crm-muted">{label}</span>
      <span className="max-w-[12rem] text-right text-xs font-semibold text-crm-text">{value}</span>
    </div>
  );
}

function UploadFormModal({ onClose, onUploaded }: { onClose: () => void; onUploaded: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectedFileName, setSelectedFileName] = useState("");
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
    <div className="forms-upload-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="forms-upload-title">
      <div className="forms-upload-modal-card w-full max-w-2xl">
        <div className="forms-upload-modal-glow" aria-hidden />
        <div className="forms-upload-modal-inner">
          <header className="forms-upload-modal-header">
            <div className="forms-upload-modal-icon">
              <FileSignature className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0">
              <p className="forms-upload-modal-eyebrow">Forms library</p>
              <h2 id="forms-upload-title">Upload PDF form</h2>
              <p>Bring a reusable PDF into Connect, then map signer fields and CRM auto-fill tokens.</p>
            </div>
            <button type="button" onClick={onClose} className="forms-upload-modal-close" aria-label="Close upload form">
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="forms-upload-form">
            <section className="forms-upload-section forms-upload-file-section">
              <div className="forms-upload-section-head">
                <div>
                  <p className="forms-upload-section-kicker">PDF source</p>
                  <h3>Choose the original document</h3>
                </div>
                <span className="forms-upload-mini-pill">PDF only</span>
              </div>

              <label className="forms-upload-dropzone">
                <span className="forms-upload-dropzone-icon">
                  <Upload className="h-5 w-5" aria-hidden />
                </span>
                <span className="forms-upload-dropzone-copy">
                  <span>{selectedFileName || "Select a PDF to upload"}</span>
                  <small>{selectedFileName ? "Ready for upload" : "Accepted format: .pdf"}</small>
                </span>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  className="sr-only"
                  onChange={(event) => setSelectedFileName(event.target.files?.[0]?.name ?? "")}
                />
              </label>
            </section>

            <section className="forms-upload-section">
              <div className="forms-upload-section-head">
                <div>
                  <p className="forms-upload-section-kicker">Template details</p>
                  <h3>Name and organize the form</h3>
                </div>
                <FileText className="h-4 w-4 text-crm-accent" aria-hidden />
              </div>

              <div className="forms-upload-field-grid">
                <label>
                  <span className="forms-upload-label">Form name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Funding authorization" className="forms-upload-input" />
                </label>
                <label>
                  <span className="forms-upload-label">Category</span>
                  <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Intake, Funding, Compliance" className="forms-upload-input" />
                </label>
              </div>

              <label className="mt-3 block">
                <span className="forms-upload-label">Description</span>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short internal note for agents using this form..." rows={3} className="forms-upload-input forms-upload-textarea" />
              </label>
            </section>

            {error ? (
              <div className="forms-upload-error" role="alert">
                {error}
              </div>
            ) : null}

            <footer className="forms-upload-footer">
              <button type="button" onClick={onClose} className="forms-upload-secondary-btn">
                Cancel
              </button>
              <button type="button" disabled={busy} onClick={upload} className="forms-upload-primary-btn">
                <Upload className="h-4 w-4" />
                {busy ? "Uploading..." : "Upload PDF"}
              </button>
            </footer>
          </div>
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
