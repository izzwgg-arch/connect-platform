"use client";

import Link from "next/link";
import { Activity, ListOrdered, TrendingUp } from "lucide-react";
import { CRMCard } from "../CRMCard";
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
  const pressureTotal = Math.max(1, counts.pending + counts.due + counts.overdue + counts.upcoming);

  const pressureItems = [
    { label: "Pending", value: counts.pending, color: CRM_CHART_COLORS.accent },
    { label: "Due", value: counts.due, color: CRM_CHART_COLORS.warning },
    { label: "Overdue", value: counts.overdue, color: CRM_CHART_COLORS.danger },
    { label: "Upcoming", value: counts.upcoming, color: CRM_CHART_COLORS.muted },
  ];

  const todayItems = stats
    ? [
        { label: "Outcomes", value: stats.dispositionsToday, color: CRM_CHART_COLORS.success },
        { label: "Calls", value: stats.callsLinkedToday, color: CRM_CHART_COLORS.accent },
        { label: "Tasks", value: stats.myOpen, color: CRM_CHART_COLORS.warning },
      ]
    : [];

  return (
    <CRMCard padding="md" className="flex h-full flex-col gap-4">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <p className={crm.label}>Overview</p>
          <p className="mt-0.5 text-2xl font-bold tabular-nums text-crm-text">{total}</p>
          <p className="text-[11px] text-crm-muted">in this view</p>
        </div>
        {campaignName ? (
          <span className="max-w-[9rem] truncate rounded-crm border border-crm-border/80 bg-crm-surface-2 px-2 py-1 text-[10px] font-medium text-crm-muted">
            {campaignName}
          </span>
        ) : null}
      </div>

      <div>
        <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-crm-muted">Queue mix</p>
        <CRMHorizontalBars items={pressureItems} maxValue={pressureTotal} />
        {counts.overdue > 0 && filter === "pending" ? (
          <button
            type="button"
            onClick={() => onFilterChange("overdue")}
            className="mt-2 w-full rounded-crm border border-crm-danger/30 bg-crm-danger/10 px-2 py-1.5 text-left text-xs font-semibold text-crm-danger hover:bg-crm-danger/15"
          >
            {counts.overdue} overdue → focus
          </button>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <CallbackTile label="Due" count={counts.due} active={filter === "due"} tone="warning" onClick={() => onFilterChange("due")} />
        <CallbackTile
          label="Overdue"
          count={counts.overdue}
          active={filter === "overdue"}
          tone="danger"
          onClick={() => onFilterChange("overdue")}
        />
      </div>

      <div className="border-t border-crm-border/60 pt-3">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-crm-muted">Today</p>
        {statsLoading ? (
          <p className={crm.muted}>Loading…</p>
        ) : stats ? (
          <>
            <CRMHorizontalBars
              items={todayItems}
              maxValue={Math.max(1, stats.dispositionsToday, stats.callsLinkedToday, stats.myOpen)}
            />
            <div className="mt-2 grid grid-cols-2 gap-2">
              <MiniStat icon={<TrendingUp className="h-3 w-3" />} label="Outcomes" value={stats.dispositionsToday} />
              <MiniStat icon={<ListOrdered className="h-3 w-3" />} label="Remaining" value={stats.queueRemaining} />
            </div>
          </>
        ) : (
          <p className={crm.muted}>Unavailable</p>
        )}
      </div>

      {stats && !statsLoading ? (
        <div className="mt-auto flex flex-wrap gap-1.5 border-t border-crm-border/60 pt-3">
          <Link href="/crm/tasks" className={cn(crm.chip, "hover:bg-crm-surface-2")}>
            <Activity className="h-3 w-3" />
            Tasks
          </Link>
          {campaignId ? (
            <Link
              href={`/crm/campaigns/${encodeURIComponent(campaignId)}`}
              className={cn(crm.chip, "hover:bg-crm-surface-2")}
            >
              Campaign
            </Link>
          ) : (
            <Link href="/crm/campaigns?status=ACTIVE" className={cn(crm.chip, "hover:bg-crm-surface-2")}>
              Campaigns ({stats.activeCampaigns})
            </Link>
          )}
        </div>
      ) : null}
    </CRMCard>
  );
}

function CallbackTile({
  label,
  count,
  active,
  tone,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  tone: "warning" | "danger";
  onClick: () => void;
}) {
  const activeCls =
    tone === "danger"
      ? "border-crm-danger/40 bg-crm-danger/12 ring-1 ring-crm-danger/20"
      : "border-crm-warning/40 bg-crm-warning/12 ring-1 ring-crm-warning/20";
  const countCls = tone === "danger" ? "text-crm-danger" : "text-crm-warning";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-crm border px-3 py-2.5 text-left transition-colors",
        active ? activeCls : "border-crm-border bg-crm-surface-2/80 hover:bg-crm-surface",
      )}
    >
      <span className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">{label}</span>
      <p className={cn("text-xl font-bold tabular-nums", countCls)}>{count}</p>
    </button>
  );
}

function MiniStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-crm border border-crm-border/80 bg-crm-surface-2/60 px-2 py-1.5">
      <p className="flex items-center gap-1 text-[10px] text-crm-muted">
        {icon}
        {label}
      </p>
      <p className="text-sm font-bold tabular-nums text-crm-text">{value}</p>
    </div>
  );
}

