"use client";

import { useMemo, useState, useRef, useCallback } from "react";
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
  checklists: Checklist[];
  onSelect: (id: string) => void;
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

const CATEGORY_FILTERS = [
  { id: "all", label: "All Playbooks" },
  { id: "qualification", label: "Qualification" },
  { id: "verification", label: "Verification" },
  { id: "follow-up", label: "Follow Up" },
  { id: "objection", label: "Objection" },
  { id: "closing", label: "Closing" },
] as const;

type CategoryFilter = (typeof CATEGORY_FILTERS)[number]["id"];

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
      className={cn(
        crm.checklistTemplateCard,
        accent.cardBase,
        accent.card
      )}
    >
      <span className={cn(crm.checklistTemplateStrip, accent.strip)} aria-hidden />
      <span
        className={cn(crm.checklistTemplateGlow, accent.cardGlow)}
        aria-hidden
      />
      <div className={crm.checklistTemplateCardInner}>
        <div className="flex items-start gap-3">
          <span className={cn(crm.checklistTemplateIconWrap, accent.iconRing)}>
            <span className={cn(crm.checklistTemplateIcon, accent.iconBox)}>
              {template.icon}
            </span>
          </span>
          <div className="min-w-0 flex-1 text-left">
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm font-semibold leading-snug text-crm-text transition-colors group-hover:text-white">
                {template.name}
              </span>
              <span className={cn(crm.checklistTemplateBadge, accent.badge)}>
                Playbook
              </span>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-crm-muted/90 line-clamp-2">
              {template.description}
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-crm-border/40 pt-2.5">
          <div className="flex flex-wrap gap-1.5">
            <span className={crm.checklistMetricChip}>
              {template.items.length} steps
            </span>
            <span className={cn(crm.checklistMetricChip, accent.meta)}>
              {template.usage}
            </span>
            <span className={crm.checklistMetricChip}>{reqCount} required</span>
          </div>
          <ArrowRight
            size={14}
            className="shrink-0 text-crm-muted/30 transition-all duration-300 group-hover:translate-x-1 group-hover:text-crm-accent"
          />
        </div>
      </div>
    </button>
  );
}

function TemplateGrid({
  onPick,
  onBlank,
  templatesFocus,
}: {
  onPick: (id: string) => void;
  onBlank: () => void;
  templatesFocus?: boolean;
}) {
  const [category, setCategory] = useState<CategoryFilter>("all");
  const visibleTemplates = useMemo(
    () =>
      category === "all"
        ? CHECKLIST_TEMPLATES
        : CHECKLIST_TEMPLATES.filter((template) => template.category === category),
    [category]
  );

  return (
    <div className={crm.checklistTemplateWorkspace}>
      <div className="checklist-template-workspace-glow pointer-events-none absolute inset-0" aria-hidden />
      <div className="relative z-[1] flex flex-col gap-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Layers size={15} className="text-crm-accent" />
              <h2 className="text-lg font-bold tracking-tight text-crm-text">
                {templatesFocus ? "Browse templates" : "Start from a template"}
              </h2>
            </div>
            <p className="mt-1 text-sm text-crm-muted">
              Choose a proven workflow or build your own
            </p>
          </div>
          <span className="rounded-full border border-crm-border/50 bg-crm-surface-2/70 px-3 py-1 text-[11px] font-semibold text-crm-muted">
            {CHECKLIST_TEMPLATES.length} playbooks available
          </span>
        </div>

        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {CATEGORY_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() => setCategory(filter.id)}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition-all",
                category === filter.id
                  ? "border-crm-accent/45 bg-crm-accent/12 text-crm-accent shadow-[0_8px_20px_-14px_rgba(2,132,199,0.5)]"
                  : "border-crm-border/45 bg-crm-surface-2/65 text-crm-muted hover:border-crm-border hover:bg-crm-surface"
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <div className={crm.checklistTemplateGrid}>
          {visibleTemplates.map((t) => (
            <TemplateCard key={t.id} template={t} onPick={onPick} />
          ))}
        </div>

        <button type="button" onClick={onBlank} className={crm.checklistScratchCard}>
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-crm-accent/25 bg-crm-accent/10 text-crm-accent">
            <Plus size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-crm-text">
              Start from scratch
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-crm-muted">
              Build a custom checklist tailored to your team's process
            </span>
          </span>
          <ArrowRight
            size={16}
            className="shrink-0 text-crm-muted transition-transform group-hover:translate-x-1 group-hover:text-crm-accent"
          />
        </button>
      </div>
    </div>
  );
}

function ActiveChecklistStrip({
  checklists,
  selectedId,
  onSelect,
}: {
  checklists: Checklist[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const active = checklists.filter((checklist) => checklist.isActive);

  if (active.length === 0) {
    return (
      <div className="checklist-empty-state rounded-[1.5rem] border border-dashed border-crm-border/45 p-5 text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-crm-accent/25 bg-crm-accent/10 text-crm-accent">
          <ClipboardList size={24} />
        </span>
        <h3 className="mt-3 text-base font-bold text-crm-text">
          Choose a checklist to begin
        </h3>
        <p className="mx-auto mt-1 max-w-xl text-sm leading-relaxed text-crm-muted">
          Start with proven outreach workflows built for live calls, campaign
          follow-ups, and verification conversations.
        </p>
      </div>
    );
  }

  return (
    <div className="checklist-active-strip rounded-[1.5rem] border border-crm-border/35 p-4 shadow-crm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-crm-text">Active checklists</h2>
          <p className="text-xs text-crm-muted">
            Select a workflow to review or edit its steps.
          </p>
        </div>
        <span className="rounded-full border border-crm-success/25 bg-crm-success/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-crm-success">
          {active.length} live
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        {active.slice(0, 6).map((checklist) => {
          const requiredCount = checklist.items.filter((item) => item.required).length;
          const liveReady = checklist.items.length > 0 && requiredCount > 0;
          const selected = checklist.id === selectedId;
          return (
            <button
              key={checklist.id}
              type="button"
              onClick={() => onSelect(checklist.id)}
              className={cn(
                "group rounded-[1.1rem] border p-3 text-left transition-all hover:-translate-y-px",
                selected
                  ? "border-crm-accent/45 bg-crm-accent/10 ring-1 ring-crm-accent/20"
                  : "border-crm-border/40 bg-crm-surface/75 hover:border-crm-border"
              )}
            >
              <div className="flex items-start gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-crm-border/45 bg-crm-surface-2 text-crm-accent">
                  <ClipboardList size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-crm-text">
                    {checklist.name}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1.5 text-[10px] text-crm-muted">
                    <span>{checklist.items.length} steps</span>
                    <span>{requiredCount} required</span>
                    <span className={liveReady ? "text-crm-success" : "text-crm-warning"}>
                      {liveReady ? "Live ready" : "Needs setup"}
                    </span>
                  </span>
                </span>
                <ArrowRight
                  size={14}
                  className="mt-1 shrink-0 text-crm-muted/50 transition-transform group-hover:translate-x-1 group-hover:text-crm-accent"
                />
              </div>
            </button>
          );
        })}
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
            cn(crm.checklistInsetSurface, "border-crm-border/40 py-5")
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
          cn(crm.checklistInsetSurface, "px-3 py-2.5 text-xs text-crm-muted"),
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
  checklists,
  onSelect,
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
  templatesFocus,
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
        <div className={cn(crm.checklistWorkspaceHeader, "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between")}>
          <div className="flex min-w-0 gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-crm-accent/25 bg-crm-accent/10 text-crm-accent">
              <ClipboardList size={18} />
            </span>
            <div>
              <h2 className="text-lg font-bold tracking-tight text-crm-text">
                Create a checklist
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-crm-muted">
                Name the playbook, add clear workflow steps, and mark the steps agents must complete.
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-5 p-4 sm:p-5">
          <div className="checklist-form-section flex flex-col gap-2 rounded-[1.25rem] border border-crm-border/35 p-4">
            <label className={crm.label} htmlFor="checklist-name">
              Checklist name
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
          <div className="checklist-form-section rounded-[1.25rem] border border-crm-border/35 p-4">
            <ItemListEditor items={createItems} onChange={onCreateItemsChange} />
          </div>
          <div className="flex flex-col-reverse gap-2 border-t border-crm-border/40 pt-3 sm:flex-row sm:items-center sm:justify-end">
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
      <div className="flex flex-col gap-4">
        <TemplateGrid
          onPick={onPickTemplate}
          onBlank={onNewBlank}
          templatesFocus={templatesFocus}
        />
        <ActiveChecklistStrip
          checklists={checklists}
          selectedId={null}
          onSelect={onSelect}
        />
      </div>
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
              cn(crm.checklistInsetSurface, "border-crm-border/40 py-6")
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
