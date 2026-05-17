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
} from "lucide-react";
import { cn } from "../cn";
import { mk, ROW_STATUS } from "./campaignCinemaClasses";
import { getCampaignQueuePressure } from "./campaignIndexInsights";
import type { CampaignListItem, CampaignReportRow } from "./campaignTypes";
import { formatShortDate, queueHref } from "./campaignUtils";

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
  const conversionRate = metrics?.conversionRate ?? 0;
  const isActive = campaign.status === "ACTIVE";
  const isPaused = campaign.status === "PAUSED";
  const isDraft = campaign.status === "DRAFT";
  const queueGlow = isActive && activeWork > 0;
  const pressure = getCampaignQueuePressure(campaign.status, metrics);
  const statusStyle = ROW_STATUS[campaign.status] ?? ROW_STATUS.DRAFT;
  const initials = campaign.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <article
      className={cn(
        mk.rowShell,
        isActive && mk.rowActive,
        isActive && queueGlow && "shadow-[0_0_56px_-6px_rgba(52,211,153,0.42)]",
        isPaused && mk.rowPaused,
        isDraft && "cinema-row-draft",
      )}
    >
      {statusStyle.edge ? (
        <div
          className={cn(
            "pointer-events-none absolute left-0 top-0 bottom-0 w-1 rounded-l-2xl",
            statusStyle.edge,
          )}
          aria-hidden
        />
      ) : null}

      <div className={cn(mk.rowBadge, statusStyle.badge, "m-4 lg:m-5 lg:mr-0")}>
        <Megaphone className={cn("h-7 w-7", statusStyle.icon)} aria-hidden />
        <span className="sr-only">{campaign.name}</span>
        <span className="absolute text-[10px] font-bold opacity-0" aria-hidden>
          {initials}
        </span>
      </div>

      <div className={mk.rowIdentity}>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/crm/campaigns/${campaign.id}`} className={mk.rowName}>
            {campaign.name}
          </Link>
          {isActive ? (
            <span
              className="cinema-live-dot"
              title="Live program"
              aria-hidden
            />
          ) : null}
        </div>
        <p className={mk.rowDesc}>
          {campaign.description?.trim() || "Outbound program — open desk to work the roster."}
        </p>
        <p className={cn(mk.rowMeta, pressure.tone === "warn" && "cinema-pressure-warn")}>{pressure.label}</p>
        <p className={mk.rowMeta}>Updated {formatShortDate(campaign.updatedAt)}</p>
      </div>

      <div className={mk.rowMetrics}>
        <RowMetric label="Members" value={members} />
        <RowMetric label="Queue" value={activeWork} warn={isActive && activeWork > 0} />
        <RowMetric label="Callbacks" value={metrics ? callbacks : "—"} warn={callbacks > 0} />
        <RowMetric
          label="Convert %"
          value={metrics && conversionRate > 0 ? `${conversionRate}%` : metrics ? "0%" : "—"}
        />
      </div>

      <div className={mk.rowActions}>
        <Link href={`/crm/campaigns/${campaign.id}`} className={mk.rowOpenBtn}>
          Open campaign
          <ChevronRight className="h-4 w-4 opacity-90" aria-hidden />
        </Link>
        <div className="flex items-center gap-2">
          {canQueue && (
            <Link href={queueHref(campaign.id)} className={cn(mk.btnQueueRow, "flex-1")}>
              <ListOrdered className="h-4 w-4 shrink-0" aria-hidden />
              Queue
            </Link>
          )}
          {isAdmin && (isDraft || isPaused) && (
            <button
              type="button"
              onClick={(e) => onQuickStatus(campaign.id, "ACTIVE", e)}
              className={cn(mk.btnQueueRow, "flex-1 cinema-btn-resume")}
            >
              <Play className="h-4 w-4 shrink-0" aria-hidden />
              {isDraft ? "Start" : "Resume"}
            </button>
          )}
          {isAdmin && (isActive || isPaused) && (
            <div className="relative group/menu">
              <button
                type="button"
                className={cn(mk.btnQueueRow, "px-3")}
                aria-label="Campaign actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
              <div className={mk.menuPanel}>
                {isActive && (
                  <button
                    type="button"
                    onClick={(e) => onQuickStatus(campaign.id, "PAUSED", e)}
                    className={cn(mk.menuItem, mk.menuItemWarn)}
                  >
                    <Pause className="h-3 w-3" /> Pause
                  </button>
                )}
                <button
                  type="button"
                  onClick={(e) => onQuickStatus(campaign.id, "ARCHIVED", e)}
                  className={cn(mk.menuItem, mk.menuItemDanger)}
                >
                  <Archive className="h-3 w-3" /> Archive
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function RowMetric({
  label,
  value,
  warn,
}: {
  label: string;
  value: string | number;
  warn?: boolean;
}) {
  return (
    <div className={mk.rowMetricCol}>
      <p className={mk.rowMetricLabel}>{label}</p>
      <p className={cn(mk.rowMetricValue, warn && "cinema-metric-warn")}>{value}</p>
    </div>
  );
}
