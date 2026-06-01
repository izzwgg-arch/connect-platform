"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { BarChart3, CheckCheck, ClipboardList, ListOrdered, Megaphone } from "lucide-react";
import { CRMCard } from "../CRMCard";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { QueueFilter } from "./queueTypes";

export function QueueEmptyOperational({
  filter,
  campaignId,
  onClearCampaign,
  onSwitchPending,
}: {
  filter: QueueFilter;
  campaignId: string | null;
  onClearCampaign: () => void;
  onSwitchPending: () => void;
}) {
  return (
    <CRMCard padding="none" className="crm-queue-empty-workspace">
      <div className="crm-queue-empty-glow" aria-hidden />
      <div className="relative z-[1] grid gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(13rem,0.55fr)_minmax(0,1fr)] lg:items-center lg:p-7">
        <div className="crm-queue-illustration mx-auto flex min-h-[13rem] w-full max-w-[18rem] items-center justify-center">
          <div className="crm-queue-clipboard">
            <ClipboardList className="h-16 w-16" />
            <span className="crm-queue-check crm-queue-check-1" />
            <span className="crm-queue-check crm-queue-check-2" />
            <span className="crm-queue-check crm-queue-check-3" />
          </div>
        </div>
        <div className="min-w-0">
          <span className="crm-queue-success-pill mb-3 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wide">
            <CheckCheck className="h-3.5 w-3.5" />
            Queue calm
          </span>
          <h2 className="crm-queue-empty-title text-2xl font-bold tracking-tight text-crm-text sm:text-3xl">
            You're all caught up
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-crm-muted sm:text-[0.95rem]">
            {campaignId
              ? "No tasks in this campaign snapshot. Keep your workspace ready or clear the campaign filter."
              : filter === "pending"
                ? "No tasks in your queue right now. Enjoy the calm before the next opportunity."
                : "This queue snapshot is clear. Switch focus or review the next operational area."}
          </p>

          <div className="mt-5">
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-crm-muted">What you can do next</p>
            <div className="crm-queue-quick-actions grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <QueueQuickAction href="/crm/campaigns?status=ACTIVE" icon={<Megaphone className="h-4 w-4" />} label="Open campaigns" hint="View active campaigns" accent="blue" />
              <QueueQuickAction href="/crm/campaigns" icon={<Megaphone className="h-4 w-4" />} label="Import leads" hint="Create campaign then import" accent="green" />
              <QueueQuickAction href="/crm/reports" icon={<BarChart3 className="h-4 w-4" />} label="View reports" hint="See performance" accent="cyan" />
            </div>
          </div>

          <EmptyActions
            campaignId={campaignId}
            filter={filter}
            onClearCampaign={onClearCampaign}
            onSwitchPending={onSwitchPending}
          />
        </div>
      </div>
    </CRMCard>
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
  if (!campaignId && filter === "pending") return null;

  return (
    <div className="mt-4 flex flex-wrap gap-2">
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
      ) : null}
    </div>
  );
}

function QueueQuickAction({
  href,
  icon,
  label,
  hint,
  accent,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  hint: string;
  accent: "blue" | "green" | "violet" | "cyan";
}) {
  return (
    <Link href={href} className={cn("crm-queue-quick-action", `crm-queue-quick-action-${accent}`)}>
      <span className="crm-queue-quick-action-icon">{icon}</span>
      <span className="min-w-0">
        <span className="block text-xs font-bold text-crm-text">{label}</span>
        <span className="mt-0.5 block text-[10px] leading-tight text-crm-muted">{hint}</span>
      </span>
    </Link>
  );
}
