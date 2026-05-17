"use client";

import Link from "next/link";
import {
  Archive,
  ChevronRight,
  ListOrdered,
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

const STATUS_STRIP: Record<CampaignListItem["status"], string> = {
  ACTIVE: "bg-crm-accent",
  PAUSED: "bg-crm-warning",
  DRAFT: "bg-crm-muted/50",
  COMPLETED: "bg-crm-success/70",
  ARCHIVED: "bg-crm-muted/30",
};

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
        crm.campaignCard,
        "flex min-h-[6rem] overflow-hidden",
        isActive && crm.campaignCardActive,
        isActive && queueGlow && crm.campaignCardQueueGlow,
        isPaused && crm.campaignCardPaused,
        isDraft && crm.campaignCardDraft,
      )}
    >
      <div
        className={cn(
          crm.campaignStatusStrip,
          STATUS_STRIP[campaign.status],
          isActive && crm.campaignStatusStripLive,
        )}
        aria-hidden
      />

      <div className="grid min-w-0 flex-1 grid-cols-1 gap-3 p-3.5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.05fr)_auto] lg:items-stretch lg:gap-4">
        {/* Identity */}
        <div className="flex min-w-0 flex-col justify-center">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              href={`/crm/campaigns/${campaign.id}`}
              className="truncate text-base font-semibold leading-snug text-crm-text hover:text-crm-accent"
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
          {campaign.description ? (
            <p className="mt-1 line-clamp-1 text-xs leading-relaxed text-crm-muted">{campaign.description}</p>
          ) : null}
          <p className="mt-1.5 text-[11px] text-crm-muted/75">Updated {formatShortDate(campaign.updatedAt)}</p>
        </div>

        {/* Metrics + pressure */}
        <div className="flex min-w-0 flex-col justify-center gap-2">
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
            <MetricCluster
              title="Volume"
              items={[
                { label: "Members", value: members },
                {
                  label: "In queue",
                  value: activeWork,
                  warn: isActive && activeWork > 0,
                },
              ]}
            />
            <MetricCluster
              title="Outcome"
              items={
                metrics
                  ? [
                      {
                        label: "Callbacks",
                        value: callbacks,
                        warn: callbacks > 0,
                      },
                      {
                        label: "Converted",
                        value: converted,
                        sub: conversionRate > 0 ? `${conversionRate}%` : undefined,
                      },
                    ]
                  : [
                      { label: "Callbacks", value: "—", muted: true },
                      { label: "Converted", value: "—", muted: true },
                    ]
              }
            />
          </div>
          <p className={cn(crm.campaignPressureLine, PRESSURE_TONE[pressure.tone])}>{pressure.label}</p>
        </div>

        {/* Actions */}
        <div className="flex min-w-[10.5rem] flex-col justify-center gap-2 lg:items-end lg:pl-1">
          <Link
            href={`/crm/campaigns/${campaign.id}`}
            className={cn(
              crm.btnPrimary,
              "w-full justify-center text-xs py-2 px-4 lg:min-w-[9.5rem]",
            )}
          >
            Open campaign
            <ChevronRight className="h-3.5 w-3.5 opacity-85" aria-hidden />
          </Link>

          {(canQueue || isAdmin) && (
            <div className="flex w-full flex-wrap items-center gap-1.5 lg:justify-end">
              {canQueue && (
                <Link href={queueHref(campaign.id)} className={cn(crm.campaignBtnSecondaryCompact, "flex-1 lg:flex-none")}>
                  <ListOrdered className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  Queue
                </Link>
              )}
              {canQueue && isActive && (
                <Link
                  href={`/crm/queue?mode=power&campaignId=${encodeURIComponent(campaign.id)}`}
                  className={cn(crm.campaignBtnSecondaryCompact, "flex-1 lg:flex-none")}
                >
                  <Zap className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  Power
                </Link>
              )}
              {isAdmin && isDraft && (
                <button
                  type="button"
                  onClick={(e) => onQuickStatus(campaign.id, "ACTIVE", e)}
                  className={cn(
                    crm.campaignBtnSecondaryCompact,
                    "flex-1 text-crm-success border-crm-success/30 lg:flex-none",
                  )}
                >
                  <Play className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  Start
                </button>
              )}
              {isAdmin && isPaused && (
                <button
                  type="button"
                  onClick={(e) => onQuickStatus(campaign.id, "ACTIVE", e)}
                  className={cn(
                    crm.campaignBtnSecondaryCompact,
                    "flex-1 text-crm-success border-crm-success/30 lg:flex-none",
                  )}
                >
                  <Play className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  Resume
                </button>
              )}
            </div>
          )}

          {isAdmin && (isActive || isPaused) && (
            <div className="flex w-full items-center justify-end gap-0.5 border-t border-crm-border/40 pt-1.5">
              {isActive && (
                <button
                  type="button"
                  onClick={(e) => onQuickStatus(campaign.id, "PAUSED", e)}
                  className={cn(crm.campaignBtnTertiary, "text-crm-warning hover:text-crm-warning")}
                >
                  <Pause className="h-3 w-3 shrink-0 opacity-80" aria-hidden />
                  Pause
                </button>
              )}
              <button
                type="button"
                onClick={(e) => onQuickStatus(campaign.id, "ARCHIVED", e)}
                className={cn(crm.campaignBtnTertiary, "hover:text-crm-danger")}
              >
                <Archive className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
                Archive
              </button>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function MetricCluster({
  title,
  items,
}: {
  title: string;
  items: {
    label: string;
    value: string | number;
    sub?: string;
    warn?: boolean;
    muted?: boolean;
  }[];
}) {
  return (
    <div className={crm.campaignMetricCluster}>
      <p className={crm.campaignMetricClusterTitle}>{title}</p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0">
        {items.map((item) => (
          <div key={item.label} className={crm.campaignIndexMetric}>
            <p className={crm.campaignIndexMetricLabel}>{item.label}</p>
            <p
              className={cn(
                crm.campaignIndexMetricValue,
                item.warn && "text-crm-warning",
                item.muted && "text-crm-muted text-base",
              )}
            >
              {item.value}
            </p>
            {item.sub ? (
              <p className="text-[10px] leading-tight text-crm-muted">{item.sub}</p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
