"use client";

import { CRMPageShell } from "../../../../components/crm/CRMPageShell";
import { crm } from "../../../../components/crm/crmClasses";
import { PermissionGate } from "../../../../components/PermissionGate";
import { FormsCommandDesk } from "../../../../components/crm/forms/FormsCommandDesk";

export default function CrmFormsPage() {
  return (
    <CRMPageShell className={crm.tasksWorkspace} innerClassName={crm.pageInnerTasks}>
      <PermissionGate permission="can_view_crm_forms" fallback={<div className="state-box">You do not have Forms access.</div>}>
        <FormsCommandDesk />
      </PermissionGate>
    </CRMPageShell>
  );
}
