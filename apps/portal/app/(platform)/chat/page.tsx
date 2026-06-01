"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { ChatConversation } from "../../../components/chat/ChatConversation";
import { ChatInbox } from "../../../components/chat/ChatInbox";
import { NewChatDialog } from "../../../components/chat/NewChatDialog";
import { mergeChatMessages, resolveActiveThread, type ChatScrollIntent, type ChatScrollReason } from "../../../components/chat/chatState";
import type { ChatDirectoryUser, ChatMessage, ChatThread, PendingAttachment } from "../../../components/chat/types";
import { apiDelete, apiGet, apiPatch, apiPost, apiUploadChatAttachment } from "../../../services/apiClient";

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ChatPage() {
  const { tenantId, adminScope, can } = useAppContext();
  const searchParams = useSearchParams();
  const [activeThread, setActiveThread] = useState<ChatThread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [search, setSearch] = useState("");
  const [showNewChat, setShowNewChat] = useState(false);
  const [msgReload, setMsgReload] = useState(0);
  const [threadReload, setThreadReload] = useState(0);
  const [pendingThreadId, setPendingThreadId] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [messageLoading, setMessageLoading] = useState(false);
  const [scrollIntent, setScrollIntent] = useState<ChatScrollIntent>({ reason: "initial", token: 0 });
  const [toast, setToast] = useState("");
  const [handledExt, setHandledExt] = useState("");
  const messagesRef = useRef<ChatMessage[]>([]);
  const messageRequestSeq = useRef(0);
  const loadedThreadId = useRef<string | null>(null);

  const threadsState = useAsyncResource<{ threads: ChatThread[] }>(
    () => apiGet("/chat/threads"),
    [threadReload, tenantId, adminScope]
  );
  const directoryState = useAsyncResource<{ users: ChatDirectoryUser[] }>(
    () => apiGet("/chat/directory"),
    [tenantId, adminScope]
  );

  const threads: ChatThread[] = threadsState.status === "success"
    ? (threadsState.data.threads ?? [])
    : [];

  const users = directoryState.status === "success" ? directoryState.data.users ?? [] : [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return threads.filter((t) =>
      !q ||
      t.participantName.toLowerCase().includes(q) ||
      t.participantExtension.includes(q) ||
      (t.externalSmsE164 || "").includes(q) ||
      (t.type || "").toLowerCase().includes(q)
    );
  }, [threads, search]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const loadMessages = useCallback(async (threadId: string, reason: ChatScrollReason = "background") => {
    const requestId = ++messageRequestSeq.current;
    const isThreadSwitch = loadedThreadId.current !== threadId;
    if (isThreadSwitch || messagesRef.current.length === 0) setMessageLoading(true);
    try {
      const res = await apiGet<{ messages: ChatMessage[] }>(`/chat/threads/${threadId}/messages`);
      if (requestId !== messageRequestSeq.current) return;
      const nextMessages = res.messages ?? [];
      setMessages((prev) => isThreadSwitch ? nextMessages : mergeChatMessages(prev, nextMessages));
      loadedThreadId.current = threadId;
      setScrollIntent({ reason: isThreadSwitch ? "initial" : reason, token: Date.now() });
    } catch {
      if (requestId === messageRequestSeq.current && messagesRef.current.length === 0) setMessages([]);
    } finally {
      if (requestId === messageRequestSeq.current) setMessageLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!activeThread) return;
    loadMessages(activeThread.id, "initial");
  }, [activeThread?.id, loadMessages]);

  useEffect(() => {
    if (!activeThread || msgReload === 0 || loadedThreadId.current !== activeThread.id) return;
    loadMessages(activeThread.id, "background");
  }, [msgReload, activeThread?.id, loadMessages]);

  useEffect(() => {
    setActiveThread((current) => {
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
    const targetExt = searchParams.get("ext");
    if (!targetExt || targetExt === handledExt || users.length === 0) return;
    const peer = users.find((u) => u.extensionNumber === targetExt);
    if (!peer) return;
    setHandledExt(targetExt);
    apiPost<{ threadId: string }>("/chat/threads", { type: "dm", peerUserId: peer.id })
      .then((res) => {
        setPendingThreadId(res.threadId);
        setThreadReload((k) => k + 1);
      })
      .catch(() => {});
  }, [searchParams, users, handledExt]);

  useEffect(() => {
    if (!activeThread) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setMsgReload((k) => k + 1);
      setThreadReload((k) => k + 1);
    }, 7000);
    return () => window.clearInterval(timer);
  }, [activeThread?.id]);

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
    } catch {
      setDraft(body);
      setPendingAttachments(atts);
      setReplyingTo(reply);
      showToast("Message failed to send");
    } finally {
      setSending(false);
    }
  }

  async function attachFiles(files: File[]) {
    if (!activeThread) return;
    for (const file of files.slice(0, 3)) {
      try {
        const r = await apiUploadChatAttachment(activeThread.id, file);
        setPendingAttachments((prev) => [...prev, {
          storageKey: r.storageKey,
          mimeType: r.mimeType,
          sizeBytes: r.sizeBytes,
          fileName: r.fileName,
          mediaKind: r.mediaKind ?? undefined,
          durationMs: r.durationMs ?? null,
          width: r.width ?? null,
          height: r.height ?? null,
        }].slice(0, 3));
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

  return (
    <div className={`cc-shell ${activeThread ? "has-active" : ""}`}>
      <ChatInbox
        threads={filtered}
        activeThreadId={activeThread?.id}
        search={search}
        onSearch={setSearch}
        onSelect={setActiveThread}
        onNewChat={() => setShowNewChat(true)}
        loading={threadsState.status === "loading"}
      />
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
      <NewChatDialog
        open={showNewChat}
        users={users}
        onClose={() => setShowNewChat(false)}
        onCreateSms={createSms}
        onCreateDm={createDm}
        onCreateGroup={createGroup}
      />
      {toast ? <div className="cc-toast">{toast}</div> : null}
    </div>
  );
}
