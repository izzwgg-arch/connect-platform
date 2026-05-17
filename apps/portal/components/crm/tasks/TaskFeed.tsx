"use client";

import { AlertCircle, Clock, ListChecks, CheckCircle2 } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { TaskCard, TaskDoneRow } from "./TaskCard";
import type { CrmTask } from "./TaskCard";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";

type Tab = "mine" | "today" | "overdue" | "all";

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({
  icon,
  label,
  count,
  urgency,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  urgency?: "danger" | "warning" | "neutral";
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 pb-2",
        urgency === "danger"
          ? "border-b border-crm-danger/25"
          : urgency === "warning"
            ? "border-b border-crm-warning/20"
            : "border-b border-crm-border/50",
      )}
    >
      <span
        className={cn(
          urgency === "danger"
            ? "text-crm-danger"
            : urgency === "warning"
              ? "text-crm-warning"
              : "text-crm-muted",
        )}
      >
        {icon}
      </span>
      <span
        className={cn(
          "text-xs font-bold uppercase tracking-wider",
          urgency === "danger"
            ? "text-crm-danger"
            : urgency === "warning"
              ? "text-crm-warning"
              : "text-crm-muted",
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          "ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums leading-none",
          urgency === "danger"
            ? "bg-crm-danger/15 text-crm-danger"
            : urgency === "warning"
              ? "bg-crm-warning/12 text-crm-warning"
              : "bg-crm-surface-2 text-crm-muted",
        )}
      >
        {count}
      </span>
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function TaskSection({
  icon,
  label,
  tasks,
  urgency,
  onComplete,
}: {
  icon: React.ReactNode;
  label: string;
  tasks: CrmTask[];
  urgency?: "danger" | "warning" | "neutral";
  onComplete: (t: CrmTask) => Promise<void>;
}) {
  if (tasks.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <SectionHeader icon={icon} label={label} count={tasks.length} urgency={urgency} />
      <div className="flex flex-col gap-1.5">
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} onComplete={onComplete} />
        ))}
      </div>
    </div>
  );
}

// ── Partition helpers ─────────────────────────────────────────────────────────

function partitionByUrgency(tasks: CrmTask[]) {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(todayStart.getDate() + 1);

  const overdue: CrmTask[] = [];
  const dueToday: CrmTask[] = [];
  const upcoming: CrmTask[] = [];
  const noDue: CrmTask[] = [];

  for (const t of tasks) {
    if (t.status === "DONE" || t.status === "CANCELED") continue;
    if (!t.dueAt) { noDue.push(t); continue; }
    const d = new Date(t.dueAt);
    if (d < todayStart) overdue.push(t);
    else if (d < tomorrowStart) dueToday.push(t);
    else upcoming.push(t);
  }

  return { overdue, dueToday, upcoming, noDue };
}

// ── TaskFeed ──────────────────────────────────────────────────────────────────

export function TaskFeed({
  tasks,
  loading,
  activeTab,
  onComplete,
}: {
  tasks: CrmTask[];
  loading: boolean;
  activeTab: Tab;
  onComplete: (t: CrmTask) => Promise<void>;
}) {
  if (loading) {
    return (
      <div className={cn(crm.card, "p-4")}>
        <LoadingSkeleton rows={5} />
      </div>
    );
  }

  const openTasks = tasks.filter((t) => t.status === "OPEN" || t.status === "IN_PROGRESS");
  const doneTasks = tasks.filter((t) => t.status === "DONE" || t.status === "CANCELED");

  if (openTasks.length === 0 && doneTasks.length === 0) {
    return null; // let parent render empty state
  }

  // For overdue and today tabs — flat list, already filtered by server
  if (activeTab === "overdue") {
    return (
      <div className="flex flex-col gap-1.5">
        {openTasks.map((t) => (
          <TaskCard key={t.id} task={t} onComplete={onComplete} />
        ))}
      </div>
    );
  }

  if (activeTab === "today") {
    return (
      <div className="flex flex-col gap-1.5">
        {openTasks.map((t) => (
          <TaskCard key={t.id} task={t} onComplete={onComplete} />
        ))}
      </div>
    );
  }

  // For "mine" and "all" — urgency partitioning
  const { overdue, dueToday, upcoming, noDue } = partitionByUrgency(openTasks);

  return (
    <div className="flex flex-col gap-5">
      {overdue.length > 0 && (
        <TaskSection
          icon={<AlertCircle className="h-3.5 w-3.5" />}
          label="Overdue"
          tasks={overdue}
          urgency="danger"
          onComplete={onComplete}
        />
      )}
      {dueToday.length > 0 && (
        <TaskSection
          icon={<Clock className="h-3.5 w-3.5" />}
          label="Due today"
          tasks={dueToday}
          urgency="warning"
          onComplete={onComplete}
        />
      )}
      {upcoming.length > 0 && (
        <TaskSection
          icon={<Clock className="h-3.5 w-3.5" />}
          label="Upcoming"
          tasks={upcoming}
          urgency="neutral"
          onComplete={onComplete}
        />
      )}
      {noDue.length > 0 && (
        <TaskSection
          icon={<ListChecks className="h-3.5 w-3.5" />}
          label="No due date"
          tasks={noDue}
          urgency="neutral"
          onComplete={onComplete}
        />
      )}

      {/* Completed section — only in "all" tab */}
      {activeTab === "all" && doneTasks.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionHeader
            icon={<CheckCircle2 className="h-3.5 w-3.5" />}
            label="Completed"
            count={doneTasks.length}
            urgency="neutral"
          />
          <div className={cn(crm.card, "px-4 py-2")}>
            {doneTasks.map((t) => (
              <TaskDoneRow key={t.id} task={t} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
