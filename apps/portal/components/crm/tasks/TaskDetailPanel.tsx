"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  ListChecks,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { ConnectSelect } from "../../ConnectSelect";
import { apiGet, apiPost } from "../../../services/apiClient";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { CrmTask, TaskPriority, TaskStatus } from "./TaskCard";
import { getTaskDueInfo, getTaskTag } from "./TaskCard";
import type { TaskStats } from "./TaskKpiStrip";

type ContactOption = { id: string; displayName: string };

type TaskDraft = {
  title: string;
  body: string;
  dueAt: string;
  priority: TaskPriority;
  status: TaskStatus;
  contactSearch: string;
  selectedContact: ContactOption | null;
};

type TaskUpdatePayload = {
  title?: string;
  body?: string | null;
  dueAt?: string | null;
  priority?: TaskPriority;
  status?: TaskStatus;
};

type Props = {
  task: CrmTask | null;
  tasks: CrmTask[];
  upcomingTasks: CrmTask[];
  stats: TaskStats | null;
  statsLoading: boolean;
  mode: "summary" | "create" | "detail";
  savedMsg: string;
  onNewTask: () => void;
  onCancelCreate: () => void;
  onCreated: (task: CrmTask) => void;
  onSave: (task: CrmTask, payload: TaskUpdatePayload) => Promise<CrmTask>;
  onComplete: (task: CrmTask) => Promise<void>;
  onDelete: (task: CrmTask) => Promise<void>;
  onSelectTask: (task: CrmTask) => void;
};

const PRIORITY_OPTIONS = [
  { value: "LOW", label: "Low" },
  { value: "MEDIUM", label: "Medium" },
  { value: "HIGH", label: "High" },
  { value: "URGENT", label: "Urgent" },
];

const STATUS_OPTIONS = [
  { value: "OPEN", label: "Scheduled" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "DONE", label: "Completed" },
  { value: "CANCELED", label: "Canceled" },
];

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  LOW: "Low priority",
  MEDIUM: "Medium priority",
  HIGH: "High priority",
  URGENT: "Urgent priority",
};

function emptyDraft(): TaskDraft {
  return {
    title: "",
    body: "",
    dueAt: "",
    priority: "MEDIUM",
    status: "OPEN",
    contactSearch: "",
    selectedContact: null,
  };
}

function draftFromTask(task: CrmTask): TaskDraft {
  return {
    title: task.title,
    body: task.body ?? "",
    dueAt: toDatetimeLocal(task.dueAt),
    priority: task.priority,
    status: task.status,
    contactSearch: task.contact?.displayName ?? "",
    selectedContact: task.contact
      ? { id: task.contact.id, displayName: task.contact.displayName }
      : null,
  };
}

function toDatetimeLocal(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function toApiDatetime(value: string) {
  return value ? new Date(value).toISOString() : null;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "No due date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No due date";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function initials(name: string | null | undefined) {
  if (!name) return "--";
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function taskState(task: CrmTask | null) {
  if (!task) {
    return {
      label: "No task selected",
      detail: "Select a row to inspect ownership, status, and readiness.",
      percent: 0,
      tone: "muted" as const,
      pill: "tasks-status-muted",
      bar: "bg-crm-muted",
      text: "text-crm-muted",
      border: "border-crm-border/45 bg-crm-surface/55",
    };
  }

  const due = getTaskDueInfo(task.dueAt);
  if (task.status === "DONE") {
    return {
      label: "Completed",
      detail: task.completedAt
        ? `Closed ${formatDateTime(task.completedAt)}`
        : "Closed and ready for reporting.",
      percent: 100,
      tone: "success" as const,
      pill: "tasks-status-completed",
      bar: "bg-crm-success",
      text: "text-crm-success",
      border: "border-crm-success/35 bg-crm-success/8",
    };
  }
  if (task.status === "CANCELED") {
    return {
      label: "Canceled",
      detail: "This task is no longer active.",
      percent: 0,
      tone: "muted" as const,
      pill: "tasks-status-muted",
      bar: "bg-crm-muted",
      text: "text-crm-muted",
      border: "border-crm-border/45 bg-crm-surface/55",
    };
  }
  if (due?.urgent && due.cls === "text-crm-danger") {
    return {
      label: "Overdue",
      detail: "Needs immediate follow-up.",
      percent: 35,
      tone: "danger" as const,
      pill: "tasks-status-overdue",
      bar: "bg-crm-danger",
      text: "text-crm-danger",
      border: "border-crm-danger/35 bg-crm-danger/8",
    };
  }
  if (due?.urgent) {
    return {
      label: "Due today",
      detail: "Ready for action today.",
      percent: 72,
      tone: "warning" as const,
      pill: "tasks-status-today",
      bar: "bg-crm-warning",
      text: "text-crm-warning",
      border: "border-crm-warning/35 bg-crm-warning/8",
    };
  }
  if (task.status === "IN_PROGRESS") {
    return {
      label: "In progress",
      detail: "Work has started and is waiting on completion.",
      percent: 64,
      tone: "warning" as const,
      pill: "tasks-status-today",
      bar: "bg-crm-warning",
      text: "text-crm-warning",
      border: "border-crm-warning/35 bg-crm-warning/8",
    };
  }
  return {
    label: "Scheduled",
    detail: task.dueAt ? "Planned for a future follow-up." : "Add a due date to improve readiness.",
    percent: task.dueAt ? 58 : 28,
    tone: "info" as const,
    pill: "tasks-status-scheduled",
    bar: "bg-crm-accent",
    text: "text-crm-accent",
    border: "border-crm-accent/35 bg-crm-accent/8",
  };
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <aside
      className="crm-queue-detail-panel crm-contact-detail-panel tasks-detail-panel custom-scrollbar"
      aria-label="Task details"
    >
      <div className="crm-queue-detail-glow" aria-hidden />
      {children}
    </aside>
  );
}

function StatRow({
  label,
  value,
  dotClass,
  valueClass,
}: {
  label: string;
  value: number | string;
  dotClass: string;
  valueClass?: string;
}) {
  return (
    <div className="tasks-detail-stat-row">
      <span className="flex min-w-0 items-center gap-2 text-[11px] text-crm-muted">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", dotClass)} />
        {label}
      </span>
      <span className={cn("text-sm font-bold tabular-nums text-crm-text", valueClass)}>
        {value}
      </span>
    </div>
  );
}

function ContactPicker({
  draft,
  setDraft,
  disabled,
}: {
  draft: TaskDraft;
  setDraft: React.Dispatch<React.SetStateAction<TaskDraft>>;
  disabled?: boolean;
}) {
  const [options, setOptions] = useState<ContactOption[]>([]);
  const [searching, setSearching] = useState(false);

  const searchContacts = useCallback(async (query: string) => {
    if (query.length < 2) {
      setOptions([]);
      return;
    }
    setSearching(true);
    try {
      const data = await apiGet<{ rows: ContactOption[] }>(
        `/crm/contacts?q=${encodeURIComponent(query)}&limit=8`
      );
      setOptions(data.rows ?? []);
    } catch {
      setOptions([]);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (disabled || draft.selectedContact) return;
    const timer = window.setTimeout(() => searchContacts(draft.contactSearch), 300);
    return () => window.clearTimeout(timer);
  }, [disabled, draft.contactSearch, draft.selectedContact, searchContacts]);

  if (draft.selectedContact) {
    return (
      <div className="flex items-center gap-2 rounded-crm border border-crm-border bg-crm-surface-2 px-3 py-2.5 text-sm text-crm-text">
        <span className="flex-1 truncate">{draft.selectedContact.displayName}</span>
        {!disabled ? (
          <button
            type="button"
            onClick={() =>
              setDraft((current) => ({
                ...current,
                selectedContact: null,
                contactSearch: "",
              }))
            }
            className="shrink-0 text-crm-muted hover:text-crm-text"
            aria-label="Clear selected contact"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        value={draft.contactSearch}
        onChange={(event) =>
          setDraft((current) => ({ ...current, contactSearch: event.target.value }))
        }
        placeholder="Search contact..."
        className={crm.input}
        disabled={disabled}
      />
      {searching ? (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-crm-muted">
          ...
        </span>
      ) : null}
      {options.length > 0 ? (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-crm border border-crm-border bg-crm-surface shadow-crm">
          {options.map((contact) => (
            <button
              key={contact.id}
              type="button"
              onClick={() => {
                setDraft((current) => ({
                  ...current,
                  selectedContact: contact,
                  contactSearch: contact.displayName,
                }));
                setOptions([]);
              }}
              className="w-full px-3 py-2 text-left text-sm text-crm-text hover:bg-crm-surface-2"
            >
              {contact.displayName}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TaskForm({
  task,
  onCancel,
  onCreated,
  onSave,
}: {
  task?: CrmTask;
  onCancel: () => void;
  onCreated?: (task: CrmTask) => void;
  onSave?: (payload: TaskUpdatePayload) => Promise<void>;
}) {
  const [draft, setDraft] = useState<TaskDraft>(() => (task ? draftFromTask(task) : emptyDraft()));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = Boolean(task);

  useEffect(() => {
    setDraft(task ? draftFromTask(task) : emptyDraft());
    setError(null);
  }, [task?.id]);

  const handleSubmit = async () => {
    if (!draft.title.trim()) return;
    if (!editing && !draft.selectedContact) return;

    setSaving(true);
    setError(null);
    try {
      if (editing && onSave) {
        await onSave({
          title: draft.title.trim(),
          body: draft.body.trim() ? draft.body.trim() : null,
          dueAt: toApiDatetime(draft.dueAt),
          priority: draft.priority,
          status: draft.status,
        });
      } else if (draft.selectedContact && onCreated) {
        const created = await apiPost<CrmTask>(
          `/crm/contacts/${draft.selectedContact.id}/tasks`,
          {
            title: draft.title.trim(),
            body: draft.body.trim() ? draft.body.trim() : undefined,
            dueAt: toApiDatetime(draft.dueAt) ?? undefined,
            priority: draft.priority,
          }
        );
        onCreated({
          ...created,
          contact: {
            id: draft.selectedContact.id,
            displayName: draft.selectedContact.displayName,
          },
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save task");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="tasks-detail-section flex flex-col gap-3">
      <label className={crm.label} htmlFor={editing ? "edit-task-title" : "new-task-title"}>
        Task title
      </label>
      <input
        id={editing ? "edit-task-title" : "new-task-title"}
        value={draft.title}
        onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
        placeholder="Task title"
        className={crm.input}
        autoFocus
      />

      <label className={crm.label} htmlFor={editing ? "edit-task-body" : "new-task-body"}>
        Notes
      </label>
      <textarea
        id={editing ? "edit-task-body" : "new-task-body"}
        value={draft.body}
        onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))}
        placeholder="Add context, next steps, or call notes..."
        rows={4}
        className={cn(crm.input, "min-h-[6rem] resize-y")}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <label className={crm.label} htmlFor={editing ? "edit-task-due" : "new-task-due"}>
            Due
          </label>
          <input
            id={editing ? "edit-task-due" : "new-task-due"}
            type="datetime-local"
            value={draft.dueAt}
            onChange={(event) => setDraft((current) => ({ ...current, dueAt: event.target.value }))}
            className={crm.input}
          />
        </div>
        <div className="flex flex-col gap-2">
          <span className={crm.label}>Priority</span>
          <ConnectSelect
            value={draft.priority}
            onChange={(value) =>
              setDraft((current) => ({ ...current, priority: value as TaskPriority }))
            }
            options={PRIORITY_OPTIONS}
          />
        </div>
      </div>

      {editing ? (
        <div className="flex flex-col gap-2">
          <span className={crm.label}>Status</span>
          <ConnectSelect
            value={draft.status}
            onChange={(value) =>
              setDraft((current) => ({ ...current, status: value as TaskStatus }))
            }
            options={STATUS_OPTIONS}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <span className={crm.label}>Contact</span>
          <ContactPicker draft={draft} setDraft={setDraft} />
        </div>
      )}

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
          onClick={handleSubmit}
          disabled={saving || !draft.title.trim() || (!editing && !draft.selectedContact)}
          className={crm.btnPrimary}
        >
          <Check size={13} />
          {saving ? "Saving..." : editing ? "Save" : "Create"}
        </button>
      </div>
    </section>
  );
}

function SummaryPanel({ onNewTask }: Pick<Props, "onNewTask">) {
  return (
    <PanelShell>
      <header className="crm-queue-detail-header">
        <span className="crm-queue-pill crm-queue-pill-info inline-flex items-center gap-1">
          <ListChecks className="h-3 w-3" />
          Task panel
        </span>
      </header>

      <section className="crm-queue-detail-identity">
        <div className="crm-queue-detail-avatar tasks-detail-icon">
          <CheckCircle2 className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-bold text-crm-text">Select a task</h2>
          <p className="text-xs leading-5 text-crm-muted">
            Open a row to view or edit it, or create a new task without leaving the list.
          </p>
        </div>
      </section>

      <section className="crm-queue-detail-actions-card">
        <p className="crm-queue-detail-section-label">Task actions</p>
        <button type="button" onClick={onNewTask} className={cn(crm.btnPrimary, "w-full justify-center")}>
          <Plus size={13} />
          Create task
        </button>
      </section>
    </PanelShell>
  );
}

export function TaskDetailPanel({
  task,
  mode,
  savedMsg,
  onNewTask,
  onCancelCreate,
  onCreated,
  onSave,
  onComplete,
  onDelete,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const state = taskState(task);

  useEffect(() => {
    setEditing(false);
  }, [task?.id, mode]);

  const handleComplete = async () => {
    if (!task || completing || task.status === "DONE" || task.status === "CANCELED") return;
    setCompleting(true);
    try {
      await onComplete(task);
    } finally {
      setCompleting(false);
    }
  };

  const handleDelete = async () => {
    if (!task || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(task);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Unable to delete task");
    } finally {
      setDeleting(false);
    }
  };

  if (mode === "create") {
    return (
      <PanelShell>
        <header className="crm-queue-detail-header">
          <span className="crm-queue-pill crm-queue-pill-info inline-flex items-center gap-1">
            <Plus className="h-3 w-3" />
            New task
          </span>
        </header>

        <section className="crm-queue-detail-identity">
          <div className="crm-queue-detail-avatar tasks-detail-icon">
            <CheckCircle2 className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-bold text-crm-text">Create a task</h2>
            <p className="text-xs leading-5 text-crm-muted">
              Add the follow-up here while the task list stays visible.
            </p>
          </div>
        </section>

        <TaskForm onCancel={onCancelCreate} onCreated={onCreated} />
      </PanelShell>
    );
  }

  if (!task) {
    return <SummaryPanel onNewTask={onNewTask} />;
  }

  if (editing) {
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
          <div className="crm-queue-detail-avatar tasks-detail-icon">
            <CheckCircle2 className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-bold text-crm-text">Edit task</h2>
            <p className="text-xs leading-5 text-crm-muted">
              Update content, status, priority, and due date.
            </p>
          </div>
        </section>

        <TaskForm
          task={task}
          onCancel={() => setEditing(false)}
          onSave={async (payload) => {
            await onSave(task, payload);
            setEditing(false);
          }}
        />
      </PanelShell>
    );
  }

  const owner = task.assignedTo?.displayName ?? "Unassigned";
  const creator = task.createdBy?.displayName ?? "Unknown";
  const completedBy = task.completedBy?.displayName ?? null;
  const tag = getTaskTag(task);

  return (
    <PanelShell>
      <header className="crm-queue-detail-header">
        <span className={cn("tasks-status-pill", state.pill)}>{state.label}</span>
        {savedMsg ? <span className="text-xs font-semibold text-crm-success">{savedMsg}</span> : null}
      </header>

      <section className="crm-queue-detail-identity">
        <div className="crm-queue-detail-avatar tasks-detail-icon">
          <CheckCircle2 className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-bold text-crm-text">{task.title}</h2>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
            <span className={cn("tasks-tag-chip", tag.className)}>
              <span className="tasks-tag-dot" aria-hidden />
              {tag.label}
            </span>
            <span className="truncate text-xs leading-5 text-crm-muted">
              {task.contact?.displayName ?? "No contact"} · {PRIORITY_LABEL[task.priority]}
            </span>
          </div>
        </div>
      </section>

      <section className={cn("tasks-detail-section", state.border)}>
        <div className="flex items-center gap-4">
          <div
            className="tasks-readiness-donut"
            style={{
              background: `conic-gradient(currentColor ${state.percent * 3.6}deg, rgba(148,163,184,0.2) 0deg)`,
            }}
          >
            <div className="tasks-readiness-donut-inner" />
            <span className={cn("relative text-lg font-black tabular-nums", state.text)}>
              {state.percent}%
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-crm-muted">
              Task readiness
            </p>
            <h3 className={cn("mt-1 text-lg font-black tracking-tight", state.text)}>
              {state.label}
            </h3>
            <p className="mt-1 text-xs leading-5 text-crm-muted">{state.detail}</p>
          </div>
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-crm-surface-2 ring-1 ring-crm-border/45">
          <div className={cn("h-full rounded-full", state.bar)} style={{ width: `${state.percent}%` }} />
        </div>
      </section>

      <section className="crm-queue-detail-actions-card">
        <p className="crm-queue-detail-section-label">Task actions</p>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className={cn(crm.btnPrimary, "w-full justify-center gap-2")}
        >
          <Pencil size={13} />
          Edit task
        </button>
        {task.status === "DONE" ? (
          <button
            type="button"
            onClick={() => onSave(task, { status: "OPEN" })}
            className="crm-queue-detail-secondary-action"
          >
            <RotateCcw size={13} />
            Reopen task
          </button>
        ) : task.status !== "CANCELED" ? (
          <button
            type="button"
            onClick={handleComplete}
            disabled={completing}
            className="crm-queue-detail-secondary-action"
          >
            <CheckCircle2 size={13} />
            {completing ? "Completing..." : "Mark complete"}
          </button>
        ) : null}
        {task.contact ? (
          <Link href={`/crm/contacts/${task.contactId}?tab=workspace`} className="crm-queue-detail-secondary-action">
            <ExternalLink size={13} />
            Open contact workspace
          </Link>
        ) : null}
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          className={cn(crm.btnDanger, "w-full justify-center gap-2")}
        >
          <Trash2 size={13} />
          {deleting ? "Deleting..." : "Delete task"}
        </button>
        {deleteError ? (
          <p className={cn(crm.bannerDanger, "rounded-2xl px-3 py-2 text-xs")} role="alert">
            {deleteError}
          </p>
        ) : null}
      </section>

      <section className="tasks-detail-section">
        <div className="mb-3 flex items-center gap-2">
          <span className="tasks-kpi-icon tasks-icon-neutral">
            <FileText className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-sm font-bold text-crm-text">Task Content</h3>
            <p className="text-xs text-crm-muted">Read view for the selected follow-up</p>
          </div>
        </div>
        <p className="rounded-[1rem] border border-crm-border/40 bg-crm-surface/70 p-3 text-sm leading-6 text-crm-text">
          {task.body?.trim() || "No notes have been added yet."}
        </p>
      </section>

      <section className="tasks-detail-section">
        <div className="mb-3 flex items-center gap-2">
          <span className="tasks-kpi-icon tasks-icon-scheduled">
            <UserRound className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-sm font-bold text-crm-text">Ownership</h3>
            <p className="text-xs text-crm-muted">Assignee and timeline context</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="tasks-detail-mini-card">
            <span className="tasks-owner-avatar">{initials(owner)}</span>
            <span className="min-w-0">
              <span className="block text-[10px] font-bold uppercase tracking-wide text-crm-muted">Owner</span>
              <span className="block truncate text-xs font-semibold text-crm-text">{owner}</span>
            </span>
          </div>
          <div className="tasks-detail-mini-card">
            <span className="tasks-owner-avatar">{initials(creator)}</span>
            <span className="min-w-0">
              <span className="block text-[10px] font-bold uppercase tracking-wide text-crm-muted">Created by</span>
              <span className="block truncate text-xs font-semibold text-crm-text">{creator}</span>
            </span>
          </div>
        </div>
        <div className="mt-2 flex flex-col gap-1.5">
          <StatRow dotClass="bg-crm-accent" label="Due" value={formatDateTime(task.dueAt)} />
          <StatRow dotClass="bg-crm-border" label="Created" value={formatDateTime(task.createdAt)} />
          {completedBy ? (
            <StatRow dotClass="bg-crm-success" label="Completed by" value={completedBy} valueClass="text-crm-success" />
          ) : null}
        </div>
      </section>

      {(task.status === "OPEN" || task.status === "IN_PROGRESS") && !task.dueAt ? (
        <section className="tasks-detail-section">
          <div className="flex items-start gap-2 rounded-[1rem] border border-crm-warning/35 bg-crm-warning/8 p-3 text-xs leading-5 text-crm-muted">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-crm-warning" />
            Add a due date when this task needs a specific follow-up window.
          </div>
        </section>
      ) : null}
    </PanelShell>
  );
}
