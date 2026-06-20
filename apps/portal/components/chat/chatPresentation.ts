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

type AttachmentLike = Pick<ChatAttachment, "mediaKind" | "mimeType" | "fileName">;

/** Connect voice notes are stored as `voice-note-*` files. */
export function isVoiceNoteFileName(name?: string | null): boolean {
  return /voice-note/i.test(String(name || ""));
}

function attachmentBaseName(name?: string | null): string {
  return String(name || "").toLowerCase().replace(/\.[a-z0-9]+$/i, "");
}

function isTrueAudioAttachment(a: AttachmentLike): boolean {
  const kind = (a.mediaKind || "").toLowerCase();
  const mime = (a.mimeType || "").toLowerCase();
  const name = (a.fileName || "").toLowerCase();
  return kind === "audio" || mime.startsWith("audio/") || /\.(m4a|aac|mp3|wav|ogg|opus|amr|webm)$/i.test(name);
}

/** A video/MP4 (or legacy MP3) attachment that could be the carrier MMS copy of a voice note. */
function isTransportMediaCandidate(a: AttachmentLike): boolean {
  const kind = (a.mediaKind || "").toLowerCase();
  const mime = (a.mimeType || "").toLowerCase();
  const name = (a.fileName || "").toLowerCase();
  return kind === "video" || mime.startsWith("video/") || /\.(mp4|3gp|3gpp|mpeg|mp3)$/i.test(name);
}

/**
 * Drop the carrier MP4/MP3 copy of a voice note when its audio original is
 * present (the worker names the copy after the original's basename), so a sent
 * voice note shows ONE voice-note bubble — never a video.
 */
export function dropVoiceTransportDuplicates<T extends AttachmentLike>(attachments: T[]): T[] {
  const originalAudioBaseNames = new Set(
    attachments
      .filter((a) => isTrueAudioAttachment(a) && !isTransportMediaCandidate(a))
      .map((a) => attachmentBaseName(a.fileName)),
  );
  if (originalAudioBaseNames.size === 0) return attachments;
  return attachments.filter(
    (a) => !(isTransportMediaCandidate(a) && originalAudioBaseNames.has(attachmentBaseName(a.fileName))),
  );
}
