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
  selectedTaskId,
  onSelect,
}: {
  tasks: CrmTask[];
  loading: boolean;
  activeTab: TaskTab;
  onComplete: (t: CrmTask) => Promise<void>;
  selectedTaskId?: string | null;
  onSelect: (t: CrmTask) => void;
}) {
  const label =
    activeTab === "today"
      ? "Due Today"
      : activeTab === "overdue"
        ? "Overdue"
        : activeTab === "completed"
          ? "Completed"
          : "Task Rows";

  if (loading) {
    return (
      <div className="crm-queue-list-panel tasks-list-card p-5">
        <LoadingSkeleton rows={5} />
      </div>
    );
  }

  if (tasks.length === 0) {
    return null; // let parent render empty state
  }

  return (
    <section className="checklist-collection-shell crm-queue-list-panel tasks-list-card">
      <div className="crm-queue-list-head">
        <div className="flex items-center gap-2">
          <ListChecks className="h-3.5 w-3.5 text-crm-muted" />
          <h2>{label}</h2>
        </div>
        <span className="text-[10px] font-semibold text-crm-muted tabular-nums">
          {tasks.length} shown
        </span>
      </div>
      <div className="crm-queue-row-list">
        {tasks.map((task, index) => (
          <TaskCard
            key={task.id}
            task={task}
            rank={index + 1}
            selected={selectedTaskId === task.id}
            onSelect={onSelect}
            onComplete={onComplete}
          />
        ))}
      </div>
    </section>
  );
}
