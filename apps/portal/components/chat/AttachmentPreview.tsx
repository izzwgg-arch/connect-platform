"use client";

import { Download, FileText, Music, Play, Video } from "lucide-react";
import type { ChatAttachment } from "./types";
import { formatBytes } from "./formatting";

export function AttachmentPreview({ attachment, compact = false }: { attachment: ChatAttachment; compact?: boolean }) {
  const href = attachment.downloadUrl || undefined;
  const mime = attachment.mimeType.toLowerCase();

  if (href && mime.startsWith("image/")) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="cc-attach cc-attach-image">
        <img src={href} alt={attachment.fileName} />
      </a>
    );
  }

  if (href && mime.startsWith("video/")) {
    return (
      <div className="cc-attach cc-attach-media">
        <video src={href} controls preload="metadata" />
      </div>
    );
  }

  if (href && mime.startsWith("audio/")) {
    return (
      <div className="cc-attach cc-attach-audio">
        <Music size={15} />
        <audio src={href} controls preload="metadata" />
      </div>
    );
  }

  return (
    <a href={href} target="_blank" rel="noreferrer" className={`cc-attach cc-attach-file${compact ? " compact" : ""}`}>
      {mime === "application/pdf" ? <FileText size={18} /> : mime.startsWith("video/") ? <Video size={18} /> : mime.startsWith("audio/") ? <Play size={18} /> : <Download size={18} />}
      <span className="cc-attach-file-meta">
        <strong>{attachment.fileName}</strong>
        <small>{formatBytes(attachment.sizeBytes)}{attachment.scanStatus ? ` · ${attachment.scanStatus}` : ""}</small>
      </span>
    </a>
  );
}
