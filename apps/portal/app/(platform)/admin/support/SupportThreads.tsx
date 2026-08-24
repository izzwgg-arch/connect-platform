"use client";

/**
 * One customer's conversations, opened from a case — screen 2 of the redesign.
 * https://claude.ai/code/artifact/6f514701-4e37-4dea-a80f-2366ed600030
 *
 * ⛔⛔ THIS REPLACED A BROWSE SURFACE, AND THE WHOLE DIFFERENCE IS THE HEADER.
 * The old Inbox listed every company's chat threads newest-first — 679 threads
 * and 2,477 messages measured on 2026-08-24 — so one person could read thirty
 * companies' customers with no case attached to the reading. Same data here,
 * same reply path, same "the reply leaves from the company's own number" rule.
 * What changed:
 *
 *   1. it cannot be reached without a case;
 *   2. it names the case it was opened for, on screen;
 *   3. it says out loud that the open was recorded, because it was.
 *
 * ⛔ The scoping is NOT enforced here. `tenantId` is a required query parameter
 * on the API, so a request without one is refused server-side — hiding a browse
 * surface in the UI leaves it one curl away. This screen simply cannot be
 * rendered without the props the case supplies.
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

type Transcript = { thread: ThreadRow & { sharedInbox: boolean }; messages: TranscriptMessage[] };

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
  const b = (e as { body?: { message?: string } })?.body;
  return b?.message || (e as Error)?.message || "Something went wrong.";
}
function threadName(t: ThreadRow): string {
  return t.externalSmsE164 || t.title || typeChip(t.type);
}

export default function SupportThreads({
  tenantId,
  tenantName,
  caseRef,
  onClose,
}: {
  tenantId: string;
  tenantName: string;
  caseRef: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<ThreadRow[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [errMsg, setErrMsg] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const selRef = useRef<string | null>(null);
  selRef.current = selectedId;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const loadList = useCallback(async () => {
    try {
      const out = await apiGet<{ threads: ThreadRow[] }>(
        `/admin/support/threads?tenantId=${encodeURIComponent(tenantId)}&caseRef=${encodeURIComponent(caseRef)}&take=60`,
      );
      setRows(out.threads);
      setListState("ready");
      if (!selRef.current && out.threads[0]) setSelectedId(out.threads[0].id);
    } catch (e) {
      setErrMsg(errorText(e));
      setListState("error");
    }
  }, [tenantId, caseRef]);

  const loadTranscript = useCallback(async (id: string) => {
    try {
      const out = await apiGet<Transcript>(`/admin/support/threads/${encodeURIComponent(id)}`);
      if (selRef.current !== id) return;
      setTranscript(out);
      window.setTimeout(() => scrollRef.current?.scrollTo({ top: 9_999_999 }), 30);
    } catch {
      if (selRef.current === id) setTranscript(null);
    }
  }, []);

  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => {
    if (!selectedId) return;
    setErr("");
    void loadTranscript(selectedId);
    const t = window.setInterval(() => void loadTranscript(selectedId), 12_000);
    return () => window.clearInterval(t);
  }, [selectedId, loadTranscript]);

  const thread = transcript?.thread ?? null;
  const canReply = !!thread && thread.type === "SMS";

  async function send() {
    if (!selectedId || !draft.trim() || busy) return;
    setBusy(true); setErr("");
    try {
      await apiPost(`/admin/support/threads/${encodeURIComponent(selectedId)}/reply`, { body: draft.trim() });
      setDraft("");
      void loadTranscript(selectedId);
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="sd-subhead sd-subhead-scoped">
        <button className="sd-btn" onClick={onClose}>← Back to the case</button>
        <span>
          <b>{tenantName}</b> · text conversations
          {" — "}
          <span className="sd-dim">opened for Ref {caseRef}. This open was recorded.</span>
        </span>
      </div>

      <div className="sd-body sd-body-2">
        <aside className="sd-queue">
          {listState === "loading" ? <div className="sd-state">Loading…</div> : null}
          {listState === "error" ? <div className="sd-state sd-state-bad">{errMsg || "Couldn't load their conversations."}</div> : null}
          {listState === "ready" && rows.length === 0 ? (
            <div className="sd-state">{tenantName} has no text conversations.</div>
          ) : null}
          {listState === "ready" && rows.length ? (
            <div className="sd-queue-head">{rows.length} thread{rows.length === 1 ? "" : "s"} on this account</div>
          ) : null}
          {rows.map((t) => (
            <button key={t.id} className={"sd-item" + (t.id === selectedId ? " on" : "")} onClick={() => setSelectedId(t.id)}>
              <span className="sd-item-top">
                <b>{threadName(t)}</b>
                <time>{timeAgo(t.lastMessageAt)}</time>
              </span>
              <span className="sd-item-sum">{t.last?.preview || "No messages yet"}</span>
              <span className="sd-item-chips">
                <span className="sd-chip sd-chip-dim">{typeChip(t.type)}</span>
                {t.sharedInbox ? <span className="sd-chip sd-chip-dim">Shared inbox</span> : null}
              </span>
            </button>
          ))}
        </aside>

        <main className="sd-detail sd-inbox-main">
          {!thread ? <div className="sd-state">Pick a conversation.</div> : null}
          {thread ? (
            <>
              <div className="sd-detail-head">
                <h2>{threadName(thread)}{thread.tenantSmsE164 ? ` ↔ ${thread.tenantSmsE164}` : ""}</h2>
                <div className="sd-meta">
                  {canReply
                    ? "Replies leave from this company's own number."
                    : "This isn't a text conversation, so there's nothing to reply into from here."}
                </div>
              </div>

              {err ? <div className="sd-banner sd-banner-bad">{err}</div> : null}

              <div className="sd-transcript" ref={scrollRef}>
                {(transcript?.messages ?? []).map((m) => (
                  <div key={m.id} className={"sd-msg " + (m.direction === "INBOUND" ? "sd-msg-user" : "sd-msg-agent")}>
                    <span className="sd-msg-who">
                      {m.direction === "INBOUND" ? threadName(thread) : m.senderName || thread.tenantName}
                      {" · "}{timeAgo(m.createdAt)}
                      {m.deliveryError ? " · not delivered" : ""}
                    </span>
                    {m.deleted ? <i className="sd-dim">deleted</i> : m.body}
                  </div>
                ))}
                {(transcript?.messages ?? []).length === 0 ? <div className="sd-state">No messages.</div> : null}
              </div>

              {canReply ? (
                <div className="sd-composer">
                  <input
                    value={draft}
                    placeholder={`Reply as ${thread.tenantName}…`}
                    disabled={busy}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => (e.key === "Enter" ? void send() : null)}
                  />
                  <button className="sd-btn sd-btn-primary" disabled={busy || !draft.trim()} onClick={() => void send()}>Send</button>
                </div>
              ) : null}
            </>
          ) : null}
        </main>
      </div>
    </>
  );
}
