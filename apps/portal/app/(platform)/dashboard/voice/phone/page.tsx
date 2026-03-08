"use client";

import { DetailCard } from "../../../../../components/DetailCard";
import { PageHeader } from "../../../../../components/PageHeader";
import { PermissionGate } from "../../../../../components/PermissionGate";
import { ScopedActionButton } from "../../../../../components/ScopedActionButton";
import { StatusChip } from "../../../../../components/StatusChip";

const contacts = [
  { id: "c1", name: "Allison West", ext: "201", state: "Ready" },
  { id: "c2", name: "Billing Queue", ext: "710", state: "Busy" },
  { id: "c3", name: "Dispatch", ext: "620", state: "Ready" },
  { id: "c4", name: "Escalation", ext: "699", state: "Away" }
];

export default function VoicePhonePage() {
  return (
    <PermissionGate permission="can_view_calls" fallback={<div className="state-box">You do not have voice phone access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="Voice Phone Console" subtitle="Operator-style call controls with compact queue and contact visibility." />
        <section className="chat-layout">
          <DetailCard title="Contacts and Queues">
            <div className="stack compact-stack">
              {contacts.map((contact) => (
                <div key={contact.id} className="chat-item">
                  <div>
                    <strong>{contact.name}</strong>
                    <div className="meta">Ext {contact.ext}</div>
                  </div>
                  <StatusChip tone={contact.state === "Ready" ? "success" : "warning"} label={contact.state} />
                </div>
              ))}
            </div>
          </DetailCard>
          <DetailCard title="Dialer and Live Session">
            <div className="row-wrap">
              <StatusChip tone="info" label="Line 1 Idle" />
              <StatusChip tone="success" label="SBC Connected" />
              <StatusChip tone="info" label="Codec Opus" />
            </div>
            <div className="grid three">
              {["1","2","3","4","5","6","7","8","9","*","0","#"].map((digit) => (
                <button key={digit} className="btn ghost">{digit}</button>
              ))}
            </div>
            <div className="row-actions">
              <ScopedActionButton className="btn">Call</ScopedActionButton>
              <ScopedActionButton className="btn ghost">Hold</ScopedActionButton>
              <ScopedActionButton className="btn ghost">Transfer</ScopedActionButton>
              <ScopedActionButton className="btn ghost">Record</ScopedActionButton>
            </div>
          </DetailCard>
        </section>
      </div>
    </PermissionGate>
  );
}
