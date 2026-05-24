"use client";

import Link from "next/link";
import { CalendarClock, CheckCircle2, PhoneCall, UserPlus } from "lucide-react";
import { CRMCard } from "../CRMCard";
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
    <CRMCard className="p-5">
      <DashboardSectionHeader title="Recent activity" action={{ label: "View activity", href: "/crm/reports?tab=operations" }} />
      {items.length === 0 ? (
        <div className="rounded-crm border border-dashed border-crm-border/70 px-3 py-5 text-center">
          <p className="text-sm font-medium text-crm-text">No recent CRM activity yet</p>
          <p className="mt-1 text-xs text-crm-muted">New calls, callbacks, outcomes, and contacts will appear here.</p>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {items.map((it) => (
            <li key={it.id} className="flex items-center gap-2 rounded-crm border border-crm-border/60 bg-crm-surface-2/40 px-2.5 py-1.5 text-sm text-crm-text">
              <span className="shrink-0 text-crm-accent">
                {it.type === "call" ? <PhoneCall size={14} /> : it.type === "callback" ? <CalendarClock size={14} /> : it.type === "outcome" ? <CheckCircle2 size={14} /> : <UserPlus size={14} />}
              </span>
              <span className="min-w-0 flex-1 truncate">{it.text}</span>
              <span className="shrink-0 text-[10px] text-crm-muted">{it.time}</span>
              {it.href ? (
                <Link href={it.href} className="ml-1 shrink-0 text-[11px] font-semibold text-crm-accent">
                  Open →
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </CRMCard>
  );
}
