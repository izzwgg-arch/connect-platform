"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { CheckCheck, Inbox, ListOrdered, Zap } from "lucide-react";
import { CRMCard } from "../CRMCard";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { QueueFilter } from "./queueTypes";

export function QueueEmptyOperational({
  filter,
  powerMode,
  campaignId,
  onClearCampaign,
  onSwitchPending,
  onExitPower,
}: {
  filter: QueueFilter;
  powerMode: boolean;
  campaignId: string | null;
  onClearCampaign: () => void;
  onSwitchPending: () => void;
  onExitPower?: () => void;
}) {
  if (powerMode) {
    return (
      <CRMCard padding="md" className={cn(crm.sidebarCard, "border-crm-success/30 bg-crm-success/5")}>
        <CompactEmpty
          icon={<CheckCheck className="h-8 w-8 text-crm-success" />}
          title="Power session complete"
          description="No leads in this view. End session or change filters."
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

  const title =
    filter === "pending"
      ? "Caught up on pending"
      : filter === "due"
        ? "No due callbacks"
        : filter === "overdue"
          ? "No overdue callbacks"
          : "No upcoming callbacks";

  return (
    <CRMCard padding="md" className={crm.sidebarCard}>
      <CompactEmpty
        icon={<Inbox className="h-8 w-8 text-crm-accent/90" />}
        title={title}
        description={
          campaignId
            ? "Nothing in this campaign for this snapshot."
            : filter === "pending"
              ? "No pending leads right now. Try another snapshot or power when work arrives."
              : "This bucket is clear."
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
  );
}

function CompactEmpty({
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
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-crm border border-crm-border/80 bg-crm-surface-2">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-base font-semibold text-crm-text">{title}</p>
        <p className="mt-0.5 text-xs text-crm-muted leading-relaxed">{description}</p>
        {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
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
    </>
  );
}
