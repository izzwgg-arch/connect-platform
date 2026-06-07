"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertCircle,
  Archive,
  Check,
  FileText,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { formatCrmSaveError } from "../crmSaveHelpers";
import { parseScriptSections, SCRIPT_TEMPLATES, serializeScriptSections } from "./ScriptTemplates";
import type { Script } from "./scriptTypes";

export function ScriptOperationalSidebar({
  script,
  loading,
  error,
  creating,
  savedMsg,
  onCreate,
  onSaveCreate,
  onCancelCreate,
  onSaveEdit,
  onSetDefault,
  onArchive,
  onRestore,
  onDelete,
}: {
  script: Script | null;
  loading: boolean;
  error: string | null;
  creating: boolean;
  savedMsg: string;
  onCreate: () => void;
  onSaveCreate: (data: { name: string; body: string }) => Promise<void>;
  onCancelCreate: () => void;
  onSaveEdit: (data: { name: string; body: string }) => Promise<void>;
  onSetDefault: (id: string) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (creating) {
    return (
      <ScriptDetailPanelShell>
        <ScriptEditorPanel
          mode="create"
          onSave={onSaveCreate}
          onCancel={onCancelCreate}
        />
      </ScriptDetailPanelShell>
    );
  }

  if (loading) {
    return (
      <ScriptDetailPanelShell>
        <div className="crm-queue-detail-header">
          <span className="h-6 w-24 animate-pulse rounded-full bg-crm-surface-2" />
        </div>
        <div className="mx-3 flex flex-col gap-3">
          {[9, 14, 18, 12].map((height) => (
            <div
              key={height}
              className="animate-pulse rounded-[1rem] border border-crm-border/40 bg-crm-surface/70"
              style={{ height: `${height * 0.25}rem` }}
            />
          ))}
        </div>
      </ScriptDetailPanelShell>
    );
  }

  if (error) {
    return (
      <ScriptDetailPanelShell>
        <section className={panelSectionClass}>
          <div className="mb-3 flex items-center gap-2">
            <span className="tasks-kpi-icon tasks-icon-neutral">
              <AlertCircle className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-bold text-crm-text">Script unavailable</h2>
              <p className="text-xs text-crm-muted">The selected script could not be loaded.</p>
            </div>
          </div>
          <p className={cn(crm.bannerDanger, "rounded-2xl px-3 py-2 text-xs")}>{error}</p>
        </section>
      </ScriptDetailPanelShell>
    );
  }

  if (script) {
    return (
      <ScriptDetailPanel
        script={script}
        savedMsg={savedMsg}
        onSaveEdit={onSaveEdit}
        onSetDefault={onSetDefault}
        onArchive={onArchive}
        onRestore={onRestore}
        onDelete={onDelete}
      />
    );
  }

  return <ScriptEmptyDetailPanel onCreate={onCreate} />;
}

type SectionDraft = {
  id: string;
  title: string;
  content: string;
};

const panelSectionClass =
  "scripts-detail-section relative z-[1] mx-3 mb-3 rounded-[1rem] border border-crm-border/40 bg-crm-surface p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]";

function makeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sectionsFromBody(body: string): SectionDraft[] {
  const parsed = parseScriptSections(body);
  if (parsed.length === 0) return [{ id: makeId(), title: "", content: "" }];
  return parsed.map((section) => ({
    id: makeId(),
    title: section.title,
    content: section.content,
  }));
}

function bodyStats(body: string) {
  const sections = parseScriptSections(body);
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  const placeholders = body.match(/\[[^\]]+\]/g)?.length ?? 0;
  return { sections, sectionCount: sections.length, words, placeholders };
}

function scriptReadiness(script: Script | null) {
  if (!script) {
    return {
      label: "No script selected",
      detail: "Select a row to review script readiness.",
      percent: 0,
      tone: "muted" as const,
    };
  }

  const stats = bodyStats(script.body);
  if (!script.isActive) {
    return {
      label: "Archived",
      detail: "Hidden from active call workflows.",
      percent: 0,
      tone: "muted" as const,
    };
  }
  if (stats.sectionCount === 0) {
    return {
      label: "Needs content",
      detail: "Add sections before reps use this on calls.",
      percent: 18,
      tone: "warning" as const,
    };
  }
  if (stats.words < 40) {
    return {
      label: "Light draft",
      detail: "Add more talk-track detail for consistent calls.",
      percent: 52,
      tone: "warning" as const,
    };
  }
  if (stats.placeholders > 0) {
    return {
      label: "Ready with prompts",
      detail: "Personalization placeholders are available for reps.",
      percent: 88,
      tone: "success" as const,
    };
  }
  return {
    label: "Live-ready",
    detail: "Structured and available for live call workflows.",
    percent: 100,
    tone: "success" as const,
  };
}

function toneClasses(tone: ReturnType<typeof scriptReadiness>["tone"]) {
  if (tone === "success") {
    return {
      pill: "tasks-status-completed",
      text: "text-crm-success",
      bar: "bg-crm-success",
      border: "border-crm-success/35 bg-crm-success/8",
      ring: "#22c55e",
    };
  }
  if (tone === "warning") {
    return {
      pill: "tasks-status-today",
      text: "text-crm-warning",
      bar: "bg-crm-warning",
      border: "border-crm-warning/35 bg-crm-warning/8",
      ring: "#f59e0b",
    };
  }
  return {
    pill: "tasks-status-muted",
    text: "text-crm-muted",
    bar: "bg-crm-muted",
    border: "border-crm-border/45 bg-crm-surface/55",
    ring: "#64748b",
  };
}

function ScriptDetailPanelShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <aside
      className={cn(
        "crm-queue-detail-panel crm-contact-detail-panel scripts-detail-panel custom-scrollbar",
        className
      )}
      aria-label="Script details"
    >
      <div className="crm-queue-detail-glow" aria-hidden />
      {children}
    </aside>
  );
}

function SectionEditor({
  section,
  index,
  canRemove,
  onUpdate,
  onRemove,
}: {
  section: SectionDraft;
  index: number;
  canRemove: boolean;
  onUpdate: (field: "title" | "content", value: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-[1rem] border border-crm-border/45 bg-crm-surface/70">
      <div className="flex items-center gap-2 border-b border-crm-border/45 px-2.5 py-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-crm-muted">
          §{index + 1}
        </span>
        <input
          type="text"
          value={section.title}
          onChange={(event) => onUpdate("title", event.target.value)}
          placeholder="Section title"
          className={cn(
            crm.input,
            "min-w-0 flex-1 border-0 bg-transparent py-1 text-xs font-semibold shadow-none focus:border-0 focus:ring-0"
          )}
        />
        {canRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-crm-muted hover:bg-crm-danger/15 hover:text-crm-danger"
            aria-label="Remove section"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        ) : null}
      </div>
      <textarea
        value={section.content}
        onChange={(event) => onUpdate("content", event.target.value)}
        placeholder="Script content..."
        rows={5}
        className={cn(
          crm.input,
          "min-h-[7rem] resize-y rounded-none border-0 bg-transparent text-xs leading-relaxed shadow-none focus:border-0 focus:ring-0"
        )}
      />
    </div>
  );
}

function ScriptEditorPanel({
  mode,
  script,
  onSave,
  onCancel,
}: {
  mode: "create" | "edit";
  script?: Script | null;
  onSave: (data: { name: string; body: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(script?.name ?? "");
  const [sections, setSections] = useState<SectionDraft[]>(() =>
    sectionsFromBody(script?.body ?? "")
  );
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode === "edit" && script) {
      setName(script.name);
      setSections(sectionsFromBody(script.body));
      setError(null);
    }
  }, [mode, script?.id]);

  function updateSection(id: string, field: "title" | "content", value: string) {
    setSections((prev) =>
      prev.map((section) => (section.id === id ? { ...section, [field]: value } : section))
    );
  }

  function removeSection(id: string) {
    setSections((prev) => (prev.length > 1 ? prev.filter((section) => section.id !== id) : prev));
  }

  function addSection() {
    setSections((prev) => [...prev, { id: makeId(), title: "", content: "" }]);
  }

  function applyTemplate(key: string) {
    setSelectedTemplate(key);
    const template = SCRIPT_TEMPLATES.find((item) => item.key === key);
    if (!template) return;
    setSections(sectionsFromBody(template.body));
    if (!name.trim()) setName(template.label);
  }

  const handleSave = useCallback(async () => {
    const body = serializeScriptSections(sections);
    if (!name.trim()) {
      setError("Script name is required.");
      return;
    }
    if (!body.trim()) {
      setError("At least one section with content is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: name.trim(), body });
    } catch (err) {
      setError(formatCrmSaveError(err));
    } finally {
      setSaving(false);
    }
  }, [name, sections, onSave]);

  return (
    <>
      <header className="crm-queue-detail-header">
        <span className="crm-queue-pill crm-queue-pill-info inline-flex items-center gap-1">
          {mode === "create" ? <Plus className="h-3 w-3" /> : <Pencil className="h-3 w-3" />}
          {mode === "create" ? "New script" : "Editing"}
        </span>
      </header>

      <section className="crm-queue-detail-identity">
        <div className="crm-queue-detail-avatar scripts-detail-icon">
          <FileText className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-bold text-crm-text">
            {mode === "create" ? "Create a script" : "Edit script"}
          </h2>
        </div>
      </section>

      <section className={cn(panelSectionClass, "flex flex-col gap-3")}>
        <label className={crm.label} htmlFor={`script-${mode}-name`}>
          Script name
        </label>
        <input
          id={`script-${mode}-name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Cold Call - SMB"
          className={crm.input}
          autoFocus
        />

        {mode === "create" ? (
          <label className="flex flex-col gap-2">
            <span className={crm.label}>Template</span>
            <select
              value={selectedTemplate}
              onChange={(event) => applyTemplate(event.target.value)}
              className={crm.select}
            >
              <option value="">Start from scratch</option>
              {SCRIPT_TEMPLATES.map((template) => (
                <option key={template.key} value={template.key}>
                  {template.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          <span className={crm.label}>Script sections</span>
          <span className="text-[11px] text-crm-muted tabular-nums">
            {sections.length} section{sections.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex flex-col gap-2">
          {sections.map((section, index) => (
            <SectionEditor
              key={section.id}
              section={section}
              index={index}
              canRemove={sections.length > 1}
              onUpdate={(field, value) => updateSection(section.id, field, value)}
              onRemove={() => removeSection(section.id)}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={addSection}
          className="flex items-center justify-center gap-2 rounded-[0.9rem] border border-dashed border-crm-border/65 bg-crm-surface/70 px-3 py-2.5 text-xs font-semibold text-crm-muted transition-colors hover:border-crm-accent/35 hover:bg-crm-accent/5 hover:text-crm-text"
        >
          <Plus size={12} />
          Add section
        </button>

        {error ? (
          <p className={cn(crm.bannerDanger, "rounded-2xl px-3 py-2 text-xs")} role="alert">
            {error}
          </p>
        ) : null}

        <div className="grid grid-cols-2 gap-2 border-t border-crm-border/45 pt-3">
          <button type="button" onClick={onCancel} className={crm.btnSecondary}>
            <X size={13} />
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!name.trim() || saving}
            className={cn(crm.btnPrimary, mode === "create" && "crm-create-blue-cta")}
          >
            <Check size={13} />
            {saving ? "Saving..." : mode === "create" ? "Create" : "Save"}
          </button>
        </div>
      </section>
    </>
  );
}

function ScriptDetailPanel({
  script,
  savedMsg,
  onSaveEdit,
  onSetDefault,
  onArchive,
  onRestore,
  onDelete,
}: {
  script: Script;
  savedMsg: string;
  onSaveEdit: (data: { name: string; body: string }) => Promise<void>;
  onSetDefault: (id: string) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const stats = useMemo(() => bodyStats(script.body), [script.body]);
  const readiness = scriptReadiness(script);
  const readinessTone = toneClasses(readiness.tone);
  const updatedAt = new Date(script.updatedAt);
  const updatedLabel = Number.isNaN(updatedAt.getTime())
    ? "No activity yet"
    : updatedAt.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });

  useEffect(() => {
    setEditing(false);
    setDeleteError(null);
  }, [script.id]);

  const handleDelete = useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(script.id);
    } catch (error) {
      setDeleteError(formatCrmSaveError(error));
    } finally {
      setDeleting(false);
    }
  }, [deleting, onDelete, script.id]);

  if (editing) {
    return (
      <ScriptDetailPanelShell>
        <ScriptEditorPanel
          mode="edit"
          script={script}
          onSave={async (data) => {
            await onSaveEdit(data);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </ScriptDetailPanelShell>
    );
  }

  return (
    <ScriptDetailPanelShell>
      <header className="crm-queue-detail-header">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cn("tasks-status-pill", readinessTone.pill)}>
            {readiness.label}
          </span>
          {script.isDefault ? <span className="crm-queue-pill crm-queue-pill-stage">Default</span> : null}
        </div>
        {savedMsg ? <span className="text-xs font-semibold text-crm-success">{savedMsg}</span> : null}
      </header>

      <section className="crm-queue-detail-identity">
        <div className="crm-queue-detail-avatar scripts-detail-icon">
          <FileText className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-bold text-crm-text">{script.name}</h2>
          <p className="text-xs leading-5 text-crm-muted">
            {stats.sectionCount} section{stats.sectionCount !== 1 ? "s" : ""} · {stats.words} words · Updated {updatedLabel}
          </p>
        </div>
      </section>

      <section className="crm-queue-detail-actions-card scripts-detail-section">
        <p className="crm-queue-detail-section-label">Script actions</p>
        {script.isActive ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={cn(crm.btnPrimary, "w-full justify-center gap-2")}
          >
            <Pencil size={13} />
            Edit script
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onRestore(script.id)}
            className={cn(crm.btnPrimary, "w-full justify-center gap-2")}
          >
            <RotateCcw size={13} />
            Restore script
          </button>
        )}
        {script.isActive ? (
          <button
            type="button"
            onClick={() => onSetDefault(script.id)}
            disabled={script.isDefault}
            className="crm-queue-detail-secondary-action"
          >
            <Check size={13} />
            {script.isDefault ? "Default script" : "Set Default"}
          </button>
        ) : null}
        {script.isActive ? (
          <button
            type="button"
            onClick={() => onArchive(script.id)}
            className="crm-queue-detail-secondary-action"
          >
            <Archive size={13} />
            Archive script
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void handleDelete()}
          disabled={deleting}
          className={cn(crm.btnDanger, "w-full justify-center gap-2")}
        >
          <Trash2 size={13} />
          {deleting ? "Deleting..." : "Delete script"}
        </button>
        {deleteError ? (
          <p className={cn(crm.bannerDanger, "rounded-2xl px-3 py-2 text-xs")} role="alert">
            {deleteError}
          </p>
        ) : null}
      </section>

      <section className={panelSectionClass}>
        <div className="mb-3 flex items-center gap-2">
          <span className="tasks-kpi-icon tasks-icon-neutral">
            <FileText className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-sm font-bold text-crm-text">Script Content</h3>
          </div>
        </div>
        {stats.sectionCount === 0 ? (
          <div className="rounded-[1rem] border border-dashed border-crm-border/45 p-4 text-center">
            <AlertCircle size={20} className="mx-auto mb-2 text-crm-muted/45" />
            <p className="text-xs text-crm-muted">No sections yet.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {stats.sections.map((section, index) => (
              <div
                key={`${section.title}-${index}`}
                className="rounded-[0.95rem] border border-crm-border/40 bg-crm-surface/70 p-2.5"
              >
                <div className="mb-1 flex items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-crm-border/60 bg-crm-surface-2 text-[11px] font-bold text-crm-muted tabular-nums">
                    {index + 1}
                  </span>
                  <h4 className="min-w-0 truncate text-xs font-bold text-crm-text">
                    {section.title || `Section ${index + 1}`}
                  </h4>
                </div>
                {section.content ? (
                  <p className="whitespace-pre-line text-xs leading-5 text-crm-muted">
                    {section.content}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

    </ScriptDetailPanelShell>
  );
}

function ScriptEmptyDetailPanel({
  onCreate,
}: {
  onCreate: () => void;
}) {
  return (
    <ScriptDetailPanelShell className="scripts-empty-detail-panel">
      <header className="crm-queue-detail-header">
        <span className="crm-queue-pill crm-queue-pill-info inline-flex items-center gap-1">
          <FileText className="h-3 w-3" />
          Script desk
        </span>
      </header>

      <section className="crm-queue-detail-identity">
        <div className="crm-queue-detail-avatar scripts-detail-icon">
          <FileText className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-bold text-crm-text">Select a script</h2>
        </div>
      </section>

      <section className="crm-queue-detail-actions-card scripts-detail-section">
        <p className="crm-queue-detail-section-label">Script actions</p>
        <button type="button" onClick={onCreate} className={cn(crm.btnPrimary, "crm-create-blue-cta w-full justify-center")}>
          <Plus size={13} />
          Create script
        </button>
      </section>
    </ScriptDetailPanelShell>
  );
}
