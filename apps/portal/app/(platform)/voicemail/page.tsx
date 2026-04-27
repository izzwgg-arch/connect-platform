"use client";

import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { useAppContext } from "../../../hooks/useAppContext";
import { useSipPhone } from "../../../hooks/useSipPhone";
import { apiDelete, apiGet, apiPatch } from "../../../services/apiClient";
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  Clipboard,
  Clock,
  Copy,
  Download,
  Mail,
  MailOpen,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Phone,
  Play,
  RefreshCw,
  Search,
  Send,
  SlidersHorizontal,
  Sparkles,
  Star,
  StickyNote,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

interface Voicemail {
  id: string;
  callerId: string;
  callerName?: string | null;
  receivedAt: string;
  durationSec: number;
  folder: "inbox" | "old" | "urgent";
  listened: boolean;
  extension: string;
  tenantId: string | null;
  tenantName?: string | null;
  transcription?: string;
  streamUrl?: string;
}

type VoicemailResponse = {
  voicemails: Voicemail[];
  total: number;
  page?: number;
};

type FolderKey = "inbox" | "old" | "urgent";
type TabKey = "inbox" | "new" | "urgent" | "old";
type DateRange = "all" | "today" | "yesterday" | "last7";

function fmtDuration(sec: number): string {
  if (!sec || sec <= 0) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function ageDays(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function groupKey(iso: string): "today" | "yesterday" | "earlier" {
  const d = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "today";
  if (d.toDateString() === yesterday.toDateString()) return "yesterday";
  return "earlier";
}

function initials(vm: Voicemail): string {
  const label = (vm.callerName || vm.callerId || "VM").trim();
  const parts = label.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  return label.replace(/\W/g, "").slice(0, 2).toUpperCase() || "VM";
}

function callerLabel(vm: Voicemail): string {
  return vm.callerName?.trim() || vm.callerId || "Unknown caller";
}

function callerType(vm: Voicemail): "Internal" | "External" {
  const digits = vm.callerId.replace(/\D/g, "");
  return digits.length > 0 && digits.length <= 6 ? "Internal" : "External";
}

function statusFor(vm: Voicemail): "new" | "urgent" | "old" | "played" {
  if (vm.folder === "urgent") return "urgent";
  if (!vm.listened) return "new";
  if (vm.folder === "old" || ageDays(vm.receivedAt) > 7) return "old";
  return "played";
}

function statusLabel(vm: Voicemail): string {
  const status = statusFor(vm);
  if (status === "new") return "New";
  if (status === "urgent") return "Urgent";
  if (status === "old") return "Old";
  return "Played";
}

function matchesDateRange(vm: Voicemail, range: DateRange): boolean {
  if (range === "all") return true;
  const key = groupKey(vm.receivedAt);
  if (range === "today") return key === "today";
  if (range === "yesterday") return key === "yesterday";
  return ageDays(vm.receivedAt) <= 7;
}

function folderForTab(tab: TabKey): FolderKey {
  if (tab === "urgent") return "urgent";
  if (tab === "old") return "old";
  return "inbox";
}

function mediaBaseUrl(): string {
  const baked = process.env.NEXT_PUBLIC_API_URL;
  const fromEnv = baked != null && String(baked).trim() !== "" ? String(baked).trim().replace(/\/$/, "") : "";
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined") return `${window.location.origin.replace(/\/$/, "")}/api`;
  return "";
}

function authToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
}

function voicemailMediaUrl(vm: Voicemail, kind: "stream" | "download"): string {
  if (kind === "stream" && vm.streamUrl) return vm.streamUrl;
  return `${mediaBaseUrl()}/voice/voicemail/${vm.id}/${kind}?token=${encodeURIComponent(authToken())}`;
}

function Waveform({ progress, active, onSeek }: { progress: number; active: boolean; onSeek: (pct: number) => void }) {
  return (
    <div
      className={`vm-waveform ${active ? "active" : ""}`}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
      }}
      aria-hidden
    >
      {Array.from({ length: 34 }).map((_, i) => {
        const filled = (i / 33) * 100 <= progress;
        return <span key={i} className={filled ? "filled" : ""} style={{ height: `${10 + ((i * 9) % 24)}px` }} />;
      })}
    </div>
  );
}

function VoicePlayer({
  vm,
  compact = false,
  onListened,
}: {
  vm: Voicemail;
  compact?: boolean;
  onListened?: (vm: Voicemail) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentSec, setCurrentSec] = useState(0);
  const [durationSec, setDurationSec] = useState(vm.durationSec || 0);
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(0.9);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const src = voicemailMediaUrl(vm, "stream");
  const progress = durationSec > 0 ? Math.min(100, (currentSec / durationSec) * 100) : 0;

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
    };
  }, []);

  function getAudio() {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.preload = "none";
      audio.src = src;
      audio.playbackRate = speed;
      audio.volume = volume;
      audio.addEventListener("loadstart", () => {
        setLoading(true);
        setError(null);
      });
      audio.addEventListener("loadedmetadata", () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) setDurationSec(Math.floor(audio.duration));
      });
      audio.addEventListener("canplay", () => setLoading(false));
      audio.addEventListener("playing", () => {
        setPlaying(true);
        setLoading(false);
        onListened?.(vm);
      });
      audio.addEventListener("pause", () => setPlaying(false));
      audio.addEventListener("waiting", () => setLoading(true));
      audio.addEventListener("stalled", () => setLoading(true));
      audio.addEventListener("timeupdate", () => setCurrentSec(Math.floor(audio.currentTime)));
      audio.addEventListener("ended", () => {
        setPlaying(false);
        setCurrentSec(durationSec || vm.durationSec);
      });
      audio.addEventListener("error", () => {
        const err = audio.error;
        const codeName = err ? ({ 1: "aborted", 2: "network", 3: "decode", 4: "src_not_supported" } as Record<number, string>)[err.code] ?? `code_${err.code}` : "unknown";
        console.error("[voicemail] audio error", { src, code: err?.code, codeName, message: err?.message });
        setError(codeName);
        setLoading(false);
        setPlaying(false);
      });
      audioRef.current = audio;
    }
    return audioRef.current;
  }

  function togglePlay(e?: React.MouseEvent) {
    e?.stopPropagation();
    const audio = getAudio();
    if (playing) {
      audio.pause();
      return;
    }
    setLoading(true);
    audio.play().catch((err) => {
      console.error("[voicemail] play() rejected", { src, name: err?.name, message: err?.message });
      setError(err?.name === "NotAllowedError" ? "blocked" : err?.name === "NotSupportedError" ? "src_not_supported" : "play_failed");
      setLoading(false);
      setPlaying(false);
    });
  }

  function seekTo(pct: number) {
    const audio = getAudio();
    const next = Math.max(0, Math.min(durationSec || vm.durationSec, pct * (durationSec || vm.durationSec)));
    audio.currentTime = next;
    setCurrentSec(Math.floor(next));
  }

  function changeSpeed(next: number) {
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }

  function changeVolume(next: number) {
    setVolume(next);
    if (audioRef.current) audioRef.current.volume = next;
  }

  return (
    <div className={`vm-player ${compact ? "compact" : ""} ${error ? "error" : ""}`} onClick={(e) => e.stopPropagation()}>
      <button className="vm-player-main" onClick={togglePlay} title={error ? `Audio error: ${error}` : playing ? "Pause voicemail" : "Play voicemail"}>
        {loading ? <span className="vm-spinner" /> : playing ? <Pause size={compact ? 14 : 18} /> : <Play size={compact ? 14 : 18} fill="currentColor" />}
      </button>
      <div className="vm-player-body">
        <Waveform progress={progress} active={playing} onSeek={seekTo} />
        <div className="vm-player-meta">
          <span>{fmtDuration(currentSec)} / {fmtDuration(durationSec || vm.durationSec)}</span>
          {!compact ? (
            <div className="vm-player-controls">
              {[1, 1.5, 2].map((value) => (
                <button key={value} className={speed === value ? "active" : ""} onClick={() => changeSpeed(value)}>
                  {value}x
                </button>
              ))}
              <label className="vm-volume">
                <Volume2 size={13} />
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={volume}
                  onChange={(e) => changeVolume(Number(e.target.value))}
                />
              </label>
            </div>
          ) : null}
        </div>
        {error ? <span className="vm-player-error">Audio unavailable: {error}</span> : null}
      </div>
    </div>
  );
}

function StatusBadge({ vm }: { vm: Voicemail }) {
  const status = statusFor(vm);
  return (
    <span className={`vm-status ${status}`}>
      {status === "urgent" ? <AlertCircle size={12} /> : status === "new" ? <Mail size={12} /> : status === "old" ? <Archive size={12} /> : <CheckCircle2 size={12} />}
      {statusLabel(vm)}
    </span>
  );
}

function VoicemailCard({
  vm,
  selected,
  showTenant,
  copied,
  deleting,
  onSelect,
  onPlay,
  onCall,
  onMessage,
  onCopy,
  onDelete,
  onToggleRead,
  onMarkUrgent,
}: {
  vm: Voicemail;
  selected: boolean;
  showTenant: boolean;
  copied: boolean;
  deleting: boolean;
  onSelect: (vm: Voicemail) => void;
  onPlay: (vm: Voicemail) => void;
  onCall: (num: string) => void;
  onMessage: (num: string) => void;
  onCopy: (vm: Voicemail) => void;
  onDelete: (id: string) => void;
  onToggleRead: (vm: Voicemail) => void;
  onMarkUrgent: (vm: Voicemail) => void;
}) {
  return (
    <article
      className={`vm-feed-card vm-${statusFor(vm)} ${selected ? "selected" : ""} ${!vm.listened ? "unread" : ""}`}
      onClick={() => onSelect(vm)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect(vm);
      }}
    >
      <div className="vm-avatar">{initials(vm)}</div>
      <div className="vm-feed-main">
        <div className="vm-feed-title-row">
          <strong>{callerLabel(vm)}</strong>
          <span className="mono">{vm.callerName ? vm.callerId : ""}</span>
        </div>
        <div className="vm-feed-sub">
          <span>ext {vm.extension}</span>
          <span>{callerType(vm)}</span>
          {showTenant && vm.tenantName ? <span>{vm.tenantName}</span> : null}
        </div>
        <div className="vm-feed-preview">
          <StatusBadge vm={vm} />
          <span>{vm.transcription?.trim() || "Voicemail received"}</span>
        </div>
      </div>
      <div className="vm-feed-right">
        <span className="vm-feed-time">{fmtTime(vm.receivedAt)}</span>
        <span className="vm-feed-duration">{fmtDuration(vm.durationSec)}</span>
        <div className="vm-feed-actions" onClick={(e) => e.stopPropagation()}>
          <VoicePlayer vm={vm} compact onListened={onPlay} />
          <button className="vm-action-btn" onClick={() => onCall(vm.callerId)} title="Call back"><Phone size={13} /></button>
          <button className="vm-action-btn" onClick={() => onMessage(vm.callerId)} title="Message"><MessageSquare size={13} /></button>
          <details className="vm-menu">
            <summary className="vm-action-btn" title="More actions"><MoreHorizontal size={13} /></summary>
            <div className="vm-menu-list">
              <button onClick={() => onCall(vm.callerId)}><Phone size={13} />Call back</button>
              <button onClick={() => onMessage(vm.callerId)}><MessageSquare size={13} />Message</button>
              <button onClick={() => onCopy(vm)}><Copy size={13} />{copied ? "Copied" : "Copy number"}</button>
              <button onClick={() => onToggleRead(vm)}>{vm.listened ? <Mail size={13} /> : <MailOpen size={13} />}{vm.listened ? "Mark unread" : "Mark read"}</button>
              <button onClick={() => onMarkUrgent(vm)}><Star size={13} />{vm.folder === "urgent" ? "Move to inbox" : "Mark urgent"}</button>
              <a href={voicemailMediaUrl(vm, "download")} download><Download size={13} />Download audio</a>
              <button className="danger" disabled={deleting} onClick={() => onDelete(vm.id)}><Trash2 size={13} />Delete</button>
            </div>
          </details>
        </div>
      </div>
    </article>
  );
}

function DetailsPanel({
  vm,
  showTenant,
  note,
  deleting,
  onClose,
  onCall,
  onMessage,
  onCopy,
  onDelete,
  onToggleRead,
  onMarkUrgent,
  onNote,
  onListened,
}: {
  vm: Voicemail | null;
  showTenant: boolean;
  note: string;
  deleting: boolean;
  onClose: () => void;
  onCall: (num: string) => void;
  onMessage: (num: string) => void;
  onCopy: (vm: Voicemail) => void;
  onDelete: (id: string) => void;
  onToggleRead: (vm: Voicemail) => void;
  onMarkUrgent: (vm: Voicemail) => void;
  onNote: (value: string) => void;
  onListened: (vm: Voicemail) => void;
}) {
  if (!vm) {
    return (
      <aside className="vm-side-panel" aria-label="Voicemail details">
        <div className="vm-side-empty">
          <Sparkles size={22} />
          <h4>Select a voicemail</h4>
          <p>Open a message to listen, read transcript notes, and take follow-up actions.</p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="vm-side-panel open" aria-label="Voicemail details">
      <div className="vm-side-content">
        <div className="vm-side-top">
          <div className="vm-avatar large">{initials(vm)}</div>
          <div>
            <h3>{callerLabel(vm)}</h3>
            <p className="mono">{vm.callerId}</p>
            <p>Extension {vm.extension}</p>
          </div>
          <button className="vm-side-close" onClick={onClose} aria-label="Close details"><X size={16} /></button>
        </div>

        <StatusBadge vm={vm} />

        <section className="vm-side-section vm-side-player">
          <h4><Volume2 size={14} /> Playback</h4>
          <VoicePlayer vm={vm} onListened={onListened} />
        </section>

        <section className="vm-side-section">
          <div className="vm-section-head">
            <h4><Clipboard size={14} /> AI transcript</h4>
            <button className="vm-action-btn" disabled={!vm.transcription} onClick={() => vm.transcription && navigator.clipboard?.writeText(vm.transcription)} title="Copy transcript">
              <Copy size={13} />
            </button>
          </div>
          <div className="vm-transcript">
            {vm.transcription?.trim() ? vm.transcription : <span>No transcription available for this voicemail.</span>}
          </div>
        </section>

        <dl className="vm-detail-grid">
          <dt>Received</dt><dd>{fmtTime(vm.receivedAt)}</dd>
          <dt>Duration</dt><dd>{fmtDuration(vm.durationSec)}</dd>
          <dt>Extension</dt><dd>{vm.extension}</dd>
          <dt>Caller type</dt><dd>{callerType(vm)}</dd>
          {showTenant && vm.tenantName ? <><dt>Tenant</dt><dd>{vm.tenantName}</dd></> : null}
          <dt>Call ID</dt><dd className="mono">{vm.id}</dd>
        </dl>

        <section className="vm-side-actions">
          <button className="btn primary btn-sm" onClick={() => onCall(vm.callerId)}><Phone size={14} />Call back</button>
          <button className="btn ghost btn-sm" onClick={() => onMessage(vm.callerId)}><Send size={14} />Message</button>
          <button className="btn ghost btn-sm" onClick={() => onToggleRead(vm)}>{vm.listened ? <Mail size={14} /> : <MailOpen size={14} />}{vm.listened ? "Mark unread" : "Mark read"}</button>
          <button className="btn ghost btn-sm" onClick={() => onMarkUrgent(vm)}><Star size={14} />{vm.folder === "urgent" ? "Move to inbox" : "Mark urgent"}</button>
          <button className="btn ghost btn-sm" onClick={() => onCopy(vm)}><Copy size={14} />Copy number</button>
          <button className="btn ghost btn-sm danger" disabled={deleting} onClick={() => onDelete(vm.id)}><Trash2 size={14} />Delete</button>
        </section>

        <section className="vm-side-section">
          <h4><StickyNote size={14} /> Notes</h4>
          <textarea value={note} onChange={(e) => onNote(e.target.value)} placeholder="Add context for follow-up..." />
        </section>
      </div>
    </aside>
  );
}

export default function VoicemailPage() {
  const phone = useSipPhone();
  const { adminScope, tenantId: contextTenantId } = useAppContext();
  const [tab, setTab] = useState<TabKey>("inbox");
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [items, setItems] = useState<Voicemail[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState({ total: 0, new: 0, urgent: 0, old: 0 });
  const [selected, setSelected] = useState<Voicemail | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [extensionFilter, setExtensionFilter] = useState("");
  const [dateRange, setDateRange] = useState<DateRange>("all");
  const [notes, setNotes] = useState<Record<string, string>>({});

  const showTenant = adminScope === "GLOBAL";
  const tenantParam = adminScope === "GLOBAL" ? "global" : contextTenantId;

  function buildQuery(folder: FolderKey, requestedPage = 1) {
    const params = new URLSearchParams({ folder, page: String(requestedPage) });
    if (tenantParam) params.set("tenantId", tenantParam);
    if (extensionFilter.trim()) params.set("extension", extensionFilter.trim());
    return params.toString();
  }

  useEffect(() => {
    setPage(1);
    setItems([]);
    setSelected(null);
  }, [tab, tenantParam, extensionFilter]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const folder = folderForTab(tab);
    apiGet<VoicemailResponse>(`/voice/voicemail?${buildQuery(folder, page)}`)
      .then((data) => {
        if (!active) return;
        setTotal(data.total ?? 0);
        setItems((prev) => {
          const next = page === 1 ? data.voicemails ?? [] : [...prev, ...(data.voicemails ?? [])];
          return Array.from(new Map(next.map((vm) => [vm.id, vm])).values());
        });
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Unable to load voicemail");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [page, reloadKey, tab, tenantParam, extensionFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let active = true;
    Promise.all([
      apiGet<VoicemailResponse>(`/voice/voicemail?${buildQuery("inbox", 1)}`),
      apiGet<VoicemailResponse>(`/voice/voicemail?${buildQuery("urgent", 1)}`),
      apiGet<VoicemailResponse>(`/voice/voicemail?${buildQuery("old", 1)}`),
    ])
      .then(([inboxData, urgentData, oldData]) => {
        if (!active) return;
        setSummary({
          total: (inboxData.total ?? 0) + (urgentData.total ?? 0) + (oldData.total ?? 0),
          new: (inboxData.voicemails ?? []).filter((vm) => !vm.listened).length + (urgentData.voicemails ?? []).filter((vm) => !vm.listened).length,
          urgent: urgentData.total ?? 0,
          old: oldData.total ?? 0,
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [reloadKey, tenantParam, extensionFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((vm) => {
      if (tab === "new" && vm.listened) return false;
      if (!matchesDateRange(vm, dateRange)) return false;
      if (!q) return true;
      return [vm.callerName, vm.callerId, vm.extension, vm.tenantName].some((value) => String(value || "").toLowerCase().includes(q));
    });
  }, [dateRange, items, query, tab]);

  const grouped = useMemo(() => {
    return filteredItems.reduce<Record<"today" | "yesterday" | "earlier", Voicemail[]>>(
      (acc, vm) => {
        acc[groupKey(vm.receivedAt)].push(vm);
        return acc;
      },
      { today: [], yesterday: [], earlier: [] },
    );
  }, [filteredItems]);

  const hasMore = items.length < total;

  function patchLocal(id: string, patch: Partial<Voicemail>) {
    setItems((prev) => prev.map((vm) => (vm.id === id ? { ...vm, ...patch } : vm)));
    setSelected((prev) => (prev?.id === id ? { ...prev, ...patch } : prev));
  }

  async function markListened(vm: Voicemail, listened = true) {
    if (vm.listened === listened) return;
    patchLocal(vm.id, { listened });
    await apiPatch(`/voice/voicemail/${vm.id}`, { listened });
    setReloadKey((k) => k + 1);
  }

  async function toggleRead(vm: Voicemail) {
    await markListened(vm, !vm.listened);
  }

  async function markUrgent(vm: Voicemail) {
    const nextFolder: FolderKey = vm.folder === "urgent" ? "inbox" : "urgent";
    patchLocal(vm.id, { folder: nextFolder });
    await apiPatch(`/voice/voicemail/${vm.id}`, { folder: nextFolder });
    setReloadKey((k) => k + 1);
  }

  async function handleDelete(id: string) {
    setDeleteId(id);
    try {
      await apiDelete(`/voice/voicemail/${id}`);
      setItems((prev) => prev.filter((vm) => vm.id !== id));
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

  function handleMessage(number: string) {
    if (!number) return;
    window.location.href = `sms:${number}`;
  }

  async function copyNumber(vm: Voicemail) {
    await navigator.clipboard?.writeText(vm.callerId);
    setCopiedId(vm.id);
    window.setTimeout(() => setCopiedId(null), 1400);
  }

  const tabs: Array<{ key: TabKey; label: string; count?: number }> = [
    { key: "inbox", label: "Inbox", count: summary.total },
    { key: "new", label: "New", count: summary.new },
    { key: "urgent", label: "Urgent", count: summary.urgent },
    { key: "old", label: "Old", count: summary.old },
  ];

  const emptyTitle = items.length === 0 && !query && dateRange === "all" && !extensionFilter ? "No voicemails yet" : "No voicemails match your filters";

  return (
    <div className="vm-premium content">
      <header className="vm-hero">
        <div>
          <div className="vm-eyebrow"><Sparkles size={14} />Communication inbox</div>
          <h1>Voicemail</h1>
          <p>Messages from people, grouped for fast follow-up.</p>
        </div>
        <button className="btn ghost btn-sm" onClick={() => setReloadKey((k) => k + 1)}>
          <RefreshCw size={14} />Refresh
        </button>
      </header>

      <section className="vm-kpi-grid" aria-label="Voicemail summary">
        <div className="vm-kpi-card total"><span>Total voicemails</span><strong>{summary.total}</strong><small>Current workspace scope</small></div>
        <div className="vm-kpi-card new"><span>New</span><strong>{summary.new}</strong><small>Needs attention</small></div>
        <div className="vm-kpi-card urgent"><span>Urgent</span><strong>{summary.urgent}</strong><small>Priority callbacks</small></div>
        <div className="vm-kpi-card old"><span>Old</span><strong>{summary.old}</strong><small>Older than active inbox</small></div>
      </section>

      <section className="vm-smart-filters">
        <div className="vm-pill-tabs" role="tablist" aria-label="Voicemail folders">
          {tabs.map((entry) => (
            <button key={entry.key} className={`vm-pill-tab ${tab === entry.key ? "active" : ""}`} onClick={() => setTab(entry.key)} role="tab" aria-selected={tab === entry.key}>
              {entry.label}
              {typeof entry.count === "number" ? <span>{entry.count}</span> : null}
            </button>
          ))}
        </div>
        <label className="vm-search-wrap">
          <Search size={15} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, number, or extension" />
        </label>
        <label className="vm-filter-field">
          <SlidersHorizontal size={14} />
          <input value={extensionFilter} onChange={(e) => setExtensionFilter(e.target.value)} placeholder="Extension" />
        </label>
        <label className="vm-filter-field">
          <Clock size={14} />
          <select value={dateRange} onChange={(e) => setDateRange(e.target.value as DateRange)}>
            <option value="all">Any date</option>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="last7">Last 7 days</option>
          </select>
        </label>
      </section>

      <main className="vm-main">
        <section className="vm-feed-shell" aria-label="Voicemail feed">
          {loading && items.length === 0 ? <LoadingSkeleton rows={6} /> : null}
          {error && items.length === 0 ? <ErrorState message={error} /> : null}
          {!loading && !error && filteredItems.length === 0 ? (
            <EmptyState title={emptyTitle} message={emptyTitle === "No voicemails yet" ? "Messages from callers will appear here." : "Try changing search, extension, date range, or tab."} />
          ) : null}
          {filteredItems.length > 0 ? (
            <div className="vm-feed-groups">
              {([
                ["Today", grouped.today],
                ["Yesterday", grouped.yesterday],
                ["Earlier", grouped.earlier],
              ] as Array<[string, Voicemail[]]>).map(([label, rows]) => (
                rows.length > 0 ? (
                  <section className="vm-group-section" key={label}>
                    <header className="vm-group-header">{label}</header>
                    <div className="vm-feed-list">
                      {rows.map((vm) => (
                        <VoicemailCard
                          key={vm.id}
                          vm={vm}
                          selected={selected?.id === vm.id}
                          showTenant={showTenant}
                          copied={copiedId === vm.id}
                          deleting={deleteId === vm.id}
                          onSelect={setSelected}
                          onPlay={(message) => markListened(message, true)}
                          onCall={handleCall}
                          onMessage={handleMessage}
                          onCopy={copyNumber}
                          onDelete={handleDelete}
                          onToggleRead={toggleRead}
                          onMarkUrgent={markUrgent}
                        />
                      ))}
                    </div>
                  </section>
                ) : null
              ))}
            </div>
          ) : null}
          <div className="vm-load-more" aria-live="polite">
            {loading && items.length > 0 ? <span>Loading messages...</span> : hasMore ? (
              <button className="btn ghost btn-sm" onClick={() => setPage((p) => p + 1)}>Load older voicemails</button>
            ) : filteredItems.length > 0 ? <span>All visible voicemails loaded</span> : null}
          </div>
        </section>

        <DetailsPanel
          vm={selected}
          showTenant={showTenant}
          note={selected ? notes[selected.id] || "" : ""}
          deleting={selected ? deleteId === selected.id : false}
          onClose={() => setSelected(null)}
          onCall={handleCall}
          onMessage={handleMessage}
          onCopy={copyNumber}
          onDelete={handleDelete}
          onToggleRead={toggleRead}
          onMarkUrgent={markUrgent}
          onNote={(value) => selected && setNotes((prev) => ({ ...prev, [selected.id]: value }))}
          onListened={(message) => markListened(message, true)}
        />
      </main>
    </div>
  );
}
