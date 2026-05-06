"use client";

import { Download, FileText, Mic, Pause, Play, Video } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatAttachment } from "./types";
import { formatBytes } from "./formatting";

function formatDurationMs(durationMs?: number | null): string {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return "0:00";
  const total = Math.round(durationMs / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Per the chat-media plan, image attachments now render as native inline
 * bubbles (rounded corners, fixed max width, server-probed aspect ratio).
 * This stops the legacy "open MMS media" external link experience and
 * matches the mobile ImageBubble for design parity.
 */
function ImageBubble({ attachment }: { attachment: ChatAttachment }) {
  const aspect = attachment.width && attachment.height ? attachment.width / attachment.height : 4 / 3;
  // Capped at 70% of the message-bubble width budget (the bubble itself
  // already maxes at ~520 px in the portal layout).
  const maxWidth = 360;
  const width = Math.min(maxWidth, 360);
  const height = Math.min(width / aspect, width * 1.4);
  if (!attachment.downloadUrl) {
    return (
      <div
        className="cc-attach cc-attach-image-bubble"
        style={{ width, height, background: "rgba(148, 163, 184, 0.18)" }}
      />
    );
  }
  return (
    <a
      href={attachment.downloadUrl}
      target="_blank"
      rel="noreferrer"
      className="cc-attach cc-attach-image-bubble"
      style={{ width, height, display: "block" }}
    >
      <img
        src={attachment.downloadUrl}
        alt={attachment.fileName}
        style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 18, display: "block" }}
        loading="lazy"
      />
    </a>
  );
}

/**
 * WhatsApp-style voice-note player. Uses the native <audio> element under
 * the hood so we get cross-browser playback for free, but layers a custom
 * play/pause button + duration label + progress bar on top so the bubble
 * matches the chat aesthetic instead of looking like a browser default.
 */
function VoiceNotePlayer({ attachment }: { attachment: ChatAttachment }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [knownDurationMs, setKnownDurationMs] = useState<number | null>(attachment.durationMs ?? null);
  const totalDurationMs = knownDurationMs ?? attachment.durationMs ?? 0;
  const progress = totalDurationMs > 0 ? Math.min(1, position / totalDurationMs) : 0;
  const remainingLabel = useMemo(
    () => formatDurationMs(totalDurationMs > 0 ? Math.max(0, totalDurationMs - position) : null),
    [position, totalDurationMs],
  );

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  if (!attachment.downloadUrl) {
    return (
      <div className="cc-attach cc-voicenote">
        <Mic size={16} />
        <span>Voice note unavailable</span>
      </div>
    );
  }

  return (
    <div className="cc-attach cc-voicenote">
      <button
        type="button"
        className="cc-voicenote-play"
        onClick={() => {
          const el = audioRef.current;
          if (!el) return;
          if (el.paused) {
            el.play().catch(() => undefined);
          } else {
            el.pause();
          }
        }}
        aria-label={playing ? "Pause voice note" : "Play voice note"}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <div className="cc-voicenote-track">
        <div
          className="cc-voicenote-fill"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
      <span className="cc-voicenote-duration">{remainingLabel}</span>
      <Mic size={14} className="cc-voicenote-mic" aria-hidden />
      <audio
        ref={audioRef}
        src={attachment.downloadUrl}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setPosition(0);
          if (audioRef.current) audioRef.current.currentTime = 0;
        }}
        onTimeUpdate={(event) => {
          const el = event.currentTarget;
          setPosition(Math.round((el.currentTime || 0) * 1000));
        }}
        onLoadedMetadata={(event) => {
          const el = event.currentTarget;
          if (el.duration && Number.isFinite(el.duration)) {
            setKnownDurationMs(Math.round(el.duration * 1000));
          }
        }}
        style={{ display: "none" }}
      />
    </div>
  );
}

export function AttachmentPreview({ attachment, compact = false }: { attachment: ChatAttachment; compact?: boolean }) {
  const href = attachment.downloadUrl || undefined;
  const mime = attachment.mimeType.toLowerCase();
  const kind = (attachment.mediaKind || "").toLowerCase();
  const name = (attachment.fileName || "").toLowerCase();
  const soundsLikeAudio = /\.(m4a|aac|mp3|wav|ogg|opus|amr|webm)$/i.test(name);
  const isAudio = kind === "audio" || mime.startsWith("audio/") || soundsLikeAudio;
  const isVideo = kind === "video" || mime.startsWith("video/");
  const isImage = !soundsLikeAudio && !mime.startsWith("audio/") && (kind === "image" || mime.startsWith("image/"));

  if (href && isAudio) return <VoiceNotePlayer attachment={attachment} />;
  if (href && isImage) return <ImageBubble attachment={attachment} />;
  if (href && isVideo) {
    return (
      <div className="cc-attach cc-attach-media">
        <video src={href} controls preload="metadata" />
      </div>
    );
  }

  return (
    <a href={href} target="_blank" rel="noreferrer" className={`cc-attach cc-attach-file${compact ? " compact" : ""}`}>
      {mime === "application/pdf" ? <FileText size={18} /> : isVideo ? <Video size={18} /> : isAudio ? <Play size={18} /> : <Download size={18} />}
      <span className="cc-attach-file-meta">
        <strong>{attachment.fileName}</strong>
        <small>{formatBytes(attachment.sizeBytes)}{attachment.scanStatus ? ` · ${attachment.scanStatus}` : ""}</small>
      </span>
    </a>
  );
}
