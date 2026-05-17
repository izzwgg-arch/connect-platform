"use client";

import {
  BarChart3,
  Download,
  RefreshCw,
  TrendingUp,
  Megaphone,
  Users,
  Clock,
  Lightbulb,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { ReportTab } from "./reportsTypes";

const TABS: { id: ReportTab; label: string; icon: ReactNode }[] = [
  { id: "operations", label: "Operations", icon: <TrendingUp className="h-4 w-4" /> },
  { id: "campaigns", label: "Campaigns", icon: <Megaphone className="h-4 w-4" /> },
  { id: "agents", label: "Agents", icon: <Users className="h-4 w-4" /> },
  { id: "follow-ups", label: "Follow-ups", icon: <Clock className="h-4 w-4" /> },
  { id: "intelligence", label: "Intelligence", icon: <Lightbulb className="h-4 w-4" /> },
];

export function ReportsCommandHeader({
  activeTab,
  onTabChange,
  lastRefreshed,
  loading,
  onRefresh,
  onExport,
}: {
  activeTab: ReportTab;
  onTabChange: (tab: ReportTab) => void;
  lastRefreshed: Date | null;
  loading: boolean;
  onRefresh: () => void;
  onExport: () => void;
}) {
  const secondsAgo =
    lastRefreshed ? Math.floor((Date.now() - lastRefreshed.getTime()) / 1000) : null;
  const timeLabel =
    secondsAgo === null
      ? null
      : secondsAgo < 60
        ? `${secondsAgo}s ago`
        : `${Math.floor(secondsAgo / 60)}m ago`;

  return (
    <div className="sticky top-0 z-20 border-b border-crm-border/80 bg-[--bg-soft]">
      <div className="mx-auto w-full max-w-[min(100%,1680px)] px-3 sm:px-5 lg:px-6 xl:px-7">
        {/* Title row */}
        <div className="flex items-center gap-3 border-b border-crm-border/40 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-crm bg-crm-accent/15 text-crm-accent">
              <BarChart3 className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-bold leading-none tracking-tight text-crm-text">
                CRM Intelligence
              </h1>
              <p className="mt-0.5 text-[11px] leading-snug text-crm-muted">
                Operations · Performance · Follow-up health
              </p>
            </div>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* Live pulse */}
            <div className="hidden items-center gap-1.5 rounded-full border border-crm-border/70 bg-crm-surface-2/60 px-2.5 py-1 sm:flex">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-crm-success opacity-75 motion-safe:animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-crm-success" />
              </span>
              <span className="text-[11px] font-medium text-crm-muted">
                {timeLabel ? `Updated ${timeLabel}` : "Live"}
              </span>
            </div>

            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              aria-label="Refresh reports"
              className={cn(crm.campaignDetailBtnTertiary, "p-2")}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", loading && "motion-safe:animate-spin")}
              />
            </button>

            <button
              type="button"
              onClick={onExport}
              aria-label="Export report"
              className={cn(crm.campaignDetailBtnSecondary, "gap-1.5 px-2.5 py-1.5 text-xs")}
            >
              <Download className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Export</span>
            </button>
          </div>
        </div>

        {/* Command tabs */}
        <div className="flex items-center gap-0.5 overflow-x-auto py-2 [scrollbar-width:none]">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap rounded-crm px-3.5 py-2 text-sm font-medium transition-colors",
                activeTab === tab.id
                  ? "border border-crm-accent/35 bg-crm-accent/15 text-crm-accent"
                  : "border border-transparent text-crm-muted hover:bg-crm-surface-2/60 hover:text-crm-text",
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
