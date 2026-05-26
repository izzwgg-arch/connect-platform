"use client";

import { useState } from "react";
import Link from "next/link";
import {
  CalendarClock,
  CheckCircle2,
  Circle,
  Clock,
  Mail,
  Phone,
  MoreVertical,
  ExternalLink,
  Building2,
  ClipboardList,
} from "lucide-react";
import { cn } from "../cn";

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
  assignedTo?: { id: string; displayName: string } | null;
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

// ── TaskCard ──────────────────────────────────────────────────────────────────

export function TaskCard({
  task,
  onComplete,
  onSmartAction,
}: {
  task: CrmTask;
  onComplete: (t: CrmTask) => Promise<void>;
  onSmartAction?: (t: CrmTask, action: "workspace" | "contact") => void;
}) {
  const [completing, setCompleting] = useState(false);
  const isDone = task.status === "DONE" || task.status === "CANCELED";
  const due = getTaskDueInfo(task.dueAt);
  const ownerName = task.assignedTo?.displayName ?? null;
  const contactHref = `/crm/contacts/${task.contactId}`;
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

  const handleComplete = async () => {
    if (isDone || completing) return;
    setCompleting(true);
    try { await onComplete(task); } finally { setCompleting(false); }
  };

  return (
    <div
      className={cn(
        "tasks-list-row group grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-3 px-4 py-3.5 transition-all md:grid-cols-[auto_auto_minmax(0,1fr)_auto_auto_auto_auto] md:items-center md:gap-4 md:px-5",
        isDone && "tasks-list-row-completed",
      )}
    >
      <button
        type="button"
        onClick={handleComplete}
        disabled={completing || isDone}
        title={isDone ? "Completed" : "Mark done"}
        className={cn(
          "mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors md:mt-0",
          isDone
            ? "border-crm-success/40 bg-crm-success/12 text-crm-success"
            : "border-crm-border bg-crm-surface text-transparent hover:border-crm-success/50 hover:bg-crm-success/10 hover:text-crm-success",
        )}
      >
        {isDone ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : completing ? (
          <Circle className="h-4 w-4 animate-pulse text-crm-muted" />
        ) : (
          <CheckCircle2 className="h-4 w-4" />
        )}
      </button>

      <div className={cn("hidden h-9 w-9 items-center justify-center rounded-crm md:flex", ICON_TONE[task.priority])}>
        {taskIcon(task)}
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <p className={cn("truncate text-sm font-semibold leading-snug text-crm-text", isDone && "text-crm-muted line-through")}>
            {task.title}
          </p>
          <span className="hidden shrink-0 text-[10px] font-semibold text-crm-muted sm:inline">
            {PRIORITY_LABEL[task.priority]}
          </span>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-crm-muted">
          {task.contact && (
            <Link
              href={contactHref}
              className="truncate font-medium text-crm-muted transition-colors hover:text-crm-accent"
            >
              {task.contact.displayName}
            </Link>
          )}
          {task.contact?.company && (
            <>
              <span className="text-crm-muted/45">•</span>
              <span className="inline-flex min-w-0 items-center gap-1 truncate">
                <Building2 className="h-3 w-3 shrink-0" />
                <span className="truncate">{task.contact.company}</span>
              </span>
            </>
          )}
          {task.body && !isDone && (
            <>
              <span className="hidden text-crm-muted/45 sm:inline">•</span>
              <span className="hidden max-w-[16rem] truncate sm:inline">{task.body}</span>
            </>
          )}
        </div>
      </div>

      <span className={cn("tasks-status-pill col-start-2 w-fit md:col-start-auto", statusClass)}>
        {statusLabel}
      </span>

      <div className="col-start-2 flex items-center gap-2 text-xs font-medium text-crm-muted md:col-start-auto md:min-w-[9.5rem]">
        <Clock className={cn("h-3.5 w-3.5", due?.cls)} />
        <span className={cn("tabular-nums", due?.cls)}>{due?.label ?? "No due date"}</span>
      </div>

      <div className="col-start-2 flex items-center gap-2 text-xs font-medium text-crm-muted md:col-start-auto md:min-w-[5.25rem]">
        <span className="tabular-nums">{due?.timeLabel ?? "Anytime"}</span>
      </div>

      <div className="col-start-2 flex items-center gap-2 md:col-start-auto">
        <span title={ownerName ?? "Unassigned"} className="tasks-owner-avatar">
          {initials(ownerName)}
        </span>
      </div>

      <div className="absolute right-3 top-3 md:static">
        {task.contact ? (
          <Link href={`${contactHref}?tab=workspace`} title="Open contact workspace" className="tasks-row-menu">
            <ExternalLink className="h-4 w-4 md:hidden" />
            <MoreVertical className="hidden h-4 w-4 md:block" />
          </Link>
        ) : (
          <span className="tasks-row-menu opacity-50">
            <MoreVertical className="h-4 w-4" />
          </span>
        )}
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
