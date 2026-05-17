"use client";

import { CRMPageShell } from "../../../../components/crm/CRMPageShell";
import { TaskCommandDesk } from "../../../../components/crm/tasks/TaskCommandDesk";

export default function CrmTasksPage() {
  return (
    <CRMPageShell>
      <TaskCommandDesk />
    </CRMPageShell>
  );
}
