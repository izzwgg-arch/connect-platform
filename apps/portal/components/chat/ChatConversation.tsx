"use client";

import { ArrowLeft, Phone, RefreshCcw } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { useSipPhone } from "../../hooks/useSipPhone";
import { isNearScrollBottom, shouldAutoScroll, shouldPreserveScrollOffset, type ChatScrollIntent } from "./chatState";
import { ChatComposer } from "./ChatComposer";
import { MessageBubble } from "./MessageBubble";
import { crmSmsBadge, initials, smsInboxBadge, threadLabel } from "./formatting";
import type { ChatMessage, ChatThread, PendingAttachment } from "./types";

export function ChatConversation({
  thread,
  messages,
  loading,
  draft,
  onDraft,
  replyingTo,
  onReply,
  onCancelReply,
  onEdit,
  onDeleteMe,
  onDeleteEveryone,
  onReact,
  onRemoveReaction,
  pendingAttachments,
  onAttachFiles,
  onRemovePending,
  onSend,
  sending,
  onBack,
  onRefresh,
  scrollIntent,
  canSendMessages = true,
}: {
  thread: ChatThread | null;
  messages: ChatMessage[];
  loading: boolean;
  draft: string;
  onDraft: (value: string) => void;
  replyingTo: ChatMessage | null;
  onReply: (message: ChatMessage) => void;
  onCancelReply: () => void;
  onEdit: (message: ChatMessage) => void;
  onDeleteMe: (message: ChatMessage) => void;
  onDeleteEveryone: (message: ChatMessage) => void;
  onReact: (message: ChatMessage, emoji: string) => void;
  onRemoveReaction: (message: ChatMessage, emoji: string) => void;
  pendingAttachments: PendingAttachment[];
  onAttachFiles: (files: File[]) => void;
  onRemovePending: (index: number) => void;
  onSend: (options?: { type?: string; location?: { lat: number; lng: number; label?: string; address?: string } }) => void;
  sending: boolean;
  onBack: () => void;
  onRefresh: () => void;
  scrollIntent: ChatScrollIntent;
  /** When false, composer is hidden (e.g. view-only shared SMS). */
  canSendMessages?: boolean;
}) {
  const phone = useSipPhone();
  const listRef = useRef<HTMLElement | null>(null);
  const previousThreadId = useRef<string | null>(null);
  const previousCount = useRef(0);
  const previousScrollHeight = useRef(0);
  const wasNearBottom = useRef(true);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !thread) return;

    const threadChanged = previousThreadId.current !== thread.id;
    const priorScrollHeight = previousScrollHeight.current;
    const priorCount = previousCount.current;
    const nearBottomBeforeUpdate = threadChanged ? true : wasNearBottom.current;

    if (shouldAutoScroll({
      reason: scrollIntent.reason,
      threadChanged,
      wasNearBottom: nearBottomBeforeUpdate,
      previousCount: priorCount,
      nextCount: messages.length,
    })) {
      list.scrollTop = list.scrollHeight;
    } else if (shouldPreserveScrollOffset({
      reason: scrollIntent.reason,
      threadChanged,
      wasNearBottom: nearBottomBeforeUpdate,
      previousScrollHeight: priorScrollHeight,
      nextScrollHeight: list.scrollHeight,
    })) {
      list.scrollTop += list.scrollHeight - priorScrollHeight;
    }

    previousThreadId.current = thread.id;
    previousCount.current = messages.length;
    previousScrollHeight.current = list.scrollHeight;
    wasNearBottom.current = isNearScrollBottom(list);
  }, [messages, scrollIntent, thread]);

  if (!thread) {
    return (
      <main className="cc-conversation empty">
        <div className="cc-empty-chat">
          <span>💬</span>
          <h2>Select a conversation</h2>
          <p>Choose a thread or start a new SMS / internal Connect chat.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="cc-conversation">
      <header className="cc-conv-head">
        <button type="button" className="cc-icon-btn cc-mobile-back" onClick={onBack}><ArrowLeft size={18} /></button>
        <span className="cc-avatar large">{initials(thread.participantName)}</span>
        <div className="cc-conv-title">
          <h2>{thread.participantName}</h2>
          <p>
            {threadLabel(thread.type)}
            {thread.type === "SMS" && crmSmsBadge(thread.crmSms) ? (
              <> · <span className="cc-sms-inbox-badge cc-sms-inbox-shared">{crmSmsBadge(thread.crmSms)}</span></>
            ) : null}
            {thread.type === "SMS" && smsInboxBadge(thread.smsInboxKind) ? (
              <> · <span className={`cc-sms-inbox-badge cc-sms-inbox-${thread.smsInboxKind}`}>{smsInboxBadge(thread.smsInboxKind)}</span></>
            ) : null}
            {thread.participantExtension ? ` · Ext ${thread.participantExtension}` : thread.externalSmsE164 ? ` · ${thread.externalSmsE164}` : ""}
          </p>
        </div>
        <button type="button" className="cc-icon-btn" onClick={onRefresh} title="Refresh"><RefreshCcw size={17} /></button>
        {thread.participantExtension ? (
          <button type="button" className="cc-call-btn" onClick={() => phone.dial(thread.participantExtension)}><Phone size={16} /> <span>Call</span></button>
        ) : null}
      </header>

      <section
        className="cc-message-list"
        ref={listRef}
        onScroll={(event) => {
          wasNearBottom.current = isNearScrollBottom(event.currentTarget);
          previousScrollHeight.current = event.currentTarget.scrollHeight;
        }}
      >
        {loading && messages.length === 0 ? (
          <div className="cc-empty-mini">Loading messages...</div>
        ) : messages.length === 0 ? (
          <div className="cc-empty-mini">No messages yet. Say hello.</div>
        ) : messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            onReact={(emoji) => onReact(message, emoji)}
            onRemoveReaction={(emoji) => onRemoveReaction(message, emoji)}
            onReply={() => onReply(message)}
            onEdit={() => onEdit(message)}
            onDeleteMe={() => onDeleteMe(message)}
            onDeleteEveryone={() => onDeleteEveryone(message)}
          />
        ))}
      </section>

      <ChatComposer
        thread={thread}
        draft={draft}
        onDraft={onDraft}
        replyingTo={replyingTo}
        onCancelReply={onCancelReply}
        pendingAttachments={pendingAttachments}
        onAttachFiles={onAttachFiles}
        onRemovePending={onRemovePending}
        onSend={onSend}
        sending={sending}
        disabled={!canSendMessages}
        disabledHint={!canSendMessages && thread.type === "SMS" && thread.smsInboxKind === "shared"
          ? "You can view this shared SMS inbox but do not have permission to send replies."
          : undefined}
      />
    </main>
  );
}
