"use client";

import { DetailCard } from "../../../../../../components/DetailCard";
import { PageHeader } from "../../../../../../components/PageHeader";
import { PermissionGate } from "../../../../../../components/PermissionGate";
import { StatusChip } from "../../../../../../components/StatusChip";

const events = [
  { id: "e1", type: "SYNC", detail: "Tenant profile sync completed for Acme North.", tone: "success" as const },
  { id: "e2", type: "ALERT", detail: "Queue policy mismatch detected and corrected.", tone: "warning" as const },
  { id: "e3", type: "AUTH", detail: "VitalPBX test succeeded using app-key header.", tone: "info" as const }
];

export default function DashboardPbxEventsPage() {
  return (
    <PermissionGate permission="can_view_admin" fallback={<div className="state-box">You do not have PBX event access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="PBX Events" subtitle="Recent operational events and synchronization notices for PBX integrations." />
        <DetailCard title="Event Feed">
          <div className="stack compact-stack">
            {events.map((event) => (
              <div key={event.id} className="chat-item">
                <div>
                  <strong>{event.type}</strong>
                  <div className="meta">{event.detail}</div>
                </div>
                <StatusChip tone={event.tone} label={event.type} />
              </div>
            ))}
          </div>
        </DetailCard>
      </div>
    </PermissionGate>
  );
}
