"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  Check,
  ChevronDown,
  Clock,
  Copy,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Phone,
  Play,
  RefreshCw,
  Search,
  Star,
  Trash2,
  Voicemail as VoicemailIcon,
  Volume2,
  X,
} from "lucide-react";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { ConnectSelect } from "../../../components/ConnectSelect";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { useSipPhone } from "../../../hooks/useSipPhone";
import { apiDelete, apiGet, apiPatch } from "../../../services/apiClient";
import { useAppContext } from "../../../hooks/useAppContext";
import { CRMPageHeader, cn, crm } from "../../../components/crm";

type FolderKey = "inbox" | "old" | "urgent";
type TabKey = "inbox" | "new" | "urgent" | "old";
type DateFilter = "all" | "today" | "7d" | "older";

interface Voicemail {
  id: string;
  callerId: string;
  callerName?: string | null;
  receivedAt: string;
  durationSec: number;
  folder: FolderKey;
  listened: boolean;
  extension: string;
  tenantId: string | null;
  tenantName?: string | null;
  transcription?: string | null;
  streamUrl?: string;
}

type VoicemailResponse = {
  voicemails: Voicemail[];
  total: number;
  page: number;
};

type MailboxData = {
  voicemails: Voicemail[];
  totals: Record<FolderKey, number>;
  page: number;
};

function buildVoicemailPreview(page: number): MailboxData {
  const callers = ["Avery Stone", "Jordan Hayes", "Morgan River", "Northstar Desk", "Harbor Retail", "Crescent Auto"];
  const voicemails: Voicemail[] = Array.from({ length: 30 }, (_, index) => {
    const folder: FolderKey = index % 9 === 0 ? "urgent" : index % 5 === 0 ? "old" : "inbox";
    return {
      id: `preview-voicemail-${index + 1}`,
      callerId: `+1555903${String(index).padStart(4, "0")}`,
      callerName: callers[index % callers.length],
      receivedAt: new Date(Date.now() - index * 43 * 60_000).toISOString(),
      durationSec: 24 + ((index * 13) % 160),
      folder,
      listened: index % 4 === 0,
      extension: String(220 + (index % 8)),
      tenantId: "preview-tenant",
      tenantName: "Local Dev Workspace",
      transcription: [
        "Hi, this is a preview voicemail. Please call me back when you have a chance.",
        "Following up on the quote. I can send the missing document this afternoon.",
        "The customer asked for confirmation before the close of business today.",
        "This longer preview item is here to make the voicemail feed scroll independently from the page.",
      ][index % 4],
      streamUrl: undefined,
    };
  });
  return {
    voicemails,
    totals: {
      inbox: voicemails.filter((vm) => vm.folder === "inbox").length,
      urgent: voicemails.filter((vm) => vm.folder === "urgent").length,
      old: voicemails.filter((vm) => vm.folder === "old").length,
    },
    page,
  };
}

const FOLDERS: FolderKey[] = ["inbox", "urgent", "old"];
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "inbox", label: "Inbox" },
  { key: "new", label: "New" },
  { key: "urgent", label: "Urgent" },
  { key: "old", label: "Old" },
];

function mediaBaseUrl(): string {
  const baked = process.env.NEXT_PUBLIC_API_URL;
  const fromEnv = baked != null && String(baked).trim() !== "" ? String(baked).trim().replace(/\/$/, "") : "";
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined") return `${window.location.origin.replace(/\/$/, "")}/api`;
  return "";
}

function browserToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken") || "";
}

function fmtDuration(sec: number): string {
  const safe = Number.isFinite(sec) ? Math.max(0, Math.floor(sec)) : 0;
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function VoicemailKpiTile({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: string | number;
  icon: ReactNode;
  tone: "blue" | "green" | "violet" | "amber" | "rose" | "cyan";
}) {
  return (
    <div className={cn(crm.queueCountPill, `crm-queue-kpi-${tone}`, "relative overflow-hidden bg-crm-surface-2")}>
      <span className="flex w-full items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="crm-queue-kpi-label block text-[10px] font-bold uppercase tracking-wide text-crm-muted">{label}</span>
          <span className="crm-queue-kpi-value mt-1 block text-2xl font-bold tabular-nums leading-none tracking-tight text-crm-text">
            {value}
          </span>
        </span>
        <span className="crm-queue-kpi-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface/70 text-crm-accent">
          {icon}
        </span>
      </span>
    </div>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((startOfDay(now).getTime() - startOfDay(d).getTime()) / 86400000);
  if (diffDays === 0) return `Today ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  if (diffDays === 1) return `Yesterday ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isOlderThanSevenDays(vm: Voicemail): boolean {
  return Date.now() - new Date(vm.receivedAt).getTime() > 7 * 86400000;
}

function callerType(vm: Voicemail): "internal" | "external" {
  const digits = vm.callerId.replace(/\D/g, "");
  return digits.length > 0 && digits.length <= 5 ? "internal" : "external";
}

function displayName(vm: Voicemail): string {
  return vm.callerName?.trim() || vm.callerId || "Unknown caller";
}

function initials(vm: Voicemail): string {
  const name = displayName(vm);
  const words = name.replace(/[^\w\s]/g, "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return "VM";
}

function statusLabel(vm: Voicemail): "New" | "Urgent" | "Old" | "Played" {
  if (vm.folder === "urgent") return "Urgent";
  if (!vm.listened) return "New";
  if (vm.folder === "old" || isOlderThanSevenDays(vm)) return "Old";
  return "Played";
}

function previewText(vm: Voicemail): string {
  const text = vm.transcription?.trim();
  if (text) return text.length > 128 ? `${text.slice(0, 128)}...` : text;
  return "Voicemail received";
}

function waveformBars(seed: string, count: number): number[] {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return Array.from({ length: count }, (_, idx) => {
    hash = (hash * 1664525 + 1013904223 + idx) >>> 0;
    return 18 + (hash % 58);
  });
}

function StatusBadge({ vm }: { vm: Voicemail }) {
  const label = statusLabel(vm);
  return <span className={`vm-status vm-status-${label.toLowerCase()}`}>{label}</span>;
}

function SmartAudioPlayer({
  vm,
  activeId,
  onActivate,
  onPlayed,
  autoPlayRequest = 0,
  size = "full",
}: {
  vm: Voicemail;
  activeId: string | null;
  onActivate: (id: string) => void;
  onPlayed: (vm: Voicemail) => void;
  autoPlayRequest?: number;
  size?: "compact" | "full";
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentSec, setCurrentSec] = useState(0);
  const [durationSec, setDurationSec] = useState(vm.durationSec);
  const [speed, setSpeed] = useState(1);
  const [volume, setVolume] = useState(0.9);
  const bars = useMemo(() => waveformBars(vm.id, size === "compact" ? 36 : 64), [vm.id, size]);
  const progress = durationSec > 0 ? Math.min(100, (currentSec / durationSec) * 100) : 0;

  const src = useMemo(() => {
    const apiBase = mediaBaseUrl();
    const token = browserToken();
    return vm.streamUrl ?? `${apiBase}/voice/voicemail/${vm.id}/stream?token=${encodeURIComponent(token)}`;
  }, [vm.id, vm.streamUrl]);

  const getOrCreateAudio = useCallback(() => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.preload = "none";
      audio.addEventListener("loadstart", () => {
        setLoading(true);
        setError(null);
      });
      audio.addEventListener("loadedmetadata", () => {
        if (Number.isFinite(audio.duration)) setDurationSec(Math.floor(audio.duration));
      });
      audio.addEventListener("canplay", () => setLoading(false));
      audio.addEventListener("playing", () => {
        setPlaying(true);
        setLoading(false);
      });
      audio.addEventListener("pause", () => setPlaying(false));
      audio.addEventListener("waiting", () => setLoading(true));
      audio.addEventListener("stalled", () => setLoading(true));
      audio.addEventListener("timeupdate", () => setCurrentSec(Math.floor(audio.currentTime)));
      audio.addEventListener("ended", () => {
        setPlaying(false);
        setCurrentSec(Math.floor(audio.duration || vm.durationSec));
      });
      audio.addEventListener("error", () => {
        const err = audio.error;
        const codeName = err
          ? ({ 1: "aborted", 2: "network", 3: "decode", 4: "src_not_supported" } as Record<number, string>)[err.code] ?? `code_${err.code}`
          : "unknown";
        console.error("[voicemail] audio error", { src, code: err?.code, codeName, message: err?.message });
        setError(codeName);
        setLoading(false);
        setPlaying(false);
      });
      audioRef.current = audio;
    }
    audioRef.current.playbackRate = speed;
    audioRef.current.volume = volume;
    return audioRef.current;
  }, [speed, src, vm.durationSec, volume]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.playbackRate = speed;
  }, [speed]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (activeId !== vm.id && audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
    }
  }, [activeId, vm.id]);

  useEffect(() => () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
  }, []);

  function togglePlay() {
    const audio = getOrCreateAudio();
    if (!audio.src) audio.src = src;
    if (playing) {
      audio.pause();
      return;
    }
    onActivate(vm.id);
    onPlayed(vm);
    setLoading(true);
    const promise = audio.play();
    if (promise && typeof promise.catch === "function") {
      promise.catch((err) => {
        console.error("[voicemail] play() rejected", { src, name: err?.name, message: err?.message });
        setError(err?.name === "NotAllowedError" ? "blocked" : err?.name === "NotSupportedError" ? "src_not_supported" : "play_failed");
        setLoading(false);
        setPlaying(false);
      });
    }
  }

  useEffect(() => {
    if (!autoPlayRequest) return;
    const audio = getOrCreateAudio();
    if (!audio.src) audio.src = src;
    if (!audio.paused) return;
    onActivate(vm.id);
    onPlayed(vm);
    setLoading(true);
    const promise = audio.play();
    if (promise && typeof promise.catch === "function") {
      promise.catch((err) => {
        console.error("[voicemail] play() rejected", { src, name: err?.name, message: err?.message });
        setError(err?.name === "NotAllowedError" ? "blocked" : err?.name === "NotSupportedError" ? "src_not_supported" : "play_failed");
        setLoading(false);
        setPlaying(false);
      });
    }
  }, [autoPlayRequest, getOrCreateAudio, onActivate, onPlayed, src, vm]);

  function seek(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const audio = getOrCreateAudio();
    if (!audio.src) audio.src = src;
    audio.currentTime = pct * durationSec;
    setCurrentSec(Math.floor(audio.currentTime));
  }

  return (
    <div className={`vm-player vm-player-${size}`}>
      <button
        className={`vm-play ${playing ? "is-playing" : ""}`}
        onClick={togglePlay}
        title={error ? `Audio error: ${error}` : loading ? "Loading" : playing ? "Pause" : "Play"}
      >
        {loading ? <span className="vm-spinner" /> : playing ? <Pause size={size === "compact" ? 15 : 18} /> : <Play size={size === "compact" ? 15 : 18} fill="currentColor" />}
      </button>
      <div className="vm-wave-wrap">
        <div className="vm-wave" onClick={seek} role="slider" aria-label="Seek voicemail" aria-valuemin={0} aria-valuemax={durationSec} aria-valuenow={currentSec}>
          <div className="vm-wave-progress" style={{ width: `${progress}%` }} />
          {bars.map((height, idx) => (
            <span key={idx} className={idx / bars.length <= progress / 100 ? "filled" : ""} style={{ height: `${height}%` }} />
          ))}
        </div>
        <div className="vm-player-meta">
          <span>{fmtDuration(currentSec)} / {fmtDuration(durationSec)}</span>
          {error ? <span className="vm-player-error">{error}</span> : null}
        </div>
      </div>
      {size === "full" ? (
        <div className="vm-player-controls">
          <div className="vm-speed-group" aria-label="Playback speed">
            {[1, 1.5, 2].map((value) => (
              <button key={value} className={speed === value ? "active" : ""} onClick={() => setSpeed(value)}>
                {value}x
              </button>
            ))}
          </div>
          <label className="vm-volume">
            <Volume2 size={15} />
            <input type="range" min="0" max="1" step="0.05" value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
          </label>
        </div>
      ) : null}
    </div>
  );
}

function QuickActionButton({
  title,
  onClick,
  children,
  danger = false,
  disabled = false,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button className={`vm-icon-btn ${danger ? "danger" : ""}`} title={title} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

function VoicemailRow({
  vm,
  selected,
  showTenant,
  canDelete,
  deleting,
  onSelect,
  onPlay,
  onCall,
  onMessage,
  onCopy,
  onDelete,
  onMarkRead,
  onMarkUrgent,
}: {
  vm: Voicemail;
  selected: boolean;
  showTenant: boolean;
  canDelete: boolean;
  deleting: boolean;
  onSelect: (vm: Voicemail) => void;
  onPlay: (vm: Voicemail) => void;
  onCall: (number: string) => void;
  onMessage: (number: string) => void;
  onCopy: (number: string) => void;
  onDelete: (id: string) => void;
  onMarkRead: (vm: Voicemail, listened: boolean) => void;
  onMarkUrgent: (vm: Voicemail, urgent: boolean) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const type = callerType(vm);

  return (
    <article className={`vm-row ${selected ? "selected" : ""} ${!vm.listened ? "unread" : ""}`} onClick={() => onSelect(vm)}>
      <div className="vm-row-main">
        <div className="vm-avatar">{initials(vm)}</div>
        <div className="vm-person">
          <div className="vm-name-line">
            <strong>{displayName(vm)}</strong>
            <StatusBadge vm={vm} />
          </div>
          <div className="vm-subline">
            <span>ext {vm.extension}</span>
            <span>{showTenant && vm.tenantName ? vm.tenantName : type}</span>
            <span className={`vm-type vm-type-${type}`}>{type}</span>
          </div>
        </div>
        <div className="vm-preview">
          <p>{previewText(vm)}</p>
        </div>
        <div className="vm-row-side">
          <span className="vm-time">{fmtTime(vm.receivedAt)}</span>
          <span className="vm-duration">{fmtDuration(vm.durationSec)}</span>
        </div>
        <div className="vm-actions" onClick={(e) => e.stopPropagation()}>
          <QuickActionButton title="Play voicemail" onClick={() => onPlay(vm)}>
            <Play size={15} fill="currentColor" />
          </QuickActionButton>
          <QuickActionButton title="Call back" onClick={() => onCall(vm.callerId)}>
            <Phone size={15} />
          </QuickActionButton>
          <QuickActionButton title="Message" onClick={() => onMessage(vm.callerId)}>
            <MessageSquare size={15} />
          </QuickActionButton>
          <div className="vm-menu-wrap">
            <QuickActionButton title="More actions" onClick={() => setMenuOpen((open) => !open)}>
              <MoreHorizontal size={16} />
            </QuickActionButton>
            {menuOpen ? (
              <div className="vm-menu">
                <button onClick={() => { onMarkRead(vm, !vm.listened); setMenuOpen(false); }}>
                  <Check size={14} /> Mark as {vm.listened ? "unread" : "read"}
                </button>
                <button onClick={() => { onMarkUrgent(vm, vm.folder !== "urgent"); setMenuOpen(false); }}>
                  <Star size={14} /> {vm.folder === "urgent" ? "Remove urgent" : "Mark urgent"}
                </button>
                <button onClick={() => { onCopy(vm.callerId); setMenuOpen(false); }}>
                  <Copy size={14} /> Copy number
                </button>
                {canDelete ? (
                  <button className="danger" disabled={deleting} onClick={() => { onDelete(vm.id); setMenuOpen(false); }}>
                    <Trash2 size={14} /> Delete
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}

function DetailPanel({
  vm,
  showTenant,
  canDelete,
  activeId,
  autoPlayRequest,
  deleting,
  note,
  onNote,
  onClose,
  onActivate,
  onPlayed,
  onCall,
  onMessage,
  onCopy,
  onDelete,
  onMarkRead,
  onMarkUrgent,
}: {
  vm: Voicemail;
  showTenant: boolean;
  canDelete: boolean;
  activeId: string | null;
  autoPlayRequest: number;
  deleting: boolean;
  note: string;
  onNote: (note: string) => void;
  onClose: () => void;
  onActivate: (id: string) => void;
  onPlayed: (vm: Voicemail) => void;
  onCall: (number: string) => void;
  onMessage: (number: string) => void;
  onCopy: (number: string) => void;
  onDelete: (id: string) => void;
  onMarkRead: (vm: Voicemail, listened: boolean) => void;
  onMarkUrgent: (vm: Voicemail, urgent: boolean) => void;
}) {
  const type = callerType(vm);

  return (
    <aside className="vm-detail custom-scrollbar">
      <div className="vm-detail-head">
        <div className="vm-detail-contact">
          <div className="vm-avatar big">{initials(vm)}</div>
          <div>
            <h2>{displayName(vm)}</h2>
            <p>{vm.callerId} · ext {vm.extension}</p>
          </div>
        </div>
        <button className="vm-icon-btn" title="Close details" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <div className="vm-detail-badges">
        <StatusBadge vm={vm} />
        <span className={`vm-type vm-type-${type}`}>{type}</span>
        {showTenant && vm.tenantName ? <span className="vm-status vm-status-played">{vm.tenantName}</span> : null}
      </div>

      <section className="vm-detail-card premium-player">
        <SmartAudioPlayer vm={vm} activeId={activeId} onActivate={onActivate} onPlayed={onPlayed} autoPlayRequest={autoPlayRequest} />
      </section>

      <section className="vm-detail-card">
        <div className="vm-section-title">
          <h3>AI transcript</h3>
          <button className="vm-text-btn" disabled={!vm.transcription} onClick={() => vm.transcription && navigator.clipboard?.writeText(vm.transcription)}>
            Copy
          </button>
        </div>
        <div className="vm-transcript">
          {vm.transcription?.trim() ? vm.transcription : <span>No transcript available for this voicemail.</span>}
        </div>
      </section>

      <section className="vm-detail-card">
        <h3>Details</h3>
        <dl className="vm-detail-list">
          <div><dt>Received</dt><dd>{fmtTime(vm.receivedAt)}</dd></div>
          <div><dt>Duration</dt><dd>{fmtDuration(vm.durationSec)}</dd></div>
          <div><dt>Extension</dt><dd>{vm.extension}</dd></div>
          <div><dt>Caller type</dt><dd>{type}</dd></div>
          <div><dt>Call ID</dt><dd>{vm.id}</dd></div>
        </dl>
      </section>

      <section className="vm-detail-card">
        <h3>Actions</h3>
        <div className="vm-action-grid">
          <button onClick={() => onCall(vm.callerId)}><Phone size={15} /> Call back</button>
          <button onClick={() => onMessage(vm.callerId)}><MessageSquare size={15} /> Send message</button>
          <button onClick={() => onMarkRead(vm, !vm.listened)}><Check size={15} /> Mark {vm.listened ? "unread" : "read"}</button>
          <button onClick={() => onMarkUrgent(vm, vm.folder !== "urgent")}><Star size={15} /> {vm.folder === "urgent" ? "Remove urgent" : "Mark urgent"}</button>
          <button onClick={() => onCopy(vm.callerId)}><Copy size={15} /> Copy number</button>
          {canDelete ? (
            <button className="danger" disabled={deleting} onClick={() => onDelete(vm.id)}><Trash2 size={15} /> Delete</button>
          ) : null}
        </div>
      </section>

      <section className="vm-detail-card">
        <h3>Notes</h3>
        <textarea
          className="vm-note"
          placeholder="Add a private follow-up note..."
          value={note}
          onChange={(e) => onNote(e.target.value)}
        />
      </section>
    </aside>
  );
}

function groupVoicemails(rows: Voicemail[]) {
  const today = startOfDay(new Date()).getTime();
  const yesterday = today - 86400000;
  return rows.reduce<Record<"Today" | "Yesterday" | "Earlier", Voicemail[]>>((acc, vm) => {
    const time = startOfDay(new Date(vm.receivedAt)).getTime();
    if (time === today) acc.Today.push(vm);
    else if (time === yesterday) acc.Yesterday.push(vm);
    else acc.Earlier.push(vm);
    return acc;
  }, { Today: [], Yesterday: [], Earlier: [] });
}

export default function VoicemailPage() {
  const router = useRouter();
  const phone = useSipPhone();
  const { adminScope, tenantId: contextTenantId, can } = useAppContext();
  // Deleting a voicemail requires can_delete_voicemail. Owner carve-out: users
  // who only see their own mailbox (no tenant-wide voicemail view) can always
  // delete their own — matching the server's own-mailbox carve-out. Tenant-wide
  // viewers must hold the explicit key to delete other people's voicemail.
  const canDeleteVoicemail = can("can_delete_voicemail") || !can("can_view_tenant_voicemails");
  const [reloadKey, setReloadKey] = useState(0);
  const [page, setPage] = useState(1);
  const [activeTab, setActiveTab] = useState<TabKey>("inbox");
  const [selected, setSelected] = useState<Voicemail | null>(null);
  const [activePlayerId, setActivePlayerId] = useState<string | null>(null);
  const [detailPlayRequest, setDetailPlayRequest] = useState(0);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [extensionFilter, setExtensionFilter] = useState("");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const showTenant = !contextTenantId && adminScope === "GLOBAL";

  const buildQuery = useCallback((folder: FolderKey) => {
    const params = new URLSearchParams({ folder, page: String(page) });
    if (contextTenantId) params.set("tenantId", contextTenantId);
    // Super-admin global scope: never send tenantId=global — API rejects it; fetch is skipped until a tenant is selected.
    if (extensionFilter.trim()) params.set("extension", extensionFilter.trim());
    return params.toString();
  }, [contextTenantId, extensionFilter, page]);

  const skipFetchNoTenant = adminScope === "GLOBAL" && !contextTenantId;

  const state = useAsyncResource<MailboxData>(async () => {
    if (skipFetchNoTenant) {
      return {
        voicemails: [],
        totals: { inbox: 0, urgent: 0, old: 0 },
        page,
      };
    }
    const responses = await Promise.all(FOLDERS.map((folder) => apiGet<VoicemailResponse>(`/voice/voicemail?${buildQuery(folder)}`)));
    const totals = FOLDERS.reduce((acc, folder, idx) => {
      acc[folder] = responses[idx]?.total ?? 0;
      return acc;
    }, { inbox: 0, urgent: 0, old: 0 } as Record<FolderKey, number>);
    const seen = new Set<string>();
    const voicemails = responses.flatMap((res) => res.voicemails ?? []).filter((vm) => {
      if (seen.has(vm.id)) return false;
      seen.add(vm.id);
      return true;
    });
    return { voicemails, totals, page };
  }, [reloadKey, buildQuery, page, skipFetchNoTenant]);

  useEffect(() => {
    setSelected(null);
    setActivePlayerId(null);
    setPage(1);
  }, [contextTenantId, adminScope]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = localStorage.getItem("connect.voicemail.notes");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") setNotes(parsed);
    } catch {
      setNotes({});
    }
  }, []);

  function saveNote(id: string, note: string) {
    const next = { ...notes, [id]: note };
    setNotes(next);
    if (typeof window !== "undefined") localStorage.setItem("connect.voicemail.notes", JSON.stringify(next));
  }

  const mailbox = state.status === "success"
    ? state.data.voicemails.length < 20 && !skipFetchNoTenant && process.env.NODE_ENV === "development"
      ? (() => {
          const preview = buildVoicemailPreview(page);
          const existingIds = new Set(state.data.voicemails.map((vm) => vm.id));
          const voicemails = [
            ...state.data.voicemails,
            ...preview.voicemails.filter((vm) => !existingIds.has(vm.id)).slice(0, 30 - state.data.voicemails.length),
          ];
          const previewTotals = voicemails.reduce((acc, vm) => {
            acc[vm.folder] += 1;
            return acc;
          }, { inbox: 0, urgent: 0, old: 0 } as Record<FolderKey, number>);
          return { ...state.data, voicemails, totals: previewTotals };
        })()
      : state.data
    : { voicemails: [], totals: { inbox: 0, urgent: 0, old: 0 }, page };
  const allVoicemails = mailbox.voicemails;
  const totalCount = mailbox.totals.inbox + mailbox.totals.urgent + mailbox.totals.old;
  const newCount = allVoicemails.filter((vm) => !vm.listened).length;
  const urgentCount = mailbox.totals.urgent;
  const oldCount = allVoicemails.filter((vm) => vm.folder === "old" || isOlderThanSevenDays(vm)).length;

  const filteredVoicemails = useMemo(() => {
    const query = search.trim().toLowerCase();
    return allVoicemails
      .filter((vm) => {
        if (activeTab === "new" && vm.listened) return false;
        if (activeTab === "urgent" && vm.folder !== "urgent") return false;
        if (activeTab === "old" && vm.folder !== "old" && !isOlderThanSevenDays(vm)) return false;
        if (query) {
          const haystack = [vm.callerName, vm.callerId, vm.extension, vm.tenantName, vm.transcription].filter(Boolean).join(" ").toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        if (dateFilter !== "all") {
          const received = startOfDay(new Date(vm.receivedAt)).getTime();
          const today = startOfDay(new Date()).getTime();
          if (dateFilter === "today" && received !== today) return false;
          if (dateFilter === "7d" && Date.now() - new Date(vm.receivedAt).getTime() > 7 * 86400000) return false;
          if (dateFilter === "older" && !isOlderThanSevenDays(vm)) return false;
        }
        return true;
      })
      .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
  }, [activeTab, allVoicemails, dateFilter, search]);

  const grouped = useMemo(() => groupVoicemails(filteredVoicemails), [filteredVoicemails]);
  const hasFilters = Boolean(search.trim() || extensionFilter.trim() || dateFilter !== "all" || activeTab !== "inbox");
  const canGoNext = totalCount > page * 100;

  async function markRead(vm: Voicemail, listened: boolean) {
    await apiPatch(`/voice/voicemail/${vm.id}`, { listened });
    if (selected?.id === vm.id) setSelected({ ...selected, listened });
    setReloadKey((key) => key + 1);
  }

  async function markUrgent(vm: Voicemail, urgent: boolean) {
    const folder: FolderKey = urgent ? "urgent" : "inbox";
    await apiPatch(`/voice/voicemail/${vm.id}`, { folder });
    if (selected?.id === vm.id) setSelected({ ...selected, folder });
    setReloadKey((key) => key + 1);
  }

  async function handlePlayed(vm: Voicemail) {
    if (vm.listened) return;
    try {
      await apiPatch(`/voice/voicemail/${vm.id}`, { listened: true });
      if (selected?.id === vm.id) setSelected({ ...selected, listened: true });
      setReloadKey((key) => key + 1);
    } catch {
      // Marking read is now driven ONLY by this explicit PATCH on real playback
      // (the stream endpoint no longer auto-marks read). Keep playback resilient
      // if the PATCH fails — the next successful play will retry the mark.
    }
  }

  async function handleDelete(id: string) {
    setDeleteId(id);
    try {
      await apiDelete(`/voice/voicemail/${id}`);
      if (selected?.id === id) setSelected(null);
      setReloadKey((key) => key + 1);
    } finally {
      setDeleteId(null);
    }
  }

  function handleCall(number: string) {
    phone.setDialpadInput(number);
    phone.dial(number);
  }

  function handleMessage(number: string) {
    router.push(`/sms?phone=${encodeURIComponent(number)}`);
  }

  function handleCopy(number: string) {
    navigator.clipboard?.writeText(number);
  }

  function handleRowPlay(vm: Voicemail) {
    setSelected(vm);
    setActivePlayerId(vm.id);
    setDetailPlayRequest((value) => value + 1);
  }

  return (
    <div className="vm-shell crm-queue-workspace crm-voicemail-workspace">
      <header className="vm-hero crm-workspace-header">
        <CRMPageHeader
          compact
          className={cn(crm.contactsHeaderPanel, "campaigns-command-header")}
          icon={<VoicemailIcon className="h-6 w-6" aria-hidden />}
          title="Voicemail"
          actions={
            <div className="campaigns-hero-actions">
              <button className="campaigns-btn-secondary vm-refresh" type="button" onClick={() => setReloadKey((key) => key + 1)}>
                <RefreshCw className="h-4 w-4" /> Refresh
              </button>
            </div>
          }
        />
      </header>

      <div className="vm-toolbar crm-workspace-toolbar">
        <section className="vm-kpis crm-queue-kpi-strip grid w-full grid-cols-2 items-stretch gap-3 md:grid-cols-4 xl:grid-cols-4" aria-label="Voicemail metrics">
          <VoicemailKpiTile label="Total Voicemails" value={totalCount} tone="blue" icon={<VoicemailIcon className="h-4 w-4" />} />
          <VoicemailKpiTile label="New" value={newCount} tone="violet" icon={<Archive className="h-4 w-4" />} />
          <VoicemailKpiTile label="Urgent" value={urgentCount} tone="rose" icon={<Star className="h-4 w-4" />} />
          <VoicemailKpiTile label="Old" value={oldCount} tone="amber" icon={<Clock className="h-4 w-4" />} />
        </section>

      <section className="vm-filter-bar crm-queue-filter-bar">
        <nav className="vm-tabs" aria-label="Voicemail filters">
          {TABS.map((tab) => (
            <button key={tab.key} className={activeTab === tab.key ? "active" : ""} onClick={() => setActiveTab(tab.key)}>
              {tab.label}
              {tab.key === "new" && newCount > 0 ? <span>{newCount}</span> : null}
              {tab.key === "urgent" && urgentCount > 0 ? <span>{urgentCount}</span> : null}
            </button>
          ))}
        </nav>
        <div className="vm-search" style={{ border: "none", outline: "none", boxShadow: "none", background: "transparent" }}>
          <Search size={16} />
          <input
            placeholder="Search name, number, extension..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ border: "none", outline: "none", boxShadow: "none" }}
          />
        </div>
        <ConnectSelect
          size="sm"
          value={dateFilter}
          onChange={(v) => setDateFilter(v as DateFilter)}
          style={{ minWidth: 140 }}
          options={[
            { value: "all", label: "All dates" },
            { value: "today", label: "Today" },
            { value: "7d", label: "Last 7 days" },
            { value: "older", label: "Older than 7 days" },
          ]}
        />
      </section>
      </div>

      <main className={`vm-workspace ${selected ? "has-detail" : ""}`}>
        <section className="vm-feed custom-scrollbar" aria-label="Voicemail feed">
          {state.status === "loading" ? <LoadingSkeleton rows={6} /> : null}
          {state.status === "error" ? <ErrorState message={state.error} /> : null}
          {state.status === "success" && skipFetchNoTenant ? (
            <div className="vm-empty">
              <EmptyState
                title="Select a workspace"
                message="Choose a tenant from the workspace switcher to load voicemail. Listing voicemail across all tenants is not permitted."
              />
            </div>
          ) : null}
          {state.status === "success" && !skipFetchNoTenant && filteredVoicemails.length === 0 ? (
            <div className="vm-empty">
              <EmptyState
                title={allVoicemails.length === 0 ? "No voicemails yet" : "No voicemails match your filters"}
                message={allVoicemails.length === 0 ? "Messages from callers will appear here." : "Try a different tab, date range, extension, or search term."}
              />
            </div>
          ) : null}
          {state.status === "success" && !skipFetchNoTenant && filteredVoicemails.length > 0 ? (
            <>
              {(["Today", "Yesterday", "Earlier"] as const).map((group) => (
                grouped[group].length > 0 ? (
                  <section className="vm-group" key={group}>
                    <div className="vm-group-head">
                      <Clock size={14} /> {group}
                    </div>
                    {grouped[group].map((vm) => (
                      <VoicemailRow
                        key={vm.id}
                        vm={vm}
                        selected={selected?.id === vm.id}
                        showTenant={showTenant}
                        canDelete={canDeleteVoicemail}
                        deleting={deleteId === vm.id}
                        onSelect={setSelected}
                        onPlay={handleRowPlay}
                        onCall={handleCall}
                        onMessage={handleMessage}
                        onCopy={handleCopy}
                        onDelete={handleDelete}
                        onMarkRead={markRead}
                        onMarkUrgent={markUrgent}
                      />
                    ))}
                  </section>
                ) : null
              ))}
              <div className="vm-pagination">
                <button disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</button>
                <span>Page {page}</span>
                <button disabled={!canGoNext} onClick={() => setPage((value) => value + 1)}>Next</button>
              </div>
            </>
          ) : null}
        </section>

        {selected ? (
          <DetailPanel
            vm={selected}
            showTenant={showTenant}
            canDelete={canDeleteVoicemail}
            activeId={activePlayerId}
            autoPlayRequest={detailPlayRequest}
            deleting={deleteId === selected.id}
            note={notes[selected.id] ?? ""}
            onNote={(note) => saveNote(selected.id, note)}
            onClose={() => setSelected(null)}
            onActivate={setActivePlayerId}
            onPlayed={handlePlayed}
            onCall={handleCall}
            onMessage={handleMessage}
            onCopy={handleCopy}
            onDelete={handleDelete}
            onMarkRead={markRead}
            onMarkUrgent={markUrgent}
          />
        ) : (
          <aside className="vm-detail-placeholder custom-scrollbar">
            <Archive size={26} />
            <h2>Select a voicemail</h2>
            <p>Open a message to play it, read transcripts, see call details, and capture follow-up notes.</p>
          </aside>
        )}
      </main>

      <style jsx global>{`
        .vm-shell {
          height: 100%;
          min-height: 0;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          background:
            radial-gradient(circle at top left, color-mix(in srgb, var(--accent) 16%, transparent), transparent 34%),
            linear-gradient(180deg, var(--bg-soft), var(--bg));
        }

        .vm-hero {
          padding: 18px 22px 14px;
          border-bottom: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
          background: color-mix(in srgb, var(--panel) 86%, transparent);
          backdrop-filter: blur(16px);
          flex-shrink: 0;
        }

        .vm-title-block {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 16px;
          margin-bottom: 16px;
        }

        .vm-eyebrow {
          color: var(--accent);
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .vm-title-block h1 {
          font-size: 28px;
          line-height: 1.1;
          letter-spacing: -0.04em;
        }

        .vm-refresh,
        .vm-pagination button,
        .vm-text-btn {
          border: 1px solid var(--border);
          background: var(--panel);
          color: var(--text);
          border-radius: 999px;
          padding: 8px 12px;
          display: inline-flex;
          align-items: center;
          gap: 7px;
          cursor: pointer;
          transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
        }

        .vm-refresh:hover,
        .vm-pagination button:hover:not(:disabled),
        .vm-text-btn:hover:not(:disabled) {
          transform: translateY(-1px);
          border-color: color-mix(in srgb, var(--accent) 48%, var(--border));
        }

        .vm-kpis {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 12px;
        }

        .vm-kpi {
          position: relative;
          overflow: hidden;
          border: 1px solid var(--border);
          border-radius: 18px;
          background: linear-gradient(135deg, color-mix(in srgb, var(--panel) 92%, transparent), color-mix(in srgb, var(--panel-2) 86%, transparent));
          box-shadow: var(--shadow);
          padding: 14px 16px;
          animation: vmRise 0.42s ease both;
        }

        .vm-kpi::after {
          content: "";
          position: absolute;
          inset: auto 12px 0;
          height: 3px;
          border-radius: 999px 999px 0 0;
          background: var(--text-dim);
          opacity: 0.35;
        }

        .vm-kpi.accent::after { background: var(--accent); opacity: 0.85; }
        .vm-kpi.danger::after { background: var(--danger); opacity: 0.85; }
        .vm-kpi.muted::after { background: var(--text-dim); }

        .vm-kpi span,
        .vm-kpi small {
          color: var(--text-dim);
          font-size: 12px;
        }

        .vm-kpi strong {
          display: block;
          margin: 7px 0 3px;
          font-size: 30px;
          letter-spacing: -0.04em;
        }

        .vm-toolbar {
          display: flex;
          flex-shrink: 0;
          flex-direction: column;
          gap: 12px;
          padding: 12px 22px 0;
        }

        .vm-filter-bar {
          display: flex;
          flex-direction: row;
          align-items: center;
          justify-content: flex-start;
          gap: 10px;
          flex-wrap: wrap;
          width: 100%;
          margin: 0;
          padding: 14px;
          border: 1px solid var(--crm-border, var(--border));
          border-radius: 1.25rem;
          background: color-mix(in srgb, var(--crm-surface, var(--panel)) 96%, var(--crm-bg, var(--bg)));
          box-shadow: var(--crm-shadow, var(--shadow));
          flex-shrink: 0;
        }

        .vm-tabs {
          display: flex;
          flex: 0 0 auto;
          align-items: center;
          gap: 6px;
          padding: 5px;
          border: 1px solid var(--crm-border, var(--border));
          border-radius: 999px;
          background: color-mix(in srgb, var(--crm-surface-2, var(--panel-2)) 90%, transparent);
        }

        .vm-tabs button {
          border: 0;
          border-radius: 999px;
          background: transparent;
          color: var(--crm-text-muted, var(--text-dim));
          padding: 8px 13px;
          cursor: pointer;
          display: inline-flex;
          gap: 6px;
          align-items: center;
          transition: background 0.15s ease, color 0.15s ease;
        }

        .vm-tabs button.active {
          background: color-mix(in srgb, var(--accent) 18%, transparent);
          color: var(--crm-text, var(--text));
          box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 36%, transparent);
        }

        .vm-tabs span {
          min-width: 19px;
          height: 19px;
          padding: 0 6px;
          border-radius: 999px;
          display: inline-grid;
          place-items: center;
          color: #fff;
          background: var(--accent);
          font-size: 11px;
          font-weight: 700;
        }

        .vm-search,
        .vm-select-wrap,
        .vm-date-select {
          height: 42px;
          border: 1px solid var(--crm-border, var(--border));
          border-radius: 14px;
          background: var(--crm-surface, var(--panel));
          color: var(--crm-text, var(--text));
        }

        .vm-search {
          flex: 1 1 16rem;
          min-width: min(100%, 16rem);
        }

        .vm-select-wrap {
          flex: 0 0 150px;
          min-width: 150px;
        }

        .vm-filter-bar > .cs-wrap {
          flex: 0 0 140px;
          min-width: 140px;
        }

        .vm-search,
        .vm-select-wrap {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0 12px;
        }

        .vm-search input,
        .vm-select-wrap input,
        .vm-note {
          width: 100%;
          border: 0;
          outline: 0;
          background: transparent;
          color: var(--text);
          font: inherit;
        }

        .vm-search input::placeholder,
        .vm-select-wrap input::placeholder,
        .vm-note::placeholder {
          color: var(--text-dim);
        }

        .vm-date-select {
          padding: 0 12px;
          outline: 0;
        }

        .vm-workspace {
          min-height: 0;
          flex: 1;
          display: grid;
          grid-template-columns: minmax(0, 1fr) 390px;
          gap: 16px;
          padding: 16px 22px 20px;
          overflow: hidden;
        }

        .vm-feed {
          min-width: 0;
          min-height: 0;
          overflow-y: auto;
          padding-right: 2px;
        }

        .vm-group {
          display: flex;
          flex-direction: column;
          gap: 10px;
          margin-bottom: 16px;
        }

        .vm-group-head {
          position: sticky;
          top: 0;
          z-index: 3;
          width: fit-content;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          color: var(--text-dim);
          font-size: 12px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          padding: 6px 10px;
          border-radius: 999px;
          background: color-mix(in srgb, var(--bg) 86%, transparent);
          backdrop-filter: blur(8px);
        }

        .vm-row {
          border: 1px solid color-mix(in srgb, var(--border) 86%, transparent);
          border-radius: 20px;
          background: color-mix(in srgb, var(--panel) 92%, transparent);
          box-shadow: 0 14px 34px rgba(0, 0, 0, 0.12);
          cursor: pointer;
          transition: transform 0.16s ease, border-color 0.16s ease, background 0.16s ease;
        }

        .vm-row:hover {
          transform: translateY(-2px);
          border-color: color-mix(in srgb, var(--accent) 42%, var(--border));
        }

        .vm-row.selected {
          border-color: color-mix(in srgb, var(--accent) 62%, var(--border));
          box-shadow: 0 18px 42px color-mix(in srgb, var(--accent) 14%, transparent);
        }

        .vm-row.unread {
          background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 10%, var(--panel)), var(--panel));
        }

        .vm-row-main {
          display: grid;
          grid-template-columns: 48px minmax(160px, 230px) minmax(160px, 1fr) auto auto;
          align-items: center;
          gap: 14px;
          padding: 14px;
        }

        .vm-avatar {
          width: 46px;
          height: 46px;
          border-radius: 16px;
          display: grid;
          place-items: center;
          color: #fff;
          font-weight: 800;
          background: linear-gradient(135deg, var(--accent), var(--accent-2));
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
        }

        .vm-avatar.big {
          width: 58px;
          height: 58px;
          border-radius: 20px;
          font-size: 18px;
        }

        .vm-person,
        .vm-preview {
          min-width: 0;
        }

        .vm-name-line {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }

        .vm-name-line strong {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 15px;
        }

        .vm-row.unread .vm-name-line strong {
          font-weight: 800;
        }

        .vm-subline {
          display: flex;
          align-items: center;
          gap: 7px;
          margin-top: 5px;
          color: var(--text-dim);
          font-size: 12px;
          min-width: 0;
        }

        .vm-subline span {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .vm-type,
        .vm-status {
          display: inline-flex;
          align-items: center;
          border-radius: 999px;
          padding: 3px 8px;
          font-size: 11px;
          font-weight: 700;
          line-height: 1;
          border: 1px solid transparent;
          white-space: nowrap;
        }

        .vm-type-internal {
          color: var(--success);
          background: color-mix(in srgb, var(--success) 14%, transparent);
          border-color: color-mix(in srgb, var(--success) 30%, transparent);
        }

        .vm-type-external {
          color: var(--warning);
          background: color-mix(in srgb, var(--warning) 14%, transparent);
          border-color: color-mix(in srgb, var(--warning) 30%, transparent);
        }

        .vm-status-new {
          color: var(--accent);
          background: color-mix(in srgb, var(--accent) 14%, transparent);
          border-color: color-mix(in srgb, var(--accent) 30%, transparent);
        }

        .vm-status-urgent {
          color: var(--danger);
          background: color-mix(in srgb, var(--danger) 14%, transparent);
          border-color: color-mix(in srgb, var(--danger) 32%, transparent);
        }

        .vm-status-old,
        .vm-status-played {
          color: var(--text-dim);
          background: color-mix(in srgb, var(--text-dim) 12%, transparent);
          border-color: color-mix(in srgb, var(--text-dim) 22%, transparent);
        }

        .vm-preview p {
          color: var(--text-dim);
          font-size: 13px;
          line-height: 1.45;
          overflow: hidden;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }

        .vm-row-side {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 5px;
          color: var(--text-dim);
          font-size: 12px;
          white-space: nowrap;
        }

        .vm-duration {
          color: var(--text);
          font-weight: 700;
        }

        .vm-actions {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .vm-icon-btn {
          width: 34px;
          height: 34px;
          border: 1px solid var(--border);
          border-radius: 12px;
          background: color-mix(in srgb, var(--panel-2) 76%, transparent);
          color: var(--text);
          display: inline-grid;
          place-items: center;
          cursor: pointer;
          transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
        }

        .vm-icon-btn:hover:not(:disabled) {
          transform: translateY(-1px);
          border-color: color-mix(in srgb, var(--accent) 44%, var(--border));
          background: color-mix(in srgb, var(--accent) 12%, var(--panel));
        }

        .vm-icon-btn.danger,
        .vm-menu .danger,
        .vm-action-grid .danger {
          color: var(--danger);
        }

        .vm-icon-btn:disabled,
        .vm-pagination button:disabled,
        .vm-text-btn:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }

        .vm-menu-wrap {
          position: relative;
        }

        .vm-menu {
          position: absolute;
          right: 0;
          top: 40px;
          z-index: 12;
          min-width: 190px;
          padding: 6px;
          border: 1px solid var(--border);
          border-radius: 14px;
          background: var(--panel);
          box-shadow: var(--shadow);
        }

        .vm-menu button {
          width: 100%;
          border: 0;
          background: transparent;
          color: var(--text);
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 9px 10px;
          border-radius: 10px;
          cursor: pointer;
          text-align: left;
        }

        .vm-menu button:hover:not(:disabled) {
          background: var(--panel-2);
        }

        .vm-player {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          gap: 12px;
          align-items: center;
        }

        .vm-player-full {
          grid-template-columns: auto minmax(0, 1fr);
        }

        .vm-play {
          width: 46px;
          height: 46px;
          border: 0;
          border-radius: 50%;
          display: grid;
          place-items: center;
          color: #fff;
          background: linear-gradient(135deg, var(--accent), var(--accent-2));
          box-shadow: 0 12px 24px color-mix(in srgb, var(--accent) 24%, transparent);
          cursor: pointer;
        }

        .vm-player-compact .vm-play {
          width: 38px;
          height: 38px;
        }

        .vm-play.is-playing {
          background: linear-gradient(135deg, var(--danger), #ff8a6a);
        }

        .vm-spinner {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          border: 2px solid rgba(255, 255, 255, 0.4);
          border-top-color: #fff;
          animation: vmSpin 0.8s linear infinite;
        }

        .vm-wave-wrap {
          min-width: 0;
        }

        .vm-wave {
          position: relative;
          height: 54px;
          display: flex;
          align-items: center;
          gap: 3px;
          padding: 7px 0;
          cursor: pointer;
          overflow: hidden;
        }

        .vm-player-compact .vm-wave {
          height: 38px;
        }

        .vm-wave span {
          width: 100%;
          min-width: 3px;
          border-radius: 999px;
          background: color-mix(in srgb, var(--text-dim) 35%, transparent);
          transition: background 0.15s ease, transform 0.15s ease;
        }

        .vm-wave span.filled {
          background: linear-gradient(180deg, var(--accent), var(--accent-2));
        }

        .vm-wave-progress {
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          pointer-events: none;
        }

        .vm-player-meta,
        .vm-player-controls,
        .vm-speed-group,
        .vm-volume {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .vm-player-meta {
          justify-content: space-between;
          color: var(--text-dim);
          font-size: 12px;
        }

        .vm-player-error {
          color: var(--danger);
        }

        .vm-player-controls {
          grid-column: 2;
          justify-content: space-between;
          margin-top: 10px;
        }

        .vm-speed-group {
          padding: 4px;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: var(--panel);
        }

        .vm-speed-group button {
          border: 0;
          border-radius: 999px;
          padding: 5px 9px;
          background: transparent;
          color: var(--text-dim);
          cursor: pointer;
          font-size: 12px;
          font-weight: 700;
        }

        .vm-speed-group button.active {
          background: var(--accent);
          color: #fff;
        }

        .vm-volume {
          color: var(--text-dim);
        }

        .vm-volume input {
          accent-color: var(--accent);
          width: 96px;
        }

        .vm-detail,
        .vm-detail-placeholder {
          min-width: 0;
          min-height: 0;
          overflow-y: auto;
          border: 1px solid var(--border);
          border-radius: 24px;
          background: color-mix(in srgb, var(--panel) 92%, transparent);
          box-shadow: var(--shadow);
        }

        .vm-detail {
          padding: 16px;
        }

        .vm-detail-placeholder {
          display: grid;
          place-items: center;
          align-content: center;
          text-align: center;
          gap: 10px;
          color: var(--text-dim);
          padding: 24px;
        }

        .vm-detail-placeholder h2 {
          color: var(--text);
          font-size: 18px;
        }

        .vm-detail-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 12px;
        }

        .vm-detail-contact {
          display: flex;
          align-items: center;
          gap: 12px;
          min-width: 0;
        }

        .vm-detail-contact h2 {
          font-size: 20px;
          letter-spacing: -0.03em;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .vm-detail-contact p {
          margin-top: 4px;
          color: var(--text-dim);
          font-size: 12px;
        }

        .vm-detail-badges {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          margin-bottom: 14px;
        }

        .vm-detail-card {
          border: 1px solid color-mix(in srgb, var(--border) 84%, transparent);
          border-radius: 18px;
          background: color-mix(in srgb, var(--panel-2) 62%, transparent);
          padding: 14px;
          margin-bottom: 12px;
        }

        .premium-player {
          background:
            radial-gradient(circle at top right, color-mix(in srgb, var(--accent) 22%, transparent), transparent 42%),
            color-mix(in srgb, var(--panel-2) 70%, transparent);
        }

        .vm-detail-card h3,
        .vm-section-title h3 {
          font-size: 13px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text-dim);
          margin-bottom: 10px;
        }

        .vm-section-title {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
        }

        .vm-transcript {
          color: var(--text);
          font-size: 13px;
          line-height: 1.65;
          white-space: pre-wrap;
        }

        .vm-transcript span {
          color: var(--text-dim);
          font-style: italic;
        }

        .vm-detail-list {
          margin: 0;
          display: grid;
          gap: 9px;
        }

        .vm-detail-list div {
          display: flex;
          justify-content: space-between;
          gap: 14px;
        }

        .vm-detail-list dt {
          color: var(--text-dim);
          font-size: 12px;
        }

        .vm-detail-list dd {
          margin: 0;
          font-size: 12px;
          font-weight: 700;
          text-align: right;
          overflow-wrap: anywhere;
        }

        .vm-action-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
        }

        .vm-action-grid button {
          border: 1px solid var(--border);
          border-radius: 13px;
          background: var(--panel);
          color: var(--text);
          padding: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          cursor: pointer;
        }

        .vm-action-grid button:hover:not(:disabled) {
          border-color: color-mix(in srgb, var(--accent) 42%, var(--border));
        }

        .vm-note {
          min-height: 92px;
          resize: vertical;
          border: 1px solid var(--border);
          border-radius: 14px;
          padding: 11px 12px;
          background: var(--panel);
        }

        .vm-empty {
          border: 1px solid var(--border);
          border-radius: 22px;
          background: var(--panel);
          padding: 28px;
        }

        .vm-pagination {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          color: var(--text-dim);
          font-size: 13px;
          padding: 8px 0 18px;
        }

        @keyframes vmRise {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }

        @keyframes vmSpin {
          to { transform: rotate(360deg); }
        }

        @media (max-width: 900px) {
          .vm-workspace {
            grid-template-columns: minmax(0, 1fr);
          }

          .vm-detail,
          .vm-detail-placeholder {
            position: fixed;
            inset: 88px 18px 18px auto;
            width: min(430px, calc(100vw - 36px));
            z-index: 30;
          }

          .vm-detail-placeholder {
            display: none;
          }
        }

        @media (max-width: 900px) {
          .vm-shell {
            height: 100%;
            min-height: 0;
            overflow: hidden;
          }

          .vm-kpis {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }

          .vm-filter-bar {
            grid-template-columns: 1fr;
          }

          .vm-tabs {
            overflow-x: auto;
          }

          .vm-workspace {
            overflow: hidden;
            padding: 14px;
          }

          .vm-feed {
            overflow-y: auto;
          }

          .vm-row-main {
            grid-template-columns: 46px minmax(0, 1fr) auto;
          }

          .vm-preview,
          .vm-row-side {
            grid-column: 2 / -1;
          }

          .vm-actions {
            grid-column: 1 / -1;
            justify-content: flex-end;
          }

        }

        @media (max-width: 640px) {
          .vm-hero {
            padding: 16px 14px 12px;
          }

          .vm-title-block {
            align-items: flex-start;
          }

          .vm-title-block h1 {
            font-size: 24px;
          }

          .vm-kpis {
            grid-template-columns: 1fr;
          }

          .vm-filter-bar {
            padding: 10px 14px;
          }

          .vm-tabs button {
            padding: 8px 11px;
          }

          .vm-detail {
            inset: 54px 0 0 0;
            width: 100vw;
            border-radius: 0;
            border-left: 0;
            border-right: 0;
            border-bottom: 0;
          }

          .vm-player-controls {
            grid-column: 1 / -1;
          }

          .vm-action-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
}
