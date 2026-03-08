import Link from "next/link";
import { DetailCard } from "../../../../components/DetailCard";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";

export default function PbxEventsJobsPage() {
  return (
    <PermissionGate permission="can_view_admin" fallback={<div className="state-box">You do not have PBX event access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="PBX Events and Jobs" subtitle="Track PBX sync events, webhook parsing status, and job diagnostics." />
        <DetailCard title="PBX Admin Event Feed">
          <p className="muted">Use the admin PBX event console for webhook status, parser checks, and event diagnostics.</p>
          <div className="row-actions">
            <Link className="btn" href="/admin/pbx/events">Open PBX Event Console</Link>
          </div>
        </DetailCard>
      </div>
    </PermissionGate>
  );
}
