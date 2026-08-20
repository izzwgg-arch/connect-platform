"use client";

/**
 * Assistant conversations — Phase 4 of the support console.
 *
 * Watch any company's assistant conversation live, TAKE IT OVER (the engine
 * goes quiet, the customer's widget shows "a real person"), talk, and hand it
 * back. The takeover flip and staff messages are audited; the customer sees a
 * transcript note at both moments, so the change of voice is never silent.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../../../../services/apiClient";

type ConvRow = {
  id: string;
  tenantId: string;
  tenantName: string;
  userName: string | null;
  status: string;
  language: string | null;
  startedAt: string;
  takenOver: boolean;
  last: { role: string; preview: string; at: string } | null;
};

type ConvMessage = { id: string; role: string; content: string; contentEn: string | null; createdAt: string; model: string | null };

type ConvDetail = {
  conversation: ConvRow & { takenOverAt: string | null };
  messages: ConvMessage[];
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

function errorText(e: unknown): string {
  const body = (e as { body?: { message?: string; error?: string } })?.body;
  return body?.message || (e as Error)?.message || "Something went wrong.";
}

export default function SupportConversations() {
  const [rows, setRows] = useState<ConvRow[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConvDetail | null>(null);
  const [detailState, setDetailState] = useState<"idle" | "loading" | "error">("idle");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const loadList = useCallback(async () => {
    try {
      const out = await apiGet<{ conversations: ConvRow[] }>("/admin/support/conversations?take=60");
      setRows(out.conversations);
      setListState("ready");
    } catch {
      setListState("error");
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const out = await apiGet<ConvDetail>(`/admin/support/conversations/${encodeURIComponent(id)}`);
      if (selectedRef.current !== id) return;
      setDetail(out);
      setDetailState("idle");
      window.setTimeout(() => scrollRef.current?.scrollTo({ top: 9_999_999 }), 30);
    } catch {
      if (selectedRef.current !== id) return;
      setDetail(null);
      setDetailState("error");
    }
  }, []);

  useEffect(() => {
    void loadList();
    const t = window.setInterval(() => void loadList(), 30_000);
    return () => window.clearInterval(t);
  }, [loadList]);

  // The open transcript refreshes every 5s — during a take-over this is the
  // live conversation, and outside one it's how you watch the assistant work.
  useEffect(() => {
    if (!selectedId) return;
    setActionError("");
    setDetailState("loading");
    void loadDetail(selectedId);
    const t = window.setInterval(() => void loadDetail(selectedId), 5_000);
    return () => window.clearInterval(t);
  }, [selectedId, loadDetail]);

  const conv = detail?.conversation ?? null;

  async function toggleTakeover(on: boolean) {
    if (!selectedId || busy) return;
    setBusy(true);
    setActionError("");
    try {
      await apiPost(`/admin/support/conversations/${encodeURIComponent(selectedId)}/takeover`, { on });
      void loadDetail(selectedId);
      void loadList();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function sendStaff() {
    if (!selectedId || !draft.trim() || busy) return;
    setBusy(true);
    setActionError("");
    try {
      await apiPost(`/admin/support/conversations/${encodeURIComponent(selectedId)}/message`, { body: draft.trim() });
      setDraft("");
      void loadDetail(selectedId);
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sd-body sd-inbox">
      <aside className="sd-queue">
        {listState === "loading" ? <div className="sd-state">Loading conversations…</div> : null}
        {listState === "error" ? <div className="sd-state sd-state-bad">Couldn&apos;t load conversations.</div> : null}
        {listState === "ready" && rows.length === 0 ? <div className="sd-state">No assistant conversations yet.</div> : null}
        {rows.map((r) => (
          <button key={r.id} className={"sd-item" + (r.id === selectedId ? " on" : "")} onClick={() => setSelectedId(r.id)}>
            <span className="sd-item-top">
              <b>{r.userName ? `${r.userName} · ${r.tenantName}` : r.tenantName}</b>
              <time>{r.last ? timeAgo(r.last.at) : timeAgo(r.startedAt)}</time>
            </span>
            <span className="sd-item-sum">{r.last ? r.last.preview : "(no messages yet)"}</span>
            <span className="sd-item-chips">
              {r.takenOver ? <span className="sd-chip sd-chip-ok">A person has it</span> : <span className="sd-chip sd-chip-new">Assistant handling</span>}
              <span className="sd-chip sd-chip-dim">{r.status === "OPEN" ? "Open" : "Closed"}</span>
              {r.language === "yi" ? <span className="sd-chip sd-chip-dim">Yiddish</span> : null}
            </span>
          </button>
        ))}
      </aside>

      <main className="sd-detail sd-inbox-main">
        {!selectedId ? <div className="sd-state">Pick a conversation to watch it live.</div> : null}
        {selectedId && detailState === "loading" && !detail ? <div className="sd-state">Loading…</div> : null}
        {selectedId && detailState === "error" ? <div className="sd-state sd-state-bad">Couldn&apos;t load that conversation.</div> : null}
        {detail && conv ? (
          <>
            <div className="sd-detail-head">
              <h2>{conv.userName ? `${conv.userName} · ${conv.tenantName}` : conv.tenantName}</h2>
              <div className="sd-meta">
                {conv.takenOver
                  ? "You have this conversation — the assistant is paused until you hand it back."
                  : "The assistant is handling this. Take over to talk as a person."}
              </div>
            </div>
            <div className="sd-transcript" ref={scrollRef}>
              {detail.messages
                .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "staff")
                .map((m) => (
                  <div key={m.id} className={"sd-msg " + (m.role === "user" ? "sd-msg-user" : "sd-msg-agent")}
                    style={m.role === "staff" ? { borderColor: "var(--success)" } : undefined}>
                    <span className="sd-msg-who">
                      {m.role === "user" ? conv.userName || "Customer" : m.role === "staff" ? "Loopcom support" : `Assistant${m.model && m.model !== "human" ? ` · ${m.model}` : ""}`}
                      {" · "}
                      {timeAgo(m.createdAt)}
                    </span>
                    {m.content}
                    {m.contentEn && m.contentEn !== m.content ? <span className="sd-dim" style={{ display: "block" }}>({m.contentEn})</span> : null}
                  </div>
                ))}
            </div>
            {conv.takenOver ? (
              <div className="sd-composer">
                <input
                  value={draft}
                  placeholder={`Reply as Loopcom support to ${conv.userName || "the customer"}…`}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => (e.key === "Enter" ? void sendStaff() : null)}
                  disabled={busy}
                />
                <button className="sd-btn sd-btn-primary" disabled={!draft.trim() || busy} onClick={() => void sendStaff()}>Send</button>
                <button className="sd-btn" disabled={busy} onClick={() => void toggleTakeover(false)}>Hand back to assistant</button>
              </div>
            ) : (
              <div className="sd-composer">
                <button className="sd-btn sd-btn-primary" disabled={busy} onClick={() => void toggleTakeover(true)}>Take over from the assistant</button>
              </div>
            )}
            {actionError ? <div className="sd-banner sd-banner-bad">{actionError}</div> : null}
          </>
        ) : null}
      </main>
    </div>
  );
}
