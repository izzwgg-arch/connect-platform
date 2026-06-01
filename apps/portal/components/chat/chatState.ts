"use client";

import type { ChatMessage, ChatThread } from "./types";

export type ChatScrollReason = "initial" | "send" | "manual" | "background";

export interface ChatScrollIntent {
  reason: ChatScrollReason;
  token: number;
}

export function mergeChatMessages(previous: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return previous.length === 0 ? previous : [];

  const byId = new Map<string, ChatMessage>();
  for (const message of previous) byId.set(message.id, message);
  for (const message of incoming) {
    const existing = byId.get(message.id);
    byId.set(message.id, existing && shallowMessageEqual(existing, message) ? existing : message);
  }

  const merged = Array.from(byId.values()).sort((a, b) => {
    const byTime = new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime();
    return byTime || a.id.localeCompare(b.id);
  });

  if (merged.length === previous.length && merged.every((message, index) => message === previous[index])) {
    return previous;
  }
  return merged;
}

export function resolveActiveThread(
  current: ChatThread | null,
  threads: ChatThread[],
  pendingThreadId?: string | null,
): ChatThread | null {
  if (pendingThreadId) {
    return threads.find((thread) => thread.id === pendingThreadId) ?? current;
  }
  if (!current) return threads[0] ?? null;
  const refreshed = threads.find((thread) => thread.id === current.id);
  if (!refreshed) return current;
  return shallowThreadEqual(current, refreshed) ? current : refreshed;
}

export function isNearScrollBottom(metrics: { scrollTop: number; clientHeight: number; scrollHeight: number }, thresholdPx = 96): boolean {
  return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= thresholdPx;
}

export function shouldAutoScroll(args: {
  reason: ChatScrollReason;
  threadChanged: boolean;
  wasNearBottom: boolean;
  previousCount: number;
  nextCount: number;
}): boolean {
  if (args.threadChanged || args.reason === "initial" || args.reason === "send" || args.reason === "manual") return true;
  if (args.nextCount <= args.previousCount) return false;
  return args.wasNearBottom;
}

export function shouldPreserveScrollOffset(args: {
  reason: ChatScrollReason;
  threadChanged: boolean;
  wasNearBottom: boolean;
  previousScrollHeight: number;
  nextScrollHeight: number;
}): boolean {
  if (args.threadChanged || args.wasNearBottom || args.reason === "send" || args.reason === "manual") return false;
  return args.nextScrollHeight > args.previousScrollHeight;
}

function shallowThreadEqual(a: ChatThread, b: ChatThread): boolean {
  return (
    a.id === b.id &&
    a.type === b.type &&
    a.title === b.title &&
    a.participantName === b.participantName &&
    a.participantExtension === b.participantExtension &&
    a.externalSmsE164 === b.externalSmsE164 &&
    a.smsInboxKind === b.smsInboxKind &&
    a.crmSms === b.crmSms &&
    a.crmContactId === b.crmContactId &&
    a.lastMessage === b.lastMessage &&
    a.lastAt === b.lastAt &&
    a.unread === b.unread &&
    a.deliveryStatus === b.deliveryStatus &&
    a.deliveryError === b.deliveryError
  );
}

function shallowMessageEqual(a: ChatMessage, b: ChatMessage): boolean {
  return (
    a.id === b.id &&
    a.threadId === b.threadId &&
    a.senderId === b.senderId &&
    a.senderName === b.senderName &&
    a.body === b.body &&
    a.sentAt === b.sentAt &&
    a.mine === b.mine &&
    a.type === b.type &&
    a.editedAt === b.editedAt &&
    a.deletedForEveryoneAt === b.deletedForEveryoneAt &&
    a.deliveryStatus === b.deliveryStatus &&
    a.deliveryError === b.deliveryError &&
    JSON.stringify(a.reactions ?? []) === JSON.stringify(b.reactions ?? []) &&
    JSON.stringify(a.mmsUrls ?? []) === JSON.stringify(b.mmsUrls ?? []) &&
    JSON.stringify(a.location ?? null) === JSON.stringify(b.location ?? null) &&
    JSON.stringify(a.replyTo ?? null) === JSON.stringify(b.replyTo ?? null) &&
    JSON.stringify(a.attachments ?? []) === JSON.stringify(b.attachments ?? [])
  );
}
