"use client";

import { TaskCard } from "./TaskCard";
import type { CrmTask } from "./TaskCard";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { crm } from "../crmClasses";
// ── TaskFeed ──────────────────────────────────────────────────────────────────

export function TaskFeed({
  tasks,
  loading,
  totalCount,
  onComplete,
  selectedTaskId,
  onSelect,
}: {
  tasks: CrmTask[];
  loading: boolean;
  totalCount: number;
  onComplete: (t: CrmTask) => Promise<void>;
  selectedTaskId?: string | null;
  onSelect: (t: CrmTask) => void;
}) {
  if (loading) {
    return (
      <div className="crm-queue-list-panel tasks-list-card p-5">
        <LoadingSkeleton rows={5} />
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <section className="checklist-collection-shell crm-queue-list-panel tasks-list-card">
        <div className="crm-queue-list-head">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-crm-muted">
            <input type="checkbox" readOnly checked={false} className={crm.checkbox} />
            <span>Select task</span>
          </label>
          <span className="text-[10px] font-semibold text-crm-muted tabular-nums">
            0 shown · {totalCount} total
          </span>
        </div>
        <div className="px-5 py-10 text-center text-sm text-crm-muted">
          No tasks match the current filters.
        </div>
      </section>
    );
  }
  return (
    <section className="checklist-collection-shell crm-queue-list-panel tasks-list-card">
      <div className="crm-queue-list-head">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-crm-muted">
          <input type="checkbox" readOnly checked={false} className={crm.checkbox} />
          <span>Select task</span>
        </label>
        <span className="text-[10px] font-semibold text-crm-muted tabular-nums">
          {tasks.length} shown · {totalCount} total
        </span>
      </div>
      <div className="crm-queue-row-list">        {tasks.map((task, index) => (
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
