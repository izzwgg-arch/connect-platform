"use client";

import { useRef, useState } from "react";
import { PageHeader } from "../../../../components/PageHeader";
import { DetailCard } from "../../../../components/DetailCard";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { StatusChip } from "../../../../components/StatusChip";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiDelete, apiGet, apiPost } from "../../../../services/apiClient";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Announcement {
  id: string;
  name: string;
  filename: string;
  durationSec?: number;
  sizeBytes?: number;
  mimeType?: string;
  usedIn?: string[]; // IVR names, queue names, etc.
  createdAt?: string;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDur(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ── Audio Row ─────────────────────────────────────────────────────────────────

function AnnouncementRow({
  rec,
  onDelete,
  deleting,
}: {
  rec: Announcement;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const apiBase = process.env.NEXT_PUBLIC_API_URL || "";
  const token = typeof window !== "undefined" ? (localStorage.getItem("token") || localStorage.getItem("cc-token") || "") : "";

  function togglePlay() {
    if (!audioRef.current) {
      const audio = new Audio(`${apiBase}/voice/pbx/recordings/${rec.id}/stream?token=${encodeURIComponent(token)}`);
      audioRef.current = audio;
      audio.onended = () => setPlaying(false);
      audio.onerror = () => setPlaying(false);
    }
    if (playing) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setPlaying(false);
    } else {
      audioRef.current.play().catch(() => setPlaying(false));
      setPlaying(true);
    }
  }

  return (
    <div
      className="panel"
      style={{
        padding: "12px 16px",
        display: "flex",
        alignItems: "center",
        gap: 14,
      }}
    >
      {/* Play button */}
      <button
        className="icon-btn"
        onClick={togglePlay}
        title={playing ? "Pause" : "Play preview"}
        style={{
          width: 38,
          height: 38,
          borderRadius: "50%",
          background: playing ? "var(--danger)" : "var(--accent)",
          color: "#fff",
          flexShrink: 0,
          fontSize: 16,
          border: "none",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {playing ? "■" : "▶"}
      </button>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 650, fontSize: 14, marginBottom: 2 }}>{rec.name}</div>
        <div style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", gap: 10, flexWrap: "wrap" }}>
          <span>{rec.filename}</span>
          {rec.durationSec ? <span>{fmtDur(rec.durationSec)}</span> : null}
          {rec.sizeBytes ? <span>{fmtBytes(rec.sizeBytes)}</span> : null}
          {rec.createdAt ? (
            <span>Uploaded {new Date(rec.createdAt).toLocaleDateString()}</span>
          ) : null}
        </div>
        {rec.usedIn && rec.usedIn.length > 0 ? (
          <div style={{ marginTop: 4, display: "flex", gap: 5, flexWrap: "wrap" }}>
            {rec.usedIn.map((u) => (
              <span key={u} className="chip" style={{ fontSize: 11 }}>{u}</span>
            ))}
          </div>
        ) : null}
      </div>

      {/* MIME badge */}
      {rec.mimeType ? (
        <StatusChip
          label={rec.mimeType.includes("wav") ? "WAV" : rec.mimeType.includes("mp3") || rec.mimeType.includes("mpeg") ? "MP3" : "Audio"}
          color="default"
        />
      ) : null}

      {/* Delete */}
      <button
        className="btn ghost"
        style={{ fontSize: 13 }}
        onClick={() => onDelete(rec.id)}
        disabled={deleting}
      >
        Delete
      </button>
    </div>
  );
}

// ── Upload Panel ──────────────────────────────────────────────────────────────

function UploadPanel({ onUploaded }: { onUploaded: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const apiBase = process.env.NEXT_PUBLIC_API_URL || "";
  const token = typeof window !== "undefined" ? (localStorage.getItem("token") || localStorage.getItem("cc-token") || "") : "";

  function handleFile(f: File | null) {
    if (!f) return;
    setFile(f);
    if (!name) setName(f.name.replace(/\.[^.]+$/, ""));
  }

  async function handleUpload() {
    if (!file) { setError("Choose a file first."); return; }
    if (!name.trim()) { setError("Enter a name for the recording."); return; }
    setUploading(true);
    setError("");
    setSuccess("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("name", name.trim());
      const res = await fetch(`${apiBase}/voice/pbx/recordings`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as any;
        throw new Error(err?.message || `Upload failed (${res.status})`);
      }
      setSuccess(`"${name}" uploaded successfully.`);
      setFile(null);
      setName("");
      if (inputRef.current) inputRef.current.value = "";
      onUploaded();
    } catch (err: any) {
      setError(err?.message || "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="panel stack" style={{ gap: 14 }}>
      <h3 style={{ fontSize: 15, fontWeight: 650 }}>Upload Recording</h3>
      <p style={{ fontSize: 13, color: "var(--text-dim)" }}>
        Supported formats: <strong>MP3</strong>, <strong>WAV</strong>, <strong>OGG</strong>. Maximum file size: 20 MB.
        Recordings can be used as IVR greetings, queue music on hold, and time condition announcements.
      </p>

      {/* Drop zone */}
      <div
        style={{
          border: "2px dashed var(--border)",
          borderRadius: 10,
          padding: "20px 24px",
          textAlign: "center",
          cursor: "pointer",
          background: file ? "rgba(34,168,255,0.06)" : undefined,
          transition: "background 0.2s",
        }}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => {
          e.preventDefault();
          const dropped = e.dataTransfer.files[0];
          if (dropped) handleFile(dropped);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="audio/mp3,audio/mpeg,audio/wav,audio/ogg,audio/*"
          style={{ display: "none" }}
          onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
        />
        {file ? (
          <div>
            <div style={{ fontSize: 24, marginBottom: 6 }}>🎵</div>
            <div style={{ fontWeight: 600 }}>{file.name}</div>
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{fmtBytes(file.size)}</div>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 24, marginBottom: 6 }}>⬆</div>
            <div style={{ fontWeight: 600 }}>Click or drag an audio file here</div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>MP3, WAV, OGG up to 20 MB</div>
          </div>
        )}
      </div>

      {file ? (
        <div>
          <label className="label">Recording Name *</label>
          <input
            className="input"
            placeholder="e.g. Holiday Greeting 2026"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      ) : null}

      {error ? <div className="chip danger">{error}</div> : null}
      {success ? <div className="chip success">{success}</div> : null}

      {file ? (
        <div className="row-actions">
          <button className="btn" onClick={handleUpload} disabled={uploading || !name.trim()}>
            {uploading ? "Uploading…" : "Upload Recording"}
          </button>
          <button className="btn ghost" onClick={() => { setFile(null); setName(""); setError(""); }}>
            Clear
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AnnouncementsPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [opMsg, setOpMsg] = useState("");

  const state = useAsyncResource<{ rows: Record<string, unknown>[] }>(
    () => apiGet("/voice/pbx/resources/voicemail"),
    [reloadKey]
  );

  const recordings: Announcement[] = (() => {
    if (state.status !== "success") return [];
    return state.data.rows.map((r, i) => ({
      id: String(r.id ?? r.uuid ?? r.recording_id ?? i),
      name: String(r.name ?? r.display_name ?? r.filename ?? `Recording ${i + 1}`),
      filename: String(r.filename ?? r.path ?? ""),
      durationSec: Number(r.duration ?? r.durationSec ?? 0) || undefined,
      sizeBytes: Number(r.size ?? r.sizeBytes ?? 0) || undefined,
      mimeType: String(r.type ?? r.mimeType ?? r.mime_type ?? ""),
      usedIn: Array.isArray(r.usedIn) ? (r.usedIn as string[]) : undefined,
      createdAt: String(r.createdAt ?? r.created_at ?? ""),
    }));
  })();

  async function handleDelete(id: string) {
    setDeleteId(id);
    try {
      await apiDelete(`/voice/pbx/resources/voicemail/${id}`);
      setOpMsg("Recording deleted.");
      setReloadKey((k) => k + 1);
    } catch (err: any) {
      setOpMsg(`Delete failed: ${err?.message}`);
    } finally {
      setDeleteId(null);
    }
  }

  return (
    <div className="stack compact-stack">
      <PageHeader
        title="Announcements"
        subtitle="Upload and manage audio recordings used as IVR greetings, queue hold music, and time condition messages."
      />

      {opMsg ? <div className="chip success" style={{ alignSelf: "flex-start" }}>{opMsg}</div> : null}

      <UploadPanel onUploaded={() => { setReloadKey((k) => k + 1); setOpMsg("Recording uploaded."); }} />

      <div>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>All Recordings</h3>

        {state.status === "loading" ? <LoadingSkeleton rows={4} /> : null}
        {state.status === "error" ? <ErrorState message={state.error} /> : null}
        {state.status === "success" && recordings.length === 0 ? (
          <EmptyState title="No recordings yet" message="Upload an MP3 or WAV file above to get started." />
        ) : null}
        {state.status === "success" && recordings.length > 0 ? (
          <div className="stack compact-stack">
            {recordings.map((rec) => (
              <AnnouncementRow
                key={rec.id}
                rec={rec}
                onDelete={handleDelete}
                deleting={deleteId === rec.id}
              />
            ))}
          </div>
        ) : null}
      </div>

      <DetailCard title="Where Recordings Are Used">
        <div style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.7 }}>
          <p>Recordings uploaded here can be assigned to:</p>
          <ul style={{ paddingLeft: 18, marginTop: 8 }}>
            <li><strong>IVR Greetings</strong> — the message callers hear before pressing a digit</li>
            <li><strong>Queue Hold Music</strong> — played while callers wait in a queue</li>
            <li><strong>IVR Override Announcements</strong> — used during scheduled holiday overrides</li>
            <li><strong>Time Condition Messages</strong> — after-hours or holiday greeting</li>
          </ul>
          <p style={{ marginTop: 8 }}>Select a recording from the dropdown in the IVR Builder or Queue settings.</p>
        </div>
      </DetailCard>
    </div>
  );
}
