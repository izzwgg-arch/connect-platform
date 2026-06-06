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
  AlertCircle,
  ChevronRight,
  Clock,
  ListChecks,
} from "lucide-react";
import { formatCrmSaveError } from "../crmSaveHelpers";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { ChecklistHeaderTab } from "./ChecklistCommandHeader";

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
  selectedId?: string | null;
  checklists: Checklist[];
  totalCount: number;
  activeFilter: ChecklistHeaderTab;
  search: string;
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
  createError?: string | null;
  onNewBlank: () => void;
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

function checklistReadiness(checklist: Checklist) {
  const requiredCount = checklist.items.filter((item) => item.required).length;
  if (!checklist.isActive) {
    return {
      label: "Archived",
      detail: "Hidden from active workflows",
      percent: 0,
      tone: "muted" as const,
      requiredCount,
    };
  }
  if (checklist.items.length === 0) {
    return {
      label: "Draft",
      detail: "Add steps to finish setup",
      percent: 12,
      tone: "warning" as const,
      requiredCount,
    };
  }
  if (requiredCount === 0) {
    return {
      label: "Needs required steps",
      detail: "Mark at least one required step",
      percent: 64,
      tone: "warning" as const,
      requiredCount,
    };
  }
  return {
    label: "Finished setup",
    detail: "Ready for live CRM workflow",
    percent: 100,
    tone: "success" as const,
    requiredCount,
  };
}

function statusPillClass(tone: ReturnType<typeof checklistReadiness>["tone"]) {
  if (tone === "success") return "tasks-status-completed";
  if (tone === "warning") return "tasks-status-today";
  return "tasks-status-muted";
}

function relativeDate(iso: string | null | undefined): string {
  if (!iso) return "No activity";
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "No activity";
  const diff = Math.max(0, Date.now() - ts);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return minutes <= 1 ? "just now" : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ChecklistEmptyState({
  activeFilter,
  search,
  onNewBlank,
}: {
  activeFilter: ChecklistHeaderTab;
  search: string;
  onNewBlank: () => void;
}) {
  const filtered = activeFilter !== "all" || search.trim().length > 0;

  return (
    <div className="tasks-empty-state">
      <div className="tasks-empty-icon text-crm-accent">
        <ClipboardList className="h-9 w-9" />
      </div>
      <p className="text-lg font-semibold tracking-tight text-crm-text">
        {filtered ? "No checklists match" : "No checklists yet"}
      </p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-crm-muted">
        {filtered
          ? "Adjust the filters or search to see more checklists."
          : "Create a checklist when you are ready to define a real workflow."}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <button type="button" onClick={onNewBlank} className="tasks-primary-action">
          <Plus className="h-3.5 w-3.5" />
          Create New Checklist
        </button>
      </div>
    </div>
  );
}

function ChecklistIndexRow({
  checklist,
  rank,
  selected,
  onSelect,
}: {
  checklist: Checklist;
  rank: number;
  selected?: boolean;
  onSelect: (id: string) => void;
}) {
  const readiness = checklistReadiness(checklist);
  const updatedLabel = relativeDate(checklist.updatedAt);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(checklist.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(checklist.id);
        }
      }}
      className={cn(
        "crm-queue-row crm-checklist-row group",
        selected && "crm-queue-row-selected checklist-index-row-active",
        !checklist.isActive && "crm-queue-row-readonly opacity-90"
      )}
    >
      <div className="crm-queue-row-grid">
        <label
          className="crm-contact-row-check"
          onClick={(event) => event.stopPropagation()}
          aria-label={`Select ${checklist.name}`}
        >
          <input
            type="checkbox"
            readOnly
            checked={selected}
            className={crm.checkbox}
          />
        </label>
        <span className="crm-queue-row-rank tabular-nums">{rank}</span>

        <div className="crm-queue-row-avatar checklist-row-avatar" aria-hidden>
          <ClipboardList className="h-4 w-4" />
        </div>

        <div className="crm-queue-row-main min-w-0">
          <div className="crm-queue-row-title-line">
            <span className="crm-queue-row-name truncate">{checklist.name}</span>
            <span className={cn("crm-queue-pill", checklist.isActive ? "crm-queue-pill-stage" : "crm-queue-pill-warning")}>
              {checklist.isActive ? "Active" : "Archived"}
            </span>
            <span className={cn("tasks-status-pill", statusPillClass(readiness.tone))}>
              {readiness.label}
            </span>
          </div>
          <p className="crm-queue-row-sub truncate">{readiness.detail}</p>
        </div>

        <div className="crm-queue-row-phone hidden md:flex">
          <ListChecks className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {checklist.items.length} step{checklist.items.length !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="crm-queue-row-email hidden lg:flex">
          <Check className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{readiness.requiredCount} required</span>
        </div>

        <div className="crm-queue-row-meta hidden xl:flex">
          <span className="crm-queue-pill crm-queue-pill-muted inline-flex items-center gap-0.5">
            <Clock className="h-3 w-3" />
            {updatedLabel}
          </span>
        </div>

        <span className={cn("crm-queue-row-status shrink-0 tasks-status-pill", statusPillClass(readiness.tone))}>
          {readiness.percent}%
        </span>

        <ChevronRight className="crm-queue-row-chevron h-4 w-4 shrink-0" />
      </div>
    </div>
  );
}

function ChecklistCollection({
  checklists,
  totalCount,
  selectedId,
  activeFilter,
  search,
  onSelect,
  onNewBlank,
}: {
  checklists: Checklist[];
  totalCount: number;
  viewMode: ChecklistViewMode;
  selectedId?: string | null;
  activeFilter: ChecklistHeaderTab;
  search: string;
  onSelect: (id: string) => void;
  onNewBlank: () => void;
}) {
  if (checklists.length === 0) {
    return (
      <ChecklistEmptyState
        activeFilter={activeFilter}
        search={search}
        onNewBlank={onNewBlank}
      />
    );
  }

  return (
    <section className="checklist-collection-shell crm-queue-list-panel">
      <div className="crm-queue-list-head">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-3.5 w-3.5 text-crm-muted" />
          <h2>Checklist rows</h2>
        </div>
        <span className="text-[10px] font-semibold text-crm-muted tabular-nums">
          {checklists.length} shown · {totalCount} total
        </span>
      </div>

      <div className="crm-queue-row-list">
        {checklists.map((checklist, index) => (
          <ChecklistIndexRow
            key={checklist.id}
            checklist={checklist}
            rank={index + 1}
            selected={selectedId === checklist.id}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}

export function ChecklistWorkspace({
  selected,
  selectedId,
  checklists,
  totalCount,
  activeFilter,
  search,
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
  createError,
  onNewBlank,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editItems, setEditItems] = useState<EditItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

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
    setEditError(null);
    setEditing(true);
  }, [selected]);

  const handleSaveEdit = useCallback(async () => {
    setSaving(true);
    setEditError(null);
    try {
      await onSaveEdit(
        editName,
        editItems
          .filter((i) => i.label.trim())
          .map((i, idx) => ({ ...i, sortOrder: idx }))
      );
      setEditing(false);
    } catch (err) {
      setEditError(formatCrmSaveError(err));
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
                Name the checklist, add workflow steps, and mark any required items.
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
              placeholder="Checklist name"
              className={crm.input}
              autoFocus
            />
          </div>
          <div className="checklist-form-section rounded-[1.25rem] border border-crm-border/35 p-4">
            <ItemListEditor items={createItems} onChange={onCreateItemsChange} />
          </div>
          {createError ? (
            <p className={cn(crm.bannerDanger, "rounded-2xl px-3 py-2 text-xs")} role="alert">
              {createError}
            </p>
          ) : null}
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
      <ChecklistCollection
        checklists={checklists}
        totalCount={totalCount}
        selectedId={selectedId}
        activeFilter={activeFilter}
        search={search}
        onSelect={onSelect}
        onNewBlank={onNewBlank}
      />
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
          {editError ? (
            <p className={cn(crm.bannerDanger, "mt-3 rounded-2xl px-3 py-2 text-xs")} role="alert">
              {editError}
            </p>
          ) : null}
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
