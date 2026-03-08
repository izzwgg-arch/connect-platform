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
import { loadChatFeed } from "../../../services/platformData";

export default function ChatPage() {
  const { adminScope } = useAppContext();
  const isGlobal = adminScope === "GLOBAL";
  const state = useAsyncResource(() => loadChatFeed(adminScope), [adminScope]);
  if (state.status === "loading") return <LoadingSkeleton rows={6} />;
  if (state.status === "error") return <ErrorState message={state.error} />;

  const { conversations, timeline, scopeLabel } = state.data;

  return (
    <PermissionGate permission="can_view_chat" fallback={<div className="state-box">You do not have chat access.</div>}>
      <div className="stack">
      <PageHeader
        title="Team Chat"
        subtitle={`Communication workspace with unread and presence context (${scopeLabel.toLowerCase()} scope).`}
        badges={<ScopeBadge scope={scopeLabel} />}
      />
      {isGlobal ? <GlobalScopeNotice /> : null}
      <section className="chat-layout">
        <DetailCard title="Conversations">
            {conversations.length === 0 ? (
              <EmptyState title="No conversations" message="Internal chat threads appear here." />
            ) : (
              <div className="list">
                {conversations.map((item) => (
                  <div key={item.id} className="chat-item">
                    {item.title}
                    {item.unread ? <StatusChip tone="info" label={`${item.unread} unread`} /> : null}
                  </div>
                ))}
              </div>
            )}
        </DetailCard>
        <DetailCard title="Active Conversation">
            {timeline.length === 0 ? (
              <EmptyState title="No messages yet" message="Select a conversation to begin." />
            ) : (
              <div className="timeline">
                {timeline.map((item, idx) => (
                  <div key={item.id} className={`bubble ${idx % 2 === 0 ? "inbound" : "outbound"}`}>
                    {item.detail}
                  </div>
                ))}
              </div>
            )}
          <div className="composer">
            <ScopeActionGuard>{({ disabled, title }) => <input className="input" placeholder="Type message..." disabled={disabled} title={title} />}</ScopeActionGuard>
            <ScopedActionButton className="btn">Send</ScopedActionButton>
          </div>
        </DetailCard>
      </section>
      </div>
    </PermissionGate>
  );
}
