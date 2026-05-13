"use client";

/**
 * CrmRecordingPlayer
 *
 * Inline audio player for CRM timeline recording events.
 *
 * Usage:
 *   <CrmRecordingPlayer linkedId={event.linkedId} />
 *   <CrmRecordingPlayer linkedId={event.linkedId} compact />
 *
 * Streams audio via the existing /api/voice/recording/:linkedId/stream endpoint
 * (which enforces tenant isolation and accepts a ?token= query param for browser
 * <audio> elements). Never exposes recordingPath.
 *
 * The component is lazy — it only constructs the audio element after the user
 * clicks "Play", so no network requests are made for collapsed rows.
 */

import { useState } from "react";
import { Play, Square, AlertCircle } from "lucide-react";

interface CrmRecordingPlayerProps {
  linkedId: string;
  /** Compact variant: smaller button text, used in dense timelines */
  compact?: boolean;
}

function getStorageToken(): string {
  if (typeof window === "undefined") return "";
  return (
    window.localStorage.getItem("token") ||
    window.localStorage.getItem("cc-token") ||
    ""
  );
}

export function CrmRecordingPlayer({ linkedId, compact = false }: CrmRecordingPlayerProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);

  const streamUrl = (() => {
    const token = getStorageToken();
    const base = `/api/voice/recording/${encodeURIComponent(linkedId)}/stream`;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  })();

  if (!open) {
    return (
      <button
        onClick={() => { setError(false); setOpen(true); }}
        title="Play recording"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: compact ? "0.15rem" : "0.25rem",
          fontSize: compact ? "0.625rem" : "0.6875rem",
          fontWeight: 600,
          padding: compact ? "0.0625rem 0.25rem" : "0.125rem 0.375rem",
          borderRadius: 4,
          background: "#ede9fe",
          color: "#5b21b6",
          border: "none",
          cursor: "pointer",
          lineHeight: 1,
        }}
      >
        <Play size={compact ? 8 : 10} />
        {compact ? "Rec" : "Play recording"}
      </button>
    );
  }

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: "0.375rem", flexWrap: "wrap" }}>
      <audio
        controls
        autoPlay={false}
        src={streamUrl}
        onError={() => setError(true)}
        style={{
          height: compact ? "28px" : "32px",
          maxWidth: compact ? "180px" : "240px",
          verticalAlign: "middle",
        }}
      />
      {error && (
        <span
          title="Recording unavailable"
          style={{
            display: "inline-flex", alignItems: "center", gap: "0.2rem",
            fontSize: "0.625rem", color: "#ef4444",
          }}
        >
          <AlertCircle size={10} />
          Unavailable
        </span>
      )}
      <button
        onClick={() => { setOpen(false); setError(false); }}
        title="Collapse player"
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: "0.125rem",
          color: "var(--text-dim, #6b7280)",
          lineHeight: 1,
          display: "inline-flex",
          alignItems: "center",
        }}
      >
        <Square size={compact ? 8 : 10} />
      </button>
    </div>
  );
}
