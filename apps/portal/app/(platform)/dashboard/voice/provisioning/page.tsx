"use client";

import { DetailCard } from "../../../../../components/DetailCard";
import { PageHeader } from "../../../../../components/PageHeader";
import { PermissionGate } from "../../../../../components/PermissionGate";
import { QRPairingModal } from "../../../../../components/QRPairingModal";
import { ScopedActionButton } from "../../../../../components/ScopedActionButton";
import { StatusChip } from "../../../../../components/StatusChip";

export default function VoiceProvisioningPage() {
  return (
    <PermissionGate permission="can_view_calls" fallback={<div className="state-box">You do not have provisioning access.</div>}>
      <div className="stack compact-stack">
        <PageHeader
          title="Voice Provisioning"
          subtitle="Provision desk phones, mobile clients, and webphone profiles from one compact console."
          actions={<QRPairingModal />}
        />
        <section className="grid three">
          <DetailCard title="Desk Phones">
            <div className="row-wrap">
              <StatusChip tone="info" label="Yealink" />
              <StatusChip tone="info" label="Fanvil" />
              <StatusChip tone="info" label="Grandstream" />
            </div>
            <p className="muted">Generate one-time provisioning links and configuration bundles for managed devices.</p>
            <div className="row-actions">
              <ScopedActionButton className="btn">Generate Config</ScopedActionButton>
              <ScopedActionButton className="btn ghost">Copy URL</ScopedActionButton>
            </div>
          </DetailCard>
          <DetailCard title="Mobile App Pairing">
            <p className="muted">Use QR pairing for one-time enrollment and tokenized extension access.</p>
            <div className="row-actions">
              <QRPairingModal />
              <ScopedActionButton className="btn ghost">Reset Pairing</ScopedActionButton>
            </div>
          </DetailCard>
          <DetailCard title="Webphone">
            <p className="muted">Issue softphone credentials with least-privilege policy and rotation controls.</p>
            <div className="row-actions">
              <ScopedActionButton className="btn">Create Profile</ScopedActionButton>
              <ScopedActionButton className="btn ghost">Revoke Session</ScopedActionButton>
            </div>
          </DetailCard>
        </section>
      </div>
    </PermissionGate>
  );
}
