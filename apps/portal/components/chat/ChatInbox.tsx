"use client";

import { AlertCircle, MessageCircle, Search } from "lucide-react";
import type { ChatThread } from "./types";
import { fmtChatTime, initials, threadLabel } from "./formatting";

export function ChatInbox({
  threads,
  activeThreadId,
  search,
  onSearch,
  onSelect,
  onNewChat,
  loading,
}: {
  threads: ChatThread[];
  activeThreadId?: string;
  search: string;
  onSearch: (value: string) => void;
  onSelect: (thread: ChatThread) => void;
  onNewChat: () => void;
  loading: boolean;
}) {
  return (
    <aside className="cc-inbox">
      <div className="cc-inbox-head">
        <div>
          <h2>Messages</h2>
          <p>SMS, tenant groups, and internal chats</p>
        </div>
        <button type="button" className="cc-new-btn" onClick={onNewChat}>+ New</button>
      </div>

      <label className="cc-search">
        <Search size={15} />
        <input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Search chats..." />
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
            <span className="cc-avatar">{initials(thread.participantName)}</span>
            <span className="cc-thread-main">
              <span className="cc-thread-top">
                <strong>{thread.participantName}</strong>
                <small>{fmtChatTime(thread.lastAt)}</small>
              </span>
              <span className="cc-thread-bottom">
                <span className={`cc-channel cc-channel-${thread.type.toLowerCase()}`}>{threadLabel(thread.type)}</span>
                <span className="cc-thread-preview">{thread.lastMessage || "No messages yet"}</span>
              </span>
            </span>
            {thread.deliveryError ? <AlertCircle className="cc-thread-alert" size={14} /> : null}
            {thread.unread > 0 ? <span className="cc-unread">{thread.unread}</span> : null}
          </button>
        ))}
      </div>
    </aside>
  );
}
