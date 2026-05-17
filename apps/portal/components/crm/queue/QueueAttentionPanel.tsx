"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { CalendarClock, CheckSquare, Megaphone } from "lucide-react";
import { CRMCard } from "../CRMCard";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { CampaignOption, QueueCounts, QueueOperationalStats } from "./queueTypes";

type AttentionItem = {
  id: string;
  label: string;
  href: string;
  tone: "danger" | "warning" | "accent" | "muted";
  count?: number;
  icon: ReactNode;
};

export function QueueAttentionPanel({
  counts,
  stats,
  statsLoading,
  campaigns,
  campaignId,
  campaignName,
}: {
  counts: QueueCounts;
  stats: QueueOperationalStats | null;
  statsLoading: boolean;
  campaigns: CampaignOption[];
  campaignId: string | null;
  campaignName: string | null;
}) {
  const items: AttentionItem[] = [];

  if (counts.overdue > 0) {
    items.push({
      id: "overdue",
      label: "Overdue callbacks",
      href: "/crm/queue?filter=overdue",
      tone: "danger",
      count: counts.overdue,
      icon: <CalendarClock className="h-3.5 w-3.5 shrink-0" />,
    });
  }

  if (counts.due > 0) {
    items.push({
      id: "due",
      label: "Due today",
      href: "/crm/queue?filter=due",
      tone: "warning",
      count: counts.due,
      icon: <CalendarClock className="h-3.5 w-3.5 shrink-0" />,
    });
  }

  if (stats && stats.myTasksOverdue > 0) {
    items.push({
      id: "tasks-overdue",
      label: "Overdue tasks",
      href: "/crm/tasks",
      tone: "danger",
      count: stats.myTasksOverdue,
      icon: <CheckSquare className="h-3.5 w-3.5 shrink-0" />,
    });
  }

  if (stats && stats.myTasksDueToday > 0) {
    items.push({
      id: "tasks-due",
      label: "Tasks due today",
      href: "/crm/tasks",
      tone: "warning",
      count: stats.myTasksDueToday,
      icon: <CheckSquare className="h-3.5 w-3.5 shrink-0" />,
    });
  }

  if (campaignId && campaignName) {
    items.push({
      id: "campaign-focus",
      label: campaignName,
      href: `/crm/campaigns/${encodeURIComponent(campaignId)}`,
      tone: "accent",
      icon: <Megaphone className="h-3.5 w-3.5 shrink-0" />,
    });
  } else if (campaigns.length > 0 && counts.pending > 0) {
    const top = [...campaigns]
      .filter((c) => (c.memberCount ?? 0) > 0)
      .sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0))[0];
    if (top) {
      items.push({
        id: "campaign-volume",
        label: top.name,
        href: `/crm/queue?campaignId=${encodeURIComponent(top.id)}`,
        tone: "accent",
        count: top.memberCount ?? 0,
        icon: <Megaphone className="h-3.5 w-3.5 shrink-0" />,
      });
    }
  }

  if (counts.pending > 10 && counts.overdue === 0) {
    items.push({
      id: "pressure",
      label: "Queue backlog",
      href: "/crm/queue?filter=pending",
      tone: "muted",
      count: counts.pending,
      icon: <CheckSquare className="h-3.5 w-3.5 shrink-0" />,
    });
  }

  const toneClass = {
    danger: "border-crm-danger/35 bg-crm-danger/10 hover:bg-crm-danger/15",
    warning: "border-crm-warning/35 bg-crm-warning/10 hover:bg-crm-warning/15",
    accent: "border-crm-accent/35 bg-crm-accent/10 hover:bg-crm-accent/15",
    muted: "border-crm-border bg-crm-surface-2 hover:bg-crm-surface",
  };

  const toneText = {
    danger: "text-crm-danger",
    warning: "text-crm-warning",
    accent: "text-crm-accent",
    muted: "text-crm-text",
  };

  return (
    <CRMCard padding="md" className="flex h-full flex-col gap-3">
      <p className={crm.label}>Attention</p>

      {statsLoading ? (
        <p className={crm.muted}>Checking…</p>
      ) : items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center rounded-crm border border-dashed border-crm-border/80 bg-crm-surface-2/40 px-3 py-6 text-center">
          <CheckSquare className="mb-2 h-8 w-8 text-crm-success opacity-80" />
          <p className="text-sm font-medium text-crm-text">All clear</p>
          <p className="mt-1 text-[11px] text-crm-muted">No overdue pressure in this view.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={item.href}
                className={cn(
                  "flex items-center gap-2 rounded-crm border px-2.5 py-2 transition-colors",
                  toneClass[item.tone],
                )}
              >
                <span className={cn("shrink-0", toneText[item.tone])}>{item.icon}</span>
                <span className={cn("min-w-0 flex-1 truncate text-xs font-semibold", toneText[item.tone])}>
                  {item.label}
                </span>
                {item.count != null ? (
                  <span className={cn("shrink-0 text-sm font-bold tabular-nums", toneText[item.tone])}>
                    {item.count}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-auto space-y-1 border-t border-crm-border/60 pt-2">
        <Link href="/crm/tasks" className="flex items-center gap-2 text-xs text-crm-muted hover:text-crm-text">
          <CheckSquare className="h-3.5 w-3.5" />
          Tasks
        </Link>
        <Link href="/crm/campaigns?status=ACTIVE" className="flex items-center gap-2 text-xs text-crm-muted hover:text-crm-text">
          <Megaphone className="h-3.5 w-3.5" />
          Campaigns
        </Link>
        {counts.upcoming > 0 ? (
          <Link
            href="/crm/queue?filter=upcoming"
            className="flex items-center gap-2 text-xs text-crm-muted hover:text-crm-text"
          >
            <CalendarClock className="h-3.5 w-3.5" />
            {counts.upcoming} upcoming
          </Link>
        ) : null}
      </div>
    </CRMCard>
  );
}

