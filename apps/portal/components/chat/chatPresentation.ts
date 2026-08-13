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

/**
 * The API mints a FRESH HMAC-signed downloadUrl (new `exp`/`sig`) for every
 * attachment on every `/chat/threads/:id/messages` fetch, and both chat
 * surfaces poll every 7s. Handing that changing string to a media element
 * makes the browser treat it as a different file: `<audio>` aborts and
 * reloads, so a voice note dies a few seconds into playback, and `<img>`
 * re-downloads and visibly flashes.
 *
 * So we pin the first URL seen per attachment id and keep reusing it until it
 * is close to expiry, keeping the `src` string byte-identical across refetches.
 * The mobile app carries the same fix (`stabilizeAttachmentUrl` in
 * `apps/mobile/src/screens/tabs/ChatTab.tsx`) — keep the two in step.
 *
 * ⛔ Apply this at EVERY message-fetch site. A surface that skips it looks
 * fine until someone plays a voice note longer than one poll interval.
 */
const stableAttachmentUrlCache = new Map<string, string>();

/** Re-pin this many seconds before expiry, so a pinned URL never goes stale mid-use. */
const STABLE_URL_RENEW_WITHIN_SECONDS = 120;

/** Bound the cache — a desktop chat window can stay open for days. */
const STABLE_URL_CACHE_MAX = 500;

/** Our signed links carry `exp=` (storage-key route) or `e=` (attachment-id route). */
function signedUrlExpSeconds(url: string): number {
  const m = url.match(/[?&](?:exp|e)=(\d+)/);
  return m ? Number(m[1]) : 0;
}

function isOurSignedUrl(url: string): boolean {
  return /[?&](?:exp|e)=\d+/.test(url);
}

export function stabilizeAttachmentUrl(
  attachmentId: string,
  url: string | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (!url) return url ?? null;
  // Only pin our own signed URLs; external (MMS carrier) URLs are already stable.
  if (!isOurSignedUrl(url)) return url;
  const cached = stableAttachmentUrlCache.get(attachmentId);
  if (cached) {
    const nowSec = Math.floor(nowMs / 1000);
    if (signedUrlExpSeconds(cached) - nowSec > STABLE_URL_RENEW_WITHIN_SECONDS) return cached;
  }
  if (stableAttachmentUrlCache.size >= STABLE_URL_CACHE_MAX && !stableAttachmentUrlCache.has(attachmentId)) {
    const oldest = stableAttachmentUrlCache.keys().next();
    if (!oldest.done) stableAttachmentUrlCache.delete(oldest.value);
  }
  stableAttachmentUrlCache.set(attachmentId, url);
  return url;
}

/**
 * Returns the same array/objects when nothing changed, so React sees stable
 * identities and does not re-render (or re-mount media) needlessly.
 */
export function stabilizeMessageAttachmentUrls(
  messages: ChatMessage[],
  nowMs: number = Date.now(),
): ChatMessage[] {
  let anyChanged = false;
  const out = messages.map((m) => {
    if (!m.attachments || m.attachments.length === 0) return m;
    let changed = false;
    const attachments = m.attachments.map((a) => {
      const stable = stabilizeAttachmentUrl(a.id, a.downloadUrl, nowMs);
      if (stable === a.downloadUrl) return a;
      changed = true;
      return { ...a, downloadUrl: stable };
    });
    if (!changed) return m;
    anyChanged = true;
    return { ...m, attachments };
  });
  return anyChanged ? out : messages;
}

/** Test seam — the pin cache is module state shared by both chat surfaces. */
export function __resetStableAttachmentUrlCacheForTests(): void {
  stableAttachmentUrlCache.clear();
}
