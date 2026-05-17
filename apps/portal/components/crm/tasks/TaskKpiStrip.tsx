"use client";

import Link from "next/link";
import { AlertCircle, CheckCircle2, Clock, User } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";

export type TaskStats = {
  myOpen: number;
  dueToday: number;
  overdue: number;
  myTasksOverdue: number;
  myTasksDueToday: number;
};

type Tab = "mine" | "today" | "overdue" | "all";

export function TaskKpiStrip({
  stats,
  loading,
  activeTab,
  onTabChange,
}: {
  stats: TaskStats | null;
  loading: boolean;
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}) {
  const tiles: Array<{
    id: Tab;
    label: string;
    value: number | null;
    icon: React.ReactNode;
    tileClass: string;
    valueClass: string;
    href?: string;
  }> = [
    {
      id: "overdue",
      label: "Overdue",
      value: stats?.overdue ?? null,
      icon: <AlertCircle className="h-4 w-4" />,
      tileClass: crm.taskKpiTileDanger,
      valueClass: (stats?.overdue ?? 0) > 0 ? "text-crm-danger" : "text-crm-text",
    },
    {
      id: "today",
      label: "Due today",
      value: stats?.dueToday ?? null,
      icon: <Clock className="h-4 w-4" />,
      tileClass: (stats?.dueToday ?? 0) > 0 ? crm.taskKpiTileWarning : "",
      valueClass: (stats?.dueToday ?? 0) > 0 ? "text-crm-warning" : "text-crm-text",
    },
    {
      id: "mine",
      label: "Assigned to me",
      value: stats?.myOpen ?? null,
      icon: <User className="h-4 w-4" />,
      tileClass: "",
      valueClass: "text-crm-text",
    },
    {
      id: "all",
      label: "All open",
      value: null,
      icon: <CheckCircle2 className="h-4 w-4" />,
      tileClass: "",
      valueClass: "text-crm-muted",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {tiles.map((tile) => {
        const isActive = activeTab === tile.id;
        return (
          <button
            key={tile.id}
            type="button"
            onClick={() => onTabChange(tile.id)}
            className={cn(
              crm.taskKpiTile,
              tile.tileClass,
              isActive &&
                "ring-2 ring-crm-accent/40 border-crm-accent/40 bg-crm-surface-2/70",
              "cursor-pointer text-left",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-wider text-crm-muted">
                {tile.label}
              </span>
              <span className={cn("opacity-60", tile.valueClass)}>{tile.icon}</span>
            </div>
            {loading ? (
              <div className="mt-1 h-7 w-10 animate-pulse rounded bg-crm-surface-2" />
            ) : tile.value !== null ? (
              <span className={cn("mt-1 text-2xl font-bold tabular-nums leading-none", tile.valueClass)}>
                {tile.value}
              </span>
            ) : (
              <span className="mt-1 text-2xl font-bold tabular-nums leading-none text-crm-muted opacity-50">
                —
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Compact tab row with urgency counts */
export function TaskTabRow({
  activeTab,
  onTabChange,
  stats,
  total,
  loading,
}: {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  stats: TaskStats | null;
  total: number;
  loading: boolean;
}) {
  const tabs: Array<{
    id: Tab;
    label: string;
    count?: number;
    urgent?: boolean;
  }> = [
    {
      id: "mine",
      label: "My tasks",
      count: stats?.myOpen,
      urgent: (stats?.myTasksOverdue ?? 0) > 0,
    },
    {
      id: "today",
      label: "Due today",
      count: stats?.dueToday,
      urgent: (stats?.dueToday ?? 0) > 0,
    },
    {
      id: "overdue",
      label: "Overdue",
      count: stats?.overdue,
      urgent: (stats?.overdue ?? 0) > 0,
    },
    { id: "all", label: "All" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        const isUrgent = !isActive && tab.urgent;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            className={cn(
              isActive
                ? crm.taskTabPillActive
                : isUrgent
                  ? crm.taskTabPillDanger
                  : crm.taskTabPill,
            )}
          >
            {tab.label}
            {tab.count !== undefined && !loading && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums leading-none",
                  isActive
                    ? "bg-crm-accent/20 text-crm-accent"
                    : isUrgent
                      ? "bg-crm-danger/20 text-crm-danger"
                      : "bg-crm-surface-2 text-crm-muted",
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
      <span className="ml-auto text-xs text-crm-muted tabular-nums">
        {loading ? "…" : `${total} task${total !== 1 ? "s" : ""}`}
      </span>
    </div>
  );
}
