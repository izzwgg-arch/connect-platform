"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, Eye, FileSignature, Pencil, Plus, RefreshCw, Upload } from "lucide-react";
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
import { ApiError, apiGet, apiPost, apiPut, getPortalApiBaseUrl } from "../../../services/apiClient";

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
            <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className="rounded-xl border border-crm-border bg-crm-surface px-3 py-2 text-sm text-crm-text">
              <option value="ALL">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="DRAFT">Draft</option>
              <option value="ARCHIVED">Archived</option>
            </select>
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

function FormEditorDrawer({ formId, onClose, onSaved }: { formId: string; onClose: () => void; onSaved: () => void }) {
  const [detail, setDetail] = useState<FormDetailResponse | null>(null);
  const [fields, setFields] = useState<FormField[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiGet<FormDetailResponse>(`/crm/forms/${formId}`)
      .then((data) => { setDetail(data); setFields(data.fields); })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load form."));
  }, [formId]);

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

  return (
    <div className="fixed inset-0 z-50 bg-black/40">
      <aside className="ml-auto flex h-full w-full max-w-3xl flex-col border-l border-crm-border bg-crm-surface shadow-2xl">
        <div className="border-b border-crm-border p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-crm-text">{detail?.form.name || "Edit form"}</h2>
              <p className="text-sm text-crm-muted">Structured field editor foundation. Coordinates are saved for PDF overlay placement.</p>
            </div>
            <button type="button" onClick={onClose} className="rounded-xl border border-crm-border px-3 py-2 text-sm text-crm-text">Close</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {error ? <div className="mb-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700">{error}</div> : null}
          <div className="mb-4 rounded-2xl border border-crm-border p-3">
            <button type="button" onClick={() => openFormPreview(formId)} className="text-sm font-medium text-crm-accent">Open PDF preview</button>
            <p className="mt-1 text-xs text-crm-muted">Full drag/drop overlay is deferred; use page and coordinate fields below for Phase 1.</p>
          </div>
          <div className="space-y-3">
            {fields.map((field, index) => (
              <div key={index} className="rounded-2xl border border-crm-border p-3">
                <div className="grid gap-2 md:grid-cols-3">
                  <select value={field.fieldType} onChange={(e) => setFields((prev) => prev.map((f, i) => i === index ? { ...f, fieldType: e.target.value as FieldType } : f))} className="rounded-xl border border-crm-border bg-crm-surface px-3 py-2 text-sm text-crm-text">
                    {FIELD_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                  </select>
                  <input value={field.label} onChange={(e) => setFields((prev) => prev.map((f, i) => i === index ? { ...f, label: e.target.value } : f))} className="rounded-xl border border-crm-border bg-crm-surface px-3 py-2 text-sm text-crm-text" />
                  <label className="flex items-center gap-2 text-sm text-crm-text">
                    <input type="checkbox" checked={field.required} onChange={(e) => setFields((prev) => prev.map((f, i) => i === index ? { ...f, required: e.target.checked } : f))} />
                    Required
                  </label>
                </div>
                <div className="mt-2 grid grid-cols-5 gap-2">
                  {(["pageNumber", "x", "y", "width", "height"] as const).map((key) => (
                    <label key={key} className="text-xs text-crm-muted">
                      {key}
                      <input type="number" value={field[key]} onChange={(e) => setFields((prev) => prev.map((f, i) => i === index ? { ...f, [key]: Number(e.target.value) } : f))} className="mt-1 w-full rounded-lg border border-crm-border bg-crm-surface px-2 py-1 text-sm text-crm-text" />
                    </label>
                  ))}
                </div>
                <button type="button" onClick={() => setFields((prev) => prev.filter((_, i) => i !== index))} className="mt-2 text-xs text-red-600">Remove field</button>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setFields((prev) => [...prev, emptyField(prev.length)])} className="mt-4 rounded-xl border border-crm-border px-3 py-2 text-sm text-crm-text">
            <Plus className="mr-1 inline h-4 w-4" /> Add field
          </button>
        </div>
        <div className="border-t border-crm-border p-5">
          <button type="button" onClick={save} disabled={saving} className="tasks-primary-action">
            {saving ? "Saving…" : "Save fields and activate"}
          </button>
        </div>
      </aside>
    </div>
  );
}
