"use client";

import { AlertCircle, MessageCircle, Search, User } from "lucide-react";
import type { ChatThread } from "./types";
import { crmSmsBadge, fmtChatTime, initials, smsInboxBadge, threadLabel } from "./formatting";

// Same avatar palette as the mini dialer / mobile app: stable color per contact,
// person figure (not digits) for phone-number-only threads.
const AVATAR_TONES = ["#22c55e", "#06b6d4", "#3b82f6", "#a78bfa", "#f59e0b", "#ec4899", "#14b8a6", "#8b5cf6"];
function toneFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}
function isPhoneLabel(name: string): boolean {
  return !/[a-z]/i.test(name || "");
}

export function ChatInbox({
  threads,
  activeThreadId,
  search,
  onSearch,
  onSelect,
  loading,
}: {
  threads: ChatThread[];
  activeThreadId?: string;
  search: string;
  onSearch: (value: string) => void;
  onSelect: (thread: ChatThread) => void;
  loading: boolean;
}) {
  return (
    <section className="cc-inbox contacts-list-shell tasks-list-card">
      <div className="cc-inbox-head">
        <div>
          <h2>Messages</h2>
          <p>SMS, tenant groups, and internal chats</p>
        </div>
      </div>

      <label className="cc-search" style={{ border: "none", outline: "none", boxShadow: "none" }}>
        <Search size={15} />
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search chats..."
          style={{ border: "none", outline: "none", boxShadow: "none" }}
        />
      </label>

      <div className="cc-thread-list">
        {loading && threads.length === 0 ? (
          <div className="cc-empty-mini">Loading chats...</div>
        ) : threads.length === 0 ? (
          <div className="cc-empty-mini">
            <MessageCircle size={28} />
            No conversations yet
          </div>
        ) : threads.map((thread) => (
          <button
            type="button"
            key={thread.id}
            className={`cc-thread ${activeThreadId === thread.id ? "active" : ""} ${thread.isDefaultTenantGroup ? "pinned" : ""}`}
            onClick={() => onSelect(thread)}
          >
            <span className="cc-avatar" style={{ background: toneFor(thread.participantName || thread.id), color: "#fff" }}>
              {isPhoneLabel(thread.participantName) ? <User size={17} /> : initials(thread.participantName)}
            </span>
            <span className="cc-thread-main">
              <span className="cc-thread-top">
                <span className="cc-thread-name">
                  <strong>{thread.participantName}</strong>
                  <span className={"cc-state " + (thread.isNew ? "new" : "read")}>{thread.isNew ? "New" : "Read"}</span>
                </span>
                <small>{fmtChatTime(thread.lastAt)}</small>
              </span>
              <span className="cc-thread-bottom">
                <span className="cc-channel-row">
                  <span className={`cc-channel cc-channel-${thread.type.toLowerCase()}`}>{threadLabel(thread.type)}</span>
                  {thread.type === "SMS" && crmSmsBadge(thread.crmSms) ? (
                    <span className="cc-sms-inbox-badge cc-sms-inbox-shared">{crmSmsBadge(thread.crmSms)}</span>
                  ) : null}
                  {thread.type === "SMS" && smsInboxBadge(thread.smsInboxKind) ? (
                    <span className={`cc-sms-inbox-badge cc-sms-inbox-${thread.smsInboxKind}`}>{smsInboxBadge(thread.smsInboxKind)}</span>
                  ) : null}
                </span>
                <span className="cc-thread-preview">{thread.lastMessage || "No messages yet"}</span>
              </span>
            </span>
            {thread.deliveryError ? <AlertCircle className="cc-thread-alert" size={14} /> : null}
            {thread.unread > 0 ? <span className="cc-unread">{thread.unread}</span> : null}
          </button>
        ))}
      </div>
    </section>
  );
}
