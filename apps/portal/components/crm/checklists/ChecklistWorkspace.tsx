"use client";

import { useState, useRef, useCallback } from "react";
import {
  Pencil,
  Archive,
  Check,
  X,
  Plus,
  GripVertical,
  Trash2,
  RotateCcw,
  ClipboardList,
  Layers,
  AlertCircle,
  Sparkles,
  ArrowRight,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import {
  CHECKLIST_TEMPLATES,
  TEMPLATE_ACCENT_CLASSES,
} from "./ChecklistTemplates";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ChecklistItem = {
  id: string;
  label: string;
  required: boolean;
  sortOrder: number;
};

export type Checklist = {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  items: ChecklistItem[];
};

type EditItem = { label: string; required: boolean; sortOrder: number };

type Props = {
  selected: Checklist | null;
  onSaveEdit: (name: string, items: EditItem[]) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  savedMsg: string;
  creating: boolean;
  createName: string;
  createItems: EditItem[];
  onCreateNameChange: (v: string) => void;
  onCreateItemsChange: (items: EditItem[]) => void;
  onConfirmCreate: () => Promise<void>;
  onCancelCreate: () => void;
  createSaving: boolean;
  onPickTemplate: (templateId: string) => void;
  onNewBlank: () => void;
  templatesFocus?: boolean;
};

function PrimaryPanel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(crm.checklistPanelPrimary, "relative", className)}>
      <div className={crm.checklistPanelPrimaryGlow} aria-hidden />
      <div className="relative z-[1] flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

function ItemEditorRow({
  item,
  index,
  onChange,
  onRemove,
}: {
  item: EditItem;
  index: number;
  onChange: (updated: EditItem) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <GripVertical size={13} className="shrink-0 cursor-grab text-crm-muted/50" aria-hidden />
      <span
        className={cn(
          item.required ? crm.checklistStepNumRequired : crm.checklistStepNum,
          "shrink-0"
        )}
      >
        {index + 1}
      </span>
      <input
        value={item.label}
        onChange={(e) => onChange({ ...item, label: e.target.value })}
        placeholder={`Step ${index + 1}…`}
        className={cn(crm.input, "flex-1 py-2 text-xs")}
        aria-label={`Step ${index + 1} label`}
      />
      <label className="flex shrink-0 cursor-pointer items-center gap-1">
        <input
          type="checkbox"
          checked={item.required}
          onChange={(e) => onChange({ ...item, required: e.target.checked })}
          className={crm.checkbox}
          aria-label="Required"
        />
        <span className="text-[10px] text-crm-muted">Req</span>
      </label>
      <button
        onClick={onRemove}
        className="shrink-0 rounded-crm p-1 text-crm-muted/60 transition-colors hover:bg-crm-danger/10 hover:text-crm-danger"
        aria-label="Remove step"
        title="Remove step"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function ChecklistStepRow({
  item,
  index,
}: {
  item: ChecklistItem;
  index: number;
}) {
  return (
    <div
      className={cn(
        crm.checklistStepCard,
        item.required ? crm.checklistStepRequired : crm.checklistStepPending
      )}
    >
      <span
        className={cn(
          item.required ? crm.checklistStepNumRequired : crm.checklistStepNum,
          "shrink-0 mt-px"
        )}
      >
        {index + 1}
      </span>
      <span className="flex-1 text-sm leading-snug">{item.label}</span>
      {item.required && (
        <span className="shrink-0 rounded-crm border border-crm-warning/40 bg-crm-warning/12 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-crm-warning">
          Required
        </span>
      )}
    </div>
  );
}

function TemplateCard({
  template,
  onPick,
}: {
  template: (typeof CHECKLIST_TEMPLATES)[number];
  onPick: (id: string) => void;
}) {
  const accent = TEMPLATE_ACCENT_CLASSES[template.accent];
  const reqCount = template.items.filter((i) => i.required).length;

  return (
    <button
      type="button"
      onClick={() => onPick(template.id)}
      className={cn(crm.checklistTemplateCard, accent.card)}
    >
      <span className={cn(crm.checklistTemplateStrip, accent.strip)} aria-hidden />
      <div className="flex items-start gap-3 pl-2">
        <span className={cn(crm.checklistTemplateIcon, accent.iconBox)}>
          {template.icon}
        </span>
        <div className="min-w-0 flex-1 text-left">
          <div className="flex items-start justify-between gap-2">
            <span className="text-sm font-semibold leading-tight text-crm-text group-hover:text-white">
              {template.name}
            </span>
            <ArrowRight
              size={14}
              className="mt-0.5 shrink-0 text-crm-muted/40 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-crm-accent"
            />
          </div>
          <p className="mt-1 text-[11px] leading-snug text-crm-muted line-clamp-2">
            {template.description}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className={crm.checklistMetricChip}>
              {template.items.length} steps
            </span>
            {reqCount > 0 && (
              <span className={cn(crm.checklistMetricChip, accent.meta)}>
                {reqCount} required
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}

const FEATURE_STRIP = [
  {
    title: "Proven playbooks",
    body: "Cold call, callback, and follow-up flows",
    icon: Sparkles,
    tone: "text-crm-accent border-crm-accent/30 bg-crm-accent/8",
  },
  {
    title: "Checklist mode",
    body: "Guided steps during live calls",
    icon: Layers,
    tone: "text-crm-warning border-crm-warning/30 bg-crm-warning/8",
  },
  {
    title: "Live call ready",
    body: "Required steps surface in workspace",
    icon: ClipboardList,
    tone: "text-crm-success border-crm-success/30 bg-crm-success/8",
  },
  {
    title: "Drive results",
    body: "Structured outreach for agents",
    icon: ArrowRight,
    tone: "text-violet-300 border-violet-400/30 bg-violet-400/8",
  },
] as const;

function TemplateGrid({
  onPick,
  onBlank,
  templatesFocus,
}: {
  onPick: (id: string) => void;
  onBlank: () => void;
  templatesFocus?: boolean;
}) {
  const templateCount = CHECKLIST_TEMPLATES.length;

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-5">
      <div className={crm.checklistHeroBand}>
        <div className={crm.checklistHeroGlow} aria-hidden />
        <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-crm-lg border border-crm-accent/30 bg-crm-accent/12 text-crm-accent shadow-[0_0_24px_-6px_rgba(56,189,248,0.35)]">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-crm-accent">
                Playbook command center
              </p>
              <h2 className="mt-0.5 text-base font-semibold text-crm-text sm:text-lg">
                Choose a playbook to begin
              </h2>
              <p className="mt-1 max-w-md text-sm text-crm-muted">
                Start with a proven outreach workflow, or build a custom checklist
                for your team.
              </p>
            </div>
          </div>
          <span
            className={cn(
              crm.checklistMetricChip,
              "shrink-0 self-start border-crm-accent/25 bg-crm-accent/8 text-crm-accent sm:self-center"
            )}
          >
            {templateCount} operational templates
          </span>
        </div>
      </div>

      <div>
        <div className="mb-2.5 flex items-center gap-2">
          <Layers size={13} className="text-crm-accent/80" />
          <span className={crm.label}>Starter playbooks</span>
        </div>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {CHECKLIST_TEMPLATES.map((t) => (
            <TemplateCard key={t.id} template={t} onPick={onPick} />
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-crm-border/40 pt-3">
        <p className="text-xs text-crm-muted">
          Need full control? Build from scratch.
        </p>
        <button type="button" onClick={onBlank} className={crm.btnSecondary}>
          <Plus size={13} />
          Start from blank
        </button>
      </div>
    </div>
  );
}

function ItemListEditor({
  items,
  onChange,
}: {
  items: EditItem[];
  onChange: (items: EditItem[]) => void;
}) {
  function updateItem(idx: number, updated: EditItem) {
    const next = [...items];
    next[idx] = updated;
    onChange(next);
  }

  function removeItem(idx: number) {
    onChange(items.filter((_, i) => i !== idx));
  }

  function addItem() {
    onChange([
      ...items,
      { label: "", required: false, sortOrder: items.length },
    ]);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className={crm.label}>Workflow steps</span>
        <span className="text-[11px] text-crm-muted tabular-nums">
          ({items.length} step{items.length !== 1 ? "s" : ""})
        </span>
      </div>

      {items.length === 0 && (
        <div
          className={cn(
            crm.emptyWrap,
            "border-crm-border/40 bg-[#101923]/50 py-5"
          )}
        >
          <p className={crm.emptyBody}>No steps yet. Add your first step below.</p>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {items.map((item, idx) => (
          <ItemEditorRow
            key={idx}
            item={item}
            index={idx}
            onChange={(updated) => updateItem(idx, updated)}
            onRemove={() => removeItem(idx)}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={addItem}
        className={cn(
          "flex items-center gap-2 rounded-crm border border-dashed border-crm-border/60",
          "bg-[#101923]/40 px-3 py-2.5 text-xs text-crm-muted",
          "transition-colors hover:border-crm-accent/35 hover:bg-crm-accent/5 hover:text-crm-text"
        )}
      >
        <Plus size={12} />
        Add step
      </button>
    </div>
  );
}

export function ChecklistWorkspace({
  selected,
  onSaveEdit,
  onArchive,
  onRestore,
  savedMsg,
  creating,
  createName,
  createItems,
  onCreateNameChange,
  onCreateItemsChange,
  onConfirmCreate,
  onCancelCreate,
  createSaving,
  onPickTemplate,
  onNewBlank,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editItems, setEditItems] = useState<EditItem[]>([]);
  const [saving, setSaving] = useState(false);

  const prevSelectedId = useRef<string | null>(null);

  if (selected && selected.id !== prevSelectedId.current) {
    prevSelectedId.current = selected.id;
    setEditing(false);
    setEditName(selected.name);
    setEditItems(
      selected.items.map((i) => ({
        label: i.label,
        required: i.required,
        sortOrder: i.sortOrder,
      }))
    );
  }

  const startEdit = useCallback(() => {
    if (!selected) return;
    setEditName(selected.name);
    setEditItems(
      selected.items.map((i) => ({
        label: i.label,
        required: i.required,
        sortOrder: i.sortOrder,
      }))
    );
    setEditing(true);
  }, [selected]);

  const handleSaveEdit = useCallback(async () => {
    setSaving(true);
    try {
      await onSaveEdit(
        editName,
        editItems
          .filter((i) => i.label.trim())
          .map((i, idx) => ({ ...i, sortOrder: idx }))
      );
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }, [editName, editItems, onSaveEdit]);

  if (creating) {
    return (
      <PrimaryPanel className="flex flex-col">
        <div className={cn(crm.checklistWorkspaceHeader, "flex items-center gap-2")}>
          <ClipboardList size={16} className="text-crm-accent" />
          <h2 className="text-sm font-semibold text-crm-text">New checklist</h2>
        </div>
        <div className="flex flex-col gap-4 p-4 sm:p-5">
          <div className="flex flex-col gap-1.5">
            <label className={crm.label} htmlFor="checklist-name">
              Name
            </label>
            <input
              id="checklist-name"
              value={createName}
              onChange={(e) => onCreateNameChange(e.target.value)}
              placeholder="e.g. Cold Call Qualification"
              className={crm.input}
              autoFocus
            />
          </div>
          <ItemListEditor items={createItems} onChange={onCreateItemsChange} />
          <div className="flex items-center justify-end gap-2 border-t border-crm-border/40 pt-3">
            <button type="button" onClick={onCancelCreate} className={crm.btnSecondary}>
              <X size={13} />
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirmCreate}
              disabled={!createName.trim() || createSaving}
              className={crm.btnPrimary}
            >
              <Check size={13} />
              {createSaving ? "Creating…" : "Create checklist"}
            </button>
          </div>
        </div>
      </PrimaryPanel>
    );
  }

  if (!selected) {
    return (
      <PrimaryPanel>
        <TemplateGrid onPick={onPickTemplate} onBlank={onNewBlank} />
      </PrimaryPanel>
    );
  }

  if (editing) {
    return (
      <PrimaryPanel className="flex flex-col">
        <div className={cn(crm.checklistWorkspaceHeader, "flex flex-wrap items-start justify-between gap-3")}>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <label className={crm.label} htmlFor="edit-checklist-name">
              Checklist name
            </label>
            <input
              id="edit-checklist-name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className={crm.input}
              autoFocus
            />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={handleSaveEdit}
              disabled={!editName.trim() || saving}
              className={crm.btnPrimary}
            >
              <Check size={13} />
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={() => setEditing(false)} className={crm.btnSecondary}>
              <X size={13} />
              Cancel
            </button>
          </div>
        </div>
        <div className="p-4 sm:p-5">
          <ItemListEditor items={editItems} onChange={setEditItems} />
        </div>
      </PrimaryPanel>
    );
  }

  const requiredItems = selected.items.filter((i) => i.required);
  const totalItems = selected.items.length;

  return (
    <PrimaryPanel className="flex flex-col">
      <div className={cn(crm.checklistWorkspaceHeader, "flex items-start justify-between gap-3")}>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-crm-lg border border-crm-accent/30 bg-crm-accent/12 text-crm-accent shadow-[0_0_20px_-6px_rgba(56,189,248,0.25)]">
            <ClipboardList size={16} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-crm-text sm:text-base">
                {selected.name}
              </h2>
              {!selected.isActive && (
                <span className={cn(crm.chip, "text-[10px]")}>Archived</span>
              )}
            </div>
            <p className="text-[11px] text-crm-muted tabular-nums">
              {totalItems} step{totalItems !== 1 ? "s" : ""} · {requiredItems.length}{" "}
              required
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {savedMsg && (
            <span className="text-xs font-medium text-crm-success">{savedMsg}</span>
          )}
          {selected.isActive && (
            <button type="button" onClick={startEdit} className={crm.btnSecondary}>
              <Pencil size={12} />
              Edit
            </button>
          )}
          {selected.isActive ? (
            <button
              type="button"
              onClick={() => onArchive(selected.id)}
              className={crm.btnGhost}
              title="Archive checklist"
            >
              <Archive size={13} />
              Archive
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onRestore(selected.id)}
              className={cn(crm.btnGhost, "text-crm-success hover:text-crm-success")}
            >
              <RotateCcw size={13} />
              Restore
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 p-4 sm:p-5">
        {totalItems === 0 && (
          <div
            className={cn(
              crm.emptyWrap,
              "border-crm-border/40 bg-[#101923]/40 py-6"
            )}
          >
            <AlertCircle size={20} className="mx-auto mb-2 text-crm-muted/60" />
            <p className={cn(crm.emptyTitle, "text-sm")}>No steps added</p>
            <p className={crm.emptyBody}>
              Click <strong className="text-crm-text">Edit</strong> to add workflow
              steps.
            </p>
          </div>
        )}
        {selected.items.map((item, i) => (
          <ChecklistStepRow key={item.id} item={item} index={i} />
        ))}
      </div>
    </PrimaryPanel>
  );
}
