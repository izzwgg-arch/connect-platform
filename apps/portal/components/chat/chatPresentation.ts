"use client";

import type { ChatAttachment, ChatMessage } from "./types";

const URL_PATTERN = /(https?:\/\/[^\s<>"']+)/gi;

export type MessageBodyPart =
  | { type: "text"; value: string }
  | { type: "url"; value: string };

export function messageRowClass(message: Pick<ChatMessage, "mine">): string {
  return `cc-msg-row ${message.mine ? "mine" : "theirs"}`;
}

export function messageBubbleClass(message: Pick<ChatMessage, "mine" | "deletedForEveryoneAt">): string {
  return `cc-bubble ${message.mine ? "mine" : "theirs"} ${message.deletedForEveryoneAt ? "deleted" : ""}`.trim();
}

export function splitMessageBody(body: string): MessageBodyPart[] {
  if (!body) return [];
  const parts: MessageBodyPart[] = [];
  let lastIndex = 0;
  for (const match of body.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    const url = match[0];
    if (index > lastIndex) parts.push({ type: "text", value: body.slice(lastIndex, index) });
    parts.push({ type: "url", value: trimTrailingUrlPunctuation(url) });
    const trailing = url.slice(trimTrailingUrlPunctuation(url).length);
    if (trailing) parts.push({ type: "text", value: trailing });
    lastIndex = index + url.length;
  }
  if (lastIndex < body.length) parts.push({ type: "text", value: body.slice(lastIndex) });
  return parts;
}

export function attachmentToneClass(attachment: Pick<ChatAttachment, "mediaKind" | "mimeType" | "fileName">): string {
  const mime = attachment.mimeType.toLowerCase();
  const kind = (attachment.mediaKind || "").toLowerCase();
  const name = (attachment.fileName || "").toLowerCase();
  if (kind === "audio" || mime.startsWith("audio/") || /\.(m4a|aac|mp3|wav|ogg|opus|amr|webm)$/i.test(name)) {
    return "cc-attach-tone-audio";
  }
  if (kind === "image" || mime.startsWith("image/")) return "cc-attach-tone-image";
  if (kind === "video" || mime.startsWith("video/")) return "cc-attach-tone-video";
  return "cc-attach-tone-file";
}

function trimTrailingUrlPunctuation(url: string): string {
  return url.replace(/[),.;!?]+$/g, "");
}
