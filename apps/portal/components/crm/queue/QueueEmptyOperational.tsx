"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  CheckCheck,
  Inbox,
  ListOrdered,
  Sparkles,
  TrendingUp,
  Zap,
} from "lucide-react";
import { CRMCard } from "../CRMCard";
import { CRMStat } from "../CRMStat";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { QueueFilter, QueueOperationalStats } from "./queueTypes";

export function QueueEmptyOperational({
  filter,
  powerMode,
  campaignId,
  stats,
  statsLoading,
  onClearCampaign,
  onSwitchPending,
  onExitPower,
}: {
  filter: QueueFilter;
  powerMode: boolean;
  campaignId: string | null;
  stats: QueueOperationalStats | null;
  statsLoading: boolean;
  onClearCampaign: () => void;
  onSwitchPending: () => void;
  onExitPower?: () => void;
}) {
  const filterTitle =
    filter === "pending"
      ? "Caught up on pending"
      : filter === "due"
        ? "No due callbacks"
        : filter === "overdue"
          ? "No overdue callbacks"
          : "No upcoming callbacks";

  if (powerMode) {
    return (
      <CRMCard
        padding="lg"
        className="border-crm-success/25 bg-gradient-to-br from-crm-success/8 via-crm-surface to-crm-surface"
      >
        <EmptyBlock
          icon={<CheckCheck className="h-10 w-10 text-crm-success" />}
          title="Power session complete"
          description="No leads left in this view. End the session or change filters."
          actions={
            onExitPower ? (
              <button type="button" onClick={onExitPower} className={crm.btnPrimary}>
                Exit power session
              </button>
            ) : null
          }
        />
      </CRMCard>
    );
  }

  const hasStats = !statsLoading && stats;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
      <CRMCard
        padding="lg"
        className={cn(
          "border-crm-border/90 bg-gradient-to-br from-crm-surface via-crm-surface to-crm-accent/[0.04]",
          hasStats && "lg:min-h-[220px]",
        )}
      >
        <EmptyBlock
          icon={<Inbox className="h-10 w-10 text-crm-accent/90" />}
          title={filterTitle}
          description={
            campaignId
              ? "Nothing in this campaign for the current snapshot."
              : filter === "pending"
                ? "No pending leads assigned — try another snapshot or start power when work arrives."
                : "This bucket is clear. Pending leads may still be waiting."
          }
          actions={
            <EmptyActions
              campaignId={campaignId}
              filter={filter}
              onClearCampaign={onClearCampaign}
              onSwitchPending={onSwitchPending}
            />
          }
        />
      </CRMCard>

      <CRMCard padding="md" className="flex flex-col gap-3 border-crm-border/80">
        <StatsHeader />
        {statsLoading ? (
          <p className={crm.muted}>Loading today…</p>
        ) : hasStats ? (
          <>
            <dl className="grid grid-cols-2 gap-2">
              <CRMStat label="Dispositions" value={stats.dispositionsToday} />
              <CRMStat label="Calls linked" value={stats.callsLinkedToday} />
              <CRMStat label="Queue left" value={stats.queueRemaining} />
              <CRMStat
                label="Overdue CB"
                value={stats.myOverdueCallbacks}
                emphasize={stats.myOverdueCallbacks > 0 ? "danger" : "default"}
              />
              <CRMStat
                label="Due today"
                value={stats.myCallbacksDueToday}
                emphasize={stats.myCallbacksDueToday > 0 ? "warn" : "default"}
              />
              <CRMStat label="Campaigns" value={stats.activeCampaigns} />
            </dl>
            <div className="mt-auto flex flex-wrap gap-2 border-t border-crm-border/60 pt-3">
              <Link href="/crm/dashboard" className={crm.btnGhost}>
                <TrendingUp className="h-4 w-4" />
                Command center
              </Link>
              <Link href="/crm/queue?filter=overdue" className={crm.btnGhost}>
                <ListOrdered className="h-4 w-4" />
                Overdue
              </Link>
              <Link href="/crm/tasks" className={crm.btnGhost}>
                Tasks
              </Link>
            </div>
          </>
        ) : (
          <p className={crm.muted}>Activity stats unavailable.</p>
        )}
      </CRMCard>
    </div>
  );
}

function StatsHeader() {
  return (
    <div>
      <p className={crm.label}>Today</p>
      <p className="mt-0.5 text-xs text-crm-muted">Live from your CRM activity</p>
    </div>
  );
}

function EmptyBlock({
  icon,
  title,
  description,
  actions,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-crm-lg border border-crm-border/80 bg-crm-surface-2/80">
        {icon}
      </div>
      <div className="min-w-0 flex-1 text-left">
        <p className="text-lg font-semibold tracking-tight text-crm-text">{title}</p>
        <p className="mt-1 text-sm text-crm-muted leading-relaxed max-w-prose">{description}</p>
        {actions ? <div className="mt-4 flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

function EmptyActions({
  campaignId,
  filter,
  onClearCampaign,
  onSwitchPending,
}: {
  campaignId: string | null;
  filter: QueueFilter;
  onClearCampaign: () => void;
  onSwitchPending: () => void;
}) {
  return (
    <>
      {campaignId ? (
        <button type="button" onClick={onClearCampaign} className={crm.btnSecondary}>
          Clear campaign
        </button>
      ) : null}
      {filter !== "pending" ? (
        <button type="button" onClick={onSwitchPending} className={crm.btnPrimary}>
          <ListOrdered className="h-4 w-4" />
          View pending
        </button>
      ) : (
        <Link href="/crm/queue?mode=power" className={crm.btnPrimary}>
          <Zap className="h-4 w-4" />
          Power session
        </Link>
      )}
      <Link href="/crm/contacts" className={crm.btnGhost}>
        <Sparkles className="h-4 w-4" />
        Contacts
      </Link>
    </>
  );
}
