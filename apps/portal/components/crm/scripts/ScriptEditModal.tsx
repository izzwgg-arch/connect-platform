"use client";

import { useEffect, useRef, useState } from "react";
import { GripVertical, Plus, Trash2, X } from "lucide-react";
import { crm } from "../crmClasses";
import { cn } from "../cn";
import { parseScriptSections, serializeScriptSections } from "./ScriptTemplates";
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
    } catch {
      setError("Save failed. Please try again.");
      setSaving(false);
    }
  }

  const isCreate = !script;

  return (
    <div className={crm.campaignModalBackdrop} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={cn(
          crm.card,
          "w-full max-w-2xl max-h-[92vh] flex flex-col",
          "[--panel:#141f2b] [--panel-2:#1a2635] [--bg-soft:#101923] [--text:#e1e9f1] [--text-dim:#8ea0b2] [--border:#26374a] [--crm-surface:#141f2b] [--crm-surface-2:#1a2635] [--crm-text:#e1e9f1] [--crm-text-muted:#8ea0b2] [--crm-border:#26374a] [color-scheme:dark]",
        )}
      >
        {/* Modal header */}
        <div className="flex items-center justify-between gap-3 border-b border-crm-border px-5 py-4">
          <h2 className="text-sm font-semibold text-crm-text">
            {isCreate ? "New Script" : "Edit Script"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-crm-muted hover:bg-crm-surface-2 hover:text-crm-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Script name */}
          <div className="mb-5">
            <label className={cn(crm.label, "mb-1.5 block")}>Script name</label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Cold Call — SMB"
              className={crm.input}
            />
          </div>

          {/* Section editor */}
          <div className="mb-2 flex items-center justify-between">
            <label className={crm.label}>Sections</label>
            <span className="text-[10px] text-crm-muted">
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
            className={cn(crm.btnGhost, "mt-3 w-full justify-center text-xs")}
          >
            <Plus className="h-3.5 w-3.5" />
            Add section
          </button>

          {/* Format hint */}
          <div className="mt-4 rounded-crm border border-crm-border/60 bg-crm-surface-2/40 px-3 py-2.5">
            <p className={cn(crm.footnote, "font-medium mb-1")}>Formatting tips</p>
            <ul className="flex flex-col gap-0.5">
              {[
                "Start a line with **text** to create a bold sub-header (e.g. objection label)",
                "Start a line with - or * for bullet points",
                "Separate sections with ---",
              ].map((tip) => (
                <li key={tip} className="flex items-baseline gap-1.5 text-[11px] text-crm-muted">
                  <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-crm-muted/60" />
                  {tip}
                </li>
              ))}
            </ul>
          </div>

          {error ? (
            <p className={cn(crm.bannerDanger, "mt-3 rounded-crm px-3 py-2 text-xs")}>{error}</p>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-crm-border px-5 py-3">
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
    <div className="rounded-crm border border-crm-border bg-crm-surface-2/50">
      {/* Section header row */}
      <div className="flex items-center gap-2 border-b border-crm-border/60 px-3 py-2">
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
            "flex-1 border-0 bg-transparent py-1 text-xs shadow-none focus:ring-0 focus:border-0",
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
        rows={5}
        className={cn(
          crm.input,
          "rounded-none border-0 bg-transparent font-mono text-xs leading-relaxed shadow-none focus:ring-0 focus:border-0 resize-y min-h-[7rem]",
        )}
      />
    </div>
  );
}
