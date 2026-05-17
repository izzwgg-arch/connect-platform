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
  const hasPressure = callbacks > 0 || (isActive && activeWork > 0);

  return (
    <article
      className={cn(
        crm.campaignCard,
        "flex overflow-hidden",
        isActive && crm.campaignCardActive,
        isPaused && crm.campaignCardPaused,
        isDraft && crm.campaignCardDraft,
        hasPressure && !isActive && !isPaused && "border-crm-warning/25",
      )}
    >
      <div className={cn(crm.campaignStatusStrip, STATUS_STRIP[campaign.status])} aria-hidden />

      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3 sm:flex-row sm:items-center sm:gap-4 sm:p-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              href={`/crm/campaigns/${campaign.id}`}
              className="truncate text-sm font-semibold text-crm-text hover:text-crm-accent sm:text-[0.9375rem]"
            >
              {campaign.name}
            </Link>
            <CampaignStatusBadge status={campaign.status} />
            <CampaignPriorityBadge priority={campaign.priority ?? "NORMAL"} hideNormal />
          </div>
          {campaign.description ? (
            <p className="mt-0.5 line-clamp-1 text-xs text-crm-muted">{campaign.description}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            <MetricPill label="Members" value={members} />
            <MetricPill label="Queue" value={activeWork} warn={isActive && activeWork > 0} />
            <MetricPill label="CB" value={callbacks} warn={callbacks > 0} />
            {metrics ? (
              <MetricPill label="Conv" value={`${converted} · ${conversionRate}%`} />
            ) : null}
            <span className="hidden text-[11px] text-crm-muted/80 sm:inline sm:ml-auto">
              Updated {formatShortDate(campaign.updatedAt)}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:flex-nowrap sm:justify-end">
          <Link
            href={`/crm/campaigns/${campaign.id}`}
            className={cn(crm.btnPrimary, "text-xs py-1.5 px-3")}
          >
            Open
            <ChevronRight className="h-3.5 w-3.5 opacity-80" aria-hidden />
          </Link>
          {canQueue && (
            <Link href={queueHref(campaign.id)} className={cn(crm.btnSecondary, "text-xs py-1.5 px-2.5")}>
              <ListOrdered className="h-3.5 w-3.5" />
              Queue
            </Link>
          )}
          {isAdmin && isDraft && (
            <button
              type="button"
              onClick={(e) => onQuickStatus(campaign.id, "ACTIVE", e)}
              className={cn(crm.btnSecondary, "text-xs py-1.5 px-2.5 text-crm-success border-crm-success/30")}
            >
              <Play className="h-3.5 w-3.5" /> Start
            </button>
          )}
          {isAdmin && isPaused && (
            <button
              type="button"
              onClick={(e) => onQuickStatus(campaign.id, "ACTIVE", e)}
              className={cn(crm.btnSecondary, "text-xs py-1.5 px-2.5 text-crm-success border-crm-success/30")}
            >
              <Play className="h-3.5 w-3.5" /> Resume
            </button>
          )}
          {canQueue && isActive && (
            <Link
              href={`/crm/queue?mode=power&campaignId=${encodeURIComponent(campaign.id)}`}
              className={cn(crm.btnGhost, "text-xs py-1.5 px-2")}
              title="Power session"
            >
              <Zap className="h-3.5 w-3.5" />
            </Link>
          )}
          {isAdmin && isActive && (
            <button
              type="button"
              onClick={(e) => onQuickStatus(campaign.id, "PAUSED", e)}
              className={cn(crm.btnGhost, "text-xs p-1.5 text-crm-warning")}
              title="Pause"
            >
              <Pause className="h-3.5 w-3.5" />
            </button>
          )}
          {isAdmin && (isActive || isPaused) && (
            <button
              type="button"
              onClick={(e) => onQuickStatus(campaign.id, "ARCHIVED", e)}
              className={cn(crm.btnGhost, "text-xs p-1.5 text-crm-muted hover:text-crm-danger")}
              title="Archive"
              aria-label="Archive"
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function MetricPill({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5 text-xs">
      <span className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">{label}</span>
      <span className={cn("font-semibold tabular-nums", warn ? "text-crm-warning" : "text-crm-text")}>{value}</span>
    </div>
  );
}
