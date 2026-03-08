import Link from "next/link";
import { DetailCard } from "../../../../components/DetailCard";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";

export default function AdminBillingPage() {
  return (
    <PermissionGate permission="can_view_admin" fallback={<div className="state-box">You do not have admin billing access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="Admin Billing" subtitle="Platform billing controls and tenant-level financial diagnostics." />
        <DetailCard title="Billing Admin Controls">
          <p className="muted">Use Billing workspace for tenant invoice lifecycle and payment visibility.</p>
          <div className="row-actions">
            <Link className="btn ghost" href="/billing">Open Billing Workspace</Link>
          </div>
        </DetailCard>
      </div>
    </PermissionGate>
  );
}
