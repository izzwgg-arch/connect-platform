"use client";

import { ListChecks } from "lucide-react";
import { cn } from "../cn";
import { TaskCard } from "./TaskCard";
import type { CrmTask } from "./TaskCard";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import type { TaskTab } from "./TaskKpiStrip";

// ── TaskFeed ──────────────────────────────────────────────────────────────────

export function TaskFeed({
  tasks,
  loading,
  activeTab,
  onComplete,
}: {
  tasks: CrmTask[];
  loading: boolean;
  activeTab: TaskTab;
  onComplete: (t: CrmTask) => Promise<void>;
}) {
  const label =
    activeTab === "today"
      ? "Due Today"
      : activeTab === "overdue"
        ? "Overdue"
        : activeTab === "completed"
          ? "Completed"
          : "Tasks";

  if (loading) {
    return (
      <div className="tasks-list-card p-5">
        <LoadingSkeleton rows={5} />
      </div>
    );
  }

  if (tasks.length === 0) {
    return null; // let parent render empty state
  }

  return (
    <section className="tasks-list-card overflow-hidden">
      <div className="tasks-list-card-header flex items-center justify-between gap-3 px-4 py-4 sm:px-5">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-crm-muted" />
          <h2 className="text-xs font-bold uppercase tracking-[0.14em] text-crm-text">
            {label} ({tasks.length})
          </h2>
        </div>
      </div>
      <div className="hidden border-b border-crm-border/55 px-5 py-2.5 text-[10px] font-bold uppercase tracking-[0.14em] text-crm-muted md:grid md:grid-cols-[auto_auto_minmax(0,1fr)_auto_auto_auto_auto] md:items-center md:gap-4">
        <span className="w-5" />
        <span className="w-9" />
        <span>Task</span>
        <span>Status</span>
        <span className="min-w-[9.5rem]">Due Date</span>
        <span className="min-w-[5.25rem]">Time</span>
        <span>Owner</span>
      </div>
      <div className="divide-y divide-crm-border/55">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} onComplete={onComplete} />
        ))}
      </div>
    </section>
  );
}
