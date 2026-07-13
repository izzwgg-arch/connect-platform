"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckCheck, Plus, Search, User } from "lucide-react";
import { useAppContext } from "../../hooks/useAppContext";
import { ChatConversation } from "./ChatConversation";
import { NewChatDialog } from "./NewChatDialog";
import { mergeChatMessages, resolveActiveThread, type ChatScrollIntent, type ChatScrollReason } from "./chatState";
import { fmtChatTime, initials } from "./formatting";
import type { ChatDirectoryUser, ChatMessage, ChatThread, PendingAttachment } from "./types";
import { apiDelete, apiGet, apiPatch, apiPost, apiUploadChatAttachment, ApiError } from "../../services/apiClient";

type FilterKey = "all" | "unread" | "sms" | "dms";

const AVATAR_TONES = ["#22c55e", "#06b6d4", "#3b82f6", "#a78bfa", "#f59e0b", "#ec4899", "#14b8a6", "#8b5cf6"];

function toneFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

function chatBadge(type: string): string {
  if (type === "SMS") return "SMS";
  if (type === "DM") return "DM";
  return "Team chat";
}

function isPhoneLabel(name: string): boolean {
  return !/[a-z]/i.test(name || "");
}

function DeliveryTick({ status }: { status?: string | null }) {
  const s = (status || "").toLowerCase();
  if (!s) return null;
  if (s.includes("read") || s.includes("deliver")) return <CheckCheck size={14} className="mc-tick read" />;
  if (s.includes("sent") || s.includes("ok") || s.includes("queue")) return <Check size={14} className="mc-tick" />;
  return null;
}

export function MiniChat() {
  const { tenantId, adminScope, can } = useAppContext();

  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [users, setUsers] = useState<ChatDirectoryUser[]>([]);
  const [activeThread, setActiveThread] = useState<ChatThread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [showNewChat, setShowNewChat] = useState(false);
  const [msgReload, setMsgReload] = useState(0);
  const [threadReload, setThreadReload] = useState(0);
  const [pendingThreadId, setPendingThreadId] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [messageLoading, setMessageLoading] = useState(false);
  const [scrollIntent, setScrollIntent] = useState<ChatScrollIntent>({ reason: "initial", token: 0 });
  const [toast, setToast] = useState("");
  const messagesRef = useRef<ChatMessage[]>([]);
  const messageRequestSeq = useRef(0);
  const loadedThreadId = useRef<string | null>(null);
  const convRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Auto-grow the composer like the mobile app: the shared ChatComposer textarea
  // is fixed-height (rows=1) and just scrolls, so here we size it to its content
  // up to a max, then let it scroll. Also shorten the long default placeholder.
  useEffect(() => {
    const ta = convRef.current?.querySelector<HTMLTextAreaElement>(".cc-compose-bubble textarea");
    if (!ta) return;
    if (ta.placeholder !== "Message") ta.placeholder = "Message";
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
  }, [draft, activeThread?.id]);

  // The reused chat components are theme-token driven (var(--panel)/--bg/--text).
  // Force this window's document into dark mode while chat is mounted so the
  // conversation matches the mobile app. This is the pop-out mini window's own
  // document (always dark) and is separate from the browser portal.
  useEffect(() => {
    const el = document.documentElement;
    const prev = el.getAttribute("data-theme");
    el.setAttribute("data-theme", "dark");
    return () => {
      if (prev) el.setAttribute("data-theme", prev);
      else el.removeAttribute("data-theme");
    };
  }, []);

  useEffect(() => {
    let alive = true;
    apiGet<{ threads: ChatThread[] }>("/chat/threads")
      .then((r) => {
        if (!alive) return;
        setThreads(r.threads ?? []);
        setThreadsLoading(false);
      })
      .catch(() => {
        if (alive) setThreadsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [threadReload, tenantId, adminScope]);

  useEffect(() => {
    let alive = true;
    apiGet<{ users: ChatDirectoryUser[] }>("/chat/directory")
      .then((r) => {
        if (alive) setUsers(r.users ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tenantId, adminScope]);

  const loadMessages = useCallback(async (threadId: string, reason: ChatScrollReason = "background") => {
    const requestId = ++messageRequestSeq.current;
    const isThreadSwitch = loadedThreadId.current !== threadId;
    if (isThreadSwitch || messagesRef.current.length === 0) setMessageLoading(true);
    try {
      const res = await apiGet<{ messages: ChatMessage[] }>(`/chat/threads/${threadId}/messages`);
      if (requestId !== messageRequestSeq.current) return;
      const next = res.messages ?? [];
      setMessages((prev) => (isThreadSwitch ? next : mergeChatMessages(prev, next)));
      loadedThreadId.current = threadId;
      setScrollIntent({ reason: isThreadSwitch ? "initial" : reason, token: Date.now() });
    } catch {
      if (requestId === messageRequestSeq.current && messagesRef.current.length === 0) setMessages([]);
    } finally {
      if (requestId === messageRequestSeq.current) setMessageLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeThread) loadMessages(activeThread.id, "initial");
  }, [activeThread?.id, loadMessages]);

  useEffect(() => {
    if (!activeThread || msgReload === 0 || loadedThreadId.current !== activeThread.id) return;
    loadMessages(activeThread.id, "background");
  }, [msgReload, activeThread?.id, loadMessages]);

  useEffect(() => {
    setActiveThread((current) => {
      // Keep showing the list until the user opens a thread (mobile-style),
      // instead of auto-selecting the first conversation.
      if (!current && !pendingThreadId) return null;
      return resolveActiveThread(current, threads, pendingThreadId);
    });
    if (pendingThreadId) {
      const found = threads.find((t) => t.id === pendingThreadId);
      if (found) {
        setActiveThread(found);
        setPendingThreadId(null);
      }
    }
  }, [threads, pendingThreadId]);

  useEffect(() => {
    if (!activeThread) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setMsgReload((k) => k + 1);
      setThreadReload((k) => k + 1);
    }, 7000);
    return () => window.clearInterval(timer);
  }, [activeThread?.id]);

  useEffect(() => {
    if (activeThread) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setThreadReload((k) => k + 1);
    }, 7000);
    return () => window.clearInterval(timer);
  }, [activeThread]);

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2500);
  }

  async function sendMessage(options?: { type?: string; location?: { lat: number; lng: number; label?: string; address?: string } }) {
    if ((!draft.trim() && pendingAttachments.length === 0 && !options?.location) || !activeThread || sending) return;
    const body = draft.trim();
    const atts = [...pendingAttachments];
    const reply = replyingTo;
    setDraft("");
    setPendingAttachments([]);
    setReplyingTo(null);
    setSending(true);
    try {
      const payload: Record<string, unknown> = { body };
      if (atts.length) payload.attachments = atts;
      if (options?.type) payload.type = options.type;
      if (options?.location) payload.location = options.location;
      if (reply) payload.replyToMessageId = reply.id;
      await apiPost(`/chat/threads/${activeThread.id}/messages`, payload);
      setScrollIntent({ reason: "send", token: Date.now() });
      setMsgReload((k) => k + 1);
      setThreadReload((k) => k + 1);
    } catch (err) {
      setDraft(body);
      setPendingAttachments(atts);
      setReplyingTo(reply);
      showToast(err instanceof ApiError ? err.message : "Message failed to send");
    } finally {
      setSending(false);
    }
  }

  async function attachFiles(files: File[]) {
    if (!activeThread) return;
    for (const file of files.slice(0, 3)) {
      try {
        const r = await apiUploadChatAttachment(activeThread.id, file);
        setPendingAttachments((prev) =>
          [
            ...prev,
            {
              storageKey: r.storageKey,
              mimeType: r.mimeType,
              sizeBytes: r.sizeBytes,
              fileName: r.fileName,
              mediaKind: r.mediaKind ?? undefined,
              durationMs: r.durationMs ?? null,
              width: r.width ?? null,
              height: r.height ?? null,
            },
          ].slice(0, 3),
        );
      } catch (err) {
        showToast(String((err as Error)?.message || "Upload failed"));
      }
    }
  }

  async function createSms(phone: string) {
    const res = await apiPost<{ threadId: string }>("/chat/threads", { type: "sms", externalPhone: phone });
    setPendingThreadId(res.threadId);
    setThreadReload((k) => k + 1);
  }

  async function createDm(userId: string) {
    const res = await apiPost<{ threadId: string }>("/chat/threads", { type: "dm", peerUserId: userId });
    setPendingThreadId(res.threadId);
    setThreadReload((k) => k + 1);
  }

  async function createGroup(title: string, userIds: string[]) {
    const res = await apiPost<{ threadId: string }>("/chat/threads", { type: "group", title, peerUserIds: userIds });
    setPendingThreadId(res.threadId);
    setThreadReload((k) => k + 1);
  }

  async function react(message: ChatMessage, emoji: string) {
    if (!activeThread) return;
    await apiPost(`/chat/threads/${activeThread.id}/messages/${message.id}/reactions`, { emoji });
    setMsgReload((k) => k + 1);
  }

  async function removeReaction(message: ChatMessage, emoji: string) {
    if (!activeThread) return;
    await apiDelete(`/chat/threads/${activeThread.id}/messages/${message.id}/reactions/${encodeURIComponent(emoji)}`);
    setMsgReload((k) => k + 1);
  }

  async function editMessage(message: ChatMessage) {
    if (!activeThread) return;
    const next = window.prompt("Edit message", message.body);
    if (!next || next.trim() === message.body.trim()) return;
    await apiPatch(`/chat/threads/${activeThread.id}/messages/${message.id}`, { body: next.trim() });
    setMsgReload((k) => k + 1);
  }

  async function deleteMessage(message: ChatMessage, mode: "me" | "everyone") {
    if (!activeThread) return;
    await apiDelete(`/chat/threads/${activeThread.id}/messages/${message.id}?mode=${mode}`);
    setMsgReload((k) => k + 1);
    setThreadReload((k) => k + 1);
  }

  const canSendInActiveThread = !activeThread || activeThread.type !== "SMS" || can("can_send_sms");

  const counts = useMemo(
    () => ({
      all: threads.length,
      unread: threads.filter((t) => (t.unread || 0) > 0).length,
      sms: threads.filter((t) => t.type === "SMS").length,
      dms: threads.filter((t) => t.type === "DM").length,
    }),
    [threads],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return threads.filter((t) => {
      if (filter === "unread" && !((t.unread || 0) > 0)) return false;
      if (filter === "sms" && t.type !== "SMS") return false;
      if (filter === "dms" && t.type !== "DM") return false;
      return (
        !q ||
        t.participantName.toLowerCase().includes(q) ||
        t.participantExtension.includes(q) ||
        (t.externalSmsE164 || "").includes(q) ||
        (t.lastMessage || "").toLowerCase().includes(q)
      );
    });
  }, [threads, search, filter]);

  if (activeThread) {
    return (
      <div className="mc-conv-wrap" ref={convRef}>
        <ChatConversation
          thread={activeThread}
          messages={messages}
          loading={messageLoading}
          draft={draft}
          onDraft={setDraft}
          replyingTo={replyingTo}
          onReply={setReplyingTo}
          onCancelReply={() => setReplyingTo(null)}
          onEdit={editMessage}
          onDeleteMe={(message) => deleteMessage(message, "me")}
          onDeleteEveryone={(message) => deleteMessage(message, "everyone")}
          onReact={react}
          onRemoveReaction={removeReaction}
          pendingAttachments={pendingAttachments}
          onAttachFiles={attachFiles}
          onRemovePending={(index) => setPendingAttachments((prev) => prev.filter((_, i) => i !== index))}
          onSend={sendMessage}
          sending={sending}
          onBack={() => setActiveThread(null)}
          scrollIntent={scrollIntent}
          onRefresh={() => {
            setScrollIntent({ reason: "manual", token: Date.now() });
            setMsgReload((k) => k + 1);
            setThreadReload((k) => k + 1);
          }}
          canSendMessages={canSendInActiveThread}
        />
        {toast ? <div className="cc-toast">{toast}</div> : null}
        <style jsx global>{`
          .mc-conv-wrap {
            height: 100%; min-height: 0; display: flex; flex-direction: column;
            /* Force the shared chat components to the mobile dark palette.
               These design tokens cascade to every cc-* descendant, so the
               conversation matches the rest of the dark dialer (and the mobile
               app) without touching global styles or the browser experience. */
            --bg: #090e18; --panel: #111827; --panel-2: #162034; --panel-3: #1a2740;
            --border: #1e2d47; --text: #f0f4ff; --text-dim: #8899bb; --text-dimmer: #4d6088;
            --accent: #3b82f6; --accent-2: #2563eb; --danger: #ef4444;
            color: #f0f4ff;
          }
          .mc-conv-wrap .cc-conversation { height: 100%; min-height: 0; flex: 1; border: 0; border-radius: 0; display: flex; flex-direction: column; }
          .mc-conv-wrap .cc-message-list { flex: 1; min-height: 0; overflow-y: auto; }
          .mc-conv-wrap .cc-conv-head { min-height: 52px; padding: 10px 12px; gap: 10px; }
          .mc-conv-wrap .cc-conv-head h2 { font-size: 15px; color: var(--text); }
          .mc-conv-wrap .cc-conv-head p { font-size: 11px; color: var(--text-dim); }
          .mc-conv-wrap .cc-conv-title { min-width: 0; }
          .mc-conv-wrap .cc-avatar.large { width: 36px; height: 36px; font-size: 13px; }
          .mc-conv-wrap .cc-call-btn span { display: none; }
          /* Wider bubbles for the narrow pop-out window (64% is too pinched here). */
          .mc-conv-wrap .cc-msg-wrap { max-width: 86%; }
          .mc-conv-wrap .cc-message-list { overflow-x: hidden; }
          /* Images ship with a fixed inline width (up to 260px) that overflows the
             narrow bubble. Make them responsive so they never exceed the bubble. */
          .mc-conv-wrap .cc-attach-stack { max-width: 100%; min-width: 0; }
          .mc-conv-wrap .cc-attach-image-bubble { width: auto !important; height: auto !important; max-width: 100% !important; }
          .mc-conv-wrap .cc-attach-image-bubble img { width: auto !important; height: auto !important; max-width: 100% !important; max-height: 300px !important; object-fit: contain !important; }
          .mc-conv-wrap .cc-attach-media video { max-width: 100% !important; height: auto !important; }
          .mc-conv-wrap .cc-voicenote { max-width: 100%; }
          .mc-conv-wrap .cc-attach-file { max-width: 100%; }
          /* The pill "bubble" composer (emoji + attach + input + send/mic on one
             row) is only styled for the CRM shell. Port it to the mini window so
             the bottom bar looks and works like the mobile composer instead of a
             stack of unstyled controls with a clipped input. */
          /* No panel/wrapper behind the composer - it sits directly on the page. */
          .mc-conv-wrap .cc-composer { padding: 8px 10px calc(8px + env(safe-area-inset-bottom, 0px)); background: transparent; border-top: 0; box-shadow: none; }
          .mc-conv-wrap .cc-compose-row { display: flex; align-items: flex-end; gap: 0; }
          .mc-conv-wrap .cc-compose-bubble {
            position: relative; display: flex; align-items: flex-end; gap: 4px; width: 100%;
            min-height: 44px; padding: 4px;
            border: 1px solid color-mix(in srgb, var(--border) 76%, transparent);
            border-radius: 22px; background: var(--panel-2);
          }
          .mc-conv-wrap .cc-compose-bubble textarea {
            flex: 1; min-width: 0; min-height: 34px; max-height: 140px; padding: 8px 8px;
            border: 0; border-radius: 0; background: transparent; box-shadow: none; outline: none;
            color: var(--text); resize: none; font: inherit; font-size: 14px; line-height: 1.4;
            overflow-y: auto;
          }
          .mc-conv-wrap .cc-compose-bubble textarea::placeholder { color: var(--text-dim); }
          .mc-conv-wrap .cc-compose-bubble textarea { scrollbar-width: none; }
          .mc-conv-wrap .cc-compose-bubble textarea::-webkit-scrollbar { width: 0; height: 0; }
          .mc-conv-wrap .cc-compose-icon,
          .mc-conv-wrap .cc-compose-action {
            width: 36px; height: 36px; flex: 0 0 auto; display: inline-flex; align-items: center;
            justify-content: center; border: 0; border-radius: 999px; background: transparent;
            color: var(--text-dim); cursor: pointer; transition: background .15s ease, color .15s ease, transform .15s ease;
          }
          .mc-conv-wrap .cc-compose-icon:hover,
          .mc-conv-wrap .cc-compose-icon.active { color: var(--text); background: rgba(59,130,246,0.16); }
          .mc-conv-wrap .cc-plus-btn.active { transform: rotate(45deg); }
          .mc-conv-wrap .cc-compose-action {
            color: #fff; background: #3b82f6; box-shadow: 0 6px 16px rgba(59,130,246,0.35);
          }
          .mc-conv-wrap .cc-compose-action:hover { filter: brightness(1.05); }
          .mc-conv-wrap .cc-compose-action:disabled { cursor: not-allowed; opacity: 0.5; box-shadow: none; }
          .mc-conv-wrap .cc-sms-counter { font-size: 11px; padding: 6px 4px 0; }
          /* Recording bar tidy-up for the narrow window. */
          .mc-conv-wrap .cc-recording { gap: 6px; }
        `}</style>
      </div>
    );
  }

  const chips: Array<[FilterKey, string, number]> = [
    ["all", "All", counts.all],
    ["unread", "Unread", counts.unread],
    ["sms", "SMS", counts.sms],
    ["dms", "DMs", counts.dms],
  ];

  return (
    <div className="mc-list">
      <div className="mc-head">
        <div className="mc-head-text">
          <div className="mc-title">Chat</div>
          <div className="mc-sub">
            {threads.length} conversation{threads.length === 1 ? "" : "s"}
          </div>
        </div>
        <button type="button" className="mc-new" onClick={() => setShowNewChat(true)} aria-label="New chat">
          <Plus size={20} />
        </button>
      </div>

      <div className="mc-search">
        <Search size={16} />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search conversations..." />
      </div>

      <div className="mc-chips">
        {chips.map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            className={"mc-chip" + (filter === key ? " active" : "")}
            onClick={() => setFilter(key)}
          >
            <span>{label}</span>
            {count > 0 ? <small>{count}</small> : null}
          </button>
        ))}
      </div>

      <div className="mc-threads">
        {threadsLoading && threads.length === 0 ? (
          <p className="mc-empty">Loading conversations...</p>
        ) : filtered.length === 0 ? (
          <p className="mc-empty">No conversations</p>
        ) : (
          filtered.map((t) => {
            const phoneish = isPhoneLabel(t.participantName);
            const tone = toneFor(t.participantName || t.id);
            return (
              <button type="button" className="mc-thread" key={t.id} onClick={() => setActiveThread(t)}>
                <span className={"mc-av" + (phoneish ? " ph" : "")} style={phoneish ? undefined : { background: tone }}>
                  {phoneish ? <User size={20} /> : initials(t.participantName)}
                  {t.type === "DM" ? <i className="mc-online" /> : null}
                </span>
                <span className="mc-main">
                  <span className="mc-row1">
                    <strong className="mc-name">{t.participantName}</strong>
                    <span className={"mc-badge " + t.type.toLowerCase()}>{chatBadge(t.type)}</span>
                  </span>
                  <span className="mc-preview">{t.lastMessage || "No messages yet"}</span>
                </span>
                <span className="mc-right">
                  <small className="mc-date">{fmtChatTime(t.lastAt)}</small>
                  {t.unread > 0 ? <span className="mc-unread">{t.unread}</span> : <DeliveryTick status={t.deliveryStatus} />}
                </span>
              </button>
            );
          })
        )}
      </div>

      <NewChatDialog
        open={showNewChat}
        users={users}
        onClose={() => setShowNewChat(false)}
        onCreateSms={createSms}
        onCreateDm={createDm}
        onCreateGroup={createGroup}
      />
      {toast ? <div className="cc-toast">{toast}</div> : null}

      <style jsx>{`
        .mc-list { display: flex; flex-direction: column; }
        .mc-head { display: flex; align-items: flex-start; justify-content: space-between; padding: 16px 16px 10px; }
        .mc-title { font-size: 26px; font-weight: 800; letter-spacing: -0.7px; color: #f0f4ff; line-height: 30px; }
        .mc-sub { margin-top: 2px; font-size: 13px; font-weight: 600; color: #8899bb; }
        .mc-new { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; border: 0; background: #3b82f6; color: #fff; cursor: pointer; flex-shrink: 0; box-shadow: 0 6px 16px rgba(59,130,246,0.4); }
        .mc-search { display: flex; align-items: center; gap: 10px; margin: 0 14px 10px; height: 44px; padding: 0 14px; border-radius: 16px; border: 0.5px solid #1e2d47; background: #111827; color: #4d6088; }
        .mc-search input { flex: 1; min-width: 0; border: 0; background: transparent; outline: none; color: #f0f4ff; font-size: 14px; font-weight: 500; }
        .mc-search input::placeholder { color: #4d6088; }
        .mc-chips { display: flex; gap: 7px; margin: 0 14px 8px; }
        .mc-chip { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; border-radius: 16px; border: 0.5px solid #182339; background: #162034; color: #8899bb; cursor: pointer; }
        .mc-chip span { font-size: 12px; font-weight: 800; }
        .mc-chip small { display: grid; place-items: center; min-width: 17px; height: 17px; padding: 0 4px; border-radius: 9px; background: rgba(136,153,187,0.2); color: #cbd5f5; font-size: 10px; font-weight: 800; }
        .mc-chip.active { border-color: rgba(59,130,246,0.5); background: #3b82f6; color: #fff; }
        .mc-chip.active small { background: rgba(255,255,255,0.25); color: #fff; }
        .mc-threads { display: flex; flex-direction: column; padding: 2px 8px 12px; }
        .mc-thread { display: flex; align-items: center; gap: 12px; padding: 11px 8px; border: 0; border-bottom: 0.5px solid #131d30; background: transparent; cursor: pointer; text-align: left; width: 100%; }
        .mc-thread:active { background: rgba(59,130,246,0.06); }
        .mc-av { position: relative; display: grid; place-items: center; width: 46px; height: 46px; border-radius: 50%; color: #fff; font-size: 15px; font-weight: 700; flex-shrink: 0; }
        .mc-av.ph { background: rgba(136,153,187,0.22); color: #c7d2e5; }
        .mc-online { position: absolute; right: 1px; bottom: 1px; width: 12px; height: 12px; border-radius: 50%; background: #22c55e; border: 2px solid #090e18; }
        .mc-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
        .mc-row1 { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .mc-name { font-size: 16px; font-weight: 800; letter-spacing: -0.2px; color: #f0f4ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
        .mc-badge { flex-shrink: 0; font-size: 11px; font-weight: 700; padding: 2px 9px; border-radius: 11px; border: 1px solid transparent; }
        .mc-badge.dm, .mc-badge.group, .mc-badge.tenant_group { color: #60a5fa; border-color: rgba(59,130,246,0.45); background: rgba(59,130,246,0.10); }
        .mc-badge.sms { color: #22d3ee; border-color: rgba(6,182,212,0.45); background: rgba(6,182,212,0.10); }
        .mc-preview { font-size: 13px; font-weight: 500; color: #8899bb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mc-right { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex-shrink: 0; }
        .mc-date { font-size: 12px; font-weight: 600; color: #4d6088; }
        .mc-tick { color: #4d6088; }
        .mc-tick.read { color: #3b82f6; }
        .mc-unread { display: grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: #3b82f6; color: #fff; font-size: 11px; font-weight: 800; }
        .mc-empty { text-align: center; color: #4d6088; font-size: 13px; padding: 40px 16px; }
      `}</style>
    </div>
  );
}
