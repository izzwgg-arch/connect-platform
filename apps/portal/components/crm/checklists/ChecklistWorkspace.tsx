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
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import {
  CHECKLIST_TEMPLATES,
  type ChecklistTemplate,
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
  // View/edit mode
  selected: Checklist | null;
  onSaveEdit: (name: string, items: EditItem[]) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  savedMsg: string;

  // Create mode
  creating: boolean;
  createName: string;
  createItems: EditItem[];
  onCreateNameChange: (v: string) => void;
  onCreateItemsChange: (items: EditItem[]) => void;
  onConfirmCreate: () => Promise<void>;
  onCancelCreate: () => void;
  createSaving: boolean;

  // No selection
  onPickTemplate: (templateId: string) => void;
  onNewBlank: () => void;
};

// ── Item editor row ────────────────────────────────────────────────────────────

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

// ── View: single checklist item ─────────────────────────────────────────────

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
        <span className="shrink-0 rounded-crm border border-crm-warning/40 bg-crm-warning/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-crm-warning">
          Required
        </span>
      )}
    </div>
  );
}

// ── Template grid (empty state) ─────────────────────────────────────────────

function TemplateGrid({
  onPick,
  onBlank,
}: {
  onPick: (id: string) => void;
  onBlank: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="text-center">
        <div className={cn(crm.iconBox, "mx-auto mb-3")}>
          <ClipboardList size={20} />
        </div>
        <h2 className="text-base font-semibold text-crm-text">
          Checklist workspace
        </h2>
        <p className="mt-1 text-sm text-crm-muted">
          Select a checklist from the library, or start from a template below.
        </p>
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2">
          <Layers size={13} className="text-crm-muted" />
          <span className={crm.label}>Starter templates</span>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {CHECKLIST_TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => onPick(t.id)}
              className={crm.checklistTemplateCard}
            >
              <div className="flex items-center gap-2">
                <span className="text-base">{t.icon}</span>
                <span className="text-xs font-semibold text-crm-text">
                  {t.name}
                </span>
              </div>
              <p className="text-[11px] leading-snug text-crm-muted">
                {t.description}
              </p>
              <div className="mt-1 flex items-center gap-1.5">
                <span className="text-[10px] text-crm-muted">
                  {t.items.length} steps
                </span>
                <span className="text-[10px] text-crm-muted">·</span>
                <span className="text-[10px] text-crm-warning">
                  {t.items.filter((i) => i.required).length} required
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-crm-border/40 pt-4 text-center">
        <button onClick={onBlank} className={crm.btnSecondary}>
          <Plus size={13} />
          Start from blank
        </button>
      </div>
    </div>
  );
}

// ── Item list editor (shared create / edit) ─────────────────────────────────

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
        <span className="text-[11px] text-crm-muted">
          ({items.length} step{items.length !== 1 ? "s" : ""})
        </span>
      </div>

      {items.length === 0 && (
        <div className={cn(crm.emptyWrap, "py-6")}>
          <p className={crm.emptyBody}>
            No steps yet. Add your first step below.
          </p>
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
        onClick={addItem}
        className={cn(
          "flex items-center gap-2 rounded-crm border border-dashed border-crm-border/70",
          "bg-crm-surface-2/30 px-3 py-2.5 text-xs text-crm-muted",
          "transition-colors hover:border-crm-border hover:bg-crm-surface-2/60 hover:text-crm-text"
        )}
      >
        <Plus size={12} />
        Add step
      </button>
    </div>
  );
}

// ── Main workspace ─────────────────────────────────────────────────────────────

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
        editItems.filter((i) => i.label.trim()).map((i, idx) => ({ ...i, sortOrder: idx }))
      );
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }, [editName, editItems, onSaveEdit]);

  // ── Create mode ──
  if (creating) {
    return (
      <div className={cn(crm.card, crm.cardPad, "flex flex-col gap-4")}>
        <div className="flex items-center gap-2">
          <ClipboardList size={16} className="text-crm-accent" />
          <h2 className="text-sm font-semibold text-crm-text">New Checklist</h2>
        </div>

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
          <button onClick={onCancelCreate} className={crm.btnSecondary}>
            <X size={13} />
            Cancel
          </button>
          <button
            onClick={onConfirmCreate}
            disabled={!createName.trim() || createSaving}
            className={crm.btnPrimary}
          >
            <Check size={13} />
            {createSaving ? "Creating…" : "Create Checklist"}
          </button>
        </div>
      </div>
    );
  }

  // ── No selection ──
  if (!selected) {
    return (
      <div className={cn(crm.card, crm.cardPad)}>
        <TemplateGrid onPick={onPickTemplate} onBlank={onNewBlank} />
      </div>
    );
  }

  // ── Edit mode ──
  if (editing) {
    return (
      <div className={cn(crm.card, crm.cardPad, "flex flex-col gap-4")}>
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
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
          <div className="flex shrink-0 items-center gap-2 pt-5">
            <button
              onClick={handleSaveEdit}
              disabled={!editName.trim() || saving}
              className={crm.btnPrimary}
            >
              <Check size={13} />
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              className={crm.btnSecondary}
            >
              <X size={13} />
              Cancel
            </button>
          </div>
        </div>

        <ItemListEditor items={editItems} onChange={setEditItems} />
      </div>
    );
  }

  // ── View mode ──
  const requiredItems = selected.items.filter((i) => i.required);
  const totalItems = selected.items.length;

  return (
    <div className={cn(crm.card, "flex flex-col overflow-hidden")}>
      {/* Workspace header */}
      <div className="flex items-start justify-between gap-3 border-b border-crm-border px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className={cn(crm.iconBox, "h-8 w-8 shrink-0")}>
            <ClipboardList size={15} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-crm-text">
                {selected.name}
              </h2>
              {!selected.isActive && (
                <span className={cn(crm.chip, "text-[10px]")}>Archived</span>
              )}
            </div>
            <p className="text-[11px] text-crm-muted">
              {totalItems} step{totalItems !== 1 ? "s" : ""} ·{" "}
              {requiredItems.length} required
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {savedMsg && (
            <span className="text-xs text-crm-success">{savedMsg}</span>
          )}
          {selected.isActive && (
            <button onClick={startEdit} className={crm.btnSecondary}>
              <Pencil size={12} />
              Edit
            </button>
          )}
          {selected.isActive ? (
            <button
              onClick={() => onArchive(selected.id)}
              className={crm.btnGhost}
              title="Archive checklist"
            >
              <Archive size={13} />
              Archive
            </button>
          ) : (
            <button
              onClick={() => onRestore(selected.id)}
              className={cn(crm.btnGhost, "text-crm-success hover:text-crm-success")}
            >
              <RotateCcw size={13} />
              Restore
            </button>
          )}
        </div>
      </div>

      {/* Steps */}
      <div className="flex flex-col gap-2 p-4">
        {totalItems === 0 && (
          <div className={crm.emptyWrap}>
            <AlertCircle size={20} className="mx-auto mb-2 text-crm-muted/60" />
            <p className={cn(crm.emptyTitle, "text-sm")}>No steps added</p>
            <p className={crm.emptyBody}>
              Click <strong className="text-crm-text">Edit</strong> to add
              workflow steps.
            </p>
          </div>
        )}

        {selected.items.map((item, i) => (
          <ChecklistStepRow key={item.id} item={item} index={i} />
        ))}
      </div>
    </div>
  );
}
