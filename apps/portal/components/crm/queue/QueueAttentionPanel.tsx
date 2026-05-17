"use client";

import Link from "next/link";
import { CalendarClock, CheckSquare, Megaphone } from "lucide-react";
import { CRMCard } from "../CRMCard";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { CampaignOption, QueueCounts, QueueOperationalStats } from "./queueTypes";

type AttentionItem = {
  id: string;
  label: string;
  detail: string;
  href: string;
  tone: "danger" | "warning" | "accent" | "muted";
  count?: number;
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
      detail: "Past due — call or reschedule",
      href: "/crm/queue?filter=overdue",
      tone: "danger",
      count: counts.overdue,
    });
  }

  if (counts.due > 0) {
    items.push({
      id: "due",
      label: "Due today",
      detail: "Scheduled for today",
      href: "/crm/queue?filter=due",
      tone: "warning",
      count: counts.due,
    });
  }

  if (stats && stats.myTasksOverdue > 0) {
    items.push({
      id: "tasks-overdue",
      label: "Overdue tasks",
      detail: "Open CRM tasks past due",
      href: "/crm/tasks",
      tone: "danger",
      count: stats.myTasksOverdue,
    });
  }

  if (stats && stats.myTasksDueToday > 0) {
    items.push({
      id: "tasks-due",
      label: "Tasks due today",
      detail: "Complete alongside queue work",
      href: "/crm/tasks",
      tone: "warning",
      count: stats.myTasksDueToday,
    });
  }

  if (campaignId && campaignName) {
    items.push({
      id: "campaign-focus",
      label: "Campaign focus",
      detail: campaignName,
      href: `/crm/campaigns/${encodeURIComponent(campaignId)}`,
      tone: "accent",
    });
  } else if (campaigns.length > 0 && counts.pending > 0) {
    const top = [...campaigns]
      .filter((c) => (c.memberCount ?? 0) > 0)
      .sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0))[0];
    if (top) {
      items.push({
        id: "campaign-volume",
        label: "High-volume campaign",
        detail: `${top.name} · ${top.memberCount ?? 0} members`,
        href: `/crm/queue?campaignId=${encodeURIComponent(top.id)}`,
        tone: "accent",
      });
    }
  }

  if (counts.pending > 10 && counts.overdue === 0) {
    items.push({
      id: "pressure",
      label: "Queue backlog",
      detail: `${counts.pending} pending leads in queue`,
      href: "/crm/queue?filter=pending",
      tone: "muted",
      count: counts.pending,
    });
  }

  const toneClass = {
    danger: "border-crm-danger/35 bg-crm-danger/10 text-crm-danger",
    warning: "border-crm-warning/35 bg-crm-warning/10 text-crm-warning",
    accent: "border-crm-accent/35 bg-crm-accent/10 text-crm-accent",
    muted: "border-crm-border bg-crm-surface-2 text-crm-muted",
  };

  return (
    <CRMCard padding="md" className="flex flex-col gap-3 h-full">
      <div>
        <p className={crm.label}>Needs attention</p>
        <p className="mt-1 text-xs text-crm-muted leading-relaxed">
          Live signals from your queue and tasks — no suggestions without data.
        </p>
      </div>

      {statsLoading ? (
        <p className={crm.muted}>Checking…</p>
      ) : items.length === 0 ? (
        <div className="rounded-crm border border-dashed border-crm-border px-3 py-4 text-center">
          <CheckSquare className="h-8 w-8 text-crm-success mx-auto mb-2 opacity-80" />
          <p className="text-sm font-medium text-crm-text">Clear for now</p>
          <p className="text-xs text-crm-muted mt-1">No overdue callbacks or task pressure in this view.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={item.href}
                className={cn(
                  "block rounded-crm border px-3 py-2.5 transition-colors hover:brightness-110",
                  toneClass[item.tone],
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs font-semibold leading-snug">{item.label}</span>
                  {item.count != null ? (
                    <span className="text-sm font-bold tabular-nums shrink-0">{item.count}</span>
                  ) : null}
                </div>
                <p className="text-[11px] opacity-90 mt-0.5 line-clamp-2">{item.detail}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="pt-2 border-t border-crm-border/60 space-y-1.5">
        <p className={crm.label}>Quick links</p>
        <Link href="/crm/tasks" className="flex items-center gap-2 text-xs text-crm-muted hover:text-crm-text">
          <CheckSquare className="h-3.5 w-3.5" />
          My tasks
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
            {counts.upcoming} upcoming callbacks
          </Link>
        ) : null}
      </div>
    </CRMCard>
  );
}
