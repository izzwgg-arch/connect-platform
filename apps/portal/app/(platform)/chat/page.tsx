"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { Inbox, MessageSquareText, Plus, Smartphone, UsersRound } from "lucide-react";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { ChatConversation } from "../../../components/chat/ChatConversation";
import { ChatInbox } from "../../../components/chat/ChatInbox";
import { NewChatDialog } from "../../../components/chat/NewChatDialog";
import { mergeChatMessages, resolveActiveThread, type ChatScrollIntent, type ChatScrollReason } from "../../../components/chat/chatState";
import type { ChatDirectoryUser, ChatMessage, ChatThread, PendingAttachment } from "../../../components/chat/types";
import { apiDelete, apiGet, apiPatch, apiPost, apiUploadChatAttachment, ApiError } from "../../../services/apiClient";
import { CRMPageHeader, CRMWorkspaceMain, CRMWorkspaceRightRail, cn, crm } from "../../../components/crm";

// ── Main Page ─────────────────────────────────────────────────────────────────

const CHAT_PREVIEW_ENABLED = process.env.NODE_ENV === "development";

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const CHAT_PREVIEW_THREADS: ChatThread[] = Array.from({ length: 18 }, (_, index) => {
  const sms = index % 3 !== 0;
  const ext = `${220 + index}`;
  return {
    id: `preview-thread-${index + 1}`,
    type: sms ? "SMS" : index % 2 === 0 ? "GROUP" : "DM",
    participantName: sms
      ? ["Avery Stone Forms Austin GA", "Jordan Hayes Retail", "Morgan River Capital", "Northstar Funding Desk", "Harbor Retail Group", "Crescent Auto Leads"][index % 6]
      : ["Sales Floor", "Support Desk", "Local Dev Workspace", "Operations Team"][index % 4],
    participantExtension: sms ? "" : ext,
    externalSmsE164: sms ? `+1555${String(910000 + index).padStart(6, "0")}` : null,
    smsInboxKind: sms ? (index % 2 === 0 ? "shared" : "personal") : null,
    crmSms: sms,
    isDefaultTenantGroup: !sms && index % 4 === 2,
    lastMessage: [
      "I have the signed docs ready when you are.",
      "Can you call me after the next appointment?",
      "Quick update: underwriting asked for one more statement.",
      "The quote looks good. Send the next step.",
      "Please confirm the delivery window.",
      "Looping in the team so everyone has the latest.",
    ][index % 6],
    lastAt: minutesAgoIso(6 + index * 11),
    unread: index % 5 === 0 ? 3 : index % 4 === 0 ? 1 : 0,
  };
});

function buildPreviewMessages(thread: ChatThread | null): ChatMessage[] {
  if (!thread) return [];
  return Array.from({ length: 42 }, (_, index) => {
    const mine = index % 3 === 2;
    return {
      id: `${thread.id}-message-${index + 1}`,
      threadId: thread.id,
      senderId: mine ? "preview-me" : "preview-peer",
      senderName: mine ? "Local Dev" : thread.participantName,
      body: mine
        ? [
            "Got it. I am checking that now.",
            "Thanks, I will send the update shortly.",
            "Confirmed. I added this to the customer notes.",
            "I can call you back after the current queue clears.",
          ][index % 4]
        : [
            "Can you take a look at this and let me know what is missing?",
            "The customer just replied with the final document.",
            "Please keep this thread open while we confirm the number.",
            "This is another preview message to prove the message list scrolls independently.",
          ][index % 4],
      sentAt: minutesAgoIso(120 - index * 2),
      mine,
      type: "TEXT",
      deliveryStatus: mine ? "sent" : null,
      reactions: index % 9 === 0 ? [{ emoji: "👍", userId: "preview-peer" }] : [],
      attachments: [],
      mmsUrls: [],
    };
  });
}

function ChatKpiTile({
  label,
  value,
  icon,
  micro,
  accent,
}: {
  label: string;
  value: number;
  icon: ReactNode;
  micro: string;
  accent: "blue" | "green" | "cyan" | "violet";
}) {
  return (
    <div className={cn(crm.queueCountPill, `crm-queue-kpi-${accent}`, "relative overflow-hidden bg-crm-surface-2")}>
      <span className="flex w-full items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="crm-queue-kpi-label block text-[10px] font-bold uppercase tracking-wide text-crm-muted">{label}</span>
          <span className="crm-queue-kpi-value mt-1 block text-2xl font-bold tabular-nums leading-none tracking-tight text-crm-text">
            {value}
          </span>
        </span>
        <span className="crm-queue-kpi-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface/70 text-crm-accent">
          {icon}
        </span>
      </span>
      <span className="crm-queue-kpi-micro text-[10px] font-medium text-crm-muted">{micro}</span>
    </div>
  );
}

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
  const [handledThreadId, setHandledThreadId] = useState("");
  const messagesRef = useRef<ChatMessage[]>([]);
  const messageRequestSeq = useRef(0);
  const lastReadPostRef = useRef<{ threadId: string; ts: number } | null>(null);
  const loadedThreadId = useRef<string | null>(null);

  const threadsState = useAsyncResource<{ threads: ChatThread[] }>(
    () => apiGet("/chat/threads"),
    [threadReload, tenantId, adminScope]
  );
  const directoryState = useAsyncResource<{ users: ChatDirectoryUser[] }>(
    () => apiGet("/chat/directory"),
    [tenantId, adminScope]
  );

  const apiThreads: ChatThread[] = useMemo(
    () => threadsState.status === "success" ? (threadsState.data.threads ?? []) : [],
    [threadsState.status, threadsState.status === "success" ? threadsState.data.threads : null],
  );
  const threads: ChatThread[] = useMemo(() => {
    if (!CHAT_PREVIEW_ENABLED) return apiThreads;
    const existingIds = new Set(apiThreads.map((thread) => thread.id));
    const needed = Math.max(0, 18 - apiThreads.length);
    return [
      ...apiThreads,
      ...CHAT_PREVIEW_THREADS.filter((thread) => !existingIds.has(thread.id)).slice(0, needed),
    ];
  }, [apiThreads]);

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
    if (threadId.startsWith("preview-thread-")) {
      const previewThread = threads.find((thread) => thread.id === threadId) ?? null;
      setMessages(buildPreviewMessages(previewThread));
      loadedThreadId.current = threadId;
      setScrollIntent({ reason: isThreadSwitch ? "initial" : reason, token: Date.now() });
      setMessageLoading(false);
      return;
    }
    try {
      const res = await apiGet<{ messages: ChatMessage[] }>(`/chat/threads/${threadId}/messages`);
      if (requestId !== messageRequestSeq.current) return;
      const nextMessages = res.messages ?? [];
      setMessages((prev) => isThreadSwitch ? nextMessages : mergeChatMessages(prev, nextMessages));
      loadedThreadId.current = threadId;
      // Viewing a thread marks it read for the team (server skips tenant-wide
      // silent viewers). Re-post when a newer message lands while it stays open.
      {
        const newest = nextMessages.length > 0 ? nextMessages[nextMessages.length - 1] : null;
        const newestTs = newest ? new Date(newest.sentAt).getTime() || 0 : 0;
        const marker = lastReadPostRef.current;
        if (!marker || marker.threadId !== threadId || newestTs > marker.ts) {
          lastReadPostRef.current = { threadId, ts: newestTs };
          void apiPost<{ ok?: boolean; skipped?: string }>(`/chat/threads/${threadId}/read`, {})
            .then((r) => {
              if (!r?.skipped) {
                setThreadReload((k) => k + 1);
                window.dispatchEvent(new Event("cc:navbadges:refresh"));
              }
            })
            .catch(() => undefined);
        }
      }
      setScrollIntent({ reason: isThreadSwitch ? "initial" : reason, token: Date.now() });
    } catch {
      if (requestId === messageRequestSeq.current && messagesRef.current.length === 0) setMessages([]);
    } finally {
      if (requestId === messageRequestSeq.current) setMessageLoading(false);
    }
  }, [threads]);

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
    const targetThreadId = searchParams.get("threadId");
    if (!targetThreadId || targetThreadId === handledThreadId || threads.length === 0) return;
    const thread = threads.find((item) => item.id === targetThreadId);
    if (!thread) return;
    setHandledThreadId(targetThreadId);
    setPendingThreadId(targetThreadId);
    setActiveThread(thread);
  }, [searchParams, threads, handledThreadId]);

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
    } catch (err) {
      setDraft(body);
      setPendingAttachments(atts);
      setReplyingTo(reply);
      const message = err instanceof ApiError ? err.message : "Message failed to send";
      showToast(message);
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
  const unreadTotal = useMemo(() => threads.filter((thread) => thread.isNew || (thread.unread || 0) > 0).length, [threads]);
  const smsThreads = useMemo(() => threads.filter((thread) => thread.type === "SMS").length, [threads]);
  const internalThreads = Math.max(threads.length - smsThreads, 0);

  return (
    <div className={`cc-shell crm-queue-workspace crm-contacts-workspace ${activeThread ? "has-active" : ""}`}>
      <section className="cc-page-header crm-workspace-header">
        <CRMPageHeader
          compact
          className={cn(crm.contactsHeaderPanel, "campaigns-command-header")}
          icon={<MessageSquareText className="h-6 w-6" aria-hidden />}
          title="Chat"
          actions={(
            <button type="button" className={cn(crm.btnPrimary, "cc-header-action")} onClick={() => setShowNewChat(true)}>
              <Plus className="h-4 w-4" />
              New chat
            </button>
          )}
        />
      </section>

      <section className="cc-kpi-strip crm-queue-kpi-strip grid w-full grid-cols-2 items-stretch gap-3 md:grid-cols-4" aria-label="Chat metrics">
        <ChatKpiTile label="Total threads" value={threads.length} icon={<Inbox className="h-4 w-4" />} micro="active conversations" accent="blue" />
        <ChatKpiTile label="Unread" value={unreadTotal} icon={<MessageSquareText className="h-4 w-4" />} micro="needs reply" accent="violet" />
        <ChatKpiTile label="SMS inboxes" value={smsThreads} icon={<Smartphone className="h-4 w-4" />} micro="customer threads" accent="green" />
        <ChatKpiTile label="Internal" value={internalThreads} icon={<UsersRound className="h-4 w-4" />} micro="team conversations" accent="cyan" />
      </section>

      <section className={`cc-workspace crm-workspace-body ${activeThread ? "crm-workspace-body--split" : ""}`}>
        <CRMWorkspaceMain className="cc-workspace-main">
          <ChatInbox
            threads={filtered}
            activeThreadId={activeThread?.id}
            search={search}
            onSearch={setSearch}
            onSelect={setActiveThread}
            loading={threadsState.status === "loading"}
          />
        </CRMWorkspaceMain>

        {activeThread ? (
          <CRMWorkspaceRightRail className="cc-side-panel crm-queue-right-rail crm-queue-detail-rail flex flex-col min-h-0">
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
          </CRMWorkspaceRightRail>
        ) : null}
      </section>
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
