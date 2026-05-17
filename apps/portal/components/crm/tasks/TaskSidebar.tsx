"use client";

import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CheckSquare,
  Megaphone,
  PhoneCall,
  Users,
  Zap,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { CRMCard } from "../CRMCard";
import { CRMRingMetric } from "../charts/CRMRingMetric";
import type { TaskStats } from "./TaskKpiStrip";

// ── Sub-components ────────────────────────────────────────────────────────────

function SideSection({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <p className={crm.label}>{title}</p>
      {children}
    </div>
  );
}

function SideMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "danger" | "warning" | "neutral";
}) {
  const valueClass =
    tone === "danger"
      ? "text-crm-danger"
      : tone === "warning"
        ? "text-crm-warning"
        : "text-crm-text";
  return (
    <div className={cn(crm.metricTile, "min-h-[3.25rem]")}>
      <p className="text-[10px] font-medium uppercase tracking-wide text-crm-muted">{label}</p>
      <p className={cn("mt-0.5 text-lg font-bold tabular-nums leading-none", valueClass)}>
        {value}
      </p>
    </div>
  );
}

// ── TaskSidebar ───────────────────────────────────────────────────────────────

export function TaskSidebar({
  stats,
  statsLoading,
}: {
  stats: TaskStats | null;
  statsLoading: boolean;
}) {
  const overdue = stats?.overdue ?? 0;
  const myOpen = stats?.myOpen ?? 0;
  const myOverdue = stats?.myTasksOverdue ?? 0;
  const myDueToday = stats?.myTasksDueToday ?? 0;
  const dueToday = stats?.dueToday ?? 0;

  // Ring: overdue vs. open (my tasks urgency pressure)
  const ringTotal = Math.max(myOpen, 1);
  const ringOverdue = Math.min(myOverdue, ringTotal);

  return (
    <CRMCard padding="md" className={cn(crm.sidebarCard, "flex flex-col gap-4")}>
      {/* Urgency ring */}
      {!statsLoading && myOpen > 0 && (
        <SideSection title="My task urgency">
          <CRMRingMetric
            value={ringOverdue}
            max={ringTotal}
            size={72}
            stroke={8}
            label={`${myOpen} open`}
            sublabel={
              myOverdue > 0
                ? `${myOverdue} overdue`
                : myDueToday > 0
                  ? `${myDueToday} due today`
                  : "on track"
            }
            color={
              myOverdue > 0
                ? "var(--crm-danger)"
                : myDueToday > 0
                  ? "var(--crm-warning)"
                  : "var(--crm-accent)"
            }
          />
        </SideSection>
      )}

      {/* Follow-up pressure */}
      <SideSection title="Workload snapshot">
        {statsLoading ? (
          <p className={crm.muted}>Loading…</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <SideMetric
              label="Overdue"
              value={overdue}
              tone={overdue > 0 ? "danger" : "neutral"}
            />
            <SideMetric
              label="Due today"
              value={dueToday}
              tone={dueToday > 0 ? "warning" : "neutral"}
            />
          </div>
        )}
      </SideSection>

      {/* Urgency action shortcuts */}
      {!statsLoading && (overdue > 0 || dueToday > 0) && (
        <SideSection title="Quick focus">
          {overdue > 0 && (
            <Link
              href="/crm/tasks?due=overdue"
              className={cn(crm.btnDanger, "w-full justify-between text-xs")}
            >
              <span className="flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5" />
                {overdue} overdue task{overdue !== 1 ? "s" : ""}
              </span>
              <ArrowRight className="h-3.5 w-3.5 opacity-70" />
            </Link>
          )}
          {dueToday > 0 && (
            <Link
              href="/crm/tasks?due=today"
              className={cn(
                crm.btnSecondary,
                "w-full justify-between text-xs border-crm-warning/35 text-crm-warning hover:bg-crm-warning/10",
              )}
            >
              <span className="flex items-center gap-1.5">
                <CheckSquare className="h-3.5 w-3.5" />
                {dueToday} due today
              </span>
              <ArrowRight className="h-3.5 w-3.5 opacity-70" />
            </Link>
          )}
        </SideSection>
      )}

      {/* Workspace shortcuts */}
      <SideSection title="Workspace links" className="mt-auto border-t border-crm-border/60 pt-3">
        <Link
          href="/crm/queue"
          className={cn(crm.btnGhost, "w-full justify-start px-2 text-xs")}
        >
          <PhoneCall className="h-3.5 w-3.5 shrink-0 text-crm-accent" />
          My queue
        </Link>
        <Link
          href="/crm/campaigns?status=ACTIVE"
          className={cn(crm.btnGhost, "w-full justify-start px-2 text-xs")}
        >
          <Megaphone className="h-3.5 w-3.5 shrink-0 text-crm-accent" />
          Active campaigns
        </Link>
        <Link
          href="/crm/contacts"
          className={cn(crm.btnGhost, "w-full justify-start px-2 text-xs")}
        >
          <Users className="h-3.5 w-3.5 shrink-0 text-crm-accent" />
          Contacts
        </Link>
        <Link
          href="/crm/queue?mode=power"
          className={cn(crm.btnGhost, "w-full justify-start px-2 text-xs")}
        >
          <Zap className="h-3.5 w-3.5 shrink-0 text-crm-accent" />
          Power session
        </Link>
      </SideSection>
    </CRMCard>
  );
}
