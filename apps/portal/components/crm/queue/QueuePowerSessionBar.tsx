"use client";

import {
  AlertCircle,
  CalendarClock,
  Megaphone,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  Zap,
  ZapOff,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { CampaignOption, QueueCounts, QueueFilter, SortMode } from "./queueTypes";

export function QueuePowerSessionBar({
  filter,
  counts,
  paused,
  sortMode,
  loading,
  acting,
  sipReady,
  campaignId,
  campaigns,
  total,
  onFilterChange,
  onToggleSort,
  onRefresh,
  onTogglePause,
  onStop,
}: {
  filter: QueueFilter;
  counts: QueueCounts;
  paused: boolean;
  sortMode: SortMode;
  loading: boolean;
  acting: boolean;
  sipReady: boolean;
  campaignId: string | null;
  campaigns: CampaignOption[];
  total: number;
  onFilterChange: (f: QueueFilter) => void;
  onToggleSort: () => void;
  onRefresh: () => void;
  onTogglePause: () => void;
  onStop: () => void;
}) {
  const campaignLabel = campaignId ? campaigns.find((c) => c.id === campaignId)?.name : null;
  const pool = counts.pending + counts.due + counts.overdue;
  const sessionProgress = pool > 0 ? Math.round((1 - total / pool) * 100) : 100;

  return (
    <div
      className={cn(
        "sticky top-0 z-30 -mx-3 sm:-mx-5 lg:-mx-7 2xl:-mx-8 rounded-none sm:rounded-crm-lg border-b sm:border border-crm-accent/35",
        "bg-gradient-to-r from-crm-accent/25 via-crm-surface-2 to-crm-bg/80 shadow-[0_8px_32px_rgba(0,0,0,0.45)] backdrop-blur-sm",
        paused && "from-crm-warning/15 border-crm-warning/30",
      )}
    >
      <div className="flex flex-col gap-3 px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full border border-crm-accent/50 bg-crm-accent/30 px-3 py-1 text-xs font-bold uppercase tracking-wider text-crm-accent shadow-[0_0_12px_rgba(99,102,241,0.25)]">
              <Zap className="h-4 w-4" />
              Power session
            </span>
            {paused ? (
              <span className="rounded-full border border-crm-warning/40 bg-crm-warning/20 px-2.5 py-0.5 text-xs font-bold uppercase text-crm-warning">
                Paused
              </span>
            ) : (
              <span className="text-xs text-crm-muted">
                Working mode · <span className="font-semibold tabular-nums text-crm-text">{total}</span> in view
              </span>
            )}
            {campaignLabel ? (
              <span className="inline-flex max-w-[200px] items-center gap-1 truncate text-xs text-crm-muted">
                <Megaphone className="h-3 w-3 shrink-0" />
                {campaignLabel}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              type="button"
              onClick={onToggleSort}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-crm border px-2.5 py-1.5 text-xs font-medium transition-colors",
                sortMode === "smart"
                  ? "border-crm-accent/50 bg-crm-accent/20 text-crm-accent"
                  : "border-crm-border bg-crm-surface text-crm-muted hover:bg-crm-surface-2",
              )}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {sortMode === "smart" ? "Smart" : "Original"}
            </button>
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading || acting}
              className={cn(crm.btnSecondary, "h-8 px-2.5 text-xs")}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              Refresh
            </button>
            <button type="button" onClick={onTogglePause} className={cn(crm.btnPrimary, "h-8 px-3 text-xs")}>
              {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
              {paused ? "Resume" : "Pause"}
            </button>
            <button
              type="button"
              onClick={onStop}
              className={cn(crm.btnGhost, "h-8 border border-crm-border px-2.5 text-xs")}
            >
              <ZapOff className="h-3.5 w-3.5" />
              End session
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex shrink-0 overflow-hidden rounded-crm border border-crm-border bg-crm-surface-2/80 text-xs shadow-crm">
            {(
              [
                { f: "pending" as QueueFilter, label: "Pending", count: counts.pending },
                { f: "due" as QueueFilter, label: "Due", count: counts.due },
                { f: "overdue" as QueueFilter, label: "Overdue", count: counts.overdue },
              ] as const
            ).map(({ f, label, count }) => (
              <button
                key={f}
                type="button"
                onClick={() => onFilterChange(f)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 font-medium transition-colors",
                  filter === f ? "bg-crm-accent/20 text-crm-accent" : "text-crm-muted hover:bg-crm-surface",
                )}
              >
                {label}
                {count > 0 ? (
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-[10px] tabular-nums",
                      f === "overdue"
                        ? "bg-crm-danger text-white"
                        : filter === f
                          ? "bg-crm-accent/30 text-crm-accent"
                          : "bg-crm-surface-2 text-crm-muted",
                    )}
                  >
                    {count}
                  </span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="min-w-[8rem] flex-1">
            <div className="mb-1 flex items-center justify-between text-[10px] text-crm-muted">
              <span>Session load</span>
              <span className="tabular-nums">{sessionProgress}% cleared in view</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-crm-border/80">
              <div
                className="h-full rounded-full bg-crm-accent transition-[width] duration-500"
                style={{ width: `${Math.min(100, sessionProgress)}%` }}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-crm-border/50 pt-2 text-[11px] text-crm-muted">
          <span className="inline-flex items-center gap-1">
            <CalendarClock className="h-3 w-3 opacity-80" />
            Upcoming <strong className="tabular-nums text-crm-text">{counts.upcoming}</strong>
          </span>
          {sortMode === "smart" && !paused ? (
            <span className="inline-flex items-center gap-1">
              <Sparkles className="h-3 w-3" />
              Smart priority
            </span>
          ) : null}
          {!sipReady ? (
            <span className="inline-flex items-center gap-1 text-crm-warning">
              <AlertCircle className="h-3 w-3 shrink-0" />
              SIP not registered
            </span>
          ) : null}
          {!paused && counts.overdue > 0 && filter === "pending" ? (
            <button
              type="button"
              onClick={() => onFilterChange("overdue")}
              className="font-medium text-crm-danger hover:underline"
            >
              {counts.overdue} overdue — switch view
            </button>
          ) : null}
          <span className="hidden text-crm-muted/70 lg:inline">
            Keys: <kbd className="rounded bg-crm-surface px-1 font-mono">C</kbd> call ·{" "}
            <kbd className="rounded bg-crm-surface px-1 font-mono">S</kbd> skip ·{" "}
            <kbd className="rounded bg-crm-surface px-1 font-mono">P</kbd> pause
          </span>
        </div>
      </div>
    </div>
  );
}
