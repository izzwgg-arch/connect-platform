"use client";

import { useRef, useState } from "react";
import { PageHeader } from "../../../components/PageHeader";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { useSipPhone } from "../../../hooks/useSipPhone";
import { apiDelete, apiGet } from "../../../services/apiClient";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Voicemail {
  id: string;
  callerId: string;
  callerName?: string;
  receivedAt: string;
  durationSec: number;
  folder: "inbox" | "old" | "urgent";
  listened: boolean;
  transcription?: string;
  streamUrl?: string;
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return `Today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  if (diffDays === 1) return `Yesterday ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ── Audio Player ──────────────────────────────────────────────────────────────

function AudioPlayer({ vm }: { vm: Voicemail }) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentSec, setCurrentSec] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const apiBase = process.env.NEXT_PUBLIC_API_URL || "";
  const token = typeof window !== "undefined"
    ? (localStorage.getItem("token") || localStorage.getItem("cc-token") || "") : "";

  const src = vm.streamUrl ??
    `${apiBase}/voice/voicemail/${vm.id}/stream?token=${encodeURIComponent(token)}`;

  function getOrCreateAudio() {
    if (!audioRef.current) {
      const audio = new Audio(src);
      audio.addEventListener("timeupdate", () => {
        setCurrentSec(Math.floor(audio.currentTime));
        setProgress(vm.durationSec > 0 ? (audio.currentTime / vm.durationSec) * 100 : 0);
      });
      audio.addEventListener("ended", () => {
        setPlaying(false);
        setProgress(100);
      });
      audioRef.current = audio;
    }
    return audioRef.current;
  }

  function togglePlay() {
    const audio = getOrCreateAudio();
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio.play().catch(() => setPlaying(false));
      setPlaying(true);
    }
  }

  function seek(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const audio = getOrCreateAudio();
    audio.currentTime = pct * vm.durationSec;
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
      <button
        onClick={togglePlay}
        style={{
          width: 34, height: 34,
          borderRadius: "50%",
          background: playing ? "var(--danger)" : "var(--accent)",
          border: "none",
          color: "#fff",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          fontSize: 14,
        }}
        title={playing ? "Pause" : "Play"}
      >
        {playing ? "■" : "▶"}
      </button>

      {/* Progress bar */}
      <div
        onClick={seek}
        style={{
          flex: 1,
          height: 4,
          background: "var(--border)",
          borderRadius: 2,
          cursor: "pointer",
          position: "relative",
          overflow: "visible",
        }}
      >
        <div style={{
          width: `${progress}%`,
          height: "100%",
          background: "var(--accent)",
          borderRadius: 2,
          transition: "width 0.1s linear",
        }} />
        {playing ? (
          <div style={{
            position: "absolute",
            top: "50%",
            left: `${progress}%`,
            transform: "translate(-50%, -50%)",
            width: 10, height: 10,
            borderRadius: "50%",
            background: "var(--accent)",
          }} />
        ) : null}
      </div>

      <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap", minWidth: 50, textAlign: "right" }}>
        {fmtDuration(currentSec)} / {fmtDuration(vm.durationSec)}
      </span>
    </div>
  );
}

// ── Voicemail Row ─────────────────────────────────────────────────────────────

function VoicemailRow({
  vm,
  onDelete,
  onCall,
  selected,
  onSelect,
  deleting,
}: {
  vm: Voicemail;
  onDelete: (id: string) => void;
  onCall: (num: string) => void;
  selected: boolean;
  onSelect: (vm: Voicemail) => void;
  deleting: boolean;
}) {
  const apiBase = process.env.NEXT_PUBLIC_API_URL || "";
  const token = typeof window !== "undefined"
    ? (localStorage.getItem("token") || localStorage.getItem("cc-token") || "") : "";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 16px",
        borderBottom: "1px solid var(--border)",
        background: selected ? "rgba(34,168,255,0.06)" : !vm.listened ? "rgba(34,168,255,0.04)" : "transparent",
        cursor: "pointer",
        transition: "background 0.12s",
      }}
      onClick={() => onSelect(vm)}
    >
      {/* Unread dot */}
      <div style={{
        width: 8, height: 8,
        borderRadius: "50%",
        background: !vm.listened ? "var(--accent)" : "transparent",
        flexShrink: 0,
      }} />

      {/* Caller avatar */}
      <div style={{
        width: 40, height: 40,
        borderRadius: "50%",
        background: "var(--panel-2)",
        border: "1px solid var(--border)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 14, fontWeight: 700, color: "var(--text-dim)",
        flexShrink: 0,
      }}>
        {vm.callerName ? vm.callerName.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase() : "VM"}
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: !vm.listened ? 700 : 500, fontSize: 14 }}>
          {vm.callerName ?? vm.callerId}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
          {vm.callerName ? vm.callerId + " · " : ""}{fmtDate(vm.receivedAt)}
        </div>
      </div>

      {/* Inline player */}
      <div style={{ width: 220, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
        <AudioPlayer vm={vm} />
      </div>

      {/* Duration */}
      <span style={{ fontSize: 12, color: "var(--text-dim)", width: 40, textAlign: "right", flexShrink: 0 }}>
        {fmtDuration(vm.durationSec)}
      </span>

      {/* Actions */}
      <div style={{ display: "flex", gap: 6, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
        {/* Download */}
        <a
          href={`${apiBase}/voice/voicemail/${vm.id}/download?token=${encodeURIComponent(token)}`}
          download
          className="icon-btn"
          title="Download"
          style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}
        >
          ↓
        </a>
        {/* Call back */}
        <button
          className="icon-btn"
          title="Call back"
          onClick={() => onCall(vm.callerId)}
          style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}
        >
          📞
        </button>
        {/* Delete */}
        <button
          className="icon-btn"
          title="Delete"
          onClick={() => onDelete(vm.id)}
          disabled={deleting}
          style={{
            width: 30, height: 30,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 14, color: "var(--danger)",
          }}
        >
          🗑
        </button>
      </div>
    </div>
  );
}

// ── Transcription Panel ───────────────────────────────────────────────────────

function TranscriptionPanel({ vm, onClose }: { vm: Voicemail; onClose: () => void }) {
  return (
    <div style={{
      padding: "20px",
      display: "flex",
      flexDirection: "column",
      gap: 16,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ fontSize: 15, fontWeight: 650 }}>Transcription</h3>
        <button className="icon-btn" onClick={onClose} style={{ fontSize: 18 }}>✕</button>
      </div>
      <div style={{ fontSize: 13, color: "var(--text-dim)", display: "flex", flexDirection: "column", gap: 4 }}>
        <div><strong>From:</strong> {vm.callerName ?? vm.callerId}</div>
        <div><strong>Received:</strong> {fmtDate(vm.receivedAt)}</div>
        <div><strong>Duration:</strong> {fmtDuration(vm.durationSec)}</div>
      </div>
      <div style={{
        background: "var(--panel-2)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "14px 16px",
        fontSize: 14,
        lineHeight: 1.7,
        minHeight: 80,
      }}>
        {vm.transcription ?? (
          <span style={{ color: "var(--text-dim)", fontStyle: "italic" }}>
            No transcription available for this voicemail.
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: 10, flexDirection: "column" }}>
        <AudioPlayer vm={vm} />
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type FolderKey = "inbox" | "old" | "urgent";

export default function VoicemailPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const [folder, setFolder] = useState<FolderKey>("inbox");
  const [selected, setSelected] = useState<Voicemail | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const phone = useSipPhone();

  const state = useAsyncResource<{ voicemails: Voicemail[] }>(
    () => apiGet(`/voice/voicemail?folder=${folder}`),
    [reloadKey, folder]
  );

  const voicemails = state.status === "success" ? (state.data.voicemails ?? []) : [];
  const unreadCount = voicemails.filter((v) => !v.listened).length;

  async function handleDelete(id: string) {
    setDeleteId(id);
    try {
      await apiDelete(`/voice/voicemail/${id}`);
      if (selected?.id === id) setSelected(null);
      setReloadKey((k) => k + 1);
    } finally {
      setDeleteId(null);
    }
  }

  function handleCall(number: string) {
    phone.setDialpadInput(number);
    phone.dial(number);
  }

  return (
    <div style={{ display: "flex", height: "calc(100vh - 54px)", overflow: "hidden", flexDirection: "column" }}>
      {/* Header */}
      <div style={{
        padding: "10px 16px 0",
        borderBottom: "1px solid var(--border)",
        background: "var(--panel)",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <h2 style={{ fontSize: 18, fontWeight: 650 }}>
            Voicemail
            {unreadCount > 0 ? (
              <span style={{
                marginLeft: 8, fontSize: 13, fontWeight: 600,
                background: "var(--accent)", color: "#fff",
                borderRadius: 20, padding: "1px 8px",
              }}>
                {unreadCount} new
              </span>
            ) : null}
          </h2>
          <button
            className="btn ghost"
            style={{ fontSize: 13 }}
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Refresh
          </button>
        </div>

        {/* Folder tabs */}
        <div style={{ display: "flex", gap: 0 }}>
          {(["inbox", "urgent", "old"] as FolderKey[]).map((f) => (
            <button
              key={f}
              onClick={() => setFolder(f)}
              style={{
                padding: "7px 18px",
                border: "none",
                borderBottom: folder === f ? "2px solid var(--accent)" : "2px solid transparent",
                background: "transparent",
                color: folder === f ? "var(--accent)" : "var(--text-dim)",
                fontWeight: folder === f ? 650 : 400,
                fontSize: 13,
                cursor: "pointer",
                textTransform: "capitalize",
              }}
            >
              {f}
              {f === "inbox" && voicemails.filter((v) => !v.listened && v.folder === "inbox").length > 0 ? (
                <span style={{
                  marginLeft: 5, fontSize: 11,
                  background: "var(--accent)", color: "#fff",
                  borderRadius: 20, padding: "0px 5px",
                }}>
                  {voicemails.filter((v) => !v.listened && v.folder === "inbox").length}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* List */}
        <div style={{
          flex: selected ? "0 0 60%" : "1",
          overflowY: "auto",
          borderRight: selected ? "1px solid var(--border)" : undefined,
        }}>
          {/* Search */}
          <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
            <input
              className="input"
              style={{ fontSize: 13 }}
              placeholder="Search voicemails…"
            />
          </div>

          {state.status === "loading" ? <LoadingSkeleton rows={5} /> : null}
          {state.status === "error" ? <ErrorState message={state.error} /> : null}
          {state.status === "success" && voicemails.length === 0 ? (
            <EmptyState
              title={`No voicemails in ${folder}`}
              message="Voicemails from callers will appear here."
            />
          ) : null}
          {state.status === "success" && voicemails.length > 0 ? (
            voicemails.map((vm) => (
              <VoicemailRow
                key={vm.id}
                vm={vm}
                onDelete={handleDelete}
                onCall={handleCall}
                selected={selected?.id === vm.id}
                onSelect={setSelected}
                deleting={deleteId === vm.id}
              />
            ))
          ) : null}
        </div>

        {/* Detail / transcription panel */}
        {selected ? (
          <div style={{ flex: 1, overflowY: "auto", background: "var(--panel)" }}>
            <TranscriptionPanel vm={selected} onClose={() => setSelected(null)} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
