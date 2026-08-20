"use client";

/**
 * The cross-company inbox — Phase 3 of the support console.
 *
 * Every company's chat/SMS threads in one list, the transcript beside it, and
 * a reply box for SMS threads. Replies go out FROM THE COMPANY'S OWN NUMBER —
 * the API takes the tenant from the thread, never from this screen — and ride
 * the one existing chat send path.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../../../../services/apiClient";

type ThreadRow = {
  id: string;
  tenantId: string;
  tenantName: string;
  type: string;
  title: string | null;
  tenantSmsE164: string | null;
  externalSmsE164: string | null;
  sharedInbox: boolean;
  lastMessageAt: string;
  last: { direction: string; type: string; preview: string; at: string } | null;
};

type TranscriptMessage = {
  id: string;
  direction: string;
  type: string;
  body: string;
  deleted: boolean;
  senderName: string | null;
  createdAt: string;
  deliveryStatus: string | null;
  deliveryError: string | null;
};

type Transcript = {
  thread: ThreadRow & { sharedInbox: boolean };
  messages: TranscriptMessage[];
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function typeChip(t: string): string {
  if (t === "SMS") return "SMS";
  if (t === "DM") return "Direct";
  if (t === "TENANT_GROUP") return "Company group";
  return "Group";
}

function errorText(e: unknown): string {
  const body = (e as { body?: { message?: string; error?: string } })?.body;
  return body?.message || (e as Error)?.message || "Something went wrong.";
}

export default function SupportInbox() {
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [transcriptState, setTranscriptState] = useState<"idle" | "loading" | "error">("idle");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const loadThreads = useCallback(async () => {
    try {
      const out = await apiGet<{ threads: ThreadRow[] }>("/admin/support/threads?take=60");
      setThreads(out.threads);
      setListState("ready");
    } catch {
      setListState("error");
    }
  }, []);

  const loadTranscript = useCallback(async (id: string) => {
    setTranscriptState("loading");
    try {
      const out = await apiGet<Transcript>(`/admin/support/threads/${encodeURIComponent(id)}`);
      if (selectedRef.current !== id) return;
      setTranscript(out);
      setTranscriptState("idle");
      window.setTimeout(() => scrollRef.current?.scrollTo({ top: 9_999_999 }), 30);
    } catch {
      if (selectedRef.current !== id) return;
      setTranscript(null);
      setTranscriptState("error");
    }
  }, []);

  useEffect(() => {
    void loadThreads();
    const t = window.setInterval(() => void loadThreads(), 30_000);
    return () => window.clearInterval(t);
  }, [loadThreads]);

  useEffect(() => {
    if (!selectedId) return;
    setSendError("");
    void loadTranscript(selectedId);
  }, [selectedId, loadTranscript]);

  async function send() {
    if (!selectedId || !draft.trim() || sending) return;
    setSending(true);
    setSendError("");
    try {
      await apiPost(`/admin/support/threads/${encodeURIComponent(selectedId)}/reply`, { body: draft.trim() });
      setDraft("");
      void loadTranscript(selectedId);
      void loadThreads();
    } catch (e) {
      setSendError(errorText(e));
    } finally {
      setSending(false);
    }
  }

  const th = transcript?.thread ?? null;
  const canReply = th?.type === "SMS";

  return (
    <div className="sd-body sd-inbox">
      <aside className="sd-queue">
        {listState === "loading" ? <div className="sd-state">Loading conversations…</div> : null}
        {listState === "error" ? <div className="sd-state sd-state-bad">Couldn&apos;t load the inbox.</div> : null}
        {listState === "ready" && threads.length === 0 ? <div className="sd-state">No conversations yet.</div> : null}
        {threads.map((t) => (
          <button key={t.id} className={"sd-item" + (t.id === selectedId ? " on" : "")} onClick={() => setSelectedId(t.id)}>
            <span className="sd-item-top">
              <b>{t.tenantName}</b>
              <time>{timeAgo(t.lastMessageAt)}</time>
            </span>
            <span className="sd-item-sum">
              {t.last ? (t.last.direction === "INBOUND" ? "" : "You: ") + (t.last.preview || `(${t.last.type.toLowerCase()})`) : t.title || "—"}
            </span>
            <span className="sd-item-chips">
              <span className="sd-chip sd-chip-new">{typeChip(t.type)}</span>
              {t.externalSmsE164 ? <span className="sd-chip sd-chip-dim">{t.externalSmsE164}</span> : null}
              {t.sharedInbox && t.type === "SMS" ? <span className="sd-chip sd-chip-dim">Shared inbox</span> : null}
            </span>
          </button>
        ))}
      </aside>

      <main className="sd-detail sd-inbox-main">
        {!selectedId ? <div className="sd-state">Pick a conversation.</div> : null}
        {selectedId && transcriptState === "loading" && !transcript ? <div className="sd-state">Loading…</div> : null}
        {selectedId && transcriptState === "error" ? <div className="sd-state sd-state-bad">Couldn&apos;t load that conversation.</div> : null}
        {transcript && th ? (
          <>
            <div className="sd-detail-head">
              <h2>{th.tenantName}{th.externalSmsE164 ? ` · ${th.externalSmsE164}` : th.title ? ` · ${th.title}` : ""}</h2>
              <div className="sd-meta">
                {typeChip(th.type)}
                {th.tenantSmsE164 ? ` · replies go out from ${th.tenantSmsE164} (${th.tenantName}'s own number)` : ""}
              </div>
            </div>
            <div className="sd-transcript" ref={scrollRef}>
              {transcript.messages.map((m) => (
                <div key={m.id} className={"sd-msg " + (m.direction === "INBOUND" ? "sd-msg-user" : "sd-msg-agent")}>
                  <span className="sd-msg-who">
                    {m.direction === "INBOUND"
                      ? th.externalSmsE164 || "Customer"
                      : m.senderName || th.tenantName}
                    {" · "}
                    {timeAgo(m.createdAt)}
                  </span>
                  {m.deleted ? <i>message deleted</i> : m.body || <i>({m.type.toLowerCase()})</i>}
                  {m.deliveryError ? <span className="sd-bad"> · failed: {m.deliveryError}</span> : null}
                </div>
              ))}
            </div>
            {canReply ? (
              <div className="sd-composer">
                <input
                  value={draft}
                  placeholder={`Reply as ${th.tenantName}…`}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => (e.key === "Enter" ? void send() : null)}
                  disabled={sending}
                />
                <button className="sd-btn sd-btn-primary" disabled={!draft.trim() || sending} onClick={() => void send()}>
                  {sending ? "Sending…" : "Send"}
                </button>
              </div>
            ) : (
              <div className="sd-state" style={{ padding: 10 }}>Internal conversation — read-only from the desk today.</div>
            )}
            {sendError ? <div className="sd-banner sd-banner-bad">{sendError}</div> : null}
          </>
        ) : null}
      </main>
    </div>
  );
}
