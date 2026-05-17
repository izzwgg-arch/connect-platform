"use client";

import Link from "next/link";
import { CheckCheck, Inbox, ListOrdered, TrendingUp, Zap } from "lucide-react";
import { CRMEmptyState } from "../CRMEmptyState";
import { CRMCard } from "../CRMCard";
import { CRMStat } from "../CRMStat";
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
      ? "You're caught up on pending"
      : filter === "due"
        ? "No due callbacks"
        : filter === "overdue"
          ? "No overdue callbacks"
          : "No upcoming callbacks";

  if (powerMode) {
    return (
      <CRMEmptyState
        icon={<CheckCheck className="h-14 w-14 text-crm-success" />}
        title="Queue complete"
        description="You've worked through all leads in this power session view."
        action={
          onExitPower ? (
            <button type="button" onClick={onExitPower} className={crm.btnPrimary}>
              Exit power session
            </button>
          ) : null
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <CRMEmptyState
        icon={<Inbox className="h-12 w-12" />}
        title={filterTitle}
        description={
          campaignId
            ? "Nothing in this campaign for this view. Try another snapshot or clear the campaign filter."
            : filter === "pending"
              ? "No pending leads are assigned to you right now."
              : "Nothing in this bucket. Pending leads may still be waiting."
        }
        action={
          <div className="flex flex-wrap justify-center gap-2">
            {campaignId ? (
              <button type="button" onClick={onClearCampaign} className={crm.btnSecondary}>
                Clear campaign filter
              </button>
            ) : null}
            {filter !== "pending" ? (
              <button type="button" onClick={onSwitchPending} className={crm.btnPrimary}>
                View pending queue
              </button>
            ) : (
              <Link href="/crm/queue?mode=power" className={crm.btnPrimary}>
                <Zap className="h-4 w-4" />
                Start power session
              </Link>
            )}
          </div>
        }
      />

      {!statsLoading && stats ? (
        <CRMCard padding="md">
          <p className={crm.label}>Today snapshot</p>
          <dl className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-3">
            <CRMStat label="Dispositions" value={stats.dispositionsToday} />
            <CRMStat label="Calls linked" value={stats.callsLinkedToday} />
            <CRMStat label="Queue remaining" value={stats.queueRemaining} />
            <CRMStat
              label="Overdue callbacks"
              value={stats.myOverdueCallbacks}
              emphasize={stats.myOverdueCallbacks > 0 ? "danger" : "default"}
            />
            <CRMStat label="Due today" value={stats.myCallbacksDueToday} emphasize={stats.myCallbacksDueToday > 0 ? "warn" : "default"} />
            <CRMStat label="Active campaigns" value={stats.activeCampaigns} />
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/crm/dashboard" className={crm.btnGhost}>
              <TrendingUp className="h-4 w-4" />
              Command center
            </Link>
            <Link href="/crm/queue?filter=overdue" className={crm.btnGhost}>
              <ListOrdered className="h-4 w-4" />
              Check overdue
            </Link>
          </div>
        </CRMCard>
      ) : null}
    </div>
  );
}
