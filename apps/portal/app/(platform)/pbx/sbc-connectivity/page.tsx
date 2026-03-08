import Link from "next/link";
import { DetailCard } from "../../../../components/DetailCard";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";

export default function PbxSbcConnectivityPage() {
  return (
    <PermissionGate permission="can_view_calls" fallback={<div className="state-box">You do not have SBC diagnostics access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="SBC / Voice Connectivity" subtitle="WebRTC transport diagnostics, SBC readiness checks, and media path validation." />
        <DetailCard title="Connectivity Diagnostics">
          <p className="muted">Run remote connectivity probes, review media transport status, and validate SBC readiness.</p>
          <div className="row-actions">
            <Link className="btn" href="/dashboard/voice/sbc-test">Open SBC Test Console</Link>
            <Link className="btn ghost" href="/dashboard/voice/settings">Voice Transport Settings</Link>
          </div>
        </DetailCard>
      </div>
    </PermissionGate>
  );
}
