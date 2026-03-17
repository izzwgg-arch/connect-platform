"use client";

import { useEffect, useRef, useState } from "react";
import { DetailCard } from "../../../components/DetailCard";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { GlobalScopeNotice } from "../../../components/GlobalScopeNotice";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { ScopeActionGuard } from "../../../components/ScopeActionGuard";
import { ScopeBadge } from "../../../components/ScopeBadge";
import { StatusChip } from "../../../components/StatusChip";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { apiGet, apiPost } from "../../../services/apiClient";
import { loadSmsThreads, type SmsThread } from "../../../services/platformData";

type SmsMessage = {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  status: string;
  createdAt: string;
};

function toneForStatus(status: string): "success" | "warning" | "danger" | "info" | "default" {
  const s = status.toUpperCase();
  if (s === "DELIVERED" || s === "SENT") return "success";
  if (s.includes("FAIL") || s.includes("ISSUE")) return "danger";
  if (s.includes("QUEUE") || s.includes("PENDING")) return "warning";
  return "info";
}

function timeLabel(iso: string) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso.slice(11, 16);
  }
}

export default function SmsPage() {
  const { adminScope } = useAppContext();
  const isGlobal = adminScope === "GLOBAL";
  const state = useAsyncResource(() => loadSmsThreads(adminScope), [adminScope]);
  const [selected, setSelected] = useState<SmsThread | null>(null);
  const [messages, setMessages] = useState<SmsMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-select first thread on data load
  useEffect(() => {
    if (state.status === "success" && state.data.threads.length > 0 && !selected) {
      setSelected(state.data.threads[0]);
    }
  }, [state.status]);

  // Load thread messages when selection changes
  useEffect(() => {
    if (!selected) return;
    let active = true;
    setLoadingMessages(true);
    setMessages([]);
    const phone = encodeURIComponent(selected.phone);
    apiGet<any[]>(`/sms/messages?phone=${phone}`)
      .then((data) => {
        if (!active) return;
        const rows: SmsMessage[] = (Array.isArray(data) ? data : []).map((m: any, idx: number) => ({
          id: String(m.id || `m-${idx}`),
          direction: m.direction === "outbound" || m.toNumber === selected.phone ? "outbound" : "inbound",
          body: String(m.body || m.message || ""),
          status: String(m.status || ""),
          createdAt: String(m.createdAt || m.sentAt || ""),
        }));
        setMessages(rows);
      })
      .catch(() => {
        if (!active) return;
        setMessages([]);
      })
      .finally(() => {
        if (active) setLoadingMessages(false);
      });
    return () => { active = false; };
  }, [selected?.id]);

  // Scroll to bottom when messages load
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    if (!selected || !draft.trim() || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await apiPost("/sms/send", { toNumber: selected.phone, body: draft.trim() });
      const sent: SmsMessage = {
        id: `local-${Date.now()}`,
        direction: "outbound",
        body: draft.trim(),
        status: "QUEUED",
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, sent]);
      setDraft("");
    } catch (err: any) {
      setSendError(err?.message || "Send failed. Check SMS provider configuration.");
    } finally {
      setSending(false);
    }
  }

  if (state.status === "loading") return <LoadingSkeleton rows={6} />;
  if (state.status === "error") return <ErrorState message={state.error} />;
  const { threads, scopeLabel } = state.data;

  return (
    <PermissionGate permission="can_view_sms" fallback={<div className="state-box">You do not have SMS access.</div>}>
      <div className="stack">
        <PageHeader
          title="SMS"
          subtitle={`External messaging threads (${scopeLabel.toLowerCase()} scope).`}
          badges={<ScopeBadge scope={scopeLabel} />}
        />
        {isGlobal ? <GlobalScopeNotice /> : null}
        <section className="chat-layout">
          {/* Thread list */}
          <DetailCard title={`Threads (${threads.length})`}>
            {threads.length === 0 ? (
              <EmptyState title="No SMS threads" message="Messages will appear once SMS activity starts." />
            ) : (
              <div className="list">
                {threads.map((thread) => (
                  <div
                    key={thread.id}
                    className={`chat-item${selected?.id === thread.id ? " active" : ""}`}
                    onClick={() => setSelected(thread)}
                    style={{ cursor: "pointer" }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{thread.phone}</div>
                    <div className="muted" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {thread.preview}
                    </div>
                    <StatusChip tone={toneForStatus(thread.status)} label={thread.status} />
                  </div>
                ))}
              </div>
            )}
          </DetailCard>

          {/* Thread detail */}
          <DetailCard
            title={selected ? selected.phone : "Select a Thread"}
            actions={selected ? <StatusChip tone={toneForStatus(selected.status)} label={selected.status} /> : undefined}
          >
            {!selected ? (
              <EmptyState title="No thread selected" message="Choose an SMS thread on the left to view messages." />
            ) : (
              <>
                {loadingMessages ? (
                  <LoadingSkeleton rows={4} />
                ) : messages.length === 0 ? (
                  <EmptyState title="No messages" message="No message history found for this number." />
                ) : (
                  <div className="timeline" style={{ maxHeight: 380, overflowY: "auto", paddingBottom: 8 }}>
                    {messages.map((msg) => (
                      <div key={msg.id} className={`bubble ${msg.direction}`} style={{ marginBottom: 6 }}>
                        <div>{msg.body}</div>
                        <div style={{ fontSize: 10, opacity: 0.6, marginTop: 2, textAlign: msg.direction === "outbound" ? "right" : "left" }}>
                          {timeLabel(msg.createdAt)} {msg.status ? `· ${msg.status}` : ""}
                        </div>
                      </div>
                    ))}
                    <div ref={bottomRef} />
                  </div>
                )}
                {sendError ? (
                  <div className="state-box danger" style={{ fontSize: 12, padding: "6px 10px", marginBottom: 6 }}>
                    {sendError}
                  </div>
                ) : null}
                <ScopeActionGuard>
                  {({ disabled, title }) => (
                    <div className="composer" style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <input
                        className="input"
                        placeholder={`Reply to ${selected.phone}...`}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
                        disabled={disabled || sending}
                        title={title}
                        style={{ flex: 1 }}
                      />
                      <button
                        className="btn"
                        onClick={handleSend}
                        disabled={disabled || sending || !draft.trim()}
                      >
                        {sending ? "Sending…" : "Send"}
                      </button>
                    </div>
                  )}
                </ScopeActionGuard>
              </>
            )}
          </DetailCard>
        </section>
      </div>
    </PermissionGate>
  );
}
