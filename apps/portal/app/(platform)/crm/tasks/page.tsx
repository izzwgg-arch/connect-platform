"use client";

import { CRMPageShell } from "../../../../components/crm/CRMPageShell";
import { crm } from "../../../../components/crm/crmClasses";
import { cn } from "../../../../components/crm/cn";
import { TaskCommandDesk } from "../../../../components/crm/tasks/TaskCommandDesk";

export default function CrmTasksPage() {
  return (
    <CRMPageShell
      className={cn(crm.queueWorkspace, crm.checklistWorkspace, crm.tasksWorkspace)}
      innerClassName={crm.pageInnerChecklist}
    >
      <TaskCommandDesk />
    </CRMPageShell>
  );
}
