"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, FileText, GripVertical, Lightbulb, Plus, Sparkles, Trash2, X } from "lucide-react";
import { formatCrmSaveError } from "../crmSaveHelpers";
import { crm } from "../crmClasses";
import { cn } from "../cn";
import { parseScriptSections, SCRIPT_TEMPLATES, serializeScriptSections } from "./ScriptTemplates";
import type { Script } from "./scriptTypes";

interface Section {
  id: string;
  title: string;
  content: string;
}

function toSections(body: string): Section[] {
  const parsed = parseScriptSections(body);
  if (parsed.length === 0) {
    return [{ id: crypto.randomUUID(), title: "", content: "" }];
  }
  return parsed.map((s) => ({
    id: crypto.randomUUID(),
    title: s.title,
    content: s.content,
  }));
}

interface ScriptEditModalProps {
  /** null = create mode, Script = edit mode */
  script: Script | null;
  /** templateBody pre-fills the editor for a brand-new script from a template */
  templateBody?: string;
  onSave: (data: { name: string; body: string }) => Promise<void>;
  onClose: () => void;
}

export function ScriptEditModal({ script, templateBody, onSave, onClose }: ScriptEditModalProps) {
  const [name, setName] = useState(script?.name ?? "");
  const [sections, setSections] = useState<Section[]>(() => {
    if (script) return toSections(script.body);
    if (templateBody) return toSections(templateBody);
    return [{ id: crypto.randomUUID(), title: "", content: "" }];
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  function addSection() {
    setSections((prev) => [...prev, { id: crypto.randomUUID(), title: "", content: "" }]);
  }

  function removeSection(id: string) {
    setSections((prev) => (prev.length > 1 ? prev.filter((s) => s.id !== id) : prev));
  }

  function updateSection(id: string, field: "title" | "content", value: string) {
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
  }

  function applyTemplate(key: string) {
    setSelectedTemplate(key);
    const tpl = SCRIPT_TEMPLATES.find((item) => item.key === key);
    if (!tpl) return;
    setSections(toSections(tpl.body));
    if (!name.trim()) setName(tpl.label);
  }

  async function handleSave() {
    if (!name.trim()) {
      setError("Script name is required.");
      nameRef.current?.focus();
      return;
    }
    const body = serializeScriptSections(sections);
    if (!body.trim()) {
      setError("At least one section with content is required.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave({ name: name.trim(), body });
    } catch (err) {
      setError(formatCrmSaveError(err));
      setSaving(false);
    }
  }

  const isCreate = !script;

  return (
    <div className="scripts-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={cn(crm.card, crm.scriptsEditModal)}
      >
        {/* Modal header */}
        <div className="scripts-modal-header flex items-center justify-between gap-3 border-b border-crm-border px-5 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span className="scripts-mini-icon scripts-mini-icon--blue">
              <FileText className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-bold tracking-tight text-crm-text">
                {isCreate ? "Create New Call Script" : "Edit Call Script"}
              </h2>
              <p className="mt-0.5 text-xs text-crm-muted">Build reusable talk tracks for live calls.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-2xl text-crm-muted hover:bg-crm-surface-2 hover:text-crm-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="grid flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
          <div className="min-w-0 px-5 py-5 sm:px-6">
            {/* Script name */}
            <div className="mb-5">
              <label className={cn(crm.label, "mb-2 block")}>Script name</label>
              <input
                ref={nameRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Cold Call — SMB"
                className={cn(crm.input, "h-12 rounded-2xl text-base")}
              />
            </div>

            {isCreate ? (
              <div className="mb-5">
                <label className={cn(crm.label, "mb-2 block")}>Template (optional)</label>
                <select
                  value={selectedTemplate}
                  onChange={(e) => applyTemplate(e.target.value)}
                  className={cn(crm.select, "h-12 rounded-2xl text-sm")}
                >
                  <option value="">Start from scratch</option>
                  {SCRIPT_TEMPLATES.map((tpl) => (
                    <option key={tpl.key} value={tpl.key}>{tpl.label}</option>
                  ))}
                </select>
              </div>
            ) : null}

            {/* Section editor */}
            <div className="mb-3 flex items-center justify-between gap-3">
              <label className="text-sm font-bold text-crm-text">Script Sections</label>
              <span className="text-xs text-crm-muted">
                Use "---" to separate sections or add below
              </span>
            </div>

            <div className="flex flex-col gap-3">
              {sections.map((section, idx) => (
                <SectionEditor
                  key={section.id}
                  section={section}
                  index={idx}
                  canRemove={sections.length > 1}
                  onUpdate={(field, val) => updateSection(section.id, field, val)}
                  onRemove={() => removeSection(section.id)}
                />
              ))}
            </div>

            <button
              type="button"
              onClick={addSection}
              className={cn(crm.btnGhost, "mt-3 w-full justify-center rounded-2xl py-3 text-sm")}
            >
              <Plus className="h-4 w-4" />
              Add section
            </button>

            {error ? (
              <p className={cn(crm.bannerDanger, "mt-3 rounded-2xl px-3 py-2 text-xs")}>{error}</p>
            ) : null}
          </div>

          <aside className="scripts-modal-guide border-t border-crm-border p-5 sm:p-6 lg:border-l lg:border-t-0">
            <div className="scripts-guide-card rounded-[1.35rem] p-4">
              <div className="mb-4 flex items-start gap-3">
                <span className="scripts-mini-icon scripts-mini-icon--violet">
                  <Sparkles className="h-4 w-4" />
                </span>
                <div>
                  <h3 className="text-sm font-bold text-crm-text">How to create an effective call script</h3>
                  <p className="mt-1 text-xs leading-relaxed text-crm-muted">
                    A well-structured script helps your team stay consistent, confident, and goal-focused.
                  </p>
                </div>
              </div>
              <ol className="flex flex-col gap-3">
                {[
                  ["Name your script", "Use a clear, specific name that reflects the purpose."],
                  ["Choose a template", "Start from a proven flow or build from scratch."],
                  ["Add sections", "Break the call into opening, discovery, value, and next steps."],
                  ["Keep it usable", "Use short prompts reps can read naturally on a live call."],
                ].map(([title, body], index) => (
                  <li key={title} className="flex gap-3">
                    <span className="scripts-step-badge">{index + 1}</span>
                    <span>
                      <span className="block text-xs font-bold text-crm-text">{title}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-crm-muted">{body}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            <div className="mt-3 rounded-[1.35rem] border border-crm-border/60 bg-crm-surface-2/45 p-4">
              <div className="mb-2 flex items-center gap-2">
                <Lightbulb className="h-4 w-4 text-crm-warning" />
                <p className="text-sm font-bold text-crm-text">Formatting Tips</p>
              </div>
              <ul className="flex flex-col gap-2">
                {[
                  "Start a line with **text** for a bold sub-header.",
                  "Start a line with - or * for bullet points.",
                  "Separate sections with ---.",
                ].map((tip) => (
                  <li key={tip} className="flex items-start gap-2 text-xs leading-relaxed text-crm-muted">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-crm-success" />
                    {tip}
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        </div>

        {/* Footer */}
        <div className="scripts-modal-footer flex items-center justify-end gap-2 border-t border-crm-border px-5 py-4 sm:px-6">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className={cn(crm.btnSecondary, "text-sm")}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !name.trim()}
            className={cn(crm.btnPrimary, "text-sm min-w-[100px]")}
          >
            {saving ? "Saving…" : isCreate ? "Create script" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SectionEditor({
  section,
  index,
  canRemove,
  onUpdate,
  onRemove,
}: {
  section: Section;
  index: number;
  canRemove: boolean;
  onUpdate: (field: "title" | "content", value: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="scripts-section-editor rounded-[1.25rem] border border-crm-border bg-crm-surface-2/50">
      {/* Section header row */}
      <div className="flex items-center gap-2 border-b border-crm-border/60 px-3 py-2.5">
        <GripVertical className="h-3.5 w-3.5 shrink-0 text-crm-muted/50" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-crm-muted">
          §{index + 1}
        </span>
        <input
          type="text"
          value={section.title}
          onChange={(e) => onUpdate("title", e.target.value)}
          placeholder="Section title (optional)"
          className={cn(
            crm.input,
            "flex-1 border-0 bg-transparent py-1 text-sm font-semibold shadow-none focus:ring-0 focus:border-0",
          )}
        />
        {canRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-crm-muted hover:bg-crm-danger/15 hover:text-crm-danger"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        ) : null}
      </div>

      {/* Section content */}
      <textarea
        value={section.content}
        onChange={(e) => onUpdate("content", e.target.value)}
        placeholder="Script content for this section…"
        rows={6}
        className={cn(
          crm.input,
          "min-h-[8rem] resize-y rounded-none border-0 bg-transparent text-sm leading-relaxed shadow-none focus:border-0 focus:ring-0",
        )}
      />
    </div>
  );
}
