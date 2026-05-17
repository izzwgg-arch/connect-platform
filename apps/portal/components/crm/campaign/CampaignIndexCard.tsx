"use client";

import Link from "next/link";
import {
  Archive,
  ChevronRight,
  ListOrdered,
  Megaphone,
  MoreHorizontal,
  Pause,
  Play,
  Zap,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { getCampaignQueuePressure } from "./campaignIndexInsights";
import type { CampaignListItem, CampaignReportRow } from "./campaignTypes";
import { CampaignPriorityBadge, CampaignStatusBadge } from "./CampaignStatusBadge";
import { formatShortDate, queueHref } from "./campaignUtils";

const PRESSURE_TONE: Record<
  ReturnType<typeof getCampaignQueuePressure>["tone"],
  string
> = {
  ok: "text-crm-success",
  default: "text-crm-muted",
  warn: "text-crm-warning",
  muted: "text-crm-muted/80",
};

export function CampaignIndexCard({
  campaign,
  metrics,
  canQueue,
  isAdmin,
  onQuickStatus,
}: {
  campaign: CampaignListItem;
  metrics?: CampaignReportRow | null;
  canQueue: boolean;
  isAdmin: boolean;
  onQuickStatus: (id: string, status: CampaignListItem["status"], e: React.MouseEvent) => void;
}) {
  const members = campaign.memberCount ?? metrics?.total ?? 0;
  const activeWork = metrics?.pending ?? 0;
  const callbacks = metrics?.callbacks ?? 0;
  const converted = metrics?.converted ?? 0;
  const conversionRate = metrics?.conversionRate ?? 0;
  const isActive = campaign.status === "ACTIVE";
  const isPaused = campaign.status === "PAUSED";
  const isDraft = campaign.status === "DRAFT";
  const queueGlow = isActive && activeWork > 0;
  const pressure = getCampaignQueuePressure(campaign.status, metrics);

  return (
    <article
      className={cn(
        crm.campaignIndexRow,
        isActive && crm.campaignIndexRowActive,
        isActive && queueGlow && crm.campaignIndexRowQueueGlow,
        isPaused && crm.campaignIndexRowPaused,
        isDraft && crm.campaignIndexRowDraft,
      )}
    >
      <div className="flex min-w-0 flex-1 items-stretch gap-3 p-3 sm:gap-4 sm:p-3.5 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-crm border border-crm-border/80 bg-crm-surface-2/80",
              isActive && "border-crm-accent/35 bg-crm-accent/10",
            )}
          >
            <Megaphone className={cn("h-4 w-4", isActive ? "text-crm-accent" : "text-crm-muted")} aria-hidden />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Link
                href={`/crm/campaigns/${campaign.id}`}
                className="truncate text-base font-semibold text-crm-text hover:text-crm-accent sm:text-[1.05rem]"
              >
                {campaign.name}
              </Link>
              {isActive ? (
                <span
                  className="crm-campaign-live-dot inline-flex h-2 w-2 shrink-0 rounded-full bg-crm-accent shadow-[0_0_8px_rgba(56,189,248,0.5)]"
                  title="Live program"
                  aria-hidden
                />
              ) : null}
              <CampaignStatusBadge status={campaign.status} variant="index" />
              <CampaignPriorityBadge priority={campaign.priority ?? "NORMAL"} hideNormal />
            </div>
            <p className={cn("mt-0.5 text-[11px] leading-snug", PRESSURE_TONE[pressure.tone])}>{pressure.label}</p>
            <p className="mt-0.5 text-[10px] text-crm-muted/75">Updated {formatShortDate(campaign.updatedAt)}</p>
          </div>
        </div>

        <div className="hidden shrink-0 items-stretch divide-x divide-crm-border/60 border-l border-crm-border/50 pl-3 lg:flex">
          <IndexMetric label="Members" value={members} />
          <IndexMetric label="Queue" value={activeWork} warn={isActive && activeWork > 0} />
          <IndexMetric label="Callbacks" value={metrics ? callbacks : "—"} warn={callbacks > 0} />
          <IndexMetric
            label="Converted"
            value={metrics ? converted : "—"}
            sub={metrics && conversionRate > 0 ? `${conversionRate}%` : undefined}
          />
        </div>

        <div className="flex shrink-0 flex-col justify-center gap-1.5 sm:min-w-[11rem] lg:items-end lg:pl-2">
          <Link
            href={`/crm/campaigns/${campaign.id}`}
            className={cn(crm.btnPrimary, "w-full justify-center px-4 py-2 text-sm font-semibold lg:min-w-[10.5rem]")}
          >
            Open campaign
            <ChevronRight className="h-4 w-4 opacity-90" aria-hidden />
          </Link>
          <div className="flex w-full items-center gap-1.5 lg:justify-end">
            {canQueue && (
              <Link
                href={queueHref(campaign.id)}
                className={cn(crm.campaignBtnSecondaryCompact, "flex-1 text-[11px] py-1.5 lg:flex-none lg:min-w-0")}
              >
                <ListOrdered className="h-3 w-3 shrink-0" aria-hidden />
                Queue
              </Link>
            )}
            {canQueue && isActive && (
              <Link
                href={`/crm/queue?mode=power&campaignId=${encodeURIComponent(campaign.id)}`}
                className={cn(crm.campaignBtnSecondaryCompact, "flex-1 text-[11px] py-1.5 lg:flex-none")}
              >
                <Zap className="h-3 w-3 shrink-0" aria-hidden />
                Power
              </Link>
            )}
            {isAdmin && (isDraft || isPaused) && (
              <button
                type="button"
                onClick={(e) => onQuickStatus(campaign.id, "ACTIVE", e)}
                className={cn(crm.campaignBtnSecondaryCompact, "flex-1 text-[11px] py-1.5 text-crm-success lg:flex-none")}
              >
                <Play className="h-3 w-3 shrink-0" aria-hidden />
                {isDraft ? "Start" : "Resume"}
              </button>
            )}
            {isAdmin && (isActive || isPaused) && (
              <div className="relative group/menu">
                <button
                  type="button"
                  className={cn(crm.campaignBtnTertiary, "px-2 py-1.5")}
                  aria-label="Campaign actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                <div className="absolute right-0 top-full z-20 mt-1 hidden min-w-[7rem] flex-col rounded-crm border border-crm-border bg-crm-surface-2 py-1 shadow-lg group-hover/menu:flex group-focus-within/menu:flex">
                  {isActive && (
                    <button
                      type="button"
                      onClick={(e) => onQuickStatus(campaign.id, "PAUSED", e)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-left text-xs text-crm-warning hover:bg-crm-surface"
                    >
                      <Pause className="h-3 w-3" /> Pause
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => onQuickStatus(campaign.id, "ARCHIVED", e)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-left text-xs text-crm-muted hover:bg-crm-surface hover:text-crm-danger"
                  >
                    <Archive className="h-3 w-3" /> Archive
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-1 border-t border-crm-border/50 px-3 py-2 lg:hidden">
        <IndexMetric label="Members" value={members} compact />
        <IndexMetric label="Queue" value={activeWork} warn={isActive && activeWork > 0} compact />
        <IndexMetric label="CB" value={metrics ? callbacks : "—"} warn={callbacks > 0} compact />
        <IndexMetric label="Conv" value={metrics ? converted : "—"} sub={metrics && conversionRate > 0 ? `${conversionRate}%` : undefined} compact />
      </div>
    </article>
  );
}

function IndexMetric({
  label,
  value,
  sub,
  warn,
  compact,
}: {
  label: string;
  value: string | number;
  sub?: string;
  warn?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={cn(crm.campaignIndexRowMetric, compact && "min-w-0 px-1.5 py-0.5 sm:min-w-0")}>
      <p className={crm.campaignIndexRowMetricLabel}>{label}</p>
      <p className={cn(crm.campaignIndexRowMetricValue, compact && "text-base sm:text-lg", warn && "text-crm-warning")}>
        {value}
      </p>
      {sub ? <p className="text-[10px] text-crm-muted">{sub}</p> : null}
    </div>
  );
}
