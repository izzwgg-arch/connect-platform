"use client";

import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Info,
  Layers,
  TrendingDown,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";
import type {
  AgentRow,
  CampaignRow,
  DailyReport,
  FollowUpsReport,
} from "./reportsTypes";

type InsightLevel = "ok" | "warn" | "danger" | "info";

type Insight = {
  id: string;
  level: InsightLevel;
  icon: ReactNode;
  message: string;
  detail?: string;
};

function deriveInsights(
  daily: DailyReport | null,
  campaigns: CampaignRow[],
  agents: AgentRow[],
  followUps: FollowUpsReport | null,
): Insight[] {
  const insights: Insight[] = [];

  if (!daily && campaigns.length === 0 && agents.length === 0 && !followUps) {
    return [];
  }

  if (daily) {
    // Queue health
    if (daily.queueRemaining === 0 && daily.activeCampaigns > 0) {
      insights.push({
        id: "queue-exhausted",
        level: "warn",
        icon: <Layers className="h-4 w-4" />,
        message: "Queue exhaustion — all contacts worked across active campaigns",
        detail: `${daily.activeCampaigns} active campaign${daily.activeCampaigns !== 1 ? "s" : ""}, 0 pending`,
      });
    } else if (daily.queueRemaining > 0 && daily.activeCampaigns > 0) {
      insights.push({
        id: "queue-healthy",
        level: "ok",
        icon: <CheckCircle2 className="h-4 w-4" />,
        message: `Queue volume healthy — ${daily.queueRemaining.toLocaleString()} contacts pending`,
        detail: `Across ${daily.activeCampaigns} active campaign${daily.activeCampaigns !== 1 ? "s" : ""}`,
      });
    }

    // Callback pressure
    if (daily.overdueCallbacks >= 5) {
      insights.push({
        id: "cb-critical",
        level: "danger",
        icon: <CalendarClock className="h-4 w-4" />,
        message: `${daily.overdueCallbacks} overdue callbacks — follow-up SLA risk detected`,
        detail: `${daily.callbacksDueToday} total due today`,
      });
    } else if (daily.overdueCallbacks > 0) {
      insights.push({
        id: "cb-warn",
        level: "warn",
        icon: <CalendarClock className="h-4 w-4" />,
        message: `${daily.overdueCallbacks} overdue callback${daily.overdueCallbacks !== 1 ? "s" : ""} — review today`,
        detail: `${daily.callbacksDueToday} total due today`,
      });
    }

    // Task overdue
    if (daily.overdueTasks >= 5) {
      insights.push({
        id: "tasks-critical",
        level: "danger",
        icon: <AlertTriangle className="h-4 w-4" />,
        message: `${daily.overdueTasks} overdue tasks — manager review needed`,
      });
    } else if (daily.overdueTasks > 0) {
      insights.push({
        id: "tasks-warn",
        level: "warn",
        icon: <AlertTriangle className="h-4 w-4" />,
        message: `${daily.overdueTasks} overdue task${daily.overdueTasks !== 1 ? "s" : ""} outstanding`,
      });
    }
  }

  // Campaign insights
  if (campaigns.length > 0) {
    const active = campaigns.filter((c) => c.status === "ACTIVE");

    const stale = active.filter((c) => {
      const last = new Date(c.lastActivityAt).getTime();
      return Date.now() - last > 48 * 60 * 60 * 1000;
    });
    if (stale.length > 0) {
      insights.push({
        id: "stale-campaigns",
        level: "warn",
        icon: <TrendingDown className="h-4 w-4" />,
        message: `${stale.length} active campaign${stale.length !== 1 ? "s" : ""} with no activity in 48h`,
        detail:
          stale
            .slice(0, 2)
            .map((c) => c.name)
            .join(", ") + (stale.length > 2 ? ` +${stale.length - 2} more` : ""),
      });
    }

    const highCallback = active.filter(
      (c) => c.total > 0 && c.callbacks / c.total > 0.2,
    );
    if (highCallback.length > 0) {
      insights.push({
        id: "callback-pressure",
        level: "warn",
        icon: <CalendarClock className="h-4 w-4" />,
        message: `Callbacks building in ${highCallback.length} campaign${highCallback.length !== 1 ? "s" : ""}`,
        detail:
          highCallback
            .slice(0, 2)
            .map((c) => `${c.name} (${c.callbacks})`)
            .join(", "),
      });
    }
  }

  // Agent insights
  if (agents.length > 0) {
    const inactive = agents.filter(
      (a) => a.dispositionsToday === 0 && a.assignedQueue > 0,
    );
    if (inactive.length >= 3) {
      insights.push({
        id: "inactive-agents",
        level: "warn",
        icon: <Users className="h-4 w-4" />,
        message: `${inactive.length} agents inactive today — have queue work assigned`,
        detail:
          inactive
            .slice(0, 3)
            .map((a) => a.displayName)
            .join(", ") + (inactive.length > 3 ? ` +${inactive.length - 3}` : ""),
      });
    } else if (inactive.length > 0) {
      insights.push({
        id: "inactive-minor",
        level: "info",
        icon: <Users className="h-4 w-4" />,
        message: `${inactive.length} agent${inactive.length !== 1 ? "s" : ""} with queue work not yet active today`,
      });
    }
  }

  // All clear
  if (insights.length === 0) {
    insights.push({
      id: "all-clear",
      level: "ok",
      icon: <CheckCircle2 className="h-4 w-4" />,
      message: "All systems operational — no urgent alerts",
      detail: "Queue, callbacks, and follow-ups are within normal range",
    });
  }

  return insights;
}

const levelStyle: Record<
  InsightLevel,
  { border: string; bg: string; icon: string }
> = {
  ok: {
    border: "border-crm-success/30",
    bg: "bg-crm-success/8",
    icon: "text-crm-success",
  },
  warn: {
    border: "border-crm-warning/30",
    bg: "bg-crm-warning/8",
    icon: "text-crm-warning",
  },
  danger: {
    border: "border-crm-danger/35",
    bg: "bg-crm-danger/10",
    icon: "text-crm-danger",
  },
  info: {
    border: "border-crm-border/70",
    bg: "bg-crm-surface-2/60",
    icon: "text-crm-accent",
  },
};

export function ReportsInsightFeed({
  daily,
  campaigns,
  agents,
  followUps,
  loading,
}: {
  daily: DailyReport | null;
  campaigns: CampaignRow[];
  agents: AgentRow[];
  followUps: FollowUpsReport | null;
  loading: boolean;
}) {
  const insights = deriveInsights(daily, campaigns, agents, followUps);

  if (loading) {
    return (
      <div className="flex flex-col gap-2 py-1">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-12 animate-pulse rounded-crm bg-crm-surface-2/50"
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {insights.map((ins) => {
        const s = levelStyle[ins.level];
        return (
          <div
            key={ins.id}
            className={cn(
              "flex items-start gap-3 rounded-crm border px-3 py-2.5",
              s.border,
              s.bg,
            )}
          >
            <span className={cn("mt-0.5 shrink-0", s.icon)}>{ins.icon}</span>
            <div className="min-w-0">
              <p className="text-sm font-medium leading-snug text-crm-text">
                {ins.message}
              </p>
              {ins.detail && (
                <p className="mt-0.5 text-xs text-crm-muted">{ins.detail}</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
