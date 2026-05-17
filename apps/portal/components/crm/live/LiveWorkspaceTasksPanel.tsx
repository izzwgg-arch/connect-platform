"use client";

import Link from "next/link";
import { Circle, Plus } from "lucide-react";
import { CRMCard } from "../CRMCard";
import { CRMSection } from "../CRMSection";
import { crm } from "../crmClasses";
import { cn } from "../cn";
import { formatDate } from "../contact/contactFormatters";
import type { CrmTask } from "./liveTypes";

export function LiveWorkspaceTasksPanel({
  tasks,
  contactId,
}: {
  tasks: CrmTask[];
  contactId: string;
}) {
  return (
    <CRMCard padding="md">
      <CRMSection
        title="Open tasks"
        description={tasks.length > 0 ? `${tasks.length} due or in progress` : "No open tasks"}
      >
        {tasks.length === 0 ? (
          <p className="text-sm text-crm-muted">No open tasks for this contact.</p>
        ) : (
          <ul className="space-y-2">
            {tasks.map((task) => (
              <li
                key={task.id}
                className="rounded-crm border border-crm-border/80 bg-crm-surface-2/50 px-3 py-2"
              >
                <div className="flex items-start gap-2">
                  <Circle className="mt-0.5 h-3 w-3 shrink-0 text-crm-warning" />
                  <span className="text-sm font-medium text-crm-text">{task.title}</span>
                </div>
                {task.dueAt ? (
                  <p className="mt-1 pl-5 text-xs text-crm-warning">
                    Due {formatDate(task.dueAt)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <Link
          href={`/crm/contacts/${contactId}#tasks`}
          className={cn(crm.btnGhost, "mt-3 w-full justify-center border border-dashed border-crm-border text-xs")}
        >
          <Plus className="h-3.5 w-3.5" />
          Add task on profile
        </Link>
      </CRMSection>
    </CRMCard>
  );
}
