"use client";

import { CRMPageShell } from "../../../../components/crm/CRMPageShell";
import { crm } from "../../../../components/crm/crmClasses";
import { TaskCommandDesk } from "../../../../components/crm/tasks/TaskCommandDesk";

export default function CrmTasksPage() {
  return (
    <CRMPageShell className={crm.tasksWorkspace} innerClassName={crm.pageInnerTasks}>
      <TaskCommandDesk />
    </CRMPageShell>
  );
}
