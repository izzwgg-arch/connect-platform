"use client";

import { useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  Circle,
  Clock,
  User,
  Phone,
  MessageSquare,
  ExternalLink,
  Building2,
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
  assignedTo?: { id: string; displayName: string } | null;
  contact?: { id: string; displayName: string; company?: string | null };
};

// ── Due helpers ───────────────────────────────────────────────────────────────

function getDueInfo(dueAt: string | null | undefined): {
  label: string;
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
      label: daysAgo === 1 ? "Overdue · yesterday" : `Overdue · ${daysAgo}d ago`,
      cls: "text-crm-danger",
      urgent: true,
    };
  }
  if (d < tomorrowStart) {
    return { label: "Due today", cls: "text-crm-warning", urgent: true };
  }
  return {
    label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    cls: "text-crm-muted",
    urgent: false,
  };
}

const PRIORITY_RAIL: Record<TaskPriority, string> = {
  LOW: crm.taskRailLow,
  MEDIUM: crm.taskRailMedium,
  HIGH: crm.taskRailHigh,
  URGENT: crm.taskRailUrgent,
};

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  LOW: "Low",
  MEDIUM: "Med",
  HIGH: "High",
  URGENT: "Urgent",
};

const PRIORITY_BADGE: Record<TaskPriority, string> = {
  LOW: "border-crm-border/60 bg-crm-surface-2 text-crm-muted",
  MEDIUM: "border-crm-accent/30 bg-crm-accent/10 text-crm-accent",
  HIGH: "border-crm-warning/35 bg-crm-warning/10 text-crm-warning",
  URGENT: "border-crm-danger/40 bg-crm-danger/12 text-crm-danger",
};

// ── Dial helper ───────────────────────────────────────────────────────────────

function dispatchDial(phone: string) {
  window.dispatchEvent(new CustomEvent("crm:dial", { detail: { target: phone } }));
}

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
  const due = getDueInfo(task.dueAt);

  const handleComplete = async () => {
    if (isDone || completing) return;
    setCompleting(true);
    try { await onComplete(task); } finally { setCompleting(false); }
  };

  return (
    <div
      className={cn(
        "flex overflow-hidden rounded-crm-lg border transition-all",
        isDone
          ? "border-crm-border/40 bg-crm-surface/40 opacity-60"
          : due?.urgent
            ? "border-crm-border bg-crm-surface hover:border-crm-border/80"
            : "border-crm-border bg-crm-surface hover:border-crm-border/80",
      )}
    >
      {/* Priority rail */}
      <div className={PRIORITY_RAIL[task.priority]} />

      {/* Main content */}
      <div className="flex flex-1 min-w-0 flex-col gap-2 px-4 py-3">
        {/* Top row: complete toggle + title + priority badge */}
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={handleComplete}
            disabled={completing || isDone}
            title={isDone ? "Completed" : "Mark done"}
            className={cn(
              "mt-0.5 shrink-0 transition-colors",
              isDone
                ? "text-crm-success cursor-default"
                : "text-crm-muted hover:text-crm-success cursor-pointer",
            )}
          >
            {isDone ? (
              <CheckCircle2 className="h-4.5 w-4.5" />
            ) : completing ? (
              <Circle className="h-4.5 w-4.5 animate-pulse opacity-40" />
            ) : (
              <Circle className="h-4.5 w-4.5" />
            )}
          </button>

          <span
            className={cn(
              "flex-1 text-sm font-medium leading-snug",
              isDone ? "line-through text-crm-muted" : "text-crm-text",
            )}
          >
            {task.title}
          </span>

          <span
            className={cn(
              "shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide",
              PRIORITY_BADGE[task.priority],
            )}
          >
            {PRIORITY_LABEL[task.priority]}
          </span>
        </div>

        {/* Meta row: contact, company, due, owner */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {task.contact && (
            <Link
              href={`/crm/contacts/${task.contactId}`}
              className="flex items-center gap-1 text-xs text-crm-accent hover:underline"
            >
              {task.contact.displayName}
            </Link>
          )}
          {task.contact?.company && (
            <span className="flex items-center gap-1 text-xs text-crm-muted">
              <Building2 className="h-3 w-3" />
              {task.contact.company}
            </span>
          )}
          {due && (
            <span className={cn("flex items-center gap-1 text-xs", due.cls)}>
              <Clock className="h-3 w-3" />
              {due.label}
            </span>
          )}
          {task.assignedTo && (
            <span className="flex items-center gap-1 text-xs text-crm-muted">
              <User className="h-3 w-3" />
              {task.assignedTo.displayName}
            </span>
          )}
        </div>

        {/* Body preview */}
        {task.body && !isDone && (
          <p className="text-xs text-crm-muted line-clamp-1">{task.body}</p>
        )}
      </div>

      {/* Quick-action column */}
      {!isDone && (
        <div className="flex shrink-0 flex-col items-center justify-center gap-1 border-l border-crm-border/60 px-2 py-2">
          {task.contact && (
            <Link
              href={`/crm/contacts/${task.contactId}?tab=workspace`}
              title="Open workspace"
              className="rounded p-1.5 text-crm-muted hover:bg-crm-surface-2 hover:text-crm-text transition-colors"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          )}
          <Link
            href={`/crm/contacts/${task.contactId}`}
            title="Contact record"
            className="rounded p-1.5 text-crm-muted hover:bg-crm-surface-2 hover:text-crm-text transition-colors"
          >
            <User className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}
    </div>
  );
}

// ── Completed task row (compact) ──────────────────────────────────────────────

export function TaskDoneRow({ task }: { task: CrmTask }) {
  const completedDate = task.completedAt
    ? new Date(task.completedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className="flex items-center gap-3 py-2 border-b border-crm-border/40 last:border-0">
      <CheckCircle2 className="h-4 w-4 shrink-0 text-crm-success/70" />
      <span className="flex-1 truncate text-sm text-crm-muted line-through">{task.title}</span>
      {task.contact && (
        <Link
          href={`/crm/contacts/${task.contactId}`}
          className="text-xs text-crm-muted hover:text-crm-accent shrink-0"
        >
          {task.contact.displayName}
        </Link>
      )}
      {completedDate && (
        <span className="text-xs text-crm-muted/60 shrink-0 hidden sm:block">{completedDate}</span>
      )}
    </div>
  );
}
