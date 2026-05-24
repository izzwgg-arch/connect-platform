"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Mail, Plus, FileText, Eye, Trash2, Loader2, AlertCircle, Save, Lock, Globe } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm, cn } from "../../../../../components/crm";
import { apiGet, apiPost, apiPut, apiDelete } from "../../../../../services/apiClient";

type Template = {
  id: string;
  name: string;
  subject: string;
  bodyText: string;
  visibility: "SHARED" | "PRIVATE";
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
};

const MERGE_FIELDS = [
  { token: "{{contact.firstName}}", label: "First name" },
  { token: "{{contact.lastName}}", label: "Last name" },
  { token: "{{contact.displayName}}", label: "Full name" },
  { token: "{{contact.company}}", label: "Company" },
  { token: "{{contact.email}}", label: "Email" },
];

function previewWith(text: string): string {
  return text
    .replace(/\{\{\s*contact\.firstName\s*\}\}/g, "Ada")
    .replace(/\{\{\s*contact\.lastName\s*\}\}/g, "Lovelace")
    .replace(/\{\{\s*contact\.displayName\s*\}\}/g, "Ada Lovelace")
    .replace(/\{\{\s*contact\.company\s*\}\}/g, "Analytical Engine Co.")
    .replace(/\{\{\s*contact\.email\s*\}\}/g, "ada@example.com");
}

export default function CrmEmailTemplatesPage() {
  const [items, setItems] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ name: string; subject: string; bodyText: string; visibility: "SHARED" | "PRIVATE" } | null>(null);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiGet<{ templates: Template[] }>("/crm/email/templates");
      setItems(res?.templates ?? []);
    } catch (e: any) {
      setError(e?.message || "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(() => items.find((t) => t.id === selectedId) ?? null, [items, selectedId]);

  const openEditor = (t: Template | null) => {
    if (!t) {
      setSelectedId(null);
      setCreating(true);
      setEditor({ name: "", subject: "", bodyText: "", visibility: "SHARED" });
      return;
    }
    setSelectedId(t.id);
    setCreating(false);
    setEditor({ name: t.name, subject: t.subject, bodyText: t.bodyText, visibility: t.visibility });
  };

  const handleSave = async () => {
    if (!editor) return;
    if (!editor.name.trim()) { setError("Name is required"); return; }
    if (!editor.subject.trim()) { setError("Subject is required"); return; }
    setSaving(true);
    setError(null);
    try {
      if (creating) {
        const row = await apiPost<Template>("/crm/email/templates", editor as any);
        await load();
        setSelectedId(row.id);
        setCreating(false);
      } else if (selectedId) {
        await apiPut(`/crm/email/templates/${selectedId}`, editor as any);
        await load();
      }
    } catch (e: any) {
      setError(e?.message || "Failed to save template");
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async () => {
    if (!selectedId) return;
    if (!confirm("Archive this template? It will no longer appear in compose pickers.")) return;
    try {
      await apiDelete(`/crm/email/templates/${selectedId}`);
      setSelectedId(null);
      setEditor(null);
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed to archive");
    }
  };

  const insertToken = (token: string) => {
    if (!editor) return;
    setEditor({ ...editor, bodyText: (editor.bodyText || "") + token });
  };

  return (
    <CRMPageShell innerClassName="space-y-4">
      <CRMPageHeader
        icon={<Mail className="h-5 w-5" />}
        title="Email Templates"
        subtitle="Reusable subject/body templates with simple merge tokens. Tenant-shared or private to you."
        actions={
          <>
            <Link href="/crm/email/settings" className={crm.btnSecondary}>Settings</Link>
            <button type="button" className={crm.btnPrimary} onClick={() => openEditor(null)}>
              <Plus className="h-4 w-4" /> New template
            </button>
          </>
        }
      />

      {error && (
        <div className="flex items-center gap-2 rounded-crm border border-crm-danger/40 bg-crm-danger/10 px-3 py-2 text-sm text-crm-danger">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <CRMCard className="p-2">
          {loading ? (
            <div className="flex items-center gap-2 px-3 py-4 text-sm text-crm-muted">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
              <FileText className="h-6 w-6 text-crm-muted" />
              <p className="text-sm text-crm-text">No templates yet</p>
              <p className="text-xs text-crm-muted">Create your first template to speed up follow-ups.</p>
              <button type="button" className={cn(crm.btnPrimary, "mt-2 text-xs")} onClick={() => openEditor(null)}>
                <Plus className="h-3.5 w-3.5" /> New template
              </button>
            </div>
          ) : (
            <ul className="flex flex-col">
              {items.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => openEditor(t)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-crm px-3 py-2 text-left transition-colors",
                      selectedId === t.id ? "bg-crm-accent/10" : "hover:bg-crm-surface-2/60",
                    )}
                  >
                    <div className="mt-0.5 text-crm-muted">
                      {t.visibility === "PRIVATE" ? <Lock className="h-3.5 w-3.5" /> : <Globe className="h-3.5 w-3.5" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-crm-text">{t.name}</p>
                      <p className="truncate text-xs text-crm-muted">{t.subject}</p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CRMCard>

        <CRMCard className="p-4 sm:p-5">
          {!editor ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 py-10 text-center">
              <FileText className="h-8 w-8 text-crm-muted" />
              <p className="text-sm text-crm-text">Select a template to edit, or create a new one.</p>
              <button type="button" className={cn(crm.btnPrimary, "mt-2 text-xs")} onClick={() => openEditor(null)}>
                <Plus className="h-3.5 w-3.5" /> New template
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-base font-semibold text-crm-text">
                  {creating ? "New template" : selected?.name}
                </h3>
                <div className="flex items-center gap-2">
                  {!creating && selected ? (
                    <button type="button" className={cn(crm.btnGhost, "text-xs text-crm-danger")} onClick={handleArchive}>
                      <Trash2 className="h-3.5 w-3.5" /> Archive
                    </button>
                  ) : null}
                  <button type="button" className={cn(crm.btnPrimary, "text-xs")} onClick={handleSave} disabled={saving}>
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    {creating ? "Create" : "Save"}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,180px)]">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-crm-muted">Name</label>
                  <input
                    className={crm.input}
                    value={editor.name}
                    onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                    maxLength={200}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-crm-muted">Visibility</label>
                  <select
                    className={crm.select}
                    value={editor.visibility}
                    onChange={(e) => setEditor({ ...editor, visibility: e.target.value as "SHARED" | "PRIVATE" })}
                  >
                    <option value="SHARED">Shared (tenant)</option>
                    <option value="PRIVATE">Private (me)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-crm-muted">Subject</label>
                <input
                  className={crm.input}
                  value={editor.subject}
                  onChange={(e) => setEditor({ ...editor, subject: e.target.value })}
                  maxLength={500}
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-crm-muted">Body</label>
                <textarea
                  className={cn(crm.input, "font-sans")}
                  rows={10}
                  value={editor.bodyText}
                  onChange={(e) => setEditor({ ...editor, bodyText: e.target.value })}
                  maxLength={50000}
                />
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-crm-muted">Insert:</span>
                  {MERGE_FIELDS.map((f) => (
                    <button
                      key={f.token}
                      type="button"
                      className={cn(crm.chip, "cursor-pointer hover:border-crm-accent/40 hover:text-crm-accent")}
                      onClick={() => insertToken(f.token)}
                      title={f.token}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-crm border border-crm-border/70 bg-crm-surface-2/40 px-3 py-3">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-crm-muted">
                  <Eye className="h-3.5 w-3.5" /> Preview (sample contact: Ada Lovelace)
                </div>
                <p className="text-sm font-semibold text-crm-text">{previewWith(editor.subject) || "(no subject)"}</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-crm-text/90">{previewWith(editor.bodyText) || "(empty body)"}</p>
              </div>
            </div>
          )}
        </CRMCard>
      </div>
    </CRMPageShell>
  );
}
