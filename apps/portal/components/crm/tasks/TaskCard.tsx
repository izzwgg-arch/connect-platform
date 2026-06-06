"use client";

import { useState } from "react";
import Link from "next/link";
import {
  CalendarClock,
  CheckCircle2,
  Circle,
  Clock,
  ChevronRight,
  Mail,
  Phone,
  Building2,
  ClipboardList,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";

export type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
export type TaskStatus = "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELED";

export type CrmTask = {
  id: string;
  contactId: string;
  title: string;
  body?: string | null;
  dueAt?: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  completedAt?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  assignedTo?: { id: string; displayName: string } | null;
  createdBy?: { id: string; displayName: string } | null;
  completedBy?: { id: string; displayName: string } | null;
  contact?: { id: string; displayName: string; company?: string | null };
};

// ── Due helpers ───────────────────────────────────────────────────────────────

export function getTaskDueInfo(dueAt: string | null | undefined): {
  label: string;
  timeLabel: string;
  cls: string;
  urgent: boolean;
} | null {
  if (!dueAt) return null;
  const d = new Date(dueAt);
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(todayStart.getDate() + 1);

  if (d < todayStart) {
    const daysAgo = Math.ceil((todayStart.getTime() - d.getTime()) / 86_400_000);
    return {
      label: d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
      timeLabel: daysAgo === 1 ? "Overdue" : "Overdue",
      cls: "text-crm-danger",
      urgent: true,
    };
  }
  if (d < tomorrowStart) {
    return {
      label: d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
      timeLabel: d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
      cls: "text-crm-warning",
      urgent: true,
    };
  }
  return {
    label: d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    timeLabel: d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
    cls: "text-crm-muted",
    urgent: false,
  };
}

function initials(name: string | null | undefined) {
  if (!name) return "—";
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function taskIcon(task: CrmTask) {
  const text = `${task.title} ${task.body ?? ""}`.toLowerCase();
  if (text.includes("call") || text.includes("phone")) return <Phone className="h-4 w-4" />;
  if (text.includes("email") || text.includes("proposal") || text.includes("send")) return <Mail className="h-4 w-4" />;
  if (task.dueAt) return <CalendarClock className="h-4 w-4" />;
  return <ClipboardList className="h-4 w-4" />;
}

const ICON_TONE: Record<TaskPriority, string> = {
  LOW: "tasks-row-icon-neutral",
  MEDIUM: "tasks-row-icon-info",
  HIGH: "tasks-row-icon-warning",
  URGENT: "tasks-row-icon-danger",
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  LOW: "Low",
  MEDIUM: "Med",
  HIGH: "High",
  URGENT: "Urgent",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  OPEN: "Scheduled",
  IN_PROGRESS: "Due Today",
  DONE: "Completed",
  CANCELED: "Canceled",
};

const STATUS_CLASS: Record<TaskStatus, string> = {
  OPEN: "tasks-status-scheduled",
  IN_PROGRESS: "tasks-status-today",
  DONE: "tasks-status-completed",
  CANCELED: "tasks-status-muted",
};

export function getTaskTag(task: CrmTask): {
  label: string;
  className: string;
} {
  if (task.status === "DONE") {
    return { label: "Closed", className: "tasks-tag-success" };
  }
  if (task.status === "CANCELED") {
    return { label: "Paused", className: "tasks-tag-muted" };
  }
  if (task.priority === "URGENT") {
    return { label: "Critical", className: "tasks-tag-danger" };
  }
  if (task.priority === "HIGH") {
    return { label: "Hot lead", className: "tasks-tag-warning" };
  }
  if (task.priority === "MEDIUM") {
    return { label: "Follow-up", className: "tasks-tag-info" };
  }
  return { label: "Low touch", className: "tasks-tag-neutral" };
}

// ── TaskCard ──────────────────────────────────────────────────────────────────

export function TaskCard({
  task,
  rank,
  selected,
  onSelect,
  onComplete,
}: {
  task: CrmTask;
  rank: number;
  selected?: boolean;
  onSelect: (t: CrmTask) => void;
  onComplete: (t: CrmTask) => Promise<void>;
}) {
  const [completing, setCompleting] = useState(false);
  const isDone = task.status === "DONE" || task.status === "CANCELED";
  const due = getTaskDueInfo(task.dueAt);
  const ownerName = task.assignedTo?.displayName ?? null;
  const tag = getTaskTag(task);
  const statusLabel = isDone
    ? STATUS_LABEL[task.status]
    : due?.urgent && due.cls === "text-crm-danger"
      ? "Overdue"
      : due?.urgent
        ? "Due Today"
        : STATUS_LABEL[task.status];
  const statusClass = isDone
    ? STATUS_CLASS[task.status]
    : due?.urgent && due.cls === "text-crm-danger"
      ? "tasks-status-overdue"
      : due?.urgent
        ? "tasks-status-today"
        : STATUS_CLASS[task.status];

  const handleComplete = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (isDone || completing) return;
    setCompleting(true);
    try { await onComplete(task); } finally { setCompleting(false); }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(task)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(task);
        }
      }}
      className={cn(
        "crm-queue-row crm-checklist-row checklist-index-row task-index-row group",
        selected && "crm-queue-row-selected checklist-index-row-active tasks-list-row-active",
        isDone && "tasks-list-row-completed",
      )}
    >
      <div className="crm-queue-row-grid">
        <button
          type="button"
          onClick={handleComplete}
          disabled={completing || isDone}
          title={isDone ? "Completed" : "Mark done"}
          className={cn(
            "crm-contact-row-check flex items-center justify-center",
            isDone && "text-crm-success"
          )}
          aria-label={isDone ? "Completed" : `Mark ${task.title} complete`}
        >
          {isDone ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : completing ? (
            <Circle className="h-4 w-4 animate-pulse text-crm-muted" />
          ) : (
            <span className={crm.checkbox} aria-hidden />
          )}
        </button>
        <span className="crm-queue-row-rank tabular-nums">{rank}</span>

        <div className={cn("crm-queue-row-avatar checklist-row-avatar", ICON_TONE[task.priority])} aria-hidden>
          {taskIcon(task)}
        </div>

        <div className="crm-queue-row-main min-w-0">
          <div className="crm-queue-row-title-line">
            <span className={cn("crm-queue-row-name truncate", isDone && "text-crm-muted line-through")}>
              {task.title}
            </span>
            <span className={cn("tasks-status-pill", statusClass)}>
              {statusLabel}
            </span>
            <span className={cn("tasks-tag-chip", tag.className)}>
              <span className="tasks-tag-dot" aria-hidden />
              {tag.label}
            </span>
            <span className="crm-queue-pill crm-queue-pill-muted">
              {PRIORITY_LABEL[task.priority]}
            </span>
          </div>
          <p className="crm-queue-row-sub truncate">
            {task.contact?.displayName ?? "No contact"}
            {task.contact?.company ? ` · ${task.contact.company}` : ""}
            {task.body && !isDone ? ` · ${task.body}` : ""}
          </p>
        </div>

        <div className="crm-queue-row-phone hidden md:flex">
          <Clock className={cn("h-3.5 w-3.5 shrink-0", due?.cls)} />
          <span className={cn("truncate tabular-nums", due?.cls)}>
            {due?.label ?? "No due date"}
          </span>
        </div>

        <div className="crm-queue-row-email hidden lg:flex">
          <Building2 className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{task.contact?.company ?? task.contact?.displayName ?? "Contact"}</span>
        </div>

        <div className="crm-queue-row-meta hidden xl:flex">
          <span className="crm-queue-pill crm-queue-pill-muted inline-flex items-center gap-0.5">
            <Clock className="h-3 w-3" />
            {due?.timeLabel ?? "Anytime"}
          </span>
        </div>

        <span title={ownerName ?? "Unassigned"} className="tasks-owner-avatar shrink-0">
          {initials(ownerName)}
        </span>

        <ChevronRight className="crm-queue-row-chevron h-4 w-4 shrink-0" />
      </div>
    </div>
  );
}

// ── Completed task row (compact) ──────────────────────────────────────────────

export function TaskDoneRow({ task }: { task: CrmTask }) {
  const completedDate = task.completedAt
    ? new Date(task.completedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className="tasks-list-row tasks-list-row-completed flex items-center gap-3 px-4 py-3">
      <CheckCircle2 className="h-4 w-4 shrink-0 text-crm-success" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-crm-muted line-through">{task.title}</span>
      {task.contact && (
        <Link href={`/crm/contacts/${task.contactId}`} className="hidden shrink-0 text-xs text-crm-muted hover:text-crm-accent sm:block">
          {task.contact.displayName}
        </Link>
      )}
      {completedDate && <span className="hidden shrink-0 text-xs text-crm-muted/70 sm:block">{completedDate}</span>}
    </div>
  );
}
