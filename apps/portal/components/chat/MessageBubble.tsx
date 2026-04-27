"use client";

import { Check, MoreHorizontal, Pencil, Reply, Smile, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AttachmentPreview } from "./AttachmentPreview";
import { fmtChatTime, mapUrl } from "./formatting";
import type { ChatMessage } from "./types";
import { QUICK_REACTIONS } from "./types";

export function MessageBubble({
  message,
  onReact,
  onRemoveReaction,
  onReply,
  onEdit,
  onDeleteMe,
  onDeleteEveryone,
}: {
  message: ChatMessage;
  onReact: (emoji: string) => void;
  onRemoveReaction: (emoji: string) => void;
  onReply: () => void;
  onEdit: () => void;
  onDeleteMe: () => void;
  onDeleteEveryone: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const deleted = Boolean(message.deletedForEveryoneAt);
  const reactions = (message.reactions || []).reduce<Record<string, number>>((acc, row) => {
    acc[row.emoji] = (acc[row.emoji] || 0) + 1;
    return acc;
  }, {});

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  return (
    <div className={`cc-msg-row ${message.mine ? "mine" : "theirs"}`}>
      <div className="cc-msg-wrap" ref={wrapRef}>
        {!message.mine ? <div className="cc-msg-sender">{message.senderName}</div> : null}
        <div
          className={`cc-bubble ${message.mine ? "mine" : "theirs"} ${deleted ? "deleted" : ""}`}
          onContextMenu={(e) => { e.preventDefault(); setMenuOpen(true); }}
        >
          {message.replyTo ? (
            <button type="button" className="cc-reply-preview" onClick={onReply}>
              <Reply size={12} />
              <span>{message.replyTo.senderName}: {message.replyTo.body || message.replyTo.type}</span>
            </button>
          ) : null}

          {deleted ? (
            <em>This message was deleted</em>
          ) : (
            <>
              {message.body ? <div className="cc-msg-body">{message.body}</div> : null}
              {message.location ? (
                <a href={mapUrl(message.location.lat, message.location.lng)} target="_blank" rel="noreferrer" className="cc-location-card">
                  <strong>{message.location.label || "Shared location"}</strong>
                  <small>{message.location.address || `${message.location.lat.toFixed(5)}, ${message.location.lng.toFixed(5)}`}</small>
                </a>
              ) : null}
              {message.mmsUrls?.map((url) => (
                <a key={url} href={url} target="_blank" rel="noreferrer" className="cc-mms-link">Open MMS media</a>
              ))}
              {message.attachments?.length ? (
                <div className="cc-attach-stack">
                  {message.attachments.map((attachment) => <AttachmentPreview key={attachment.id} attachment={attachment} />)}
                </div>
              ) : null}
            </>
          )}

          <button type="button" className="cc-msg-more" onClick={() => setMenuOpen((v) => !v)} aria-label="Message actions">
            <MoreHorizontal size={15} />
          </button>

          {menuOpen ? (
            <div className="cc-msg-menu">
              <div className="cc-reaction-row">
                {QUICK_REACTIONS.map((emoji) => (
                  <button key={emoji} type="button" onClick={() => { onReact(emoji); setMenuOpen(false); }}>{emoji}</button>
                ))}
              </div>
              <button type="button" onClick={() => { onReply(); setMenuOpen(false); }}><Reply size={14} /> Reply</button>
              {message.mine && !deleted && message.type === "TEXT" ? (
                <button type="button" onClick={() => { onEdit(); setMenuOpen(false); }}><Pencil size={14} /> Edit</button>
              ) : null}
              <button type="button" onClick={() => { onDeleteMe(); setMenuOpen(false); }}><Trash2 size={14} /> Delete for me</button>
              {message.mine && !deleted ? (
                <button type="button" onClick={() => { onDeleteEveryone(); setMenuOpen(false); }}><Trash2 size={14} /> Delete for everyone</button>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className={`cc-msg-meta ${message.mine ? "mine" : ""}`}>
          <span>{fmtChatTime(message.sentAt)}</span>
          {message.editedAt ? <span>edited</span> : null}
          {message.deliveryStatus ? <span>{message.deliveryStatus}</span> : null}
          {message.mine && message.deliveryStatus === "sent" ? <Check size={12} /> : null}
          {message.deliveryError ? <span className="cc-error">{message.deliveryError}</span> : null}
        </div>

        {Object.keys(reactions).length ? (
          <div className={`cc-reactions ${message.mine ? "mine" : ""}`}>
            {Object.entries(reactions).map(([emoji, count]) => (
              <button key={emoji} type="button" onClick={() => onRemoveReaction(emoji)}>
                {emoji} {count}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
