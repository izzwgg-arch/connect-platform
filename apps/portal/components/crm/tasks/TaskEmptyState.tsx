"use client";

import Link from "next/link";
import {
  CheckCircle2,
  Clock,
  AlertCircle,
  ListChecks,
  Plus,
  PhoneCall,
  Megaphone,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { TaskStats } from "./TaskKpiStrip";

type Tab = "mine" | "today" | "overdue" | "all";

export function TaskEmptyState({
  tab,
  stats,
  onAddTask,
}: {
  tab: Tab;
  stats: TaskStats | null;
  onAddTask: () => void;
}) {
  if (tab === "overdue") {
    return (
      <div className={cn(crm.emptyWrap, "border-crm-success/30 bg-crm-success/5")}>
        <CheckCircle2 className="mx-auto mb-3 h-8 w-8 text-crm-success" />
        <p className={crm.emptyTitle}>No overdue tasks</p>
        <p className={crm.emptyBody}>You're all caught up. No tasks are past their due date.</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Link href="/crm/queue" className={crm.btnSecondary}>
            <PhoneCall className="h-3.5 w-3.5" />
            Go to queue
          </Link>
        </div>
      </div>
    );
  }

  if (tab === "today") {
    return (
      <div className={cn(crm.emptyWrap)}>
        <Clock className="mx-auto mb-3 h-8 w-8 text-crm-muted" />
        <p className={crm.emptyTitle}>Nothing due today</p>
        <p className={crm.emptyBody}>
          {(stats?.overdue ?? 0) > 0
            ? `You have ${stats!.overdue} overdue task${stats!.overdue !== 1 ? "s" : ""} that need attention.`
            : "No tasks are due today. Check upcoming tasks or add one now."}
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {(stats?.overdue ?? 0) > 0 && (
            <Link href="/crm/tasks?due=overdue" className={cn(crm.btnDanger, "text-xs")}>
              <AlertCircle className="h-3.5 w-3.5" />
              {stats!.overdue} overdue
            </Link>
          )}
          <button type="button" onClick={onAddTask} className={crm.btnPrimary}>
            <Plus className="h-3.5 w-3.5" />
            Add task
          </button>
        </div>
      </div>
    );
  }

  if (tab === "mine") {
    return (
      <div className={cn(crm.emptyWrap)}>
        <ListChecks className="mx-auto mb-3 h-8 w-8 text-crm-muted" />
        <p className={crm.emptyTitle}>No open tasks assigned to you</p>
        <p className={crm.emptyBody}>
          {(stats?.dueToday ?? 0) > 0 || (stats?.overdue ?? 0) > 0
            ? `There are ${(stats?.overdue ?? 0) + (stats?.dueToday ?? 0)} tasks needing attention in the team.`
            : "Your task queue is clear. Add a new task or check the all-tasks view."}
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <button type="button" onClick={onAddTask} className={crm.btnPrimary}>
            <Plus className="h-3.5 w-3.5" />
            Add task
          </button>
          <Link href="/crm/queue" className={crm.btnSecondary}>
            <PhoneCall className="h-3.5 w-3.5" />
            My queue
          </Link>
        </div>
      </div>
    );
  }

  // "all" tab — empty
  return (
    <div className={cn(crm.emptyWrap)}>
      <ListChecks className="mx-auto mb-3 h-8 w-8 text-crm-muted" />
      <p className={crm.emptyTitle}>No tasks yet</p>
      <p className={crm.emptyBody}>
        Tasks track follow-ups, callbacks, and action items linked to your contacts.
        Create a task from a contact workspace or from here.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <button type="button" onClick={onAddTask} className={crm.btnPrimary}>
          <Plus className="h-3.5 w-3.5" />
          Add first task
        </button>
        <Link href="/crm/contacts" className={crm.btnSecondary}>
          Browse contacts
        </Link>
        <Link href="/crm/campaigns?status=ACTIVE" className={crm.btnSecondary}>
          <Megaphone className="h-3.5 w-3.5" />
          Campaigns
        </Link>
      </div>
    </div>
  );
}
