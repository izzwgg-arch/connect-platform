import Link from "next/link";
import { DetailCard } from "../../../../components/DetailCard";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";

export default function PbxSoftphonePage() {
  return (
    <PermissionGate permission="can_view_calls" fallback={<div className="state-box">You do not have softphone access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="WebRTC / Softphone" subtitle="Operator softphone view with registration and media diagnostics." />
        <DetailCard title="Softphone Console">
          <p className="muted">Use the voice phone surface for live call controls, dialer actions, and extension-linked call activity.</p>
          <div className="row-actions">
            <Link className="btn" href="/dashboard/voice/phone">Open Softphone</Link>
            <Link className="btn ghost" href="/settings/webrtc">Media Policy Settings</Link>
          </div>
        </DetailCard>
      </div>
    </PermissionGate>
  );
}
