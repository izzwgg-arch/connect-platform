"use client";

import Link from "next/link";
import { DetailCard } from "../../../components/DetailCard";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";

export default function PbxOverviewPage() {
  return (
    <PermissionGate permission="can_view_calls" fallback={<div className="state-box">You do not have PBX access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="PBX Control Center" subtitle="Telephony configuration, routing, WebRTC, provisioning, recordings, and diagnostics." />
        <section className="grid three">
          <DetailCard title="Core Voice">
            <div className="row-actions">
              <Link className="btn ghost" href="/pbx/extensions">Extensions</Link>
              <Link className="btn ghost" href="/pbx/queues">Queues</Link>
              <Link className="btn ghost" href="/pbx/ring-groups">Ring Groups</Link>
              <Link className="btn ghost" href="/pbx/ivr">IVR</Link>
            </div>
          </DetailCard>
          <DetailCard title="Routing">
            <div className="row-actions">
              <Link className="btn ghost" href="/pbx/trunks">Trunks</Link>
              <Link className="btn ghost" href="/pbx/inbound-routes">Inbound Routes</Link>
              <Link className="btn ghost" href="/pbx/outbound-routes">Outbound Routes</Link>
              <Link className="btn ghost" href="/pbx/time-conditions">Time Conditions</Link>
            </div>
          </DetailCard>
          <DetailCard title="Operations">
            <div className="row-actions">
              <Link className="btn ghost" href="/pbx/softphone">WebRTC Softphone</Link>
              <Link className="btn ghost" href="/pbx/provisioning">Provisioning</Link>
              <Link className="btn ghost" href="/pbx/sbc-connectivity">SBC Connectivity</Link>
              <Link className="btn ghost" href="/pbx/call-recordings">Call Recordings</Link>
            </div>
          </DetailCard>
        </section>
      </div>
    </PermissionGate>
  );
}
