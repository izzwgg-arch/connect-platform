"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Avatar, Dialog, Empty, Icon, Menu, Skeleton, fmtDate, useToast } from "@/components/ui";
import { Composer } from "./Composer";
import { REACTION_EMOJIS, type Message, type ThreadDetail, type ThreadListItem } from "./types";

type ReplyTarget = { id: string; senderName: string; body: string | null };

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return fmtDate(iso, { month: "long", day: "numeric", year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined });
}

export function Conversation({ threadId, onThreadChanged, onOpenInfo }: { threadId: string; onThreadChanged: () => void; onOpenInfo?: () => void }) {
  const { me, on } = useAuth();
  const toast = useToast();
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  const [typingNames, setTypingNames] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [forwardMessageId, setForwardMessageId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  async function loadThread() {
    const d = await api<ThreadDetail>(`/threads/${threadId}`);
    setDetail(d);
  }
  async function loadMessages(before?: string) {
    const q = before ? `?cursor=${encodeURIComponent(before)}` : "";
    const r = await api<{ items: Message[]; nextCursor: string | null }>(`/threads/${threadId}/messages${q}`);
    setNextCursor(r.nextCursor);
    return r.items;
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    setMessages([]);
    setReplyTo(null);
    Promise.all([api<ThreadDetail>(`/threads/${threadId}`), loadMessages()]).then(([d, msgs]) => {
      if (cancelled) return;
      setDetail(d);
      setMessages(msgs);
      setLoading(false);
      setTimeout(() => bodyRef.current?.scrollTo(0, bodyRef.current.scrollHeight), 0);
    }).catch((err) => {
      if (!cancelled) {
        toast((err as Error).message, { kind: "err" });
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  // Mark read whenever the conversation is visible and has something unread.
  const markRead = useMemo(
    () => () => {
      if (document.visibilityState !== "visible") return;
      void api(`/threads/${threadId}/read`, { method: "POST" }).catch(() => {});
    },
    [threadId],
  );
  useEffect(() => {
    if (!loading) markRead();
    document.addEventListener("visibilitychange", markRead);
    return () => document.removeEventListener("visibilitychange", markRead);
  }, [loading, markRead]);

  useEffect(() => {
    const offMessage = on("message", (data: any) => {
      if (data.threadId !== threadId) return;
      if (data.message) {
        setMessages((cur) => {
          const idx = cur.findIndex((m) => m.id === data.message.id);
          if (idx === -1) return [...cur, data.message];
          const next = [...cur];
          next[idx] = data.message;
          return next;
        });
        if (data.message.sender?.id !== me?.person.id) markRead();
        setTimeout(() => {
          const el = bodyRef.current;
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTo(0, el.scrollHeight);
        }, 0);
      }
    });
    const offTyping = on("typing", (data: any) => {
      if (data.threadId !== threadId || data.personId === me?.person.id) return;
      const p = detail?.participants.find((x) => x.person.id === data.personId);
      const name = p?.person.name ?? "Someone";
      setTypingNames((cur) => new Set(cur).add(name));
      setTimeout(() => setTypingNames((cur) => { const next = new Set(cur); next.delete(name); return next; }), 4000);
    });
    const offThread = on("thread", (data: any) => {
      if (data.threadId !== threadId) return;
      void loadThread();
      onThreadChanged();
    });
    return () => {
      offMessage();
      offTyping();
      offThread();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, detail, me?.person.id, on, markRead]);

  async function loadOlder() {
    if (!nextCursor) return;
    const older = await loadMessages(nextCursor);
    setMessages((cur) => [...older, ...cur]);
  }

  function onComposerSent(message: Message) {
    // The SSE echo of our own send can arrive before the POST resolves; never show it twice.
    setMessages((cur) => (cur.some((m) => m.id === message.id) ? cur.map((m) => (m.id === message.id ? message : m)) : [...cur, message]));
    setReplyTo(null);
    setTimeout(() => bodyRef.current?.scrollTo(0, bodyRef.current!.scrollHeight), 0);
  }

  async function react(messageId: string, emoji: string) {
    try {
      const res = await api<{ message: Message }>(`/threads/${threadId}/messages/${messageId}/react`, { method: "POST", body: { emoji } });
      setMessages((cur) => cur.map((m) => (m.id === messageId ? res.message : m)));
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    }
  }

  async function saveEdit(messageId: string) {
    try {
      const res = await api<{ message: Message }>(`/threads/${threadId}/messages/${messageId}`, { method: "PATCH", body: { body: editText.trim() } });
      setMessages((cur) => cur.map((m) => (m.id === messageId ? res.message : m)));
      setEditingId(null);
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    }
  }

  async function doDelete(messageId: string) {
    try {
      const res = await api<{ message: Message }>(`/threads/${threadId}/messages/${messageId}`, { method: "DELETE" });
      setMessages((cur) => cur.map((m) => (m.id === messageId ? res.message : m)));
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setConfirmDeleteId(null);
    }
  }

  async function accept() {
    await api(`/threads/${threadId}/accept`, { method: "POST" });
    await loadThread();
    onThreadChanged();
  }
  async function decline() {
    await api(`/threads/${threadId}/decline`, { method: "POST" });
    onThreadChanged();
  }

  if (loading) {
    return (
      <div className="msg-pane-conv">
        <div style={{ padding: 14 }}>
          <Skeleton h={40} />
        </div>
      </div>
    );
  }
  if (!detail) return <div className="msg-pane-conv"><Empty title="This conversation isn't available" /></div>;

  const other = detail.kind === "DIRECT" ? detail.participants.find((p) => p.person.id !== me?.person.id) : null;
  const iAmRequested = detail.myState === "REQUESTED";
  // The read-receipt privacy preference already gates whether `other.lastReadAt`
  // is populated at all (server-side); the client just needs to show it.
  const lastMineId = [...messages].reverse().find((m) => m.sender?.id === me?.person.id)?.id;
  const seenLastMine = !!(other?.lastReadAt && lastMineId && new Date(other.lastReadAt).getTime() >= new Date(messages.find((m) => m.id === lastMineId)!.createdAt).getTime());

  let lastDay = "";

  return (
    <div className="msg-pane-conv">
      <div className="msg-conv-head">
        <Link href="/messages" className="ib msg-back" aria-label="Back to conversations" data-testid="messages-back">
          <Icon name="back" />
        </Link>
        <Avatar name={detail.title} assetId={other?.person.avatarAssetId} size={36} square={detail.kind !== "DIRECT"} />
        <div className="who" style={{ flex: 1, minWidth: 0 }}>
          <b>{detail.title}</b>
          {other ? <small>{other.online ? <span className="msg-online-dot">● online</span> : other.person.headline ?? ""}</small> : <small>{detail.participants.length} people</small>}
        </div>
        <Menu label="Conversation actions">
          <button type="button" onClick={onOpenInfo} data-testid="messages-conv-info">
            <Icon name="info" /> Conversation info
          </button>
        </Menu>
      </div>

      {iAmRequested ? (
        <div className="msg-request-banner">
          <span>Message request{other ? ` from ${other.person.name}` : ""}.</span>
          <button type="button" className="btn p s" onClick={() => void accept()} data-testid="messages-accept-request">Accept</button>
          <button type="button" className="btn g s" onClick={() => void decline()} data-testid="messages-decline-request">Decline</button>
        </div>
      ) : null}

      <div className="msg-body" ref={bodyRef} data-testid="messages-body">
        {nextCursor ? (
          <button type="button" className="btn g s msg-load-older" onClick={() => void loadOlder()} data-testid="messages-load-older">
            Load earlier messages
          </button>
        ) : null}
        {messages.map((m) => {
          const day = dayLabel(m.createdAt);
          const showDay = day !== lastDay;
          lastDay = day;
          const mine = m.sender?.id === me?.person.id;
          const counts = Object.entries(m.reactions || {}).filter(([k]) => k !== "mine") as Array<[string, number]>;
          const mineReactions = (m.reactions?.mine as string[] | undefined) ?? [];
          return (
            <div key={m.id}>
              {showDay ? <div className="msg-day">{day}</div> : null}
              <div className={`msg-line ${mine ? "me" : "them"}`}>
                {editingId === m.id ? (
                  <div className="bubble editing">
                    <textarea className="in" value={editText} onChange={(e) => setEditText(e.target.value)} rows={2} data-testid="messages-edit-input" />
                    <div className="row" style={{ marginTop: 6 }}>
                      <button type="button" className="btn p s" onClick={() => void saveEdit(m.id)} data-testid="messages-edit-save">Save</button>
                      <button type="button" className="btn g s" onClick={() => setEditingId(null)} data-testid="messages-edit-cancel">Cancel</button>
                    </div>
                  </div>
                ) : m.deletedAt ? (
                  <div className="bubble">
                    <span className="msg-deleted">Message deleted</span>
                  </div>
                ) : (
                  <div className={`bubble ${mine ? "me" : ""}`} data-testid={`messages-bubble-${m.id}`}>
                    {m.replyTo ? (
                      <div className="quote">
                        <b>{m.replyTo.senderName}</b>: {m.replyTo.body ?? "(deleted)"}
                      </div>
                    ) : null}
                    {m.kind === "IMAGE" && m.asset ? <img className="msg-img" src={m.asset.url} alt="" /> : null}
                    {m.kind === "VIDEO" && m.asset ? <video className="msg-img" src={m.asset.url} controls /> : null}
                    {m.kind === "AUDIO" && m.asset ? <audio className="msg-audio" src={m.asset.url} controls /> : null}
                    {m.kind === "FILE" && m.asset ? (
                      <a href={m.asset.url} target="_blank" rel="noreferrer" className="row">
                        <Icon name="doc" /> {m.asset.name ?? "File"}
                      </a>
                    ) : null}
                    {m.body ? <div>{m.body}</div> : null}
                    <small>
                      {fmtDate(m.createdAt, { hour: "numeric", minute: "2-digit" } as any)}
                      {m.editedAt ? " · edited" : ""}
                      {mine && m.id === lastMineId && seenLastMine ? <span data-testid="messages-seen"> · Seen</span> : null}
                    </small>
                  </div>
                )}
                {!m.deletedAt && editingId !== m.id ? (
                  <div className="msg-tools">
                    {REACTION_EMOJIS.slice(0, 3).map((e) => (
                      <button key={e} type="button" onClick={() => void react(m.id, e)} aria-label={`React ${e}`} data-testid={`messages-react-${m.id}-${e}`}>
                        {e}
                      </button>
                    ))}
                    <button type="button" onClick={() => setReplyTo({ id: m.id, senderName: m.sender?.name ?? "Someone", body: m.body })} aria-label="Reply" data-testid={`messages-reply-${m.id}`}>
                      <Icon name="arrow" />
                    </button>
                    <button type="button" onClick={() => setForwardMessageId(m.id)} aria-label="Forward" data-testid={`messages-forward-${m.id}`}>
                      <Icon name="share" />
                    </button>
                    {m.body ? (
                      <button type="button" onClick={() => { void navigator.clipboard?.writeText(m.body ?? ""); toast("Copied."); }} aria-label="Copy" data-testid={`messages-copy-${m.id}`}>
                        <Icon name="copy" />
                      </button>
                    ) : null}
                    {mine ? (
                      <button type="button" onClick={() => { setEditingId(m.id); setEditText(m.body ?? ""); }} aria-label="Edit" data-testid={`messages-edit-${m.id}`}>
                        <Icon name="edit" />
                      </button>
                    ) : null}
                    {mine ? (
                      <button type="button" onClick={() => setConfirmDeleteId(m.id)} aria-label="Delete" data-testid={`messages-delete-${m.id}`}>
                        <Icon name="trash" />
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {counts.length ? (
                  <div className="msg-reactions">
                    {counts.map(([emoji, count]) => (
                      <span key={emoji} className={`rx ${mineReactions.includes(emoji) ? "mine" : ""}`} onClick={() => void react(m.id, emoji)} data-testid={`messages-rx-${m.id}-${emoji}`}>
                        {emoji} {count as number}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
        {typingNames.size ? <div className="msg-typing">{[...typingNames].join(", ")} {typingNames.size === 1 ? "is" : "are"} typing…</div> : null}
      </div>

      <Composer threadId={threadId} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} onSent={onComposerSent} />

      <Dialog open={!!confirmDeleteId} onClose={() => setConfirmDeleteId(null)} title="Delete message?" footer={
        <>
          <button type="button" className="btn g" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
          <button type="button" className="btn d" onClick={() => confirmDeleteId && void doDelete(confirmDeleteId)} data-testid="messages-delete-confirm">Delete</button>
        </>
      }>
        <p className="sm dim">This can't be undone. The other side will see "Message deleted".</p>
      </Dialog>

      <ForwardDialog messageId={forwardMessageId} currentThreadId={threadId} onClose={() => setForwardMessageId(null)} />
    </div>
  );
}

function ForwardDialog({ messageId, currentThreadId, onClose }: { messageId: string | null; currentThreadId: string; onClose: () => void }) {
  const toast = useToast();
  const [threads, setThreads] = useState<ThreadListItem[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!messageId) return;
    void api<{ items: ThreadListItem[] }>("/threads?tab=inbox").then((r) => setThreads(r.items.filter((t) => t.id !== currentThreadId)));
  }, [messageId, currentThreadId]);

  async function forwardTo(targetId: string) {
    if (!messageId) return;
    setBusy(true);
    try {
      const res = await api<{ results: Array<{ threadId: string; ok: boolean; error?: string }> }>(`/threads/${currentThreadId}/messages/${messageId}/forward`, { method: "POST", body: { toThreadIds: [targetId] } });
      const r = res.results[0];
      if (r?.ok) toast("Forwarded.");
      else toast(r?.error ?? "Couldn't forward that message.", { kind: "err" });
      onClose();
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!messageId} onClose={onClose} title="Forward message">
      {threads.length ? (
        <div className="list sm" data-testid="messages-forward-list">
          {threads.map((t) => (
            <div key={t.id} className="li">
              <Avatar name={t.title} size={32} />
              <div className="t">
                <b>{t.title}</b>
              </div>
              <button type="button" className="btn p s" disabled={busy} onClick={() => void forwardTo(t.id)} data-testid={`messages-forward-to-${t.id}`}>
                Forward
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="sm dim">No other conversations to forward into yet.</p>
      )}
    </Dialog>
  );
}
