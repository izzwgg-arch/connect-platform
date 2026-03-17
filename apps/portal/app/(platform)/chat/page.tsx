"use client";

import { useEffect, useRef, useState } from "react";
import { useAppContext } from "../../../hooks/useAppContext";
import { useSipPhone } from "../../../hooks/useSipPhone";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { apiGet, apiPost } from "../../../services/apiClient";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChatThread {
  id: string;
  participantName: string;
  participantExtension: string;
  lastMessage: string;
  lastAt: string;
  unread: number;
  presence?: "available" | "on_call" | "offline" | "away";
}

interface ChatMessage {
  id: string;
  threadId: string;
  senderId: string;
  senderName: string;
  body: string;
  sentAt: string;
  mine: boolean;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

const PRESENCE_DOT: Record<string, string> = {
  available: "var(--success)",
  on_call:   "var(--danger)",
  away:      "var(--warning)",
  offline:   "var(--text-dim)",
};

function initials(name: string): string {
  return name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

// ── Thread List Item ──────────────────────────────────────────────────────────

function ThreadItem({
  thread,
  active,
  onSelect,
}: {
  thread: ChatThread;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "11px 14px",
        cursor: "pointer",
        background: active ? "var(--panel-2)" : "transparent",
        borderBottom: "1px solid var(--border)",
        transition: "background 0.12s",
      }}
    >
      {/* Avatar */}
      <div style={{ position: "relative", flexShrink: 0 }}>
        <div style={{
          width: 40, height: 40,
          borderRadius: "50%",
          background: "var(--accent)",
          opacity: 0.85,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          fontWeight: 700,
          color: "#fff",
        }}>
          {initials(thread.participantName)}
        </div>
        <span style={{
          position: "absolute",
          bottom: 1, right: 1,
          width: 10, height: 10,
          borderRadius: "50%",
          background: PRESENCE_DOT[thread.presence ?? "offline"],
          border: "2px solid var(--panel)",
        }} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 }}>
          <span style={{ fontWeight: thread.unread > 0 ? 700 : 500, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {thread.participantName}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0, marginLeft: 8 }}>
            {fmtTime(thread.lastAt)}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{
            fontSize: 12,
            color: thread.unread > 0 ? "var(--text)" : "var(--text-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}>
            {thread.lastMessage || "No messages yet"}
          </span>
          {thread.unread > 0 ? (
            <span style={{
              background: "var(--accent)",
              color: "#fff",
              borderRadius: 20,
              padding: "1px 7px",
              fontSize: 11,
              fontWeight: 700,
              flexShrink: 0,
              marginLeft: 8,
            }}>
              {thread.unread}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── Message Bubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: ChatMessage }) {
  return (
    <div style={{
      display: "flex",
      justifyContent: msg.mine ? "flex-end" : "flex-start",
      marginBottom: 8,
    }}>
      {!msg.mine ? (
        <div style={{
          width: 28, height: 28,
          borderRadius: "50%",
          background: "var(--panel-2)",
          border: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 11, fontWeight: 700, color: "var(--text-dim)",
          marginRight: 8, flexShrink: 0,
          alignSelf: "flex-end",
        }}>
          {initials(msg.senderName)}
        </div>
      ) : null}
      <div style={{ maxWidth: "68%" }}>
        {!msg.mine ? (
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 3, paddingLeft: 2 }}>
            {msg.senderName}
          </div>
        ) : null}
        <div style={{
          background: msg.mine ? "var(--accent)" : "var(--panel-2)",
          color: msg.mine ? "#fff" : "var(--text)",
          borderRadius: msg.mine ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
          padding: "8px 13px",
          fontSize: 13,
          lineHeight: 1.5,
          border: msg.mine ? "none" : "1px solid var(--border)",
          wordBreak: "break-word",
        }}>
          {msg.body}
        </div>
        <div style={{
          fontSize: 10,
          color: "var(--text-dim)",
          marginTop: 3,
          textAlign: msg.mine ? "right" : "left",
          paddingLeft: 2, paddingRight: 2,
        }}>
          {new Date(msg.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ChatPage() {
  const { user } = useAppContext();
  const phone = useSipPhone();
  const [activeThread, setActiveThread] = useState<ChatThread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [search, setSearch] = useState("");
  const [showNewChat, setShowNewChat] = useState(false);
  const [newChatExt, setNewChatExt] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [msgReload, setMsgReload] = useState(0);

  const threadsState = useAsyncResource<{ threads: ChatThread[] }>(
    () => apiGet("/chat/threads"),
    []
  );

  const threads: ChatThread[] = threadsState.status === "success"
    ? (threadsState.data.threads ?? [])
    : [];

  const filtered = threads.filter((t) =>
    !search.trim() ||
    t.participantName.toLowerCase().includes(search.toLowerCase()) ||
    t.participantExtension.includes(search)
  );

  // Load messages for active thread
  useEffect(() => {
    if (!activeThread) return;
    apiGet<{ messages: ChatMessage[] }>(`/chat/threads/${activeThread.id}/messages`)
      .then((res) => setMessages(res.messages ?? []))
      .catch(() => setMessages([]));
  }, [activeThread?.id, msgReload]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage() {
    if (!draft.trim() || !activeThread || sending) return;
    const body = draft.trim();
    setDraft("");
    setSending(true);
    try {
      await apiPost(`/chat/threads/${activeThread.id}/messages`, { body });
      setMsgReload((k) => k + 1);
    } catch {
      setDraft(body);
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ display: "flex", height: "calc(100vh - 54px)", overflow: "hidden" }}>
      {/* Thread list */}
      <div style={{
        width: 300,
        flexShrink: 0,
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          padding: "10px 12px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h3 style={{ fontSize: 15, fontWeight: 650 }}>Chat</h3>
            <button
              className="icon-btn"
              onClick={() => setShowNewChat((v) => !v)}
              title="New conversation"
              style={{ fontSize: 18, fontWeight: 700, color: "var(--accent)" }}
            >
              +
            </button>
          </div>

          {showNewChat ? (
            <div style={{ display: "flex", gap: 6 }}>
              <input
                className="input"
                style={{ flex: 1, fontSize: 12 }}
                placeholder="Extension or name"
                value={newChatExt}
                onChange={(e) => setNewChatExt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newChatExt.trim()) {
                    setShowNewChat(false);
                    setNewChatExt("");
                  }
                }}
              />
              <button className="btn" style={{ fontSize: 12, padding: "0 10px" }}>Go</button>
            </div>
          ) : null}

          <div style={{ position: "relative" }}>
            <input
              className="input"
              style={{ paddingLeft: 30, fontSize: 13 }}
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)", fontSize: 13 }}>🔍</span>
          </div>

          {/* Filter tabs */}
          <div style={{ display: "flex", gap: 0, fontSize: 12 }}>
            <button style={{ flex: 1, padding: "4px 0", border: "none", background: "transparent", borderBottom: "2px solid var(--accent)", color: "var(--accent)", fontWeight: 650, cursor: "pointer" }}>Recents</button>
            <button style={{ flex: 1, padding: "4px 0", border: "none", background: "transparent", borderBottom: "2px solid transparent", color: "var(--text-dim)", cursor: "pointer" }}>Unread</button>
          </div>
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
              No chats
            </div>
          ) : (
            filtered.map((t) => (
              <ThreadItem
                key={t.id}
                thread={t}
                active={activeThread?.id === t.id}
                onSelect={() => setActiveThread(t)}
              />
            ))
          )}
        </div>
      </div>

      {/* Message area */}
      {activeThread ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Chat header */}
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 16px",
            borderBottom: "1px solid var(--border)",
            background: "var(--panel)",
            flexShrink: 0,
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: "50%",
              background: "var(--accent)", opacity: 0.85,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 13, fontWeight: 700, color: "#fff",
            }}>
              {initials(activeThread.participantName)}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 650, fontSize: 14 }}>{activeThread.participantName}</div>
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Ext {activeThread.participantExtension}</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="icon-btn"
                title="Call"
                onClick={() => phone.dial(activeThread.participantExtension)}
                style={{ color: "var(--success)" }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 16.92v3a2 2 0 01-2.18 2 19.8 19.8 0 01-8.63-3.07A19.5 19.5 0 013.07 10.8 19.8 19.8 0 01.02 2.18 2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.9.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.34 1.85.573 2.81.7A2 2 0 0122 14h0v2.92z"/>
                </svg>
              </button>
              <button className="icon-btn" title="Close" onClick={() => setActiveThread(null)}>✕</button>
            </div>
          </div>

          {/* Messages */}
          <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px 8px" }}>
            {messages.length === 0 ? (
              <div style={{ textAlign: "center", color: "var(--text-dim)", fontSize: 13, marginTop: 40 }}>
                No messages yet. Send a message below.
              </div>
            ) : (
              messages.map((msg) => <MessageBubble key={msg.id} msg={msg} />)
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input bar */}
          <div style={{
            display: "flex",
            gap: 10,
            padding: "10px 14px",
            borderTop: "1px solid var(--border)",
            background: "var(--panel)",
            flexShrink: 0,
          }}>
            <input
              className="input"
              style={{ flex: 1, fontSize: 13 }}
              placeholder={`Message ${activeThread.participantName}…`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
              }}
            />
            <button
              className="btn"
              style={{
                background: draft.trim() ? "var(--accent)" : "var(--border)",
                border: "none",
                padding: "0 16px",
                fontSize: 13,
                transition: "background 0.15s",
              }}
              onClick={sendMessage}
              disabled={!draft.trim() || sending}
            >
              {sending ? "…" : "Send"}
            </button>
          </div>
        </div>
      ) : (
        /* Empty state when no thread selected */
        <div style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-dim)",
          gap: 12,
        }}>
          <div style={{ fontSize: 40 }}>💬</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>No conversation selected</div>
          <div style={{ fontSize: 13 }}>Select a conversation from the left or start a new one</div>
          <button className="btn" style={{ marginTop: 8, fontSize: 13 }} onClick={() => setShowNewChat(true)}>
            + New Conversation
          </button>
        </div>
      )}
    </div>
  );
}
