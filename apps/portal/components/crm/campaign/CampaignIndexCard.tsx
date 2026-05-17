"use client";

import Link from "next/link";
import {
  Archive,
  ExternalLink,
  ListOrdered,
  Pause,
  Play,
  Users,
  Zap,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { CRMCard } from "../CRMCard";
import { CRMRingMetric } from "../charts/CRMRingMetric";
import type { CampaignListItem, CampaignReportRow } from "./campaignTypes";
import { CampaignPriorityBadge, CampaignStatusBadge } from "./CampaignStatusBadge";
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
  const converted = metrics?.converted ?? 0;
  const conversionRate = metrics?.conversionRate ?? 0;
  const isActive = campaign.status === "ACTIVE";
  const hasPressure = callbacks > 0 || activeWork > 10;

  return (
    <CRMCard
      className={cn(
        "p-0 overflow-hidden transition-colors",
        isActive && "border-crm-accent/35 ring-1 ring-crm-accent/15",
        hasPressure && !isActive && "border-crm-warning/25",
      )}
    >
      <div className="flex flex-col lg:flex-row lg:items-stretch">
        <div className="min-w-0 flex-1 p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/crm/campaigns/${campaign.id}`}
              className="truncate text-base font-semibold text-crm-text hover:text-crm-accent"
            >
              {campaign.name}
            </Link>
            <CampaignStatusBadge status={campaign.status} />
            <CampaignPriorityBadge priority={campaign.priority ?? "NORMAL"} hideNormal />
          </div>

          {campaign.description ? (
            <p className="mt-1.5 line-clamp-2 text-sm text-crm-muted">{campaign.description}</p>
          ) : null}

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            <StatMini label="Members" value={members} />
            <StatMini label="Queue work" value={activeWork} warn={activeWork > 0 && isActive} />
            <StatMini label="Callbacks" value={callbacks} warn={callbacks > 0} />
            <StatMini
              label="Converted"
              value={metrics ? `${converted} (${conversionRate}%)` : String(converted)}
            />
          </dl>

          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-crm-muted">
            <span className="inline-flex items-center gap-1">
              <Users className="h-3.5 w-3.5" aria-hidden />
              {members} enrolled
            </span>
            <span>Updated {formatShortDate(campaign.updatedAt)}</span>
            {(campaign.script || campaign.checklist) && (
              <span className="text-crm-muted/80">
                {campaign.script ? campaign.script.name : ""}
                {campaign.script && campaign.checklist ? " · " : ""}
                {campaign.checklist ? campaign.checklist.name : ""}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-crm-border/60 bg-crm-surface-2/40 p-4 lg:w-56 lg:border-t-0 lg:border-l lg:shrink-0">
          {metrics && members > 0 ? (
            <CRMRingMetric
              value={converted}
              max={members}
              label="Converted"
              sublabel={`${conversionRate}% of roster`}
              color="var(--crm-success)"
              size={72}
              stroke={8}
            />
          ) : (
            <p className="text-xs text-crm-muted leading-snug">
              {members === 0
                ? "No members — import or add contacts to start outbound work."
                : "Open for workload breakdown."}
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <Link
              href={`/crm/campaigns/${campaign.id}`}
              className={cn(crm.btnSecondary, "w-full justify-center text-xs py-2")}
            >
              Open workspace
              <ExternalLink className="h-3.5 w-3.5 opacity-70" aria-hidden />
            </Link>
            {canQueue && (
              <Link href={queueHref(campaign.id)} className={cn(crm.btnGhost, "w-full justify-center text-xs py-2")}>
                <ListOrdered className="h-3.5 w-3.5" />
                Queue
              </Link>
            )}
            {canQueue && isActive && (
              <Link
                href={`/crm/queue?mode=power&campaignId=${encodeURIComponent(campaign.id)}`}
                className={cn(crm.btnGhost, "w-full justify-center text-xs py-2")}
              >
                <Zap className="h-3.5 w-3.5" />
                Power session
              </Link>
            )}
          </div>

          {isAdmin && (
            <div className="flex flex-wrap gap-1.5 pt-1 border-t border-crm-border/50">
              {campaign.status === "DRAFT" && (
                <button
                  type="button"
                  onClick={(e) => onQuickStatus(campaign.id, "ACTIVE", e)}
                  className={cn(crm.btnGhost, "text-xs py-1.5 px-2 text-crm-success")}
                  title="Start"
                >
                  <Play className="h-3.5 w-3.5" /> Start
                </button>
              )}
              {campaign.status === "ACTIVE" && (
                <button
                  type="button"
                  onClick={(e) => onQuickStatus(campaign.id, "PAUSED", e)}
                  className={cn(crm.btnGhost, "text-xs py-1.5 px-2 text-crm-warning")}
                  title="Pause"
                >
                  <Pause className="h-3.5 w-3.5" /> Pause
                </button>
              )}
              {campaign.status === "PAUSED" && (
                <button
                  type="button"
                  onClick={(e) => onQuickStatus(campaign.id, "ACTIVE", e)}
                  className={cn(crm.btnGhost, "text-xs py-1.5 px-2 text-crm-success")}
                  title="Resume"
                >
                  <Play className="h-3.5 w-3.5" /> Resume
                </button>
              )}
              {(campaign.status === "ACTIVE" || campaign.status === "PAUSED") && (
                <button
                  type="button"
                  onClick={(e) => onQuickStatus(campaign.id, "ARCHIVED", e)}
                  className="p-1.5 text-crm-muted hover:text-crm-text rounded"
                  title="Archive"
                  aria-label="Archive"
                >
                  <Archive className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </CRMCard>
  );
}

function StatMini({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">{label}</dt>
      <dd className={cn("mt-0.5 text-lg font-semibold tabular-nums", warn ? "text-crm-warning" : "text-crm-text")}>
        {value}
      </dd>
    </div>
  );
}
