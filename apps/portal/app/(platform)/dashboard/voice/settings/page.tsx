"use client";

import { DetailCard } from "../../../../../components/DetailCard";
import { PageHeader } from "../../../../../components/PageHeader";
import { PermissionGate } from "../../../../../components/PermissionGate";
import { ScopedActionButton } from "../../../../../components/ScopedActionButton";

export default function VoiceSettingsPage() {
  return (
    <PermissionGate permission="can_view_calls" fallback={<div className="state-box">You do not have voice settings access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="Voice Settings" subtitle="Compact controls for office hours, failover behavior, and recording policy." />
        <section className="grid two">
          <DetailCard title="Routing Defaults">
            <div className="row-actions">
              <ScopedActionButton className="btn">Business Hours</ScopedActionButton>
              <ScopedActionButton className="btn ghost">After Hours</ScopedActionButton>
              <ScopedActionButton className="btn ghost">Holiday Mode</ScopedActionButton>
            </div>
          </DetailCard>
          <DetailCard title="Recording and Compliance">
            <div className="row-actions">
              <ScopedActionButton className="btn">Policy Rules</ScopedActionButton>
              <ScopedActionButton className="btn ghost">Retention</ScopedActionButton>
              <ScopedActionButton className="btn ghost">Legal Prompt</ScopedActionButton>
            </div>
          </DetailCard>
        </section>
      </div>
    </PermissionGate>
  );
}
