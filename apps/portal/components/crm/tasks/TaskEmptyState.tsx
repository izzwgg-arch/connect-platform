"use client";

import Link from "next/link";
import {
  CheckCircle2,
  Clock,
  AlertCircle,
  ListChecks,
  Plus,
  Search,
} from "lucide-react";
import { cn } from "../cn";
import type { TaskStats } from "./TaskKpiStrip";
import type { TaskTab } from "./TaskKpiStrip";

type EmptyCopy = {
  icon: React.ReactNode;
  title: string;
  body: string;
  tone: string;
};

export function TaskEmptyState({
  tab,
  stats,
  onAddTask,
}: {
  tab: TaskTab;
  stats: TaskStats | null;
  onAddTask: () => void;
}) {
  const copy: EmptyCopy =
    tab === "overdue"
      ? {
          icon: <CheckCircle2 className="h-9 w-9" />,
          title: "No overdue tasks",
          body: "Everything past due is clear. Keep the team moving with the next follow-up.",
          tone: "text-crm-success",
        }
      : tab === "today"
        ? {
            icon: <Clock className="h-9 w-9" />,
            title: "Nothing due today",
            body:
              (stats?.overdue ?? 0) > 0
                ? `You still have ${stats!.overdue} overdue task${stats!.overdue !== 1 ? "s" : ""} that need attention.`
                : "No tasks are due today. Schedule the next customer touchpoint when you are ready.",
            tone: "text-crm-warning",
          }
        : tab === "completed"
          ? {
              icon: <CheckCircle2 className="h-9 w-9" />,
              title: "No completed tasks yet",
              body: "Completed work will appear here once tasks are marked done.",
              tone: "text-crm-success",
            }
          : {
              icon: <ListChecks className="h-9 w-9" />,
              title: "No tasks yet",
              body: "Tasks track follow-ups, callbacks, and action items linked to real contacts.",
              tone: "text-crm-accent",
            };

  return (
    <div className="tasks-empty-state">
      <div className={cn("tasks-empty-icon", copy.tone)}>{copy.icon}</div>
      <p className="text-lg font-semibold tracking-tight text-crm-text">{copy.title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-crm-muted">{copy.body}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {(stats?.overdue ?? 0) > 0 && tab !== "overdue" && (
          <Link href="/crm/tasks?due=overdue" className="tasks-secondary-action text-xs">
            <AlertCircle className="h-3.5 w-3.5" />
            {stats!.overdue} overdue
          </Link>
        )}
        <button type="button" onClick={onAddTask} className="tasks-primary-action">
          <Plus className="h-3.5 w-3.5" />
          Create New Task
        </button>
        <Link href="/crm/contacts" className="tasks-secondary-action">
          <Search className="h-3.5 w-3.5" />
          Add from Contact
        </Link>
      </div>
    </div>
  );
}
