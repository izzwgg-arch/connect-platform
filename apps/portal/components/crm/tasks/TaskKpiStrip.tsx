"use client";

import { AlertCircle, CalendarClock, CheckCircle2, Clock, Filter, ListChecks, SortAsc } from "lucide-react";
import { cn } from "../cn";

export type TaskStats = {
  myOpen: number;
  dueToday: number;
  overdue: number;
  myTasksOverdue: number;
  myTasksDueToday: number;
  scheduled?: number;
  allTasks?: number;
  completed?: number;
};

export type TaskTab = "all" | "today" | "overdue" | "completed";

export function TaskKpiStrip({
  stats,
  loading,
  activeTab,
  onTabChange,
}: {
  stats: TaskStats | null;
  loading: boolean;
  activeTab: TaskTab;
  onTabChange: (tab: TaskTab) => void;
}) {
  const tiles: Array<{
    id: TaskTab | "scheduled";
    label: string;
    value: number | null;
    icon: React.ReactNode;
    tone: "danger" | "warning" | "scheduled" | "neutral" | "success";
    clickable?: boolean;
  }> = [
    {
      id: "overdue",
      label: "Overdue",
      value: stats?.overdue ?? null,
      icon: <AlertCircle className="h-5 w-5" />,
      tone: "danger",
      clickable: true,
    },
    {
      id: "today",
      label: "Due Today",
      value: stats?.dueToday ?? null,
      icon: <Clock className="h-5 w-5" />,
      tone: "warning",
      clickable: true,
    },
    {
      id: "scheduled",
      label: "Scheduled",
      value: stats?.scheduled ?? null,
      icon: <CalendarClock className="h-5 w-5" />,
      tone: "scheduled",
    },
    {
      id: "all",
      label: "All Tasks",
      value: stats?.allTasks ?? null,
      icon: <ListChecks className="h-5 w-5" />,
      tone: "neutral",
      clickable: true,
    },
    {
      id: "completed",
      label: "Completed",
      value: stats?.completed ?? null,
      icon: <CheckCircle2 className="h-5 w-5" />,
      tone: "success",
      clickable: true,
    },
  ];

  return (
    <div className="tasks-kpi-grid grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {tiles.map((tile) => {
        const isActive = activeTab === tile.id;
        const valueClass =
          tile.tone === "danger"
            ? "text-crm-danger"
            : tile.tone === "warning"
              ? "text-crm-warning"
              : tile.tone === "success"
                ? "text-crm-success"
                : "text-crm-text";
        const iconClass =
          tile.tone === "danger"
            ? "tasks-icon-danger"
            : tile.tone === "warning"
              ? "tasks-icon-warning"
              : tile.tone === "success"
                ? "tasks-icon-success"
                : tile.tone === "scheduled"
                  ? "tasks-icon-scheduled"
                  : "tasks-icon-neutral";
        const content = (
          <>
            <div className="flex min-w-0 flex-col gap-2">
              <span className="text-[11px] font-semibold leading-none text-crm-muted">{tile.label}</span>
              {loading || tile.value === null ? (
                <span className="mt-1 h-7 w-12 animate-pulse rounded bg-crm-surface-2" />
              ) : (
                <span className={cn("text-3xl font-semibold leading-none tracking-tight tabular-nums", valueClass)}>
                  {tile.value}
                </span>
              )}
            </div>
            <span className={cn("tasks-kpi-icon", iconClass)}>{tile.icon}</span>
          </>
        );

        if (!tile.clickable) {
          return (
            <div key={tile.id} className="tasks-kpi-card">
              {content}
            </div>
          );
        }

        return (
          <button
            key={tile.id}
            type="button"
            onClick={() => onTabChange(tile.id as TaskTab)}
            className={cn(
              "tasks-kpi-card cursor-pointer text-left",
              isActive && "tasks-kpi-card-active",
            )}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}

/** Mockup-style filter bar with real tab/filter behavior. */
export function TaskTabRow({
  activeTab,
  onTabChange,
  stats,
  total,
  loading,
  assignedToMe,
  onAssignedToMeChange,
}: {
  activeTab: TaskTab;
  onTabChange: (tab: TaskTab) => void;
  stats: TaskStats | null;
  total: number;
  loading: boolean;
  assignedToMe: boolean;
  onAssignedToMeChange: (next: boolean) => void;
}) {
  const tabs: Array<{
    id: TaskTab;
    label: string;
    count?: number;
    urgent?: boolean;
  }> = [
    { id: "all", label: "All Tasks", count: stats?.allTasks },
    {
      id: "today",
      label: "Due Today",
      count: stats?.dueToday,
      urgent: (stats?.dueToday ?? 0) > 0,
    },
    {
      id: "overdue",
      label: "Overdue",
      count: stats?.overdue,
      urgent: (stats?.overdue ?? 0) > 0,
    },
    { id: "completed", label: "Completed", count: stats?.completed },
  ];

  return (
    <div className="tasks-filter-bar flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          const isUrgent = !isActive && tab.urgent;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              className={cn("tasks-filter-pill", isActive && "tasks-filter-pill-active", isUrgent && "tasks-filter-pill-urgent")}
            >
              {tab.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => onAssignedToMeChange(!assignedToMe)}
          className={cn("tasks-filter-icon-button", assignedToMe && "tasks-filter-icon-button-active")}
          title={assignedToMe ? "Showing tasks assigned to me" : "Filter to tasks assigned to me"}
        >
          <Filter className="h-4 w-4" />
          <span className="sr-only">Assigned to me filter</span>
        </button>
      </div>
      <div className="flex items-center justify-between gap-3 sm:justify-end">
        <span className="text-xs font-medium text-crm-muted tabular-nums">
          {loading ? "Loading tasks..." : `${total} shown`}
        </span>
        <div className="tasks-sort-pill" aria-label="Sorted by due date">
          <SortAsc className="h-3.5 w-3.5" />
          <span>Sort: Due Date</span>
        </div>
      </div>
    </div>
  );
}
