"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Activity, AlertTriangle, CheckCircle2, CheckSquare, Megaphone, ShieldCheck } from "lucide-react";
import { CRMCard } from "../CRMCard";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { CampaignOption, QueueOperationalStats } from "./queueTypes";

type ExceptionItem = {
  id: string;
  label: string;
  detail: string;
  href: string;
  tone: "danger" | "warning" | "accent";
  icon: ReactNode;
};

/** Exceptions only — no duplicate pending/due/overdue/upcoming counts (top pills own those). */
export function QueueAttentionPanel({
  stats,
  statsLoading,
  campaigns,
  campaignId,
  campaignName,
}: {
  stats: QueueOperationalStats | null;
  statsLoading: boolean;
  campaigns: CampaignOption[];
  campaignId: string | null;
  campaignName: string | null;
}) {
  const items: ExceptionItem[] = [];

  if (stats && stats.myTasksOverdue > 0) {
    items.push({
      id: "tasks-overdue",
      label: "Overdue tasks",
      detail: "CRM tasks past due",
      href: "/crm/tasks",
      tone: "danger",
      icon: <CheckSquare className="h-3.5 w-3.5 shrink-0" />,
    });
  }

  if (stats && stats.myTasksDueToday > 0) {
    items.push({
      id: "tasks-due",
      label: "Tasks due today",
      detail: "Finish alongside queue work",
      href: "/crm/tasks",
      tone: "warning",
      icon: <CheckSquare className="h-3.5 w-3.5 shrink-0" />,
    });
  }

  if (stats && stats.myOverdueCallbacks > 0) {
    items.push({
      id: "personal-overdue-cb",
      label: "Personal overdue callbacks",
      detail: "Your assigned callbacks past due",
      href: "/crm/queue?filter=overdue",
      tone: "danger",
      icon: <AlertTriangle className="h-3.5 w-3.5 shrink-0" />,
    });
  }

  if (campaignId && campaignName) {
    items.push({
      id: "campaign-focus",
      label: "Filtered campaign",
      detail: campaignName,
      href: `/crm/campaigns/${encodeURIComponent(campaignId)}`,
      tone: "accent",
      icon: <Megaphone className="h-3.5 w-3.5 shrink-0" />,
    });
  } else if (campaigns.length > 0) {
    const top = [...campaigns]
      .filter((c) => (c.memberCount ?? 0) > 0)
      .sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0))[0];
    if (top && (top.memberCount ?? 0) > 0) {
      items.push({
        id: "campaign-volume",
        label: "Busiest campaign",
        detail: top.name,
        href: `/crm/queue?campaignId=${encodeURIComponent(top.id)}`,
        tone: "accent",
        icon: <Megaphone className="h-3.5 w-3.5 shrink-0" />,
      });
    }
  }

  const toneClass = {
    danger: "border-crm-danger/35 bg-crm-danger/10 hover:bg-crm-danger/15",
    warning: "border-crm-warning/35 bg-crm-warning/10 hover:bg-crm-warning/15",
    accent: "border-crm-accent/35 bg-crm-accent/10 hover:bg-crm-accent/15",
  };

  const toneText = {
    danger: "text-crm-danger",
    warning: "text-crm-warning",
    accent: "text-crm-accent",
  };

  const overdueTotal = (stats?.myOverdueCallbacks ?? 0) + (stats?.myTasksOverdue ?? 0);
  const dueSoonTotal = (stats?.myCallbacksDueToday ?? 0) + (stats?.myTasksDueToday ?? 0);
  const healthScore = overdueTotal > 0 ? 62 : dueSoonTotal > 0 ? 84 : 100;

  return (
    <>
      <CRMCard padding="md" className="crm-queue-rail-card crm-queue-health-card flex flex-col">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-crm-text">Queue Health</p>
            <p className="mt-0.5 text-[11px] text-crm-muted">
              {statsLoading ? "Checking queue signals" : overdueTotal > 0 ? "Action needed" : "All good"}
            </p>
          </div>
          <span className="crm-queue-rail-icon crm-queue-rail-icon-green">
            <ShieldCheck className="h-4 w-4" />
          </span>
        </div>
        <div className="rounded-crm border border-crm-success/25 bg-crm-success/8 p-3">
          <div className="mb-2 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-crm-success" />
            <p className="text-xs font-bold text-crm-success">
              {overdueTotal > 0 ? "Needs focus" : "All good"}
            </p>
          </div>
          <p className="text-[11px] leading-snug text-crm-muted">
            {overdueTotal > 0 ? "Overdue work is waiting. Start with the red queue signals." : "You're up to date. Keep it going."}
          </p>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-crm-surface-2">
            <div className="h-full rounded-full bg-crm-success transition-[width] duration-500" style={{ width: `${healthScore}%` }} />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <HealthMetric label="Overdue" value={statsLoading ? "-" : overdueTotal} tone={overdueTotal > 0 ? "danger" : "default"} />
            <HealthMetric label="Due Soon" value={statsLoading ? "-" : dueSoonTotal} />
            <HealthMetric label="Follow Ups" value={statsLoading ? "-" : (stats?.myCallbacksDueToday ?? 0)} />
          </div>
        </div>
      </CRMCard>

      <CRMCard padding="md" className="crm-queue-rail-card flex flex-col">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-crm-text">Recent Activity</p>
            <p className="mt-0.5 text-[11px] text-crm-muted">Real queue signals</p>
          </div>
          <span className="crm-queue-rail-icon crm-queue-rail-icon-violet">
            <Activity className="h-4 w-4" />
          </span>
        </div>

        {statsLoading ? (
          <p className={cn(crm.muted, "py-2")}>Checking...</p>
        ) : items.length === 0 ? (
          <div className="rounded-crm border border-crm-border/80 bg-crm-surface-2/50 px-3 py-4 text-center">
            <CheckSquare className="mx-auto mb-1.5 h-6 w-6 text-crm-success opacity-90" />
            <p className="text-xs font-medium text-crm-text">No exceptions</p>
            <p className="mt-0.5 text-[10px] text-crm-muted">Tasks and callbacks look clear.</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <li key={item.id}>
                <Link
                  href={item.href}
                  className={cn(
                    "crm-queue-activity-row block rounded-crm border px-2.5 py-2 transition-colors",
                    toneClass[item.tone],
                  )}
                >
                  <div className="flex items-start gap-2">
                    <span className={cn("crm-queue-activity-icon mt-0.5 shrink-0", toneText[item.tone])}>{item.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className={cn("block text-xs font-semibold leading-snug", toneText[item.tone])}>
                          {item.label}
                        </span>
                        <span className="shrink-0 text-[10px] text-crm-muted">Today</span>
                      </span>
                      <span className="mt-0.5 block text-[10px] text-crm-muted line-clamp-2">{item.detail}</span>
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CRMCard>
    </>
  );
}

function HealthMetric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number | string;
  tone?: "default" | "danger";
}) {
  return (
    <div className="rounded-crm border border-crm-border/60 bg-crm-surface/70 px-2 py-2">
      <p className={cn("text-sm font-bold tabular-nums", tone === "danger" ? "text-crm-danger" : "text-crm-text")}>{value}</p>
      <p className="mt-0.5 text-[9px] font-semibold uppercase tracking-wide text-crm-muted">{label}</p>
    </div>
  );
}
