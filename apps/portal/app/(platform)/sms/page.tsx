"use client";

import { DetailCard } from "../../../components/DetailCard";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { GlobalScopeNotice } from "../../../components/GlobalScopeNotice";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { ScopedActionButton } from "../../../components/ScopedActionButton";
import { ScopeActionGuard } from "../../../components/ScopeActionGuard";
import { ScopeBadge } from "../../../components/ScopeBadge";
import { StatusChip } from "../../../components/StatusChip";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { loadSmsThreads } from "../../../services/platformData";

export default function SmsPage() {
  const { adminScope } = useAppContext();
  const isGlobal = adminScope === "GLOBAL";
  const state = useAsyncResource(() => loadSmsThreads(adminScope), [adminScope]);
  if (state.status === "loading") return <LoadingSkeleton rows={6} />;
  if (state.status === "error") return <ErrorState message={state.error} />;
  const { threads, scopeLabel } = state.data;

  return (
    <PermissionGate permission="can_view_sms" fallback={<div className="state-box">You do not have SMS access.</div>}>
      <div className="stack">
        <PageHeader
          title="SMS Operations"
          subtitle={`External messaging workspace with provider-aware delivery tracking (${scopeLabel.toLowerCase()} scope).`}
          badges={<ScopeBadge scope={scopeLabel} />}
        />
      {isGlobal ? <GlobalScopeNotice /> : null}
      <section className="chat-layout">
        <DetailCard title="Threads">
            {threads.length === 0 ? (
              <EmptyState title="No SMS threads" message="Messages will appear once SMS activity starts." />
            ) : (
              <div className="list">
                {threads.map((thread) => (
                  <div key={thread.id} className="chat-item">
                    {thread.phone}
                    <StatusChip tone={thread.status.includes("ISSUE") ? "warning" : "info"} label={thread.status} />
                  </div>
                ))}
              </div>
            )}
        </DetailCard>
        <DetailCard title="Thread Detail">
            {threads[0] ? (
              <div className="timeline">
                <div className="bubble inbound">{threads[0].preview}</div>
                <div className="bubble outbound">Reply draft ready.</div>
              </div>
            ) : (
              <EmptyState title="Select a thread" message="Choose an SMS thread to view timeline and send replies." />
            )}
          <div className="row-wrap">
            <StatusChip tone="info" label="Assigned Number +1 212 555 9870" />
            <StatusChip tone="success" label="Provider: VoIP.ms" />
          </div>
          <div className="composer">
            <ScopeActionGuard>{({ disabled, title }) => <input className="input" placeholder="Send SMS..." disabled={disabled} title={title} />}</ScopeActionGuard>
            <ScopedActionButton className="btn">Send</ScopedActionButton>
          </div>
        </DetailCard>
      </section>
      </div>
    </PermissionGate>
  );
}
