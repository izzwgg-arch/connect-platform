"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Archive,
  Check,
  ClipboardCheck,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { formatCrmSaveError } from "../crmSaveHelpers";

type ChecklistItem = {
  id: string;
  label: string;
  required: boolean;
  sortOrder?: number;
};

type Checklist = {
  id: string;
  name: string;
  isActive: boolean;
  isDefault?: boolean;
  updatedAt?: string;
  items: ChecklistItem[];
};

type Props = {
  checklist: Checklist | null;
  creating: boolean;
  createName: string;
  createItems: EditItem[];
  createSaving: boolean;
  createError?: string | null;
  savedMsg: string;
  onNewBlank: () => void;
  onCreateNameChange: (value: string) => void;
  onCreateItemsChange: (items: EditItem[]) => void;
  onConfirmCreate: () => Promise<void>;
  onCancelCreate: () => void;
  onSaveEdit: (name: string, items: EditItem[]) => Promise<void>;
  onSetDefault: (id: string) => Promise<void>;
  onArchive: (id: string) => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
};

type EditItem = { label: string; required: boolean; sortOrder: number };

function readinessReport(checklist: Checklist | null) {
  const total = checklist?.items.length ?? 0;
  const required = checklist?.items.filter((item) => item.required).length ?? 0;

  if (!checklist) {
    return {
      label: "No checklist selected",
      detail: "Select a row to review completion readiness.",
      percent: 0,
      tone: "muted" as const,
    };
  }
  if (!checklist.isActive) {
    return {
      label: "Archived",
      detail: "This workflow is hidden from active CRM use.",
      percent: 0,
      tone: "muted" as const,
    };
  }
  if (total === 0) {
    return {
      label: "Draft",
      detail: "Add workflow steps to finish setup.",
      percent: 12,
      tone: "warning" as const,
    };
  }
  if (required === 0) {
    return {
      label: "Needs required steps",
      detail: "Mark at least one required step before going live.",
      percent: 64,
      tone: "warning" as const,
    };
  }
  return {
    label: "Finished setup",
    detail: "Ready for live CRM workflow.",
    percent: 100,
    tone: "success" as const,
  };
}

function toneClasses(tone: ReturnType<typeof readinessReport>["tone"]) {
  if (tone === "success") {
    return {
      pill: "tasks-status-completed",
      text: "text-crm-success",
      border: "border-crm-success/35 bg-crm-success/8",
    };
  }
  if (tone === "warning") {
    return {
      pill: "tasks-status-today",
      text: "text-crm-warning",
      border: "border-crm-warning/35 bg-crm-warning/8",
    };
  }
  return {
    pill: "tasks-status-muted",
    text: "text-crm-muted",
    border: "border-crm-border/45 bg-crm-surface/55",
  };
}

function PanelShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <aside
      className={cn(
        "crm-queue-detail-panel crm-contact-detail-panel checklist-detail-panel custom-scrollbar",
        className
      )}
      aria-label="Checklist details"
    >
      <div className="crm-queue-detail-glow" aria-hidden />
      {children}
    </aside>
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
    <div className="flex items-center gap-2 rounded-[0.9rem] border border-crm-border/40 bg-crm-surface/70 px-2.5 py-2">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-crm-border/70 bg-crm-surface-2 text-[11px] font-bold text-crm-muted tabular-nums">
        {index + 1}
      </span>
      <input
        value={item.label}
        onChange={(event) => onChange({ ...item, label: event.target.value })}
        placeholder={`Step ${index + 1}...`}
        className={cn(crm.input, "min-w-0 flex-1 py-2 text-xs")}
        aria-label={`Step ${index + 1} label`}
      />
      <label className="flex shrink-0 cursor-pointer items-center gap-1">
        <input
          type="checkbox"
          checked={item.required}
          onChange={(event) => onChange({ ...item, required: event.target.checked })}
          className={crm.checkbox}
          aria-label="Required"
        />
        <span className="text-[10px] font-semibold text-crm-muted">Req</span>
      </label>
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 rounded-crm p-1 text-crm-muted/60 transition-colors hover:bg-crm-danger/10 hover:text-crm-danger"
        aria-label="Remove step"
      >
        <Trash2 size={12} />
      </button>
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
  function updateItem(index: number, updated: EditItem) {
    const next = [...items];
    next[index] = updated;
    onChange(next);
  }

  function removeItem(index: number) {
    onChange(items.filter((_, itemIndex) => itemIndex !== index));
  }

  function addItem() {
    onChange([
      ...items,
      { label: "", required: false, sortOrder: items.length },
    ]);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className={crm.label}>Workflow steps</span>
        <span className="text-[11px] text-crm-muted tabular-nums">
          {items.length} step{items.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        {items.map((item, index) => (
          <ItemEditorRow
            key={index}
            item={item}
            index={index}
            onChange={(updated) => updateItem(index, updated)}
            onRemove={() => removeItem(index)}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={addItem}
        className="flex items-center justify-center gap-2 rounded-[0.9rem] border border-dashed border-crm-border/65 bg-crm-surface/70 px-3 py-2.5 text-xs font-semibold text-crm-muted transition-colors hover:border-crm-accent/35 hover:bg-crm-accent/5 hover:text-crm-text"
      >
        <Plus size={12} />
        Add step
      </button>
    </div>
  );
}

export function ChecklistProgressPanel({
  checklist,
  creating,
  createName,
  createItems,
  createSaving,
  createError,
  savedMsg,
  onNewBlank,
  onCreateNameChange,
  onCreateItemsChange,
  onConfirmCreate,
  onCancelCreate,
  onSaveEdit,
  onSetDefault,
  onArchive,
  onRestore,
  onDelete,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editItems, setEditItems] = useState<EditItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const selectedTotal = checklist?.items.length ?? 0;
  const selectedRequired = checklist?.items.filter((item) => item.required) ?? [];
  const selectedRequiredCount = selectedRequired.length;
  const readiness = readinessReport(checklist);
  const readinessTone = toneClasses(readiness.tone);
  const selectedUpdatedAt = checklist?.updatedAt ? new Date(checklist.updatedAt) : null;
  const selectedUpdatedLabel =
    selectedUpdatedAt && !Number.isNaN(selectedUpdatedAt.getTime())
      ? selectedUpdatedAt.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "No activity yet";
  useEffect(() => {
    if (!checklist) {
      setEditing(false);
      setEditName("");
      setEditItems([]);
      return;
    }
    setEditing(false);
    setEditError(null);
    setDeleteError(null);
    setEditName(checklist.name);
    setEditItems(
      checklist.items.map((item, index) => ({
        label: item.label,
        required: item.required,
        sortOrder: item.sortOrder ?? index,
      }))
    );
  }, [checklist?.id]);

  const handleSaveEdit = useCallback(async () => {
    if (!checklist) return;
    setSaving(true);
    setEditError(null);
    try {
      await onSaveEdit(
        editName,
        editItems
          .filter((item) => item.label.trim())
          .map((item, index) => ({ ...item, sortOrder: index }))
      );
      setEditing(false);
    } catch (error) {
      setEditError(formatCrmSaveError(error));
    } finally {
      setSaving(false);
    }
  }, [checklist, editName, editItems, onSaveEdit]);

  const handleDelete = useCallback(async () => {
    if (!checklist || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(checklist.id);
    } catch (error) {
      setDeleteError(formatCrmSaveError(error));
    } finally {
      setDeleting(false);
    }
  }, [checklist, deleting, onDelete]);

  if (creating) {
    return (
      <PanelShell>
        <header className="crm-queue-detail-header">
          <span className="crm-queue-pill crm-queue-pill-info inline-flex items-center gap-1">
            <Plus className="h-3 w-3" />
            New checklist
          </span>
        </header>

        <section className="crm-queue-detail-identity">
          <div className="crm-queue-detail-avatar checklist-detail-icon">
            <ClipboardCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-bold text-crm-text">Create a checklist</h2>
            <p className="text-xs leading-5 text-crm-muted">
              Build the workflow here, then keep the list visible on the left.
            </p>
          </div>
        </section>

        <section className="checklist-detail-section flex flex-col gap-3">
          <label className={crm.label} htmlFor="side-checklist-name">
            Checklist name
          </label>
          <input
            id="side-checklist-name"
            value={createName}
            onChange={(event) => onCreateNameChange(event.target.value)}
            placeholder="Checklist name"
            className={crm.input}
            autoFocus
          />
          <ItemListEditor items={createItems} onChange={onCreateItemsChange} />
          {createError ? (
            <p className={cn(crm.bannerDanger, "rounded-2xl px-3 py-2 text-xs")} role="alert">
              {createError}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2 border-t border-crm-border/45 pt-3">
            <button type="button" onClick={onCancelCreate} className={crm.btnSecondary}>
              <X size={13} />
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirmCreate}
              disabled={!createName.trim() || createSaving}
              className="tasks-primary-action w-full justify-center gap-2"
            >
              <Check size={13} />
              {createSaving ? "Creating..." : "Create"}
            </button>
          </div>
        </section>
      </PanelShell>
    );
  }

  if (checklist && editing) {
    return (
      <PanelShell>
        <header className="crm-queue-detail-header">
          <span className="crm-queue-pill crm-queue-pill-info inline-flex items-center gap-1">
            <Pencil className="h-3 w-3" />
            Editing
          </span>
          {savedMsg ? <span className="text-xs font-semibold text-crm-success">{savedMsg}</span> : null}
        </header>

        <section className="crm-queue-detail-identity">
          <div className="crm-queue-detail-avatar checklist-detail-icon">
            <ClipboardCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-bold text-crm-text">Edit checklist</h2>
            <p className="text-xs leading-5 text-crm-muted">
              Update the name, steps, and required markers.
            </p>
          </div>
        </section>

        <section className="checklist-detail-section flex flex-col gap-3">
          <label className={crm.label} htmlFor="side-edit-checklist-name">
            Checklist name
          </label>
          <input
            id="side-edit-checklist-name"
            value={editName}
            onChange={(event) => setEditName(event.target.value)}
            className={crm.input}
            autoFocus
          />
          <ItemListEditor items={editItems} onChange={setEditItems} />
          {editError ? (
            <p className={cn(crm.bannerDanger, "rounded-2xl px-3 py-2 text-xs")} role="alert">
              {editError}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2 border-t border-crm-border/45 pt-3">
            <button type="button" onClick={() => setEditing(false)} className={crm.btnSecondary}>
              <X size={13} />
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSaveEdit}
              disabled={!editName.trim() || saving}
              className="tasks-primary-action w-full justify-center gap-2"
            >
              <Check size={13} />
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </section>
      </PanelShell>
    );
  }

  if (checklist) {
    return (
      <PanelShell>
        <header className="crm-queue-detail-header">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn("tasks-status-pill", readinessTone.pill)}>
              {readiness.label}
            </span>
            {checklist.isDefault ? <span className="crm-queue-pill crm-queue-pill-stage">Default</span> : null}
          </div>
          {savedMsg ? <span className="text-xs font-semibold text-crm-success">{savedMsg}</span> : null}
        </header>

        <section className="crm-queue-detail-identity">
          <div className="crm-queue-detail-avatar checklist-detail-icon">
            <ClipboardCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-bold text-crm-text">{checklist.name}</h2>
            <p className="text-xs leading-5 text-crm-muted">
              {selectedTotal} step{selectedTotal !== 1 ? "s" : ""} · {selectedRequiredCount} required · Updated {selectedUpdatedLabel}
            </p>
          </div>
        </section>

        <section className="checklist-detail-section">
          <div className="mb-3 flex items-center gap-2">
            <span className="tasks-kpi-icon tasks-icon-neutral">
              <ClipboardCheck className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-sm font-bold text-crm-text">Checklist Steps</h3>
              <p className="text-xs text-crm-muted">Read view for the selected workflow</p>
            </div>
          </div>
          {selectedTotal === 0 ? (
            <div className="rounded-[1rem] border border-dashed border-crm-border/45 p-4 text-center">
              <AlertCircle size={20} className="mx-auto mb-2 text-crm-muted/45" />
              <p className="text-xs text-crm-muted">No steps yet. Press Edit to add the workflow.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {checklist.items.map((item, index) => (
                <div
                  key={item.id}
                  className="flex items-start gap-2 rounded-[0.95rem] border border-crm-border/40 bg-crm-surface/70 p-2.5"
                >
                  <span
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold tabular-nums",
                      item.required
                        ? "border-crm-warning/45 bg-crm-warning/12 text-crm-warning"
                        : "border-crm-border/60 bg-crm-surface-2 text-crm-muted"
                    )}
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 text-xs font-medium leading-5 text-crm-text">
                    {item.label}
                  </span>
                  {item.required ? (
                    <span className="rounded-full border border-crm-warning/35 bg-crm-warning/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-crm-warning">
                      Req
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="crm-queue-detail-actions-card mt-auto">
          <p className="crm-queue-detail-section-label">Checklist actions</p>
          {checklist.isActive ? (
            <button
              type="button"
              onClick={() => void onSetDefault(checklist.id)}
              disabled={checklist.isDefault}
              className="crm-queue-detail-secondary-action"
            >
              <Check size={13} />
              {checklist.isDefault ? "Default checklist" : "Set Default"}
            </button>
          ) : null}
          {checklist.isActive ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="tasks-primary-action w-full justify-center gap-2"
            >
              <Pencil size={13} />
              Edit checklist
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onRestore(checklist.id)}
              className="tasks-primary-action w-full justify-center gap-2"
            >
              <RotateCcw size={13} />
              Restore checklist
            </button>
          )}
          {checklist.isActive ? (
            <button
              type="button"
              onClick={() => onArchive(checklist.id)}
              className="crm-queue-detail-secondary-action"
            >
              <Archive size={13} />
              Archive checklist
            </button>
          ) : null}
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            className={cn(crm.btnDanger, "w-full justify-center gap-2")}
          >
            <Trash2 size={13} />
            {deleting ? "Deleting..." : "Delete checklist"}
          </button>
          {deleteError ? (
            <p className={cn(crm.bannerDanger, "rounded-2xl px-3 py-2 text-xs")} role="alert">
              {deleteError}
            </p>
          ) : null}
        </section>
      </PanelShell>
    );
  }

  return (
    <PanelShell>
      <header className="crm-queue-detail-header">
        <span className="crm-queue-pill crm-queue-pill-info inline-flex items-center gap-1">
          <ClipboardCheck className="h-3 w-3" />
          Checklist desk
        </span>
      </header>

      <section className="crm-queue-detail-identity">
        <div className="crm-queue-detail-avatar checklist-detail-icon">
          <ClipboardCheck className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-bold text-crm-text">Select a checklist</h2>
          <p className="text-xs leading-5 text-crm-muted">
            Open a row to review steps, or create a new checklist without leaving the list.
          </p>
        </div>
      </section>

      <section className="crm-queue-detail-actions-card mt-auto">
        <p className="crm-queue-detail-section-label">Checklist actions</p>
        <button type="button" onClick={onNewBlank} className="tasks-primary-action w-full justify-center gap-2">
          <Plus size={13} />
          Create checklist
        </button>
      </section>
    </PanelShell>
  );
}
