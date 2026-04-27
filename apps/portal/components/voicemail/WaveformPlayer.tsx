"use client";

import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtDuration } from "./formatting";
import { streamSrcForVoicemail } from "./mediaBase";
import type { VoicemailRow } from "./types";

const SPEEDS = [1, 1.5, 2] as const;

function hashSeed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h << 5) - h + id.charCodeAt(i);
  return Math.abs(h);
}

function barHeightsPct(id: string, count: number): number[] {
  const seed = hashSeed(id);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const v = Math.sin(seed * 0.001 + i * 0.73) * 0.5 + 0.5;
    out.push(22 + v * 78);
  }
  return out;
}

type Props = {
  vm: VoicemailRow;
  autoPlay?: boolean;
  /** compact row strip vs full drawer */
  density?: "comfortable" | "compact";
  onPlayState?: (playing: boolean) => void;
};

export function WaveformPlayer({ vm, autoPlay = false, density = "comfortable", onPlayState }: Props) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentSec, setCurrentSec] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateIdx, setRateIdx] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const src = streamSrcForVoicemail(vm);
  const bars = barHeightsPct(vm.id, density === "compact" ? 36 : 56);
  const compact = density === "compact";

  const wireAudio = useCallback(
    (audio: HTMLAudioElement) => {
      audio.preload = "none";
      audio.src = src;
      audio.playbackRate = SPEEDS[rateIdx] ?? 1;
      audio.volume = muted ? 0 : volume;
      audio.addEventListener("loadstart", () => {
        setLoading(true);
        setError(null);
      });
      audio.addEventListener("canplay", () => setLoading(false));
      audio.addEventListener("playing", () => {
        setPlaying(true);
        setLoading(false);
        onPlayState?.(true);
      });
      audio.addEventListener("pause", () => {
        setPlaying(false);
        onPlayState?.(false);
      });
      audio.addEventListener("waiting", () => setLoading(true));
      audio.addEventListener("stalled", () => setLoading(true));
      audio.addEventListener("error", () => {
        const err = audio.error;
        const codeName = err
          ? ({ 1: "aborted", 2: "network", 3: "decode", 4: "src_not_supported" } as Record<number, string>)[err.code] ??
            `code_${err.code}`
          : "unknown";
        console.error("[voicemail] audio error", { src, code: err?.code, codeName });
        setError(codeName);
        setLoading(false);
        setPlaying(false);
        onPlayState?.(false);
      });
      audio.addEventListener("timeupdate", () => {
        setCurrentSec(Math.floor(audio.currentTime));
        setProgress(vm.durationSec > 0 ? (audio.currentTime / vm.durationSec) * 100 : 0);
      });
      audio.addEventListener("ended", () => {
        setPlaying(false);
        setProgress(100);
        onPlayState?.(false);
      });
    },
    [onPlayState, rateIdx, src, vm.durationSec, volume, muted],
  );

  function getOrCreateAudio(): HTMLAudioElement {
    type AudioEl = HTMLAudioElement & { dataset: DOMStringMap };
    const existing = audioRef.current as AudioEl | null;
    if (!existing || existing.dataset.vmSrcId !== vm.id) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
      }
      const audio = new Audio() as AudioEl;
      audio.dataset.vmSrcId = vm.id;
      wireAudio(audio);
      audioRef.current = audio;
      return audio;
    }
    existing.playbackRate = SPEEDS[rateIdx] ?? 1;
    existing.volume = muted ? 0 : volume;
    return existing;
  }

  useEffect(() => {
    const a = audioRef.current;
    if (a) {
      a.playbackRate = SPEEDS[rateIdx] ?? 1;
      a.volume = muted ? 0 : volume;
    }
  }, [rateIdx, volume, muted]);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
    };
  }, [vm.id]);

  useEffect(() => {
    if (!autoPlay) return;
    const audio = getOrCreateAudio();
    setLoading(true);
    const p = audio.play();
    if (p && typeof p.catch === "function") {
      p.catch((err: unknown) => {
        const e = err as { name?: string };
        console.error("[voicemail] play() rejected", e);
        setError(e?.name === "NotAllowedError" ? "blocked" : "play_failed");
        setLoading(false);
      });
    }
  }, [autoPlay, vm.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function togglePlay() {
    const audio = getOrCreateAudio();
    if (!playing) setLoading(true);
    if (playing) {
      audio.pause();
    } else {
      const p = audio.play();
      if (p && typeof p.catch === "function") {
        p.catch((err: unknown) => {
          const e = err as { name?: string };
          setError(e?.name === "NotAllowedError" ? "blocked" : "play_failed");
          setLoading(false);
        });
      }
    }
  }

  function seekPct(pct: number) {
    const audio = getOrCreateAudio();
    audio.currentTime = Math.max(0, Math.min(1, pct)) * vm.durationSec;
  }

  function cycleSpeed() {
    setRateIdx((i) => (i + 1) % SPEEDS.length);
  }

  const playedBars = Math.floor((progress / 100) * bars.length);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: compact ? 8 : 12,
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: compact ? 1.5 : 2,
          height: compact ? 36 : 52,
          padding: "4px 2px",
          borderRadius: 12,
          background: "linear-gradient(180deg, rgba(34,168,255,0.06), transparent)",
          cursor: "pointer",
        }}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = (e.clientX - rect.left) / rect.width;
          seekPct(pct);
          const audio = getOrCreateAudio();
          if (!playing) void audio.play().catch(() => undefined);
        }}
        title="Click to seek"
      >
        {bars.map((h, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              minWidth: 2,
              maxWidth: 5,
              height: `${h}%`,
              borderRadius: 2,
              background: i <= playedBars ? "var(--accent)" : "var(--border)",
              opacity: i <= playedBars ? 1 : 0.55,
              transition: "background 0.12s, opacity 0.12s",
            }}
          />
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            togglePlay();
          }}
          style={{
            width: compact ? 40 : 48,
            height: compact ? 40 : 48,
            borderRadius: "50%",
            background: error ? "var(--danger)" : playing ? "var(--accent-2)" : "var(--accent)",
            border: "none",
            color: "#fff",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            boxShadow: "0 4px 14px rgba(34,168,255,0.25)",
          }}
          title={error ? `Audio: ${error}` : loading ? "Loading…" : playing ? "Pause" : "Play"}
        >
          {loading ? (
            <span style={{ fontSize: 12 }}>…</span>
          ) : error ? (
            "!"
          ) : playing ? (
            <Pause size={compact ? 18 : 22} fill="currentColor" />
          ) : (
            <Play size={compact ? 18 : 22} style={{ marginLeft: 2 }} fill="currentColor" />
          )}
        </button>

        <div
          role="slider"
          aria-valuenow={Math.round(progress)}
          tabIndex={0}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") seekPct(progress / 100 + 0.05);
            if (e.key === "ArrowLeft") seekPct(progress / 100 - 0.05);
          }}
          style={{
            flex: 1,
            height: 8,
            background: "var(--border)",
            borderRadius: 99,
            cursor: "pointer",
            position: "relative",
            minWidth: 80,
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            const bar = e.currentTarget;
            const move = (ev: MouseEvent) => {
              const rect = bar.getBoundingClientRect();
              seekPct((ev.clientX - rect.left) / rect.width);
            };
            const up = () => {
              window.removeEventListener("mousemove", move);
              window.removeEventListener("mouseup", up);
            };
            move(e.nativeEvent);
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
          }}
        >
          <div
            style={{
              width: `${progress}%`,
              height: "100%",
              borderRadius: 99,
              background: "linear-gradient(90deg, var(--accent), var(--accent-2))",
            }}
          />
        </div>

        <span style={{ fontSize: 12, color: "var(--text-dim)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
          {fmtDuration(currentSec)} / {fmtDuration(vm.durationSec)}
        </span>

        <button
          type="button"
          className="btn ghost"
          style={{ fontSize: 12, padding: "4px 10px", borderRadius: 99 }}
          onClick={(e) => {
            e.stopPropagation();
            cycleSpeed();
          }}
          title="Playback speed"
        >
          {SPEEDS[rateIdx]}×
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="icon-btn"
            title={muted ? "Unmute" : "Mute"}
            onClick={() => setMuted((m) => !m)}
            style={{ width: 34, height: 34 }}
          >
            {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => {
              setMuted(false);
              setVolume(Number(e.target.value));
            }}
            style={{ width: compact ? 72 : 100, accentColor: "var(--accent)" }}
          />
        </div>
      </div>
    </div>
  );
}
