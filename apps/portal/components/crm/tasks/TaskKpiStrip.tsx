"use client";

import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Filter,
  ListChecks,
  Search,
  SortAsc,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ConnectSelect } from "../../ConnectSelect";
import { cn } from "../cn";
import { crm } from "../crmClasses";

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
export type TaskSortMode = "due" | "created" | "priority" | "title";

const STATUS_TABS: { id: TaskTab; label: string }[] = [
  { id: "all", label: "All Tasks" },
  { id: "today", label: "Due Today" },
  { id: "overdue", label: "Overdue" },
  { id: "completed", label: "Completed" },
];

function KpiTile({
  label,
  value,
  hint,
  icon: Icon,
  tone,
  loading,
}: {
  label: string;
  value: number | null;
  hint: string;
  icon: LucideIcon;
  tone: "blue" | "green" | "violet" | "amber" | "rose" | "cyan";
  loading?: boolean;
}) {
  return (
    <div className={cn(crm.queueCountPill, `crm-queue-kpi-${tone}`, "relative overflow-hidden bg-crm-surface-2")}>
      <span className="flex w-full items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="crm-queue-kpi-label block text-[10px] font-bold uppercase tracking-wide text-crm-muted">
            {label}
          </span>
          {loading || value === null ? (
            <span className="crm-queue-kpi-value mt-1 block h-7 w-12 animate-pulse rounded bg-crm-surface-2" />
          ) : (
            <span className="crm-queue-kpi-value mt-1 block text-2xl font-bold tabular-nums leading-none tracking-tight text-crm-text">
              {value}
            </span>
          )}
        </span>
        <span className="crm-queue-kpi-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface/70 text-crm-accent">
          <Icon className="h-4 w-4" />
        </span>
      </span>
      <span className="crm-queue-kpi-micro text-[10px] font-medium text-crm-muted">{hint}</span>
    </div>
  );
}

export function TaskKpiStrip({
  stats,
  loading,
}: {
  stats: TaskStats | null;
  loading: boolean;
}) {
  return (
    <section
      className="crm-queue-kpi-strip grid w-full grid-cols-2 items-stretch gap-3 md:grid-cols-4 xl:grid-cols-4"
      aria-label="Task metrics"
    >
      <KpiTile
        label="Active"
        value={stats?.myOpen ?? null}
        hint={`${stats?.dueToday ?? 0} due today`}
        icon={ListChecks}
        tone="green"
        loading={loading}
      />
      <KpiTile
        label="Due Today"
        value={stats?.dueToday ?? null}
        hint="Needs follow-up"
        icon={Clock}
        tone="amber"
        loading={loading}
      />
      <KpiTile
        label="Overdue"
        value={stats?.overdue ?? null}
        hint="Past due"
        icon={AlertCircle}
        tone="rose"
        loading={loading}
      />
      <KpiTile
        label="Completed"
        value={stats?.completed ?? null}
        hint="Finished tasks"
        icon={CheckCircle2}
        tone="blue"
        loading={loading}
      />
    </section>
  );
}

export function TaskFilterBar({
  activeTab,
  onTabChange,
  search,
  onSearchChange,
  sortMode,
  onSortModeChange,
  shownCount,
  assignedToMe,
  onAssignedToMeChange,
}: {
  activeTab: TaskTab;
  onTabChange: (tab: TaskTab) => void;
  search: string;
  onSearchChange: (value: string) => void;
  sortMode: TaskSortMode;
  onSortModeChange: (mode: TaskSortMode) => void;
  shownCount: number;
  assignedToMe: boolean;
  onAssignedToMeChange: (next: boolean) => void;
}) {
  return (
    <div className="crm-queue-filter-bar tasks-filter-bar">
      <div className="crm-queue-filter-grid tasks-filter-grid">
        <div className="crm-queue-filter-field crm-queue-filter-field-search">
          <Search className="crm-queue-filter-icon h-4 w-4 shrink-0 text-crm-muted" />
          <input
            id="crm-tasks-search"
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Title, contact, notes..."
            className="crm-queue-filter-control min-w-[10rem] flex-1"
            aria-label="Search tasks"
          />
          <button
            type="button"
            onClick={() => onAssignedToMeChange(!assignedToMe)}
            className={cn(
              "tasks-filter-icon-button shrink-0",
              assignedToMe && "tasks-filter-icon-button-active",
            )}
            title={assignedToMe ? "Showing tasks assigned to me" : "Filter to tasks assigned to me"}
          >
            <Filter className="h-4 w-4" />
            <span className="sr-only">Assigned to me filter</span>
          </button>
          {search ? (
            <button
              type="button"
              onClick={() => onSearchChange("")}
              className="text-xs font-medium text-crm-accent hover:underline"
            >
              Clear
            </button>
          ) : null}
        </div>

        <div className="crm-queue-filter-field">
          <label htmlFor="crm-tasks-status" className="sr-only">
            Status
          </label>
          <ConnectSelect
            id="crm-tasks-status"
            value={activeTab}
            onChange={(value) => onTabChange(value as TaskTab)}
            options={STATUS_TABS.map((tab) => ({ value: tab.id, label: tab.label }))}
            className="min-w-[10rem] flex-1"
            size="sm"
          />
        </div>

        <div className="crm-queue-filter-field">
          <SortAsc className="h-4 w-4 shrink-0 text-crm-muted" />
          <label htmlFor="crm-tasks-sort" className="sr-only">
            Sort
          </label>
          <ConnectSelect
            id="crm-tasks-sort"
            value={sortMode}
            onChange={(value) => onSortModeChange(value as TaskSortMode)}
            options={[
              { value: "due", label: "Due date" },
              { value: "created", label: "Created" },
              { value: "priority", label: "Priority" },
              { value: "title", label: "Title" },
            ]}
            className="min-w-[10rem] flex-1"
            size="sm"
          />
        </div>

        <div className="crm-queue-filter-field tasks-filter-count">
          <span
            className="crm-queue-filter-control tasks-filter-count-value"
            aria-label={`${shownCount} tasks shown`}
          >
            {shownCount}
          </span>
        </div>
      </div>
    </div>
  );
}

/** @deprecated Use TaskFilterBar */
export const TaskTabRow = TaskFilterBar;
