"use client";

import Link from "next/link";
import {
  ArrowRight,
  CalendarDays,
  ChevronRight,
  Clock,
  FileText,
  ListPlus,
  Plus,
  Search,
} from "lucide-react";
import { cn } from "../cn";
import type { TaskStats } from "./TaskKpiStrip";
import type { CrmTask } from "./TaskCard";
import { getTaskDueInfo } from "./TaskCard";

// ── Sub-components ────────────────────────────────────────────────────────────

function SidebarCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("tasks-sidebar-card", className)}>
      {children}
    </section>
  );
}

function SidebarHeader({
  title,
  action,
}: {
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-crm-text">{title}</h3>
      {action}
    </div>
  );
}

function LegendRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "danger" | "warning" | "scheduled" | "success";
}) {
  const dotClass =
    tone === "danger"
      ? "bg-crm-danger"
      : tone === "warning"
        ? "bg-crm-warning"
        : tone === "success"
          ? "bg-crm-success"
          : "bg-crm-accent";
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="flex items-center gap-2 text-crm-muted">
        <span className={cn("h-2 w-2 rounded-full", dotClass)} />
        {label}
      </span>
      <span className="font-semibold tabular-nums text-crm-text">{value}</span>
    </div>
  );
}

// ── TaskSidebar ───────────────────────────────────────────────────────────────

export function TaskSidebar({
  stats,
  statsLoading,
  upcomingTasks,
  onCreateTask,
}: {
  stats: TaskStats | null;
  statsLoading: boolean;
  upcomingTasks: CrmTask[];
  onCreateTask: () => void;
}) {
  const overdue = stats?.overdue ?? 0;
  const dueToday = stats?.dueToday ?? 0;
  const scheduled = stats?.scheduled ?? 0;
  const completed = stats?.completed ?? 0;
  const total = Math.max(stats?.allTasks ?? 0, 0);
  const completePct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const donutStyle = {
    background: `conic-gradient(var(--crm-success) 0 ${completePct}%, var(--crm-danger) ${completePct}% ${completePct + (total ? Math.round((overdue / total) * 100) : 0)}%, var(--crm-warning) 0 ${completePct + (total ? Math.round(((overdue + dueToday) / total) * 100) : 0)}%, var(--crm-accent) 0 100%)`,
  };

  return (
    <div className="flex flex-col gap-4">
      <SidebarCard>
        <SidebarHeader title="Upcoming Tasks" />
        {upcomingTasks.length > 0 ? (
          <div className="flex flex-col gap-3">
            {upcomingTasks.slice(0, 3).map((task) => {
              const due = getTaskDueInfo(task.dueAt);
              return (
                <Link key={task.id} href={`/crm/contacts/${task.contactId}`} className="tasks-upcoming-row">
                  <span className={cn("tasks-upcoming-icon", task.priority === "URGENT" || task.priority === "HIGH" ? "text-crm-warning" : "text-crm-accent")}>
                    <Clock className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-crm-text">{task.title}</span>
                    <span className="block truncate text-xs text-crm-muted">
                      {task.contact?.displayName ?? "Contact"} · {due?.timeLabel ?? "Anytime"}
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="rounded-crm border border-dashed border-crm-border px-4 py-5 text-center">
            <CalendarDays className="mx-auto mb-2 h-7 w-7 text-crm-muted" />
            <p className="text-sm font-semibold text-crm-text">No upcoming tasks</p>
            <p className="mt-1 text-xs leading-5 text-crm-muted">Scheduled follow-ups will appear here.</p>
          </div>
        )}
      </SidebarCard>

      <SidebarCard>
        <SidebarHeader title="Task Summary" />
        {statsLoading ? (
          <div className="h-36 animate-pulse rounded-crm bg-crm-surface-2" />
        ) : (
          <div className="flex items-center gap-5">
            <div className="tasks-summary-donut" style={donutStyle}>
              <div className="tasks-summary-donut-inner">
                <span className="text-2xl font-semibold tabular-nums text-crm-text">{total}</span>
                <span className="text-[10px] font-medium text-crm-muted">Total Tasks</span>
              </div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2.5">
              <LegendRow label="Overdue" value={overdue} tone="danger" />
              <LegendRow label="Due Today" value={dueToday} tone="warning" />
              <LegendRow label="Scheduled" value={scheduled} tone="scheduled" />
              <LegendRow label="Completed" value={completed} tone="success" />
            </div>
          </div>
        )}
        <Link href="/crm/reports" className="tasks-sidebar-link mt-4 justify-center">
          View full report
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </SidebarCard>

      <SidebarCard>
        <SidebarHeader title="Quick Actions" />
        <div className="flex flex-col divide-y divide-crm-border/55">
          <button type="button" onClick={onCreateTask} className="tasks-quick-action">
            <Plus className="h-4 w-4" />
            <span>Create New Task</span>
            <ChevronRight className="ml-auto h-4 w-4" />
          </button>
          <button type="button" onClick={onCreateTask} className="tasks-quick-action">
            <ListPlus className="h-4 w-4" />
            <span>Schedule Follow-up</span>
            <ChevronRight className="ml-auto h-4 w-4" />
          </button>
          <Link href="/crm/contacts" className="tasks-quick-action">
            <Search className="h-4 w-4" />
            <span>Add from Contact</span>
            <ChevronRight className="ml-auto h-4 w-4" />
          </Link>
          <span className="tasks-quick-action tasks-quick-action-disabled" aria-disabled="true">
            <FileText className="h-4 w-4" />
            <span>Task Templates</span>
            <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide">No route</span>
          </span>
        </div>
      </SidebarCard>
    </div>
  );
}
