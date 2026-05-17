"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  CalendarClock,
  Headset,
  ListOrdered,
  Megaphone,
  Users,
} from "lucide-react";
import { CRMCard } from "../CRMCard";
import { CRMEmptyState } from "../CRMEmptyState";
import { CRMPageHeader } from "../CRMPageHeader";
import { CRMStat } from "../CRMStat";
import { crm } from "../crmClasses";
import type { QueueOperationalStats } from "../queue/queueTypes";

export function LiveWorkspaceIdle({
  stats,
  statsLoading,
}: {
  stats: QueueOperationalStats | null;
  statsLoading: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <CRMPageHeader
        icon={<Headset className="h-5 w-5" />}
        title="Ready for live work"
        subtitle="Your communication cockpit for calls, notes, disposition, and timeline — open a contact from queue, campaigns, or an incoming screen pop."
        actions={
          <Link href="/crm/queue" className={crm.btnPrimary}>
            <ListOrdered className="h-4 w-4" />
            Open queue
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <QuickLink
          href="/crm/queue"
          icon={<ListOrdered className="h-5 w-5" />}
          label="My Queue"
          detail="Work pending leads and callbacks"
        />
        <QuickLink
          href="/crm/contacts"
          icon={<Users className="h-5 w-5" />}
          label="Contacts"
          detail="Find a contact and open workspace"
        />
        <QuickLink
          href="/crm/campaigns"
          icon={<Megaphone className="h-5 w-5" />}
          label="Campaigns"
          detail="Campaign lists and member context"
        />
        <QuickLink
          href="/crm/queue?filter=overdue"
          icon={<CalendarClock className="h-5 w-5" />}
          label="Overdue callbacks"
          detail="Prioritize due follow-ups"
        />
      </div>

      <CRMCard padding="lg">
        <p className={crm.label}>How this workspace works</p>
        <ul className="mt-3 space-y-2 text-sm text-crm-muted">
          <li>• Incoming calls screen-pop here with contact context and live telephony state when available.</li>
          <li>• From My Queue, use <strong className="text-crm-text">Work</strong> to open a lead with campaign script and checklist.</li>
          <li>• Log notes, disposition, and follow-up tasks without leaving the call — timeline updates from real CRM events.</li>
        </ul>
      </CRMCard>

      {!statsLoading && stats ? (
        <CRMCard padding="md">
          <p className={crm.label}>Your workload snapshot</p>
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <CRMStat label="Queue remaining" value={stats.queueRemaining} />
            <CRMStat
              label="Overdue callbacks"
              value={stats.myOverdueCallbacks}
              emphasize={stats.myOverdueCallbacks > 0 ? "danger" : "default"}
            />
            <CRMStat
              label="Due today"
              value={stats.myCallbacksDueToday}
              emphasize={stats.myCallbacksDueToday > 0 ? "warn" : "default"}
            />
            <CRMStat label="Open tasks" value={stats.myOpen} />
            <CRMStat label="Dispositions today" value={stats.dispositionsToday} />
            <CRMStat label="Active campaigns" value={stats.activeCampaigns} />
          </dl>
        </CRMCard>
      ) : null}

      <CRMEmptyState
        icon={<Headset className="h-12 w-12" />}
        title="No contact in session"
        description="Select a lead from the queue or wait for an incoming call — this page stays useful as your live desk even between calls."
      />
    </div>
  );
}

function QuickLink({
  href,
  icon,
  label,
  detail,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  detail: string;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-2 rounded-crm-lg border border-crm-border bg-crm-surface p-4 transition-colors hover:border-crm-accent/40 hover:bg-crm-surface-2"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-crm bg-crm-accent/15 text-crm-accent group-hover:bg-crm-accent/25">
        {icon}
      </div>
      <div>
        <p className="text-sm font-semibold text-crm-text">{label}</p>
        <p className="mt-0.5 text-xs text-crm-muted">{detail}</p>
      </div>
    </Link>
  );
}
