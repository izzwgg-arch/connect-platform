"use client";

import type { ReactNode } from "react";
import { Activity, CalendarClock, CheckSquare, MessageSquareDot, Phone } from "lucide-react";
import { CRMCard, CRMSection, CRMStat } from "..";
import { CRMRingMetric } from "../charts";
import type { CrmTask, TimelineEvent } from "./contactTypes";
import { formatTimeAgo } from "./contactFormatters";

export function ContactRelationshipHealth({
  timeline,
  openTasks,
  overdueTasks,
  lastTouchAt,
  daysSinceComm,
  callbackUrgent,
  recentActivityCount,
}: {
  timeline: TimelineEvent[];
  openTasks: CrmTask[];
  overdueTasks: number;
  lastTouchAt: string | null;
  daysSinceComm: number | null;
  callbackUrgent: boolean;
  recentActivityCount: number;
}) {
  const callCount = timeline.filter((e) => e.type.startsWith("CDR_")).length;
  const smsCount = timeline.filter((e) => e.type.startsWith("SMS_")).length;

  return (
    <CRMCard padding="md">
      <CRMSection title="Relationship health" description="From real activity on this contact">
        <div className="flex flex-col gap-4">
          <CRMRingMetric
            value={recentActivityCount}
            max={Math.max(recentActivityCount, 10)}
            label="Touches (7d)"
            sublabel={lastTouchAt ? `Last ${formatTimeAgo(lastTouchAt)}` : "No recent touch"}
            color={recentActivityCount > 0 ? "var(--crm-accent)" : "var(--crm-muted)"}
            size={76}
            stroke={8}
          />
          <StatGrid>
            <CRMStat label="Open tasks" value={openTasks.length} emphasize={overdueTasks > 0 ? "danger" : "default"} />
            {overdueTasks > 0 ? (
              <CRMStat label="Overdue" value={overdueTasks} emphasize="danger" />
            ) : null}
            <CRMStat label="Calls" value={callCount} />
            <CRMStat label="SMS" value={smsCount} />
            {daysSinceComm != null && daysSinceComm > 7 ? (
              <CRMStat label="Comm gap" value={`${daysSinceComm}d`} emphasize="warn" />
            ) : null}
            {callbackUrgent ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-crm-danger/40 bg-crm-danger/10 px-2 py-0.5 text-xs font-medium text-crm-danger">
                <CalendarClock className="h-3 w-3" />
                Callback pressure
              </span>
            ) : null}
          </StatGrid>
          <div className="flex flex-wrap gap-2 text-[11px] text-crm-muted">
            {callCount > 0 ? (
              <span className="inline-flex items-center gap-1">
                <Phone className="h-3 w-3" />
                {callCount} logged
              </span>
            ) : null}
            {smsCount > 0 ? (
              <span className="inline-flex items-center gap-1">
                <MessageSquareDot className="h-3 w-3" />
                {smsCount} messages
              </span>
            ) : null}
            {openTasks.length > 0 ? (
              <span className="inline-flex items-center gap-1">
                <CheckSquare className="h-3 w-3" />
                {openTasks.length} follow-ups
              </span>
            ) : null}
            {recentActivityCount === 0 ? (
              <span className="inline-flex items-center gap-1">
                <Activity className="h-3 w-3" />
                Quiet week — plan next touch
              </span>
            ) : null}
          </div>
        </div>
      </CRMSection>
    </CRMCard>
  );
}

function StatGrid({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-x-4 gap-y-2">{children}</div>;
}
