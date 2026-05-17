"use client";

import Link from "next/link";
import { Activity, ListOrdered, TrendingUp } from "lucide-react";
import { CRMCard } from "../CRMCard";
import { CRMSection } from "../CRMSection";
import { CRMHorizontalBars } from "../charts/CRMHorizontalBars";
import { CRM_CHART_COLORS } from "../charts/chartColors";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { QueueCounts, QueueFilter, QueueOperationalStats } from "./queueTypes";

export function QueueOverviewPanel({
  counts,
  filter,
  total,
  stats,
  statsLoading,
  campaignId,
  campaignName,
  onFilterChange,
}: {
  counts: QueueCounts;
  filter: QueueFilter;
  total: number;
  stats: QueueOperationalStats | null;
  statsLoading: boolean;
  campaignId: string | null;
  campaignName: string | null;
  onFilterChange: (f: QueueFilter) => void;
}) {
  const queuePressure = counts.pending + counts.overdue;
  const callbackLoad = counts.due + counts.overdue;

  const pressureItems = [
    { label: "Pending", value: counts.pending, color: CRM_CHART_COLORS.accent },
    { label: "Due today", value: counts.due, color: CRM_CHART_COLORS.warning },
    { label: "Overdue", value: counts.overdue, color: CRM_CHART_COLORS.danger },
    { label: "Upcoming", value: counts.upcoming, color: CRM_CHART_COLORS.muted },
  ];

  const todayItems = stats
    ? [
        { label: "Dispositions", value: stats.dispositionsToday, color: CRM_CHART_COLORS.success },
        { label: "Calls linked", value: stats.callsLinkedToday, color: CRM_CHART_COLORS.accent },
        {
          label: "Open tasks",
          value: stats.myOpen,
          color: CRM_CHART_COLORS.warning,
        },
      ]
    : [];

  return (
    <CRMCard padding="md" className="flex flex-col gap-4 h-full">
      <div>
        <p className={crm.label}>Operational overview</p>
        <p className="mt-1 text-sm font-semibold text-crm-text tabular-nums">
          {total} in view
          {campaignName ? (
            <span className="font-normal text-crm-muted"> · {campaignName}</span>
          ) : null}
        </p>
      </div>

      <CRMSection title="Queue pressure">
        <CRMHorizontalBars items={pressureItems} />
        {queuePressure > 0 && filter === "pending" && counts.overdue > 0 ? (
          <button
            type="button"
            onClick={() => onFilterChange("overdue")}
            className="mt-2 text-xs font-semibold text-crm-danger hover:underline"
          >
            {counts.overdue} overdue — focus overdue
          </button>
        ) : null}
      </CRMSection>

      <CRMSection title="Callback load">
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => onFilterChange("due")}
            className={cn(
              "rounded-crm border px-3 py-2 text-left transition-colors",
              filter === "due"
                ? "border-crm-warning/40 bg-crm-warning/10"
                : "border-crm-border bg-crm-bg/60 hover:bg-crm-surface-2",
            )}
          >
            <span className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">Due</span>
            <p className="text-xl font-bold tabular-nums text-crm-warning">{counts.due}</p>
          </button>
          <button
            type="button"
            onClick={() => onFilterChange("overdue")}
            className={cn(
              "rounded-crm border px-3 py-2 text-left transition-colors",
              filter === "overdue"
                ? "border-crm-danger/40 bg-crm-danger/10"
                : "border-crm-border bg-crm-bg/60 hover:bg-crm-surface-2",
            )}
          >
            <span className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">Overdue</span>
            <p className="text-xl font-bold tabular-nums text-crm-danger">{counts.overdue}</p>
          </button>
        </div>
        <p className={crm.footnote}>{callbackLoad} callbacks need attention today</p>
      </CRMSection>

      <CRMSection title="Today">
        {statsLoading ? (
          <p className={crm.muted}>Loading activity…</p>
        ) : stats ? (
          <>
            <CRMHorizontalBars items={todayItems} maxValue={Math.max(1, stats.dispositionsToday, stats.callsLinkedToday, stats.myOpen)} />
            <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-crm border border-crm-border/80 bg-crm-bg/50 px-2 py-1.5">
                <dt className="text-crm-muted flex items-center gap-1">
                  <TrendingUp className="h-3 w-3" />
                  Outcomes
                </dt>
                <dd className="font-bold tabular-nums text-crm-text">{stats.dispositionsToday}</dd>
              </div>
              <div className="rounded-crm border border-crm-border/80 bg-crm-bg/50 px-2 py-1.5">
                <dt className="text-crm-muted flex items-center gap-1">
                  <ListOrdered className="h-3 w-3" />
                  Remaining
                </dt>
                <dd className="font-bold tabular-nums text-crm-text">{stats.queueRemaining}</dd>
              </div>
            </dl>
          </>
        ) : (
          <p className={crm.muted}>Activity unavailable</p>
        )}
      </CRMSection>

      {stats && !statsLoading ? (
        <div className="flex flex-wrap gap-2 pt-1 border-t border-crm-border/60">
          <Link
            href="/crm/tasks"
            className={cn(crm.chip, "hover:bg-crm-surface-2")}
          >
            <Activity className="h-3 w-3" />
            Tasks
          </Link>
          {campaignId ? (
            <Link
              href={`/crm/campaigns/${encodeURIComponent(campaignId)}`}
              className={cn(crm.chip, "hover:bg-crm-surface-2")}
            >
              Campaign detail
            </Link>
          ) : (
            <Link href="/crm/campaigns?status=ACTIVE" className={cn(crm.chip, "hover:bg-crm-surface-2")}>
              Active campaigns ({stats.activeCampaigns})
            </Link>
          )}
        </div>
      ) : null}
    </CRMCard>
  );
}
