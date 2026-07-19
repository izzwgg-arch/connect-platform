"use client";
/**
 * AI Support Chat ("Shammes") — client page. Talks to the agent service via
 * the nginx /agent-api/ proxy using the same Bearer token as the rest of the
 * portal. Identity/tenant come from the JWT server-side — nothing here is
 * trusted for authorization. See docs/ai-support-agent/PLAN.md.
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Msg = { id: string; role: string; content: string; createdAt?: string };
type Conv = { id: string; startedAt: string; status: string; language?: string | null };

function token(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
}

async function agentPost<T>(path: string, body: object): Promise<T> {
  const res = await fetch(`/agent-api/chat/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`agent ${path} failed: ${res.status}`);
  return res.json();
}

export default function SupportChatPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState<Conv[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    setInput("");
    setMessages((m) => [...m, { id: `local-${Date.now()}`, role: "user", content: text }]);
    try {
      const res = await agentPost<{ conversationId: string; reply: string }>("message", { text, channel: "chat" });
      setConversationId(res.conversationId);
      setMessages((m) => [...m, { id: `r-${Date.now()}`, role: "assistant", content: res.reply }]);
    } catch {
      setError("Couldn't reach the support assistant. Please try again, or contact us directly.");
    } finally {
      setSending(false);
    }
  }, [input, sending]);

  const startNewChat = useCallback(async () => {
    if (conversationId) {
      try {
        await agentPost("close", { conversationId });
      } catch {
        /* non-fatal */
      }
    }
    setConversationId(null);
    setMessages([]);
  }, [conversationId]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await agentPost<{ visible: boolean; conversations: Conv[] }>("history", {});
      setHistory(res.visible ? res.conversations : null);
      setShowHistory(true);
    } catch {
      setHistory(null);
      setShowHistory(true);
    }
  }, []);

  const openConversation = useCallback(async (id: string) => {
    try {
      const res = await agentPost<{ messages: Msg[] }>("messages", { conversationId: id });
      setMessages(res.messages);
      setConversationId(id);
      setShowHistory(false);
    } catch {
      setError("Couldn't load that conversation.");
    }
  }, []);

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: 16, display: "flex", flexDirection: "column", height: "calc(100vh - 120px)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Support Chat</h1>
          <div style={{ fontSize: 12, opacity: 0.7 }}>AI assistant · English / ייִדיש · a human is always behind it</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={loadHistory} style={btnStyle}>History</button>
          <button onClick={startNewChat} style={btnStyle}>New chat</button>
        </div>
      </div>

      {showHistory && (
        <div style={{ border: "1px solid rgba(128,128,128,.3)", borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <b style={{ fontSize: 13 }}>Past chats</b>
            <button onClick={() => setShowHistory(false)} style={{ ...btnStyle, padding: "2px 10px" }}>×</button>
          </div>
          {history === null ? (
            <div style={{ fontSize: 13, opacity: 0.7 }}>Chat history isn&apos;t available for your account.</div>
          ) : history.length === 0 ? (
            <div style={{ fontSize: 13, opacity: 0.7 }}>No past chats yet.</div>
          ) : (
            history.map((c) => (
              <button key={c.id} onClick={() => openConversation(c.id)} style={{ ...btnStyle, display: "block", width: "100%", textAlign: "left", marginBottom: 6 }}>
                {new Date(c.startedAt).toLocaleString()} · {c.status === "OPEN" ? "open" : "closed"}
              </button>
            ))
          )}
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", border: "1px solid rgba(128,128,128,.3)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        {messages.length === 0 && (
          <div style={{ opacity: 0.6, fontSize: 14, margin: "auto", textAlign: "center" }}>
            How can we help? Type in English or Yiddish.<br />
            ?וואָס קענען מיר טאָן פֿאַר אײַך
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "80%",
              padding: "8px 12px",
              borderRadius: 12,
              fontSize: 14,
              background: m.role === "user" ? "#2563eb" : "rgba(128,128,128,.15)",
              color: m.role === "user" ? "#fff" : undefined,
              whiteSpace: "pre-wrap",
            }}
          >
            {m.content}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {error && <div style={{ color: "#dc2626", fontSize: 13, marginTop: 6 }}>{error}</div>}

      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
          placeholder="Type a message…"
          style={{ flex: 1, padding: "10px 14px", borderRadius: 999, border: "1px solid rgba(128,128,128,.4)", fontSize: 14, background: "transparent", color: "inherit" }}
        />
        <button onClick={send} disabled={sending || !input.trim()} style={{ ...btnStyle, background: "#2563eb", color: "#fff", opacity: sending ? 0.6 : 1 }}>
          {sending ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "6px 14px",
  borderRadius: 8,
  border: "1px solid rgba(128,128,128,.4)",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontSize: 13,
};
