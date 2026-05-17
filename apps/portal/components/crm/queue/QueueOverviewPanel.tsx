"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Megaphone, PhoneCall, Sparkles, TrendingUp, Zap } from "lucide-react";
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

  return (
    <CRMCard padding="md" className={cn(crm.sidebarCard, "flex flex-col")}>
      <SidebarSection title="In this view">
        <p className="text-2xl font-bold tabular-nums leading-none text-crm-text">{total}</p>
        <p className="mt-1 text-[11px] text-crm-muted">
          {total === 1 ? "lead" : "leads"} · {filterLabel(filter)}
        </p>
      </SidebarSection>

      {next ? (
        <SidebarSection title="Next best action">
          <p className="text-xs leading-relaxed text-crm-muted">{next.hint}</p>
          <Link href={next.href} className={cn(crm.btnSecondary, "mt-2 w-full justify-center gap-2 text-xs")}>
            {next.icon}
            {next.cta}
            <ArrowRight className="ml-auto h-3.5 w-3.5 opacity-70" />
          </Link>
        </SidebarSection>
      ) : null}

      <SidebarSection title="Your activity today">
        {statsLoading ? (
          <p className={crm.muted}>Loading…</p>
        ) : stats ? (
          <div className="grid grid-cols-3 gap-2">
            <MetricTile label="Outcomes" value={stats.dispositionsToday} />
            <MetricTile label="Calls" value={stats.callsLinkedToday} icon={<PhoneCall className="h-3 w-3" />} />
            <MetricTile label="Open tasks" value={stats.myOpen} emphasize={stats.myOpen > 0 ? "warn" : "default"} />
          </div>
        ) : (
          <p className={crm.muted}>Unavailable</p>
        )}
      </SidebarSection>

      <SidebarSection title="Campaign" className="mt-auto border-t border-crm-border/60 pt-3">
        {campaignId && campaignName ? (
          <Link
            href={`/crm/campaigns/${encodeURIComponent(campaignId)}`}
            className={cn(crm.btnGhost, "w-full justify-start px-2 text-xs")}
          >
            <Megaphone className="h-3.5 w-3.5 shrink-0 text-crm-accent" />
            <span className="truncate">{campaignName}</span>
          </Link>
        ) : stats && !statsLoading ? (
          <Link href="/crm/campaigns?status=ACTIVE" className={cn(crm.btnGhost, "w-full justify-start px-2 text-xs")}>
            <Megaphone className="h-3.5 w-3.5" />
            {stats.activeCampaigns} active campaigns
          </Link>
        ) : (
          <p className="text-xs text-crm-muted">All campaigns</p>
        )}
        <Link href="/crm/dashboard" className={cn(crm.btnGhost, "mt-1 w-full justify-start px-2 text-xs")}>
          <TrendingUp className="h-3.5 w-3.5" />
          Command center
        </Link>
      </SidebarSection>
    </CRMCard>
  );
}

function SidebarSection({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(crm.sidebarSection, className)}>
      <p className={crm.label}>{title}</p>
      {children}
    </div>
  );
}

function MetricTile({
  label,
  value,
  icon,
  emphasize,
}: {
  label: string;
  value: number;
  icon?: ReactNode;
  emphasize?: "default" | "warn";
}) {
  return (
    <div className={cn(crm.metricTile, "min-h-[3.5rem]")}>
      <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-crm-muted">
        {icon}
        {label}
      </p>
      <p
        className={cn(
          "mt-1 text-lg font-bold tabular-nums leading-none",
          emphasize === "warn" && value > 0 ? "text-crm-warning" : "text-crm-text",
        )}
      >
        {value}
      </p>
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

