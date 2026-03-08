import Link from "next/link";
import { DetailCard } from "../../../../components/DetailCard";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";

export default function PbxProvisioningPage() {
  return (
    <PermissionGate permission="can_view_calls" fallback={<div className="state-box">You do not have provisioning access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="Phone Provisioning" subtitle="Provision desk phones, mobile clients, and webphone profiles." />
        <DetailCard title="Provisioning Workspace">
          <p className="muted">Use the provisioning console for QR pairing, profile generation, and tokenized onboarding.</p>
          <div className="row-actions">
            <Link className="btn" href="/dashboard/voice/provisioning">Open Provisioning Console</Link>
          </div>
        </DetailCard>
      </div>
    </PermissionGate>
  );
}
