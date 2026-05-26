"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, CalendarDays, Megaphone, Sparkles, Timer, TrendingUp, Zap } from "lucide-react";
import { CRMCard } from "../CRMCard";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { QueueCounts, QueueFilter, QueueOperationalStats } from "./queueTypes";

/** Right-column command context — no duplicate queue snapshot counts (those live in top pills only). */
export function QueueOverviewPanel({
  filter,
  total,
  stats,
  statsLoading,
  counts,
  campaignId,
  campaignName,
}: {
  filter: QueueFilter;
  total: number;
  stats: QueueOperationalStats | null;
  statsLoading: boolean;
  counts: QueueCounts;
  campaignId: string | null;
  campaignName: string | null;
}) {
  const next = pickNextAction(filter, total, counts);
  const completed = stats?.dispositionsToday ?? 0;
  const calls = stats?.callsLinkedToday ?? 0;
  const efficiency = calls > 0 ? Math.round((completed / calls) * 100) : 0;

  return (
    <>
      <CRMCard padding="md" className="crm-queue-rail-card crm-queue-rail-snapshot flex flex-col">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-crm-text">Today's Snapshot</p>
            <p className="mt-0.5 text-[11px] text-crm-muted">{filterLabel(filter)} · live view</p>
          </div>
          <span className="crm-queue-rail-icon crm-queue-rail-icon-blue">
            <CalendarDays className="h-4 w-4" />
          </span>
        </div>
        <div className="grid grid-cols-3 overflow-hidden rounded-crm border border-crm-border/70 bg-crm-surface-2/45">
          <SnapshotMetric label="Tasks" value={stats?.myOpen ?? 0} loading={statsLoading} />
          <SnapshotMetric label="Calls" value={calls} loading={statsLoading} />
          <SnapshotMetric label="Outcomes" value={completed} loading={statsLoading} />
          <SnapshotMetric label="Open Tabs" value={total} />
          <SnapshotMetric label="Completed" value={completed} loading={statsLoading} />
          <SnapshotMetric label="Efficiency" value={`${efficiency}%`} loading={statsLoading} />
        </div>
      </CRMCard>

      <CRMCard padding="md" className="crm-queue-rail-card crm-queue-session-card flex flex-col">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-crm-text">Session</p>
            <p className="mt-0.5 text-[11px] text-crm-muted">Power session readiness</p>
          </div>
          <span className="crm-queue-rail-icon crm-queue-rail-icon-violet">
            <Timer className="h-4 w-4" />
          </span>
        </div>
        <div className="rounded-crm border border-crm-border/70 bg-crm-surface-2/45 p-3">
          <div className="mb-3 flex items-center gap-2">
            <span className={cn(crm.statusDot, total > 0 ? "bg-crm-accent" : "bg-crm-muted/60")} />
            <div>
              <p className="text-xs font-bold text-crm-text">{total > 0 ? "Ready to focus" : "Power session inactive"}</p>
              <p className="text-[11px] leading-snug text-crm-muted">
                {total > 0 ? `${total} ${total === 1 ? "lead" : "leads"} available in this view.` : "Eliminate distractions and focus on your queue."}
              </p>
            </div>
          </div>
          {next ? (
            <Link href={next.href} className={cn(crm.btnPrimary, "w-full justify-center gap-2 text-xs")}>
              {next.icon}
              {next.cta}
              <ArrowRight className="ml-auto h-3.5 w-3.5 opacity-80" />
            </Link>
          ) : (
            <Link href="/crm/queue?mode=power" className={cn(crm.btnPrimary, "w-full justify-center gap-2 text-xs")}>
              <Zap className="h-3.5 w-3.5" />
              Start power session
            </Link>
          )}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {campaignId && campaignName ? (
            <Link href={`/crm/campaigns/${encodeURIComponent(campaignId)}`} className="crm-queue-mini-link">
              <Megaphone className="h-3.5 w-3.5" />
              <span className="truncate">{campaignName}</span>
            </Link>
          ) : stats && !statsLoading ? (
            <Link href="/crm/campaigns?status=ACTIVE" className="crm-queue-mini-link">
              <Megaphone className="h-3.5 w-3.5" />
              {stats.activeCampaigns} active
            </Link>
          ) : null}
          <Link href="/crm/dashboard" className="crm-queue-mini-link">
            <TrendingUp className="h-3.5 w-3.5" />
            Dashboard
          </Link>
        </div>
      </CRMCard>
    </>
  );
}

function SnapshotMetric({
  label,
  value,
  loading,
}: {
  label: string;
  value: number | string;
  loading?: boolean;
}) {
  return (
    <div className="border-r border-t border-crm-border/60 px-3 py-3 first:border-t-0 [&:nth-child(2)]:border-t-0 [&:nth-child(3)]:border-t-0 [&:nth-child(3n)]:border-r-0">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-crm-muted">{label}</p>
      <p className="mt-1 text-lg font-bold tabular-nums leading-none text-crm-text">{loading ? "-" : value}</p>
    </div>
  );
}

function filterLabel(filter: QueueFilter): string {
  switch (filter) {
    case "pending":
      return "pending snapshot";
    case "due":
      return "due today";
    case "overdue":
      return "overdue";
    case "upcoming":
      return "upcoming";
  }
}

function pickNextAction(filter: QueueFilter, total: number, counts: QueueCounts) {
  if (counts.overdue > 0 && filter !== "overdue") {
    return {
      hint: "Overdue callbacks should be worked before fresh pending leads.",
      href: "/crm/queue?filter=overdue",
      cta: "Focus overdue",
      icon: <AlertTriangle className="h-3.5 w-3.5 shrink-0" />,
    };
  }
  if (counts.due > 0 && filter !== "due") {
    return {
      hint: "Callbacks due today are waiting in the due snapshot.",
      href: "/crm/queue?filter=due",
      cta: "View due today",
      icon: <Sparkles className="h-3.5 w-3.5 shrink-0" />,
    };
  }
  if (total > 0 && filter === "pending") {
    return {
      hint: "Power session walks the list with outcomes on this page.",
      href: "/crm/queue?mode=power",
      cta: "Start power session",
      icon: <Zap className="h-3.5 w-3.5 shrink-0" />,
    };
  }
  if (total === 0 && filter !== "pending") {
    return {
      hint: "Pending may still have assigned leads.",
      href: "/crm/queue?filter=pending",
      cta: "View pending",
      icon: <Sparkles className="h-3.5 w-3.5 shrink-0" />,
    };
  }
  return null;
}

