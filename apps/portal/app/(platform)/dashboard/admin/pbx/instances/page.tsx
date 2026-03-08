import Link from "next/link";
import { DetailCard } from "../../../../../../components/DetailCard";
import { PageHeader } from "../../../../../../components/PageHeader";
import { PermissionGate } from "../../../../../../components/PermissionGate";

export default function DashboardPbxInstancesPage() {
  return (
    <PermissionGate permission="can_view_admin" fallback={<div className="state-box">You do not have PBX admin access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="PBX Instances" subtitle="Operational entry point for VitalPBX connectivity and tenant-level instance controls." />
        <DetailCard title="Manage VitalPBX Connections">
          <p className="muted">Use the configured instance workspace to save credentials, test health, and toggle active instance status.</p>
          <div className="row-actions">
            <Link className="btn" href="/admin/pbx">Open PBX Connections</Link>
          </div>
        </DetailCard>
      </div>
    </PermissionGate>
  );
}
