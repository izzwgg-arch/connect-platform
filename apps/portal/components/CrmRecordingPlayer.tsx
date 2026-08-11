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
import { Play, Square, AlertCircle, MicOff } from "lucide-react";

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

/**
 * An <audio> element's onError says only "it broke" — never why. That produced
 * a dead player next to a 10px "Unavailable" for calls that simply have no
 * recording, which reads as a broken product. So on failure we ask the server
 * for one byte and use its answer to say the true thing.
 */
type PlayFailure = "not_recorded" | "temporary";

async function classifyStreamFailure(streamUrl: string): Promise<PlayFailure> {
  try {
    const resp = await fetch(streamUrl, { headers: { Range: "bytes=0-0" } });
    if (resp.ok || resp.status === 206) return "temporary"; // audio fetched fine — the element choked, not the server
    if (resp.status === 404) {
      const body = await resp.json().catch(() => null as any);
      return body?.error === "audio_fetch_failed" ? "temporary" : "not_recorded";
    }
    return "temporary";
  } catch {
    return "temporary";
  }
}

export function CrmRecordingPlayer({ linkedId, compact = false }: CrmRecordingPlayerProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const [failure, setFailure] = useState<PlayFailure | null>(null);
  // True from the moment the player opens until the first `playing` event, and
  // again on `waiting` (mid-play rebuffer). Without this the native controls
  // flip to "pause" while the network is still fetching — the "it says playing
  // but nothing is playing" report.
  const [buffering, setBuffering] = useState(false);

  const streamUrl = (() => {
    const token = getStorageToken();
    const base = `/api/voice/recording/${encodeURIComponent(linkedId)}/stream`;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  })();

  if (!open) {
    return (
      <button
        onClick={() => { setError(false); setFailure(null); setBuffering(true); setOpen(true); }}
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

  // A player that can never produce sound is worse than no player — once we know
  // the call was not recorded, replace it with the plain fact.
  if (failure === "not_recorded") {
    return (
      <span
        title="This call was not recorded, so there is no audio to play."
        style={{
          display: "inline-flex", alignItems: "center", gap: "0.25rem",
          fontSize: compact ? "0.625rem" : "0.6875rem", fontWeight: 600,
          padding: compact ? "0.0625rem 0.25rem" : "0.125rem 0.375rem",
          borderRadius: 4, background: "#f3f4f6", color: "#6b7280", lineHeight: 1,
        }}
      >
        <MicOff size={compact ? 8 : 10} />
        Not recorded
      </span>
    );
  }

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: "0.375rem", flexWrap: "wrap" }}>
      <audio
        controls
        // The user already pressed "Play recording" to get here — starting
        // immediately is what they asked for, and the click counts as the
        // user gesture browsers require for autoplay-with-sound.
        autoPlay
        preload="auto"
        src={streamUrl}
        onPlaying={() => setBuffering(false)}
        onCanPlay={() => setBuffering(false)}
        onWaiting={() => setBuffering(true)}
        onError={() => {
          setError(true);
          setBuffering(false);
          void classifyStreamFailure(streamUrl).then(setFailure);
        }}
        style={{
          height: compact ? "28px" : "32px",
          maxWidth: compact ? "180px" : "240px",
          verticalAlign: "middle",
        }}
      />
      {buffering && !error && (
        <span
          style={{
            display: "inline-flex", alignItems: "center", gap: "0.25rem",
            fontSize: "0.625rem", fontWeight: 600, color: "#6b7280",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 10, height: 10, borderRadius: "50%",
              border: "2px solid #d1d5db", borderTopColor: "#5b21b6",
              animation: "ccRecSpin 0.8s linear infinite",
            }}
          />
          Loading…
          <style>{"@keyframes ccRecSpin { to { transform: rotate(360deg); } }"}</style>
        </span>
      )}
      {error && (
        <span
          title="The recording could not be fetched just now. This is usually temporary."
          style={{
            display: "inline-flex", alignItems: "center", gap: "0.2rem",
            fontSize: "0.625rem", color: "#ef4444",
          }}
        >
          <AlertCircle size={10} />
          Couldn’t load — try again
        </span>
      )}
      <button
        onClick={() => { setOpen(false); setError(false); setFailure(null); setBuffering(false); }}
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
