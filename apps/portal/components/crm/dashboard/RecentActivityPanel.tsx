"use client";

import Link from "next/link";
import { CalendarClock, CheckCircle2, PhoneCall, UserPlus } from "lucide-react";
import { CRMCard } from "../CRMCard";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { DashboardSectionHeader } from "./DashboardSectionHeader";

export type ActivityItem = {
  id: string;
  time: string; // preformatted like 08:45 or May 12, 3:14 PM
  type: "call" | "callback" | "outcome" | "contact";
  text: string; // short description without names
  href?: string;
};

export function RecentActivityPanel({ items }: { items: ActivityItem[] }) {
  return (
    <CRMCard className={cn("crm-dashboard-panel p-5", crm.opCard, "border-crm-border/80")}>
      <div className={crm.opCardGlow} />
      <div className="relative z-[1]">
      <DashboardSectionHeader title="Recent activity" action={{ label: "View activity", href: "/crm/reports?tab=operations" }} />
      {items.length === 0 ? (
        <div className="crm-dashboard-empty-soft rounded-crm border border-dashed border-crm-border/70 bg-crm-surface-2/25 px-3 py-4">
          <div className="mb-2 flex items-center gap-2">
            <span className={cn(crm.statusDot, "bg-crm-muted/60")} />
            <p className="text-sm font-semibold text-crm-text">Activity feed standing by</p>
          </div>
          <p className="text-xs leading-relaxed text-crm-muted">New calls, callbacks, outcomes, and contacts will appear here when activity is available.</p>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {items.map((it) => (
            <li key={it.id} className="crm-dashboard-list-row group flex items-center gap-2 rounded-crm border border-crm-border/60 bg-crm-surface-2/40 px-2.5 py-1.5 text-sm text-crm-text transition-all duration-200 hover:-translate-y-px hover:border-crm-border hover:bg-crm-surface-2/70">
              <span className="crm-dashboard-action-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface/60 text-crm-accent">
                {it.type === "call" ? <PhoneCall size={14} /> : it.type === "callback" ? <CalendarClock size={14} /> : it.type === "outcome" ? <CheckCircle2 size={14} /> : <UserPlus size={14} />}
              </span>
              <span className="min-w-0 flex-1 truncate">{it.text}</span>
              <span className="shrink-0 text-[10px] text-crm-muted">{it.time}</span>
              {it.href ? (
                <Link href={it.href} className="ml-1 shrink-0 text-[11px] font-semibold text-crm-accent transition-transform group-hover:translate-x-0.5">
                  Open →
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      </div>
    </CRMCard>
  );
}
