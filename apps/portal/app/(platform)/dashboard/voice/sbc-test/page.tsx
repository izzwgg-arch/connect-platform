"use client";

import { DetailCard } from "../../../../../components/DetailCard";
import { PageHeader } from "../../../../../components/PageHeader";
import { PermissionGate } from "../../../../../components/PermissionGate";
import { ScopedActionButton } from "../../../../../components/ScopedActionButton";
import { StatusChip } from "../../../../../components/StatusChip";

export default function VoiceSbcTestPage() {
  return (
    <PermissionGate permission="can_view_calls" fallback={<div className="state-box">You do not have SBC test access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="SBC Test Console" subtitle="Run readiness probes and transport checks for WebRTC and SIP traffic." />
        <section className="grid two">
          <DetailCard title="Connectivity Checks">
            <div className="row-wrap">
              <StatusChip tone="success" label="remoteWsOk: true" />
              <StatusChip tone="success" label="remoteTcpOk: true" />
              <StatusChip tone="info" label="latency: 86ms" />
            </div>
            <div className="row-actions">
              <ScopedActionButton className="btn">Run Probe</ScopedActionButton>
              <ScopedActionButton className="btn ghost">View Last Logs</ScopedActionButton>
            </div>
          </DetailCard>
          <DetailCard title="Transport Matrix">
            <ul className="list">
              <li>WSS 7443: Reachable</li>
              <li>SIP TLS 5061: Reachable</li>
              <li>RTP Port Block 35000-35199: Open</li>
              <li>Certificate Validity: 72 days left</li>
            </ul>
          </DetailCard>
        </section>
      </div>
    </PermissionGate>
  );
}
