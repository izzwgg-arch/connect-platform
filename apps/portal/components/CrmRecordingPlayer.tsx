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
import {
  classifyRecordingPlaybackFailure,
  recordingStreamUrl,
  type RecordingPlaybackFailure,
} from "../services/recordingPlayback";

interface CrmRecordingPlayerProps {
  linkedId: string;
  /** Compact variant: smaller button text, used in dense timelines */
  compact?: boolean;
}

export function CrmRecordingPlayer({ linkedId, compact = false }: CrmRecordingPlayerProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const [failure, setFailure] = useState<RecordingPlaybackFailure | null>(null);
  // True from the moment the player opens until the first `playing` event, and
  // again on `waiting` (mid-play rebuffer). Without this the native controls
  // flip to "pause" while the network is still fetching — the "it says playing
  // but nothing is playing" report.
  const [buffering, setBuffering] = useState(false);

  const streamUrl = recordingStreamUrl(linkedId);

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
  // the call was not recorded (or this user may not hear it), replace it with
  // the plain fact.
  if (failure === "not_recorded" || failure === "forbidden") {
    return (
      <span
        title={failure === "forbidden"
          ? "You don’t have permission to listen to this recording."
          : "This call was not recorded, so there is no audio to play."}
        style={{
          display: "inline-flex", alignItems: "center", gap: "0.25rem",
          fontSize: compact ? "0.625rem" : "0.6875rem", fontWeight: 600,
          padding: compact ? "0.0625rem 0.25rem" : "0.125rem 0.375rem",
          borderRadius: 4, background: "#f3f4f6", color: "#6b7280", lineHeight: 1,
        }}
      >
        <MicOff size={compact ? 8 : 10} />
        {failure === "forbidden" ? "No access" : "Not recorded"}
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
          void classifyRecordingPlaybackFailure(streamUrl).then(setFailure);
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
