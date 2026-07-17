"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  Bell,
  Grid3x3,
  Volume2,
  ChevronLeft,
  Clock3,
  Delete,
  Headphones,
  Maximize2,
  MessageSquare,
  Mic,
  MicOff,
  Pause,
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  Play,
  Pin,
  PinOff,
  Plus,
  Search,
  Send,
  Settings,
  MoreHorizontal,
  StickyNote,
  BellRing,
  User,
  Users,
  Voicemail,
} from "lucide-react";
import { useAppContext } from "../hooks/useAppContext";
import { useSipPhone } from "../hooks/useSipPhone";
import { useTelephonySocket } from "../hooks/useTelephonySocket";
import { apiGet, apiPatch, apiPost, getPortalApiBaseUrl } from "../services/apiClient";
import { loadContacts, loadSmsThreads, type ContactRow, type SmsThread } from "../services/platformData";
import { MiniChat } from "./chat/MiniChat";
import { MiniTeam } from "./MiniTeam";
import { readAuthToken } from "../services/session";
import {
  getWebRingerOutputDeviceId,
  setWebRingerOutputDeviceId,
  getWebRingerVolume,
  setWebRingerVolume,
} from "../hooks/telephonyAudioPreferences";

type TabKey = "dialer" | "calls" | "messages" | "voicemail" | "team";

type MiniCallRow = {
  callId?: string;
  rowId?: string;
  fromNumber?: string;
  fromName?: string | null;
  toNumber?: string;
  direction?: string;
  status?: string;
  durationSec?: number;
  startedAt?: string;
};

type MiniVoicemail = {
  id: string;
  callerId: string;
  callerName?: string | null;
  receivedAt: string;
  durationSec: number;
  listened: boolean;
  transcription?: string | null;
  streamUrl?: string;
  note?: string | null;
  noteUpdatedByName?: string | null;
  callbackReminderAt?: string | null;
  callbackReminderLabel?: string | null;
  callbackReminderMine?: boolean;
  callbackReminderSetByName?: string | null;
};

type DueReminder = {
  id: string;
  callerId: string;
  callerName?: string | null;
  callbackReminderAt?: string | null;
  callbackReminderLabel?: string | null;
  note?: string | null;
};

function formatPhoneDisplay(n?: string | null): string {
  const d = (n || "").replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === "1") return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return n || "";
}

function toLocalInput(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function reminderWhen(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(d) - startOf(today)) / 86400000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

type DialSuggestion = {
  id: string;
  label: string;
  number: string;
  meta: string;
};

type MiniDesktopSettings = {
  alwaysOnTop?: boolean;
  startOnLogin?: boolean;
  openMinimizedToTray?: boolean;
  openMiniOnStartup?: boolean;
  minimizeToTray?: boolean;
  selectedMicDeviceId?: string;
  selectedSpeakerDeviceId?: string;
};

const KEYS: Array<[string, string]> = [
  ["1", ""], ["2", "ABC"], ["3", "DEF"],
  ["4", "GHI"], ["5", "JKL"], ["6", "MNO"],
  ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"],
  ["*", ""], ["0", "+"], ["#", ""],
];

function formatDuration(sec = 0): string {
  const safe = Math.max(0, Math.floor(sec));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function shortTime(value?: string): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return value;
  }
}

// Just the clock time (e.g. "2:34 PM") — matches the mobile Recents/Voicemail rows.
function timeOfDay(value?: string): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function initials(value: string | null | undefined): string {
  const source = (value || "Connect").trim();
  return source
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "C";
}

// Mobile-matching avatar: the same 8-colour palette + name hash as the mobile
// app's Avatar, and a slate "person" glyph for unsaved numbers (a raw phone
// number / no letters), so Recents and Voicemail look identical to mobile.
const AVATAR_COLORS = ["#3b82f6", "#06b6d4", "#8b5cf6", "#f43f5e", "#10b981", "#f59e0b", "#ec4899", "#6366f1"];
function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}
function isUnsavedNumber(name: string | null | undefined): boolean {
  const s = (name || "").trim();
  if (!s) return true;
  return !/[a-zA-Z]/.test(s);
}
function MiniAvatar({ name, size = 44 }: { name: string | null | undefined; size?: number }) {
  const label = (name || "").trim();
  const unsaved = isUnsavedNumber(label);
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    color: "#fff",
    fontSize: Math.round(size * 0.36),
    fontWeight: 700,
    letterSpacing: 0.5,
    background: unsaved ? "#64748b" : avatarColor(label),
  };
  return (
    <span className="mini-avatar" style={style}>
      {unsaved ? <User size={Math.round(size * 0.52)} /> : initials(label)}
    </span>
  );
}

function callStatusLabel(callState: string): string {
  if (callState === "ringing") return "Ringing";
  if (callState === "connected") return "Connected";
  if (callState === "dialing") return "Dialing";
  if (callState === "ended") return "Ended";
  return "Idle";
}

function digitsOnly(value: string | null | undefined): string {
  return String(value || "").replace(/\D/g, "");
}

function voicemailStreamUrl(id: string): string {
  const token = readAuthToken();
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${getPortalApiBaseUrl()}/voice/voicemail/${encodeURIComponent(id)}/stream${tokenQuery}`;
}

// Locally-authoritative voicemail read/unread overrides, persisted so a voicemail
// that was played (or explicitly toggled) NEVER reverts to NEW because a later
// server refetch returned a stale copy — it only flips back on an explicit
// "mark unread". Mirrors the mobile app's read-override behaviour.
const VM_READ_KEY = "cc-mini-vm-read";
const VM_UNREAD_KEY = "cc-mini-vm-unread";
const MISSED_DISMISS_KEY = "cc-mini-missed-dismissed";
function loadIdSet(key: string): Set<string> {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(key) : null;
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? (arr as string[]) : []);
  } catch {
    return new Set();
  }
}
function saveIdSet(key: string, set: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
}
function applyVmReadOverrides(list: MiniVoicemail[]): MiniVoicemail[] {
  const read = loadIdSet(VM_READ_KEY);
  const unread = loadIdSet(VM_UNREAD_KEY);
  if (read.size === 0 && unread.size === 0) return list;
  return list.map((vm) => {
    if (read.has(vm.id) && !vm.listened) return { ...vm, listened: true };
    if (unread.has(vm.id) && vm.listened) return { ...vm, listened: false };
    return vm;
  });
}

// Elapsed seconds since the call connected. Driven by an absolute timestamp
// (broadcast from the full window) rather than a local "started counting now",
// so the mini pop-out proxy shows the real elapsed time even if it's opened
// mid-call. Returns 0 while startedAt is null (not connected).
function useCallTimer(startedAt: number | null): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!startedAt) {
      setSeconds(0);
      return;
    }
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return seconds;
}

function vmWaveBars(src: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < src.length; i += 1) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const bars: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    h >>>= 0;
    bars.push(0.25 + ((h % 1000) / 1000) * 0.75);
  }
  return bars;
}

function VoicemailPlayer({ src, durationSec, onPlay }: { src: string; durationSec: number; onPlay?: () => void }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(durationSec || 0);
  const [error, setError] = useState(false);

  useEffect(() => {
    const audio = new Audio(src);
    audio.preload = "none";
    audioRef.current = audio;

    const updateTime = () => setCurrent(audio.currentTime || 0);
    const updateDuration = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
    };
    const markEnded = () => {
      setPlaying(false);
      setCurrent(0);
      audio.currentTime = 0;
    };
    const markError = () => {
      setPlaying(false);
      setError(true);
    };

    audio.addEventListener("timeupdate", updateTime);
    audio.addEventListener("loadedmetadata", updateDuration);
    audio.addEventListener("durationchange", updateDuration);
    audio.addEventListener("ended", markEnded);
    audio.addEventListener("error", markError);

    return () => {
      audio.pause();
      audio.removeEventListener("timeupdate", updateTime);
      audio.removeEventListener("loadedmetadata", updateDuration);
      audio.removeEventListener("durationchange", updateDuration);
      audio.removeEventListener("ended", markEnded);
      audio.removeEventListener("error", markError);
      audioRef.current = null;
    };
  }, [src]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    setError(false);
    if (playing) {
      audio.pause();
      setPlaying(false);
      return;
    }
    setError(false);
    audio.play()
      .then(() => {
        setPlaying(true);
        onPlay?.();
      })
      .catch(() => {
        setPlaying(false);
        setError(true);
      });
  };

  const seek = (value: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = value;
    setCurrent(value);
  };

  const max = Math.max(duration, durationSec, 1);
  const bars = vmWaveBars(src);
  const pct = Math.max(0, Math.min(1, current / max));

  return (
    <div className="vm-player" data-error={error ? "true" : "false"}>
      <button type="button" className="vm-play" data-active={playing ? "true" : "false"} onClick={toggle} aria-label={playing ? "Pause voicemail" : "Play voicemail"}>
        {error ? <AlertCircle size={16} /> : playing ? <Pause size={17} /> : <Play size={17} />}
      </button>
      <div
        className="vm-wave"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (rect.width <= 0) return;
          seek(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * max);
        }}
      >
        {bars.map((h, i) => (
          <span key={i} className={i / bars.length < pct ? "on" : ""} style={{ height: String(Math.round(6 + h * 22)) + "px" }} />
        ))}
      </div>
      <style jsx>{`
        .vm-player { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
        .vm-player[data-error="true"] { opacity: .5; }
        .vm-play { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 50%; border: 0; background: rgba(59,130,246,0.14); color: #3b82f6; cursor: pointer; flex-shrink: 0; padding: 0; box-sizing: border-box; }
        .vm-play[data-active="true"] { background: #3b82f6; color: #fff; }
        .vm-wave { display: flex; align-items: center; gap: 2px; flex: 1; height: 30px; cursor: pointer; }
        .vm-wave span { flex: 1; border-radius: 2px; background: rgba(148,163,184,0.34); }
        .vm-wave span.on { background: #3b82f6; }
      `}</style>
    </div>
  );
}

export function DesktopMiniDialer() {
  const phone = useSipPhone();
  const { user, tenant, adminScope } = useAppContext();
  // The pop-out is a separate BrowserWindow that can't reliably read the portal's
  // theme directly, so the desktop main process pushes it: the initial value arrives
  // as a ?miniTheme= query param (no flash on open), and live changes arrive over the
  // connectDesktop.window.onMiniTheme channel. Falls back to dark (the base palette).
  const [miniTheme, setMiniTheme] = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") return "dark";
    return new URLSearchParams(window.location.search).get("miniTheme") === "light" ? "light" : "dark";
  });
  useEffect(() => {
    const off = window.connectDesktop?.window?.onMiniTheme?.((t) => {
      setMiniTheme(t === "light" ? "light" : "dark");
    });
    return () => { off?.(); };
  }, []);
  // Drive the document theme from the pushed value so reused/global-styled controls
  // (chat, form inputs) match the mini's light/dark palette.
  useEffect(() => {
    const el = document.documentElement;
    const prev = el.getAttribute("data-theme");
    el.setAttribute("data-theme", miniTheme);
    return () => { if (prev) el.setAttribute("data-theme", prev); else el.removeAttribute("data-theme"); };
  }, [miniTheme]);
  const [tab, setTab] = useState<TabKey>("dialer");
  const [calls, setCalls] = useState<MiniCallRow[]>([]);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [threads, setThreads] = useState<SmsThread[]>([]);
  const [voicemails, setVoicemails] = useState<MiniVoicemail[]>([]);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifTick, setNotifTick] = useState(0);
  const [newChats, setNewChats] = useState<{ id: string; name: string; preview: string; route: string }[]>([]);
  const [vmQuery, setVmQuery] = useState("");
  const [vmFilter, setVmFilter] = useState<"all" | "new" | "urgent" | "old">("all");
  const [vmMenuId, setVmMenuId] = useState<string | null>(null);
  const [vmNoteEditId, setVmNoteEditId] = useState<string | null>(null);
  const [vmNoteDraft, setVmNoteDraft] = useState("");
  const [vmRemEditId, setVmRemEditId] = useState<string | null>(null);
  const [vmRemDraft, setVmRemDraft] = useState<{ at: string; label: string }>({ at: "", label: "" });
  const [dueReminders, setDueReminders] = useState<DueReminder[]>([]);
  const [settings, setSettings] = useState<MiniDesktopSettings>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quickReply, setQuickReply] = useState("");
  const [lastDialed, setLastDialed] = useState("");
  const inCall = phone.callState === "ringing" || phone.callState === "dialing" || phone.callState === "connected";
  // Enrich the incoming caller from the live-call feed: the SIP INVITE From can
  // arrive empty for WebRTC/mini calls, but the telephony socket carries the real
  // caller number/name, matched by the ringing extension.
  const { calls: liveCalls } = useTelephonySocket();
  const incomingLiveCall = useMemo(() => {
    if (phone.callDirection !== "inbound") return null;
    const ext = phone.diag?.extensionNumber?.trim();
    if (!ext) return null;
    for (const call of liveCalls.values()) {
      const involved = [call.from, call.to, call.connectedLine, call.source_extension, call.destination_extension, ...(call.extensions || [])].some((v) => v?.trim() === ext);
      const active = call.state === "ringing" || call.state === "dialing" || call.state === "up" || call.state === "held";
      if (involved && active) return call;
    }
    return null;
  }, [liveCalls, phone.callDirection, phone.diag?.extensionNumber]);
  // Structured incoming caller: ring-group prefix, caller name, and the number
  // (always shown). Prefer the live-call feed's separated fields; fall back to the
  // SIP display name (which may embed the ring-group prefix with no separator).
  const incomingCaller = useMemo(() => {
    const lc = incomingLiveCall;
    const rawDisplay = (phone.remoteParty || "").trim() || null;
    const number = phone.remotePartyNumber?.trim() || lc?.from?.trim() || null;
    // Prefer the full-window enrichment broadcast over IPC (phone.remotePartyName/Prefix);
    // fall back to the mini's own live-call feed, then to local SIP-display derivation.
    const cleanName = phone.remotePartyName?.trim() || lc?.fromName?.trim() || null;
    let prefix: string | null = phone.remotePartyPrefix?.trim() || lc?.fromPrefix?.trim() || null;
    let name: string | null = cleanName || rawDisplay;
    // (a) colon-delimited "Prefix:Caller" — the standard VitalPBX ring-group format.
    if (!prefix && rawDisplay) {
      const c = rawDisplay.indexOf(":");
      if (c > 0 && !/^\+?\d{5,}$/.test(rawDisplay.slice(0, c).trim())) {
        prefix = rawDisplay.slice(0, c).trim();
        name = rawDisplay.slice(c + 1).replace(/:\s*$/, "").trim() || cleanName || null;
      }
    }
    // (b) no separator: strip the clean caller name off the display to get the prefix.
    if (!prefix && cleanName && rawDisplay && rawDisplay.length > cleanName.length && rawDisplay.toLowerCase().endsWith(cleanName.toLowerCase())) {
      prefix = rawDisplay.slice(0, rawDisplay.length - cleanName.length).trim() || null;
      name = cleanName;
    }
    if (name && number && name.replace(/\D/g, "") === number.replace(/\D/g, "")) name = null;
    if (name && prefix && name.trim().toLowerCase() === prefix.trim().toLowerCase()) name = null;
    return { prefix: prefix || null, name: name || null, number };
  }, [incomingLiveCall, phone.remoteParty, phone.remotePartyNumber, phone.remotePartyName, phone.remotePartyPrefix]);
  const timerSec = useCallTimer(phone.callState === "connected" ? phone.callStartedAt : null);
  // In-call sub-views for the active-call screen: the 6-control grid ("controls"),
  // a live DTMF keypad ("keypad"), or a number-entry pad for Transfer / Add call
  // ("entry"). Previously Keypad/Add-call switched tabs (hidden under the call
  // overlay) and Transfer used window.prompt() (blocked in Electron) — all no-ops.
  const [callView, setCallView] = useState<"controls" | "keypad" | "entry">("controls");
  const [callEntry, setCallEntry] = useState("");
  const [entryMode, setEntryMode] = useState<"transfer" | "add">("transfer");
  const [dtmfLog, setDtmfLog] = useState("");
  // Reset the in-call sub-view whenever a call ends so the next call starts on the grid.
  useEffect(() => {
    if (!inCall) { setCallView("controls"); setCallEntry(""); setDtmfLog(""); }
  }, [inCall]);
  const runCallEntry = () => {
    const v = callEntry.trim();
    if (!v) return;
    if (entryMode === "transfer") phone.transfer(v);
    else phone.dial(v); // Add call — the full-window phone holds the current call and dials.
    setCallEntry("");
    setCallView("controls");
  };

  const registration = useMemo(() => {
    if (phone.regState === "registered") return { label: "Registered", tone: "green" };
    if (phone.regState === "connecting" || phone.regState === "registering") return { label: "Connecting", tone: "yellow" };
    return { label: "Not registered", tone: "red" };
  }, [phone.regState]);

  const routeOptions = useMemo(
    () => [{ id: "", name: "No route prefix" }, ...phone.outboundRoutes.map((route) => ({ id: route.id, name: route.name || route.label || "Outbound route" }))],
    [phone.outboundRoutes],
  );

  const dialQuery = digitsOnly(phone.dialpadInput);

  const dialSuggestions = useMemo<DialSuggestion[]>(() => {
    if (dialQuery.length < 2) return [];
    const suggestions = new Map<string, DialSuggestion>();
    const addSuggestion = (suggestion: DialSuggestion) => {
      const numberDigits = digitsOnly(suggestion.number);
      if (!numberDigits.includes(dialQuery)) return;
      if (!suggestions.has(numberDigits)) suggestions.set(numberDigits, suggestion);
    };

    for (const contact of contacts) {
      if (!contact.number || contact.number === "-") continue;
      addSuggestion({
        id: `contact-${contact.id}`,
        label: contact.name || contact.company || contact.number,
        number: contact.number,
        meta: contact.company && contact.company !== "-" ? contact.company : "Contact",
      });
    }

    for (const call of calls) {
      const target = call.direction === "outgoing" ? call.toNumber : call.fromNumber;
      if (!target) continue;
      addSuggestion({
        id: `call-${call.rowId || call.callId || target}-${call.startedAt || ""}`,
        label: call.fromName || target,
        number: target,
        meta: shortTime(call.startedAt) || "Recent call",
      });
    }

    return Array.from(suggestions.values()).slice(0, 3);
  }, [calls, contacts, dialQuery]);

  const refreshLists = useCallback(() => {
    apiGet<{ items?: MiniCallRow[] }>("/calls/history?page=1&pageSize=20")
      .then((result) => setCalls(Array.isArray(result.items) ? result.items : []))
      .catch(() => setCalls([]));
    loadSmsThreads(adminScope)
      .then((result) => setThreads(result.threads.slice(0, 20)))
      .catch(() => setThreads([]));
    apiGet<{ voicemails?: MiniVoicemail[] }>("/voice/voicemail?folder=inbox&page=1&pageSize=20")
      .then((result) => setVoicemails(applyVmReadOverrides(Array.isArray(result.voicemails) ? result.voicemails : [])))
      .catch(() => setVoicemails([]));
    apiGet<{ threads?: Array<{ id: string; isNew?: boolean; participantName?: string; lastMessage?: string; type?: string; externalSmsE164?: string | null }> }>("/chat/threads")
      .then((result) => setNewChats((result.threads || [])
        .filter((t) => t.isNew)
        .map((t) => ({
          id: t.id,
          name: t.participantName || "Chat",
          preview: t.lastMessage || "",
          route: t.type === "SMS" && t.externalSmsE164 ? `/sms?phone=${encodeURIComponent(t.externalSmsE164)}` : "/chat",
        }))))
      .catch(() => setNewChats([]));
  }, [adminScope]);

  const notifItems = useMemo(() => {
    const chats = newChats.map((c) => ({ kind: "chat" as const, id: c.id, title: c.name, sub: c.preview || "New message", route: c.route }));
    const vms = (voicemails || [])
      .filter((v) => !v.listened)
      .map((v) => ({ kind: "voicemail" as const, id: v.id, title: v.callerName || v.callerId || "Voicemail", sub: "New voicemail", route: "/voicemail" }));
    const dismissedMissed = loadIdSet(MISSED_DISMISS_KEY);
    const missed = (calls || [])
      .filter((c) => (c.direction || "").toLowerCase().startsWith("in") && /miss|no.?answer|unanswer|fail/i.test(c.status || ""))
      .map((c) => ({ kind: "missed" as const, id: c.callId || c.rowId || `${c.fromNumber || "x"}-${c.startedAt || ""}`, title: c.fromName || c.fromNumber || "Missed call", sub: "Missed call", route: "/calls" }))
      .filter((n) => !dismissedMissed.has(String(n.id)));
    return { chats, vms, missed, total: chats.length + vms.length + missed.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newChats, voicemails, calls, notifTick]);

  const markAllNotifsRead = useCallback(async () => {
    const ids = newChats.map((c) => c.id);
    const vmIds = (voicemails || []).filter((v) => !v.listened).map((v) => v.id);
    if (vmIds.length > 0) {
      const read = loadIdSet(VM_READ_KEY);
      const unread = loadIdSet(VM_UNREAD_KEY);
      for (const id of vmIds) { read.add(id); unread.delete(id); }
      saveIdSet(VM_READ_KEY, read);
      saveIdSet(VM_UNREAD_KEY, unread);
      setVoicemails((prev) => prev.map((v) => (v.listened ? v : { ...v, listened: true })));
    }
    if (notifItems.missed.length > 0) {
      const dismissed = loadIdSet(MISSED_DISMISS_KEY);
      for (const n of notifItems.missed) dismissed.add(String(n.id));
      saveIdSet(MISSED_DISMISS_KEY, dismissed);
      setNotifTick((t) => t + 1);
    }
    await Promise.all(ids.map((id) => apiPost(`/chat/threads/${id}/read`, {}).catch(() => undefined)));
    const vmResults = await Promise.all(vmIds.map((id) =>
      apiPatch<{ ok?: boolean; skipped?: string }>(`/voice/voicemail/${encodeURIComponent(id)}`, { listened: true })
        .then((r) => (r?.skipped ? id : null))
        .catch(() => null),
    ));
    const vmSkipped = vmResults.filter(Boolean) as string[];
    if (vmSkipped.length > 0) {
      const r2 = loadIdSet(VM_READ_KEY); const u2 = loadIdSet(VM_UNREAD_KEY);
      for (const id of vmSkipped) { r2.delete(id); u2.delete(id); }
      saveIdSet(VM_READ_KEY, r2); saveIdSet(VM_UNREAD_KEY, u2);
      const set = new Set(vmSkipped);
      setVoicemails((prev) => prev.map((v) => (set.has(v.id) ? { ...v, listened: false } : v)));
    }
    setNewChats([]);
    setNotifOpen(false);
    refreshLists();
  }, [newChats, voicemails, notifItems, refreshLists]);

  useEffect(() => {
    if (dialQuery.length < 2) {
      setContacts([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      loadContacts(dialQuery, adminScope)
        .then((result) => {
          if (active) setContacts(result.rows.slice(0, 8));
        })
        .catch(() => {
          if (active) setContacts([]);
        });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [adminScope, dialQuery]);

  useEffect(() => {
    refreshLists();
    const timer = setInterval(refreshLists, 30_000);
    return () => clearInterval(timer);
  }, [refreshLists]);

  useEffect(() => {
    window.connectDesktop?.window?.getSettings?.().then((value) => setSettings(value)).catch(() => undefined);
    return window.connectDesktop?.window?.onSettings?.((value) => setSettings(value));
  }, []);

  const updateDesktopSettings = useCallback((patch: Partial<MiniDesktopSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    void window.connectDesktop?.window?.updateSettings?.(patch).then((value) => setSettings(value)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (settingsOpen) void phone.refreshAudioDevices();
  }, [phone.refreshAudioDevices, settingsOpen]);

  const updateMicDevice = useCallback((deviceId: string) => {
    void phone.setAudioInputDeviceId(deviceId).catch(() => undefined);
    updateDesktopSettings({ selectedMicDeviceId: deviceId });
  }, [phone.setAudioInputDeviceId, updateDesktopSettings]);

  const updateSpeakerDevice = useCallback((deviceId: string) => {
    void phone.setAudioSinkId(deviceId);
    updateDesktopSettings({ selectedSpeakerDeviceId: deviceId });
  }, [phone.setAudioSinkId, updateDesktopSettings]);

  const [ringerDeviceId, setRingerDeviceId] = useState<string>(() => getWebRingerOutputDeviceId());
  const [ringerVolume, setRingerVolume] = useState<number>(() => getWebRingerVolume());
  const updateRingerDevice = useCallback((deviceId: string) => {
    setRingerDeviceId(deviceId);
    setWebRingerOutputDeviceId(deviceId);
  }, []);
  const updateRingerVolume = useCallback((value: number) => {
    setRingerVolume(value);
    setWebRingerVolume(value);
  }, []);

  // Do NOT switch tabs when a call starts. The active-call screen is a full overlay,
  // so the underlying tab (Recents / Chat / Voicemail / Team) — and its scroll
  // position — stays mounted beneath it. Leaving the tab alone means that when the
  // call ends you land back exactly where you dialed from (e.g. the same voicemail),
  // with no scrolling required.

  const appendDigit = (digit: string) => {
    phone.setDialpadInput((prev) => `${prev}${digit}`);
    phone.playDtmfTone(digit);
  };

  const callTarget = (target: string) => {
    const value = target.trim();
    if (value && phone.regState === "registered") { phone.dial(value); setLastDialed(value); }
  };

  // Mark a voicemail read/unread: persist a local override (so a later refetch can
  // never revert it), update the on-screen list, and tell the server. Playing a
  // voicemail calls this with listened=true; it only flips back on an explicit
  // "mark unread".
  const markVmListened = useCallback((id: string, listened: boolean) => {
    const read = loadIdSet(VM_READ_KEY);
    const unread = loadIdSet(VM_UNREAD_KEY);
    if (listened) { read.add(id); unread.delete(id); } else { unread.add(id); read.delete(id); }
    saveIdSet(VM_READ_KEY, read);
    saveIdSet(VM_UNREAD_KEY, unread);
    setVoicemails((prev) => prev.map((v) => (v.id === id ? { ...v, listened } : v)));
    apiPatch<{ ok?: boolean; skipped?: string }>(`/voice/voicemail/${encodeURIComponent(id)}`, { listened })
      .then((r) => {
        if (r?.skipped) {
          // Tenant-wide viewer: server kept the shared state — undo the local override.
          const r2 = loadIdSet(VM_READ_KEY); const u2 = loadIdSet(VM_UNREAD_KEY);
          r2.delete(id); u2.delete(id);
          saveIdSet(VM_READ_KEY, r2); saveIdSet(VM_UNREAD_KEY, u2);
          setVoicemails((prev) => prev.map((v) => (v.id === id ? { ...v, listened: !listened } : v)));
        }
      })
      .catch(() => undefined);
  }, []);

  // Mark every unlistened voicemail read in one shot: persist local overrides,
  // flip the on-screen list, and PATCH each one server-side (best-effort).
  const markAllVmsRead = useCallback(() => {
    const vmIds = (voicemails || []).filter((v) => !v.listened).map((v) => v.id);
    if (vmIds.length === 0) return;
    const read = loadIdSet(VM_READ_KEY);
    const unread = loadIdSet(VM_UNREAD_KEY);
    for (const id of vmIds) { read.add(id); unread.delete(id); }
    saveIdSet(VM_READ_KEY, read);
    saveIdSet(VM_UNREAD_KEY, unread);
    setVoicemails((prev) => prev.map((v) => (v.listened ? v : { ...v, listened: true })));
    void Promise.all(vmIds.map((id) =>
      apiPatch<{ ok?: boolean; skipped?: string }>(`/voice/voicemail/${encodeURIComponent(id)}`, { listened: true })
        .then((r) => (r?.skipped ? id : null))
        .catch(() => null),
    )).then((results) => {
      const skippedIds = results.filter(Boolean) as string[];
      if (skippedIds.length === 0) return;
      const r2 = loadIdSet(VM_READ_KEY); const u2 = loadIdSet(VM_UNREAD_KEY);
      for (const id of skippedIds) { r2.delete(id); u2.delete(id); }
      saveIdSet(VM_READ_KEY, r2); saveIdSet(VM_UNREAD_KEY, u2);
      const set = new Set(skippedIds);
      setVoicemails((prev) => prev.map((v) => (set.has(v.id) ? { ...v, listened: false } : v)));
    });
  }, [voicemails]);

  const patchVm = useCallback((id: string, body: Record<string, unknown>, patch: Partial<MiniVoicemail>) => {
    setVoicemails((prev) => prev.map((v) => (v.id === id ? { ...v, ...patch } : v)));
    apiPatch(`/voice/voicemail/${encodeURIComponent(id)}`, body).catch(() => undefined);
  }, []);

  useEffect(() => {
    let alive = true;
    const check = () => {
      apiGet<{ reminders?: DueReminder[] }>("/voice/voicemail/callback-reminders/due")
        .then((r) => { if (alive) setDueReminders(Array.isArray(r.reminders) ? r.reminders : []); })
        .catch(() => undefined);
    };
    check();
    const t = setInterval(check, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const dismissReminder = useCallback((id: string) => {
    setDueReminders((prev) => prev.filter((r) => r.id !== id));
    apiPatch(`/voice/voicemail/${encodeURIComponent(id)}`, { ackCallbackReminder: true }).catch(() => undefined);
  }, []);

  const selectedSession = phone.sessions.find((session) => session.isActive) || phone.sessions[0] || null;
  const incomingWaiting = phone.sessions.filter((session) => session.state === "ringing" && !session.isActive);

  return (
    <main className={"mini-shell" + (miniTheme === "light" ? " mini-light" : "")}>
      {dueReminders.length > 0 ? (
        <div className="vm-alert-overlay">
          <div className="vm-alert">
            <div className="vm-alert-icon"><BellRing size={26} /></div>
            <div className="vm-alert-title">Callback reminder</div>
            <div className="vm-alert-name">{dueReminders[0].callerName || dueReminders[0].callerId || "Unknown"}</div>
            {dueReminders[0].callbackReminderLabel ? <div className="vm-alert-label">{dueReminders[0].callbackReminderLabel}</div> : null}
            {dueReminders[0].note ? <div className="vm-alert-note"><StickyNote size={12} /> {dueReminders[0].note}</div> : null}
            <div className="vm-alert-btns">
              <button className="vm-btn ghost" onClick={() => dismissReminder(dueReminders[0].id)}>Dismiss</button>
              <button className="vm-btn primary" onClick={() => { const r = dueReminders[0]; dismissReminder(r.id); callTarget(r.callerId); }}><Phone size={15} /> Call back</button>
            </div>
            {dueReminders.length > 1 ? <div className="vm-alert-more">+{dueReminders.length - 1} more reminder{dueReminders.length - 1 > 1 ? "s" : ""}</div> : null}
          </div>
        </div>
      ) : null}
      <div className="mini-titlebar">
        <div className="mini-identity">
          <div className="mini-identity-avatar">{initials(user?.name || tenant?.name || "Connect")}</div>
          <div className="mini-identity-text">
            <strong>{user?.name || tenant?.name || "Connect"}</strong>
            <span className={`mini-identity-status ${registration.tone}`}>{registration.label}</span>
          </div>
        </div>
        <div className="mini-drag" />
        <div className="mini-winbtns">
          <div className="notif-wrap">
            <button type="button" title="Notifications" aria-label="Notifications" aria-expanded={notifOpen} onClick={() => setNotifOpen((v) => !v)}>
              <Bell size={15} />
              {notifItems.total > 0 && <span className="notif-dot">{notifItems.total > 9 ? "9+" : notifItems.total}</span>}
            </button>
            {notifOpen && (
              <div className="notif-popover">
                <div className="notif-head">
                  <strong>Notifications</strong>
                  {notifItems.total > 0 && <button type="button" className="notif-clear" onClick={markAllNotifsRead}>Mark all read</button>}
                </div>
                <div className="notif-body">
                  {notifItems.total === 0 && <p className="notif-empty">You&apos;re all caught up.</p>}
                  {notifItems.chats.map((n) => (
                    <button type="button" key={`c-${n.id}`} className="notif-row" onClick={() => { window.connectDesktop?.window?.expandToFull?.(n.route); setNotifOpen(false); }}>
                      <span className="notif-ic chat"><MessageSquare size={14} /></span>
                      <span className="notif-text"><strong>{n.title}</strong><small>{n.sub}</small></span>
                    </button>
                  ))}
                  {notifItems.vms.map((n) => (
                    <button type="button" key={`v-${n.id}`} className="notif-row" onClick={() => { window.connectDesktop?.window?.expandToFull?.(n.route); setNotifOpen(false); }}>
                      <span className="notif-ic vm"><Voicemail size={14} /></span>
                      <span className="notif-text"><strong>{n.title}</strong><small>{n.sub}</small></span>
                    </button>
                  ))}
                  {notifItems.missed.map((n) => (
                    <button type="button" key={`m-${n.id}`} className="notif-row" onClick={() => { window.connectDesktop?.window?.expandToFull?.(n.route); setNotifOpen(false); }}>
                      <span className="notif-ic missed"><PhoneMissed size={14} /></span>
                      <span className="notif-text"><strong>{n.title}</strong><small>{n.sub}</small></span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="settings-wrap">
            <button title="Settings" aria-label="Settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((v) => !v)}>
              <Settings size={15} />
            </button>
            {settingsOpen && (
              <div className="settings-popover">
                <div className="settings-title">
                  <span className="settings-title-icon"><Headphones size={15} /></span>
                  <span>
                    <strong>Headset settings</strong>
                    <small>Choose the microphone and speaker used for calls.</small>
                  </span>
                </div>
                <label className="settings-field">
                  <span>Microphone</span>
                  <select value={phone.currentMicDeviceId} onChange={(e) => updateMicDevice(e.target.value)}>
                    <option value="">System default microphone</option>
                    {phone.audioInputDevices.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${device.deviceId.slice(0, 6)}`}</option>
                    ))}
                  </select>
                </label>
                <label className="settings-field">
                  <span>Speaker / headset output</span>
                  <select value={phone.currentSinkId} onChange={(e) => updateSpeakerDevice(e.target.value)}>
                    <option value="">System default speaker</option>
                    {phone.audioOutputDevices.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>{device.label || `Speaker ${device.deviceId.slice(0, 6)}`}</option>
                    ))}
                  </select>
                </label>
                <div className="settings-section-label">Ringer</div>
                <label className="settings-field">
                  <span>Ringer output (rings here even during a headset call)</span>
                  <select value={ringerDeviceId} onChange={(e) => updateRingerDevice(e.target.value)}>
                    <option value="">System default speaker</option>
                    {phone.audioOutputDevices.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>{device.label || `Speaker ${device.deviceId.slice(0, 6)}`}</option>
                    ))}
                  </select>
                </label>
                <label className="settings-field">
                  <span>Ringer volume</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(ringerVolume * 100)}
                    onChange={(e) => updateRingerVolume(Number(e.target.value) / 100)}
                    className="ringer-range"
                    style={{ width: "100%", background: `linear-gradient(to right, #3b82f6 ${Math.round(ringerVolume * 100)}%, var(--mn-surface-2) ${Math.round(ringerVolume * 100)}%)` }}
                  />
                </label>
                <div className="settings-section-label">Startup</div>
                {([
                  { checked: settings.startOnLogin !== false, label: "Start with Windows", hint: "Open Connect when this computer starts", apply: (c: boolean) => updateDesktopSettings({ startOnLogin: c }) },
                  { checked: settings.openMinimizedToTray !== false, label: "Open minimized", hint: "Start quietly in the system tray", apply: (c: boolean) => updateDesktopSettings({ openMinimizedToTray: c }) },
                  { checked: Boolean(settings.openMiniOnStartup), label: "Open mini dialer", hint: "Show this floating dialer on startup", apply: (c: boolean) => updateDesktopSettings({ openMiniOnStartup: c }) },
                ]).map((row) => (
                  // A <div> (not a native <button>) so the row reliably stretches to the
                  // full popover width — Chromium buttons shrink-wrap to content even with
                  // width:100%, which collapsed the label column. Inlined so styled-jsx
                  // scopes .settings-toggle-row to it.
                  <div
                    key={row.label}
                    className="settings-toggle-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => row.apply(!row.checked)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); row.apply(!row.checked); } }}
                  >
                    <span><strong>{row.label}</strong><small>{row.hint}</small></span>
                    <i data-on={row.checked ? "true" : "false"} />
                  </div>
                ))}
              </div>
            )}
          </div>
          <button title="Always on top" onClick={() => window.connectDesktop?.window?.toggleAlwaysOnTop?.()}>{settings.alwaysOnTop ? <Pin size={14} /> : <PinOff size={14} />}</button>
          <button title="Open full app" onClick={() => window.connectDesktop?.window?.expandToFull?.("/dashboard/voice/phone")}><Maximize2 size={14} /></button>
          <button title="Minimize" onClick={() => window.connectDesktop?.window?.minimize?.()}><ChevronLeft size={15} /></button>
          <button title="Close" className="close-btn" onClick={() => window.connectDesktop?.window?.closeMini?.()}>&#215;</button>
        </div>
      </div>

      {inCall && (
        phone.callState === "ringing" && phone.callDirection === "inbound" ? (
          <section className="call-screen incoming">
            <div className="call-label">Incoming call</div>
            <div className="call-avatar-wrap">
              <div className="call-rings"><span /><span /><span /></div>
              <div className="call-avatar-lg green">{initials(incomingCaller.name || incomingCaller.prefix || incomingCaller.number || "?")}</div>
            </div>
            <div className="call-id">
              {incomingCaller.prefix ? <div className="call-prefix-pill">{incomingCaller.prefix}</div> : null}
              {incomingCaller.name ? <strong className="call-name">{incomingCaller.name}</strong> : null}
              {incomingCaller.number ? <div className="call-number">{formatPhoneDisplay(incomingCaller.number)}</div> : null}
              {!incomingCaller.name && !incomingCaller.number ? <strong className="call-name">Unknown caller</strong> : null}
            </div>
            {incomingWaiting.length > 0 && <div className="call-waiting"><Bell size={13} /> Call waiting</div>}
            <div className="call-spacer" />
            <div className="call-answer-row">
              <div className="call-action">
                <button className="round-btn decline" onClick={phone.hangup}><Phone size={28} style={{ transform: "rotate(135deg)" }} /></button>
                <span>Decline</span>
              </div>
              <div className="call-action">
                <button className="round-btn answer" onClick={phone.answer}><Phone size={28} /></button>
                <span>Answer</span>
              </div>
            </div>
          </section>
        ) : (
          <section className="call-screen active">
            {callView === "controls" ? (
              <>
                <div className="call-status">{callStatusLabel(phone.callState)}</div>
                <div className="call-timer">{formatDuration(timerSec)}</div>
                <div className="call-avatar-lg blue">{initials(selectedSession?.remoteParty || phone.remoteParty || phone.dialpadInput || "?")}</div>
                <strong className="call-name">{selectedSession?.remoteParty || phone.remoteParty || phone.dialpadInput || "Unknown caller"}</strong>
                {incomingWaiting.length > 0 && (
                  <div className="call-waiting">
                    <Bell size={13} /> {incomingWaiting[0]?.remoteParty}
                    <button onClick={() => phone.answerSession(incomingWaiting[0]!.id)}>Answer</button>
                    <button onClick={() => phone.hangupSession(incomingWaiting[0]!.id)}>Decline</button>
                  </div>
                )}
                <div className="call-spacer" />
                <div className="call-grid">
                  <button className={phone.muted ? "hot" : ""} onClick={() => phone.setMute(!phone.muted)}><span>{phone.muted ? <MicOff size={22} /> : <Mic size={22} />}</span>{phone.muted ? "Unmute" : "Mute"}</button>
                  <button className={phone.speakerOn ? "hot" : ""} onClick={phone.toggleSpeaker}><span><Volume2 size={22} /></span>Speaker</button>
                  <button onClick={() => { setDtmfLog(""); setCallView("keypad"); }}><span><Grid3x3 size={22} /></span>Keypad</button>
                  <button className={phone.onHold ? "hot" : ""} onClick={phone.toggleHold}><span><Pause size={22} /></span>{phone.onHold ? "Resume" : "Hold"}</button>
                  <button onClick={() => { setCallEntry(""); setEntryMode("transfer"); setCallView("entry"); }}><span><Send size={22} /></span>Transfer</button>
                  <button onClick={() => { setCallEntry(""); setEntryMode("add"); setCallView("entry"); }}><span><Plus size={22} /></span>Add call</button>
                </div>
                <button className="round-btn hangup" onClick={phone.hangup}><Phone size={26} style={{ transform: "rotate(135deg)" }} /></button>
              </>
            ) : callView === "keypad" ? (
              <>
                <div className="call-subhead">
                  <button className="call-back" onClick={() => setCallView("controls")} aria-label="Back"><ChevronLeft size={18} /></button>
                  <div className="call-subhead-mid"><strong>{selectedSession?.remoteParty || phone.remoteParty || "On call"}</strong><span>{formatDuration(timerSec)}</span></div>
                  <span className="call-subhead-spacer" />
                </div>
                <div className="call-dtmf">{dtmfLog || " "}</div>
                <div className="keypad in-call-keypad">
                  {KEYS.map(([digit, letters]) => (
                    <button key={digit} onClick={() => { phone.sendDtmf(digit); phone.playDtmfTone(digit); setDtmfLog((prev) => (prev + digit).slice(-24)); }}><strong>{digit}</strong><span>{letters}</span></button>
                  ))}
                </div>
                <button className="round-btn hangup" onClick={phone.hangup}><Phone size={26} style={{ transform: "rotate(135deg)" }} /></button>
              </>
            ) : (
              <>
                <div className="call-subhead">
                  <button className="call-back" onClick={() => setCallView("controls")} aria-label="Back"><ChevronLeft size={18} /></button>
                  <div className="call-subhead-mid"><strong>{entryMode === "transfer" ? "Transfer to" : "Add call"}</strong></div>
                  <span className="call-subhead-spacer" />
                </div>
                <input className="number-input call-entry-input" value={callEntry} placeholder="Number or extension" onChange={(e) => setCallEntry(e.target.value.replace(/[^\d*#+]/g, ""))} onKeyDown={(e) => { if (e.key === "Enter") runCallEntry(); }} autoFocus />
                <div className="keypad in-call-keypad">
                  {KEYS.map(([digit, letters]) => (
                    <button key={digit} onClick={() => { setCallEntry((prev) => prev + digit); phone.playDtmfTone(digit); }}><strong>{digit}</strong><span>{letters}</span></button>
                  ))}
                </div>
                <div className="call-entry-actions">
                  <button className="call-entry-del" onClick={() => setCallEntry((prev) => prev.slice(0, -1))} aria-label="Delete"><Delete size={18} /></button>
                  <button className={"call-entry-go" + (entryMode === "transfer" ? " transfer" : "")} disabled={!callEntry.trim()} onClick={runCallEntry}>
                    {entryMode === "transfer" ? <><Send size={16} /> Transfer</> : <><Phone size={16} /> Call</>}
                  </button>
                  <span className="call-entry-spacer" />
                </div>
              </>
            )}
          </section>
        )
      )}

      <section className="mini-content">
        {tab === "dialer" && (
          <div className={"screen dialer-pane" + (dialSuggestions.length > 0 ? " with-suggestions" : "")}>
            <input className="number-input" value={phone.dialpadInput} placeholder="Search or dial" onChange={(e) => phone.setDialpadInput(e.target.value.replace(/[^\d*#+]/g, ""))} onKeyDown={(e) => { if (e.key === "Enter") callTarget(phone.dialpadInput); }} />
            {phone.outboundRoutes.length > 0 && (
              <select className="route-select" value={phone.selectedOutboundRouteId} onChange={(e) => phone.setSelectedOutboundRouteId(e.target.value)}>
                {routeOptions.map((route) => <option key={route.id || "none"} value={route.id}>{route.name}</option>)}
              </select>
            )}
            {dialSuggestions.length > 0 && (
              <div className="suggestions">
                {dialSuggestions.map((s) => (<button key={s.id} onClick={() => phone.setDialpadInput(s.number)}><span className="sugg-av">{initials(s.label)}</span><span className="sugg-main"><strong>{s.label}</strong><small>{s.number}</small></span><ArrowUpRight size={16} /></button>))}
              </div>
            )}
            <div className="keypad">
              {KEYS.map(([digit, letters]) => (<button key={digit} onClick={() => appendDigit(digit)}><strong>{digit}</strong><span>{letters}</span></button>))}
            </div>
            <div className="dialer-actions">
              <button className="call-button" onClick={() => { const v = phone.dialpadInput.trim(); if (!v) { if (lastDialed) phone.setDialpadInput(lastDialed); return; } callTarget(v); }}><Phone size={22} /></button>
              <button className="delete-button" onClick={() => phone.setDialpadInput((prev) => prev.slice(0, -1))}><Delete size={20} /></button>
            </div>
          </div>
        )}

        {tab === "calls" && (
          <div className="screen list-pane">
            <div className="screen-title">Recents</div>
            {calls.map((call) => {
              const target = call.direction === "outgoing" ? call.toNumber : call.fromNumber;
              const missed = call.status === "missed";
              const outgoing = call.direction === "outgoing";
              const name = call.fromName || target || "Unknown";
              const dur = formatDuration(call.durationSec);
              const kindLabel = missed ? "Missed" : outgoing ? "Outgoing" : "Incoming";
              return (
                <article className="mini-row" key={call.rowId || call.callId || `${target}-${call.startedAt}`}>
                  <MiniAvatar name={name} size={44} />
                  <div className="row-main">
                    <strong>{name}</strong>
                    <span className="row-meta">
                      {missed
                        ? <PhoneOff size={13} className="rm-icon rm-missed" />
                        : outgoing
                          ? <PhoneCall size={13} className="rm-icon rm-out" />
                          : <PhoneIncoming size={13} className="rm-icon rm-in" />}
                      {missed ? "Missed" : dur ? `${kindLabel} · ${dur}` : kindLabel}
                    </span>
                  </div>
                  <div className="row-right">
                    <span className="row-time">{timeOfDay(call.startedAt)}</span>
                    <div className="row-actions">
                      <button className="row-msg" onClick={() => setTab("messages")} title="Message"><MessageSquare size={15} /></button>
                      <button className="row-call" onClick={() => target && callTarget(target)} title="Call"><Phone size={16} /></button>
                    </div>
                  </div>
                </article>
              );
            })}
            {calls.length === 0 && <p className="empty">No recent calls yet.</p>}
          </div>
        )}

        {tab === "messages" && <MiniChat />}

        {tab === "voicemail" && (() => {
          const q = vmQuery.trim().toLowerCase();
          const unreadCount = voicemails.filter((v) => !v.listened).length;
          const counts = {
            all: voicemails.length,
            new: unreadCount,
            urgent: 0,
            old: voicemails.filter((v) => v.listened).length,
          } as const;
          const list = voicemails
            .filter((v) => (vmFilter === "all" ? true : vmFilter === "new" ? !v.listened : vmFilter === "old" ? v.listened : false))
            .filter((v) => !q || (v.callerName || "").toLowerCase().includes(q) || (v.callerId || "").toLowerCase().includes(q) || (v.transcription || "").toLowerCase().includes(q));
          const chips = [["all", "All"], ["new", "New"], ["urgent", "Urgent"], ["old", "Old"]] as const;
          return (
            <div className="screen list-pane vm-screen">
              <div className="vm-header">
                <div className="vm-h-title">Voicemail</div>
                <div className="vm-h-sub">{unreadCount} new &#183; {voicemails.length} total</div>
                {unreadCount > 0 && <button type="button" className="vm-mark-all" onClick={markAllVmsRead}>Mark all read</button>}
              </div>
              <div className="vm-search">
                <Search size={16} />
                <input value={vmQuery} onChange={(e) => setVmQuery(e.target.value)} placeholder="Search caller, number..." />
              </div>
              <div className="vm-chips">
                {chips.map(([key, label]) => (
                  <button key={key} className={"vm-chip" + (vmFilter === key ? " active" : "")} onClick={() => setVmFilter(key)}>
                    <span>{label}</span>
                    <small>{counts[key]}</small>
                  </button>
                ))}
              </div>
              <div className="vm-cards">
                {list.map((vm) => (
                  <div className={"vm-card" + (!vm.listened ? " new" : "")} key={vm.id}>
                    <div className="vm-top">
                      <MiniAvatar name={vm.callerName || vm.callerId} size={40} />
                      <div className="vm-info">
                        <strong>{vm.callerName || vm.callerId || "Unknown caller"}</strong>
                        <small>{vm.callerId || "Unknown number"}</small>
                      </div>
                      <div className="vm-right">
                        {!vm.listened ? <span className="vm-badge new">NEW</span> : <span className="vm-badge read">READ</span>}
                        <span className="vm-dur">{formatDuration(vm.durationSec)}</span>
                      </div>
                    </div>
                    <VoicemailPlayer src={vm.streamUrl || voicemailStreamUrl(vm.id)} durationSec={vm.durationSec} onPlay={() => markVmListened(vm.id, true)} />
                    {vm.transcription ? <p className="vm-transcript">{vm.transcription}</p> : null}
                    {(vm.note || vm.callbackReminderAt) && vmNoteEditId !== vm.id && vmRemEditId !== vm.id ? (
                      <div className="vm-meta">
                        {vm.note ? (
                          <div className="vm-note-chip"><StickyNote size={12} /> <span>{vm.note}</span>{vm.noteUpdatedByName ? <em>— {vm.noteUpdatedByName}</em> : null}</div>
                        ) : null}
                        {vm.callbackReminderAt ? (
                          <div className="vm-rem-chip"><BellRing size={12} /> <span>Callback {reminderWhen(vm.callbackReminderAt)}{vm.callbackReminderLabel ? ` · ${vm.callbackReminderLabel}` : ""}</span></div>
                        ) : null}
                      </div>
                    ) : null}
                    {vmNoteEditId === vm.id ? (
                      <div className="vm-edit">
                        <textarea className="vm-note-input" placeholder="Add a note for the team…" value={vmNoteDraft} onChange={(e) => setVmNoteDraft(e.target.value)} rows={3} autoFocus />
                        <div className="vm-edit-btns">
                          <button className="vm-btn ghost" onClick={() => setVmNoteEditId(null)}>Cancel</button>
                          {vm.note ? <button className="vm-btn ghost danger" onClick={() => { patchVm(vm.id, { note: null }, { note: null, noteUpdatedByName: null }); setVmNoteEditId(null); }}>Clear</button> : null}
                          <button className="vm-btn primary" onClick={() => { const t = vmNoteDraft.trim(); patchVm(vm.id, { note: t }, { note: t || null, noteUpdatedByName: t ? "You" : null }); setVmNoteEditId(null); }}>Save note</button>
                        </div>
                      </div>
                    ) : null}
                    {vmRemEditId === vm.id ? (
                      <div className="vm-edit">
                        <label className="vm-edit-lbl">Remind me to call back at</label>
                        <input className="vm-rem-input" type="datetime-local" value={vmRemDraft.at} onChange={(e) => setVmRemDraft((d) => ({ ...d, at: e.target.value }))} autoFocus />
                        <input className="vm-rem-input" type="text" placeholder="Note for the reminder (optional)" value={vmRemDraft.label} onChange={(e) => setVmRemDraft((d) => ({ ...d, label: e.target.value }))} />
                        <div className="vm-edit-btns">
                          <button className="vm-btn ghost" onClick={() => setVmRemEditId(null)}>Cancel</button>
                          {vm.callbackReminderAt ? <button className="vm-btn ghost danger" onClick={() => { patchVm(vm.id, { callbackReminderAt: null }, { callbackReminderAt: null, callbackReminderLabel: null }); setVmRemEditId(null); }}>Clear</button> : null}
                          <button className="vm-btn primary" disabled={!vmRemDraft.at} onClick={() => { const iso = vmRemDraft.at ? new Date(vmRemDraft.at).toISOString() : null; if (!iso) return; patchVm(vm.id, { callbackReminderAt: iso, callbackReminderLabel: vmRemDraft.label.trim() || null }, { callbackReminderAt: iso, callbackReminderLabel: vmRemDraft.label.trim() || null, callbackReminderMine: true }); setVmRemEditId(null); }}>Set reminder</button>
                        </div>
                      </div>
                    ) : null}
                    <div className="vm-actions">
                      <span className="vm-date"><Clock3 size={12} /> {shortTime(vm.receivedAt)}</span>
                      <div className="vm-action-btns">
                        <button className="vm-act vm-act-call" onClick={() => callTarget(vm.callerId)} title="Call back"><Phone size={16} /></button>
                        <button className="vm-act vm-act-msg" onClick={() => setTab("messages")} title="Message"><MessageSquare size={16} /></button>
                        <div className="vm-menu-wrap">
                          <button className={"vm-act vm-act-more" + (vmMenuId === vm.id ? " open" : "")} onClick={() => setVmMenuId(vmMenuId === vm.id ? null : vm.id)} title="More"><MoreHorizontal size={18} /></button>
                          {vmMenuId === vm.id ? (
                            <>
                              <div className="vm-menu-backdrop" onClick={() => setVmMenuId(null)} />
                              <div className="vm-menu">
                                <button onClick={() => { markVmListened(vm.id, !vm.listened); setVmMenuId(null); }}>{vm.listened ? "Mark as unread" : "Mark as read"}</button>
                                <button onClick={() => { setVmNoteDraft(vm.note || ""); setVmNoteEditId(vm.id); setVmRemEditId(null); setVmMenuId(null); }}><StickyNote size={14} /> {vm.note ? "Edit note" : "Add note"}</button>
                                <button onClick={() => { setVmRemDraft({ at: toLocalInput(vm.callbackReminderAt), label: vm.callbackReminderLabel || "" }); setVmRemEditId(vm.id); setVmNoteEditId(null); setVmMenuId(null); }}><BellRing size={14} /> {vm.callbackReminderAt ? "Edit callback reminder" : "Schedule callback reminder"}</button>
                              </div>
                            </>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {list.length === 0 && <p className="empty">No voicemails.</p>}
            </div>
          );
        })()}

        {tab === "team" && <MiniTeam onCall={callTarget} onMessage={() => setTab("messages")} tenantId={tenant?.id ?? null} />}
      </section>

      <nav className="mini-tabs">
        {([["dialer", Phone, "Dialer"], ["calls", Clock3, "Recents"], ["messages", MessageSquare, "Chat"], ["voicemail", Voicemail, "Voicemail"], ["team", Users, "Team"]] as const).map(([key, Icon, label]) => (
          <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key as TabKey)}>
            <Icon size={20} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <style jsx>{`
        * { box-sizing: border-box; }
        .mini-shell {
          height: 100vh; min-height: 100vh; display: flex; flex-direction: column;
          --mn-bg: #090e18; --mn-surface: #111827; --mn-surface-2: #162034; --mn-line: #162036;
          --mn-border: #1e2d47; --mn-text: #f0f4ff; --mn-text-2: #8899bb; --mn-text-3: #4d6088;
          --mn-text-4: #374869; --mn-card-new: #13203b;
          color: var(--mn-text); background: var(--mn-bg); overflow: hidden;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        }
        .mini-shell.mini-light {
          --mn-bg: #eef2f7; --mn-surface: #ffffff; --mn-surface-2: #eef2f8; --mn-line: rgba(15,23,42,0.08);
          --mn-border: rgba(15,23,42,0.14); --mn-text: #0f172a; --mn-text-2: #55637a; --mn-text-3: #8794a8;
          --mn-text-4: #b6c0d0; --mn-card-new: #e8f1ff;
        }
        .mini-titlebar { -webkit-app-region: drag; display: flex; align-items: center; height: 34px; padding: 0 6px 0 0; background: var(--mn-bg); border-bottom: 0.5px solid var(--mn-line); }
        .mini-drag { flex: 1; height: 100%; }
        .mini-winbtns { -webkit-app-region: no-drag; display: flex; align-items: center; gap: 2px; }
        .settings-wrap { position: relative; }
        .mini-identity { display: flex; align-items: center; gap: 8px; padding-left: 6px; min-width: 0; -webkit-app-region: no-drag; }
        .mini-identity-avatar { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font-size: 10px; font-weight: 700; color: #dbeafe; background: linear-gradient(135deg,#2563eb,#0ea5e9); flex-shrink: 0; }
        .mini-identity-text { display: grid; gap: 1px; min-width: 0; }
        .mini-identity-text strong { color: #e5eefb; font-size: 12px; line-height: 1.15; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mini-identity-status { font-size: 10px; line-height: 1.15; display: inline-flex; align-items: center; gap: 4px; color: #8fb3c8; }
        .mini-identity-status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; display: inline-block; }
        .mini-identity-status.green { color: #34d399; }
        .mini-identity-status.amber { color: #fbbf24; }
        .mini-identity-status.red { color: #f87171; }
        .notif-wrap { position: relative; }
        .notif-wrap > button { position: relative; }
        .notif-dot { position: absolute; top: -1px; right: -2px; min-width: 15px; height: 15px; padding: 0 4px; border-radius: 999px; background: #ef4444; color: #fff; font-size: 9px; font-weight: 800; line-height: 15px; text-align: center; box-shadow: 0 0 0 2px rgba(5,12,24,.9); }
        .notif-popover { position: fixed; top: 40px; left: 8px; right: 8px; margin-left: auto; z-index: 60; width: auto; max-width: 336px; padding: 10px; border-radius: 20px; background: radial-gradient(circle at 0% 0%, rgba(56,189,248,.18), transparent 42%), linear-gradient(145deg, rgba(12,20,36,.98), rgba(5,12,24,.98)); border: 1px solid rgba(125, 211, 252, .20); box-shadow: 0 24px 70px rgba(0,0,0,.50); backdrop-filter: blur(22px); }
        .notif-head { display: flex; align-items: center; justify-content: space-between; padding: 4px 6px 8px; }
        .notif-head strong { color: #e5eefb; font-size: 13px; }
        .notif-clear { width: auto !important; height: auto !important; padding: 4px 9px !important; border-radius: 8px !important; background: rgba(56,189,248,.14) !important; border: 1px solid rgba(125,211,252,.28) !important; color: #7dd3fc; font-size: 10px; font-weight: 700; }
        .notif-body { display: flex; flex-direction: column; gap: 4px; max-height: 320px; overflow-y: auto; }
        .notif-empty { color: #8fb3c8; font-size: 12px; text-align: center; padding: 16px 8px; }
        .notif-row { width: 100% !important; height: auto !important; display: flex !important; align-items: center; gap: 10px; padding: 9px 8px !important; border-radius: 12px !important; background: rgba(15,23,42,.55) !important; border: 1px solid rgba(148,163,184,.12) !important; text-align: left; cursor: pointer; }
        .notif-row:hover { background: rgba(30,41,59,.75) !important; }
        .notif-ic { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px; flex-shrink: 0; }
        .notif-ic.chat { background: rgba(56,189,248,.16); color: #7dd3fc; }
        .notif-ic.vm { background: rgba(167,139,250,.16); color: #c4b5fd; }
        .notif-ic.missed { background: rgba(248,113,113,.16); color: #fca5a5; }
        .notif-text { display: grid; gap: 1px; min-width: 0; }
        .notif-text strong { color: #e5eefb; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .notif-text small { color: #8fb3c8; font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mini-winbtns button { -webkit-app-region: no-drag; display: grid; place-items: center; width: 28px; height: 26px; border-radius: 8px; border: 0; background: transparent; color: var(--mn-text-2); cursor: pointer; font-size: 18px; }
        .mini-winbtns button:hover { background: var(--mn-surface-2); color: var(--mn-text); }
        .close-btn:hover { background: #ef4444; color: #fff; }

        .settings-popover { position: fixed; top: 36px; right: 6px; left: auto; z-index: 50; width: min(320px, calc(100vw - 12px)); max-height: calc(100vh - 46px); overflow-y: auto; padding: 14px; border-radius: 16px; background: var(--mn-surface); border: 0.5px solid var(--mn-border); box-shadow: 0 24px 70px rgba(0,0,0,.55); -webkit-app-region: no-drag; }
        .settings-title { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
        .settings-title span:last-child { display: flex; flex-direction: column; }
        .settings-title strong { font-size: 14px; font-weight: 500; }
        .settings-title small { font-size: 11px; color: var(--mn-text-2); }
        .settings-title-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; background: rgba(59,130,246,0.14); border: 1px solid rgba(59,130,246,0.3); color: #93c5fd; }
        .settings-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
        .settings-field > span { font-size: 12px; color: var(--mn-text-2); }
        .settings-field select { width: 100%; height: 38px; border-radius: 12px; border: 0.5px solid var(--mn-border); background: var(--mn-surface-2) !important; color: var(--mn-text) !important; font-size: 13px; padding: 0 10px; outline: none; }
        .settings-field input[type="range"] { -webkit-appearance: none; appearance: none; width: 100%; height: 5px; border-radius: 3px; background: var(--mn-surface-2); outline: none; margin: 6px 0; }
        .settings-field input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 15px; height: 15px; border-radius: 50%; background: #3b82f6; border: 2px solid var(--mn-surface); cursor: pointer; }
        .settings-section-label { font-size: 11px; font-weight: 500; color: var(--mn-text-3); text-transform: uppercase; letter-spacing: 1px; margin: 6px 0 8px; }
        .settings-toggle-row { -webkit-appearance: none; appearance: none; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; min-height: 46px; padding: 8px 0; box-sizing: border-box; border: 0 !important; border-top: 0.5px solid var(--mn-line) !important; background: transparent !important; background-color: transparent !important; width: 100%; text-align: left; cursor: pointer; color: var(--mn-text); font: inherit; }
        .settings-toggle-row > span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .settings-toggle-row strong { font-size: 13px; font-weight: 500; line-height: 1.25; }
        .settings-toggle-row small { font-size: 11px; line-height: 1.3; color: var(--mn-text-2); }
        .settings-toggle-row i { display: block; position: relative; width: 40px; height: 23px; border-radius: 999px; background: var(--mn-border); flex-shrink: 0; transition: background .16s ease; }
        .settings-toggle-row i:after { content: ""; position: absolute; top: 2px; left: 2px; width: 19px; height: 19px; border-radius: 50%; background: var(--mn-text-2); transition: transform .16s ease, background .16s ease; }
        .settings-toggle-row i[data-on="true"] { background: #3b82f6; }
        .settings-toggle-row i[data-on="true"]:after { transform: translateX(17px); background: #fff; }

        .call-screen { position: absolute; inset: 0; z-index: 40; display: flex; flex-direction: column; align-items: center; padding: 40px 24px 26px; }
        .call-screen.incoming { background: #0b1330; }
        .call-screen.active { background: #0a1128; }
        .call-avatar-wrap { position: relative; margin-top: 34px; display: grid; place-items: center; }
        .call-avatar-wrap .call-avatar-lg { margin-top: 0; }
        .call-rings { position: absolute; top: 50%; left: 50%; width: 250px; height: 250px; transform: translate(-50%, -50%); pointer-events: none; }
        .call-id { margin-top: 18px; display: flex; flex-direction: column; align-items: center; gap: 5px; }
        .call-id .call-name { margin-top: 0; }
        .call-prefix-pill { display: inline-flex; align-items: center; padding: 4px 13px; border-radius: 999px; font-size: 12px; font-weight: 600; letter-spacing: 0.3px; text-transform: uppercase; background: rgba(34,197,94,0.16); color: #34d399; border: 0.5px solid rgba(34,197,94,0.4); }
        .call-number { font-size: 15px; color: var(--mn-text-2); font-variant-numeric: tabular-nums; text-align: center; }
        .call-rings span {
          position: absolute; inset: 0; border-radius: 50%;
          border: 1.5px solid rgba(34,197,94,0.55);
          transform: scale(0.5); opacity: 0; transform-origin: center;
          animation: cc-ring-ripple 2.2s cubic-bezier(0.2,0.6,0.3,1) infinite;
          will-change: transform, opacity;
        }
        .call-rings span:nth-child(2) { animation-delay: 0.73s; }
        .call-rings span:nth-child(3) { animation-delay: 1.46s; }
        @keyframes cc-ring-ripple {
          0%   { transform: scale(0.5);  opacity: 0; }
          12%  { opacity: 0.7; }
          100% { transform: scale(1.18); opacity: 0; }
        }
        .call-label { font-size: 12px; letter-spacing: 3px; text-transform: uppercase; color: rgba(34,197,94,0.9); margin-top: 8px; }
        .call-status { font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: #34d399; }
        .call-timer { font-size: 15px; color: var(--mn-text-2); font-variant-numeric: tabular-nums; margin-top: 6px; }
        .call-avatar-lg { display: grid; place-items: center; width: 116px; height: 116px; border-radius: 50%; font-size: 38px; font-weight: 500; margin-top: 34px; }
        .call-avatar-lg.green { background: rgba(34,197,94,0.15); border: 2px solid rgba(34,197,94,0.4); color: #22c55e; }
        .call-avatar-lg.blue { background: rgba(59,130,246,0.12); border: 2px solid rgba(59,130,246,0.35); color: #93c5fd; }
        .call-name { font-size: 24px; font-weight: 500; margin-top: 20px; text-align: center; }
        .call-waiting { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 7px 12px; border-radius: 14px; background: rgba(30,45,71,0.7); border: 1px solid rgba(147,197,253,0.25); font-size: 12px; color: #dbe4ff; }
        .call-waiting button { border: 0; border-radius: 9px; padding: 5px 9px; font-size: 11px; font-weight: 500; color: #fff; cursor: pointer; }
        .call-waiting button:nth-of-type(1) { background: #22c55e; }
        .call-waiting button:nth-of-type(2) { background: #ef4444; }
        .call-spacer { flex: 1; }
        .call-answer-row { display: flex; justify-content: space-around; width: 100%; }
        .call-action { display: flex; flex-direction: column; align-items: center; gap: 12px; font-size: 13px; color: rgba(240,244,255,0.7); }
        .round-btn { display: grid; place-items: center; border: 0; border-radius: 50%; color: #fff; cursor: pointer; padding: 0; box-sizing: border-box; flex-shrink: 0; }
        .round-btn.decline, .round-btn.answer { width: 76px; height: 76px; }
        .round-btn.decline { background: #ef4444; box-shadow: 0 6px 18px rgba(239,68,68,0.4); }
        .round-btn.answer { background: #22c55e; box-shadow: 0 6px 18px rgba(34,197,94,0.4); }
        .round-btn.hangup { width: 72px; height: 72px; background: #ef4444; box-shadow: 0 6px 18px rgba(239,68,68,0.4); }
        .call-grid { display: grid; grid-template-columns: repeat(3, 64px); gap: 16px 12px; justify-content: center; margin-bottom: 22px; }
        .call-grid button { display: flex; flex-direction: column; align-items: center; gap: 7px; border: 0; background: transparent; color: var(--mn-text-2); font-size: 11px; cursor: pointer; }
        .call-grid button { padding: 0; } .call-grid button span { display: grid; place-items: center; width: 58px; height: 58px; border-radius: 50%; background: rgba(30,45,71,0.55); border: 1px solid var(--mn-border); color: #dbe4ff; box-sizing: border-box; }
        .call-grid button.hot span { background: var(--mn-text); border-color: var(--mn-text); color: #0a1128; }

        /* In-call sub-views (DTMF keypad, Transfer / Add-call entry). */
        .call-subhead { display: flex; align-items: center; justify-content: space-between; width: 100%; margin-bottom: 4px; }
        .call-subhead-spacer { width: 34px; flex-shrink: 0; }
        .call-back { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; border: 0; background: rgba(30,45,71,0.55); color: #dbe4ff; cursor: pointer; flex-shrink: 0; }
        .call-back:hover { background: rgba(59,130,246,0.28); }
        .call-subhead-mid { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 0; }
        .call-subhead-mid strong { font-size: 15px; color: var(--mn-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px; }
        .call-subhead-mid span { font-size: 12px; color: var(--mn-text-2); font-variant-numeric: tabular-nums; }
        .call-dtmf { min-height: 34px; font-size: 26px; letter-spacing: 3px; color: var(--mn-text); text-align: center; margin: 8px 0 6px; font-variant-numeric: tabular-nums; word-break: break-all; }
        .in-call-keypad { margin: 6px auto 16px; --keyh: 54px; }
        .call-entry-input { margin: 8px 0 6px; }
        .call-entry-actions { display: flex; align-items: center; justify-content: space-between; width: 100%; max-width: 300px; margin: 0 auto 6px; }
        .call-entry-del { display: grid; place-items: center; width: 52px; height: 52px; border-radius: 50%; border: 0.5px solid var(--mn-border); background: rgba(30,45,71,0.55); color: var(--mn-text-2); cursor: pointer; flex-shrink: 0; }
        .call-entry-spacer { width: 52px; flex-shrink: 0; }
        .call-entry-go { display: inline-flex; align-items: center; gap: 8px; height: 50px; padding: 0 22px; border: 0; border-radius: 25px; background: #22c55e; color: #fff; font-size: 14px; font-weight: 700; cursor: pointer; box-shadow: 0 6px 16px rgba(34,197,94,0.35); }
        .call-entry-go.transfer { background: #3b82f6; box-shadow: 0 6px 16px rgba(59,130,246,0.35); }
        .call-entry-go:disabled { background: var(--mn-border); color: var(--mn-text-3); box-shadow: none; cursor: default; }

        .mini-content { flex: 1; overflow-y: auto; overflow-x: hidden; }
        .screen { display: flex; flex-direction: column; }
        .screen-title { font-size: 24px; font-weight: 500; letter-spacing: -0.4px; padding: 16px 18px 10px; }
        .dialer-pane { padding: 14px 16px 10px; height: 100%; display: flex; flex-direction: column; --keyh: 56px; }
        .number-input { width: 100%; height: 44px; border-radius: 14px; border: 0.5px solid var(--mn-border); background: var(--mn-surface) !important; color: var(--mn-text) !important; font-size: 20px; text-align: center; letter-spacing: 1px; outline: none; }
        .number-input::placeholder { color: var(--mn-text-3) !important; font-size: 15px; letter-spacing: 0; }
        .route-select { width: 100%; height: 34px; border-radius: 10px; border: 0.5px solid var(--mn-border); background: var(--mn-surface) !important; color: var(--mn-text-2) !important; font-size: 12px; padding: 0 10px; margin-top: 8px; outline: none; }
        .suggestions { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 2px; }
        .suggestions button { display: flex; align-items: center; gap: 11px; padding: 9px 12px; border: 0.5px solid var(--mn-border); border-radius: 14px; background: var(--mn-surface); color: var(--mn-text); cursor: pointer; text-align: left; } .suggestions button > :global(svg) { color: var(--mn-text-3); flex-shrink: 0; } .sugg-av { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 50%; background: rgba(136,153,187,0.16); color: var(--mn-text-2); font-size: 13px; font-weight: 500; flex-shrink: 0; } .sugg-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; } .sugg-main strong { font-size: 15px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .sugg-main small { font-size: 13px; color: var(--mn-text-2); }
        
        .keypad { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(4, minmax(0, var(--keyh))); align-content: center; gap: 4px; margin: 2px auto; width: 100%; max-width: 300px; }
        .keypad button { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; height: 100%; min-height: 0; border-radius: 12px; border: 0; background: transparent; color: var(--mn-text); cursor: pointer; }
        .keypad button:hover { background: var(--mn-surface-2); }
        .keypad strong { font-size: 30px; font-weight: 400; line-height: 1; }
        .keypad span { font-size: 9px; letter-spacing: 2px; color: var(--mn-text-3); font-weight: 500; }
        /* Dialer tab: drop the keypad to the bottom of the pane so it sits right on top of the call button (no dead gap). */
        .dialer-pane .keypad { align-content: end; padding-bottom: 4px; }
        .dialer-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; justify-content: center; align-items: center; margin: 4px auto 6px; width: 100%; max-width: 300px; }
        .call-button { grid-column: 2; justify-self: center; display: grid; place-items: center; width: 60px; height: 60px; border-radius: 50%; border: 0; background: #22c55e; color: #fff; cursor: pointer; box-shadow: 0 8px 20px rgba(34,197,94,0.35); }
        .call-button:disabled { background: var(--mn-border); color: var(--mn-text-3); box-shadow: none; cursor: default; }
        .delete-button { grid-column: 3; justify-self: center; display: grid; place-items: center; width: 52px; height: 52px; border-radius: 50%; border: 0.5px solid var(--mn-border); background: rgba(30,45,71,0.55); color: var(--mn-text-2); cursor: pointer; }

        .list-pane { display: flex; flex-direction: column; }
        /* Recents rows — cards that match the mobile RecentTab exactly. */
        .mini-row { display: flex; align-items: center; gap: 12px; padding: 12px; margin: 0 12px 10px; border-radius: 18px; border: 0.5px solid var(--mn-border); background: var(--mn-surface); min-height: 72px; box-sizing: border-box; }
        .row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
        .row-main strong { font-size: 15px; font-weight: 700; letter-spacing: -0.15px; color: var(--mn-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .row-meta { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--mn-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .rm-icon { flex-shrink: 0; }
        .rm-missed { color: #ef4444; }
        .rm-in { color: #22d3ee; }
        .rm-out { color: #22c55e; }
        .row-right { display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; align-self: stretch; gap: 6px; flex-shrink: 0; padding: 1px 0; }
        .row-actions { display: flex; align-items: center; gap: 6px; }
        .row-msg { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; border: 1px solid rgba(6,182,212,0.33); background: rgba(6,182,212,0.14); color: #22d3ee; cursor: pointer; flex-shrink: 0; }
        .row-msg:hover { background: rgba(6,182,212,0.22); }
        .row-preview { color: var(--mn-text-2); }
        .row-time { font-size: 11.5px; font-weight: 700; color: var(--mn-text-3); flex-shrink: 0; }
        .row-call { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; border: 0; background: #3b82f6; color: #fff; cursor: pointer; flex-shrink: 0; box-shadow: 0 4px 12px rgba(59,130,246,0.35); }
        .row-call:hover { filter: brightness(1.05); }
        .unread-dot { width: 8px; height: 8px; border-radius: 50%; background: #3b82f6; flex-shrink: 0; }

        .vm-screen { padding: 0; }
        .vm-header { position: relative; text-align: center; padding: 14px 16px 10px; }
        .vm-mark-all { position: absolute; right: 12px; top: 16px; padding: 5px 10px; border-radius: 9px; border: 1px solid rgba(125,211,252,.28); background: rgba(56,189,248,.12); color: #7dd3fc; font-size: 11px; font-weight: 700; cursor: pointer; }
        .vm-mark-all:hover { background: rgba(56,189,248,.20); }
        .vm-h-title { font-size: 26px; font-weight: 800; letter-spacing: -0.7px; color: var(--mn-text); line-height: 30px; }
        .vm-h-sub { margin-top: 3px; font-size: 13px; font-weight: 600; color: var(--mn-text-2); }
        .vm-search { display: flex; align-items: center; gap: 10px; margin: 0 14px 10px; height: 44px; padding: 0 14px; border-radius: 16px; border: 0.5px solid var(--mn-border); background: var(--mn-surface); color: var(--mn-text-3); }
        .vm-search input { flex: 1; min-width: 0; border: 0; background: transparent !important; outline: none; color: var(--mn-text) !important; font-size: 14px; font-weight: 500; box-shadow: none !important; }
        .vm-search input:-webkit-autofill, .vm-search input:-webkit-autofill:focus, .vm-search input:-webkit-autofill:hover { -webkit-box-shadow: 0 0 0 1000px var(--mn-surface) inset !important; -webkit-text-fill-color: var(--mn-text) !important; caret-color: var(--mn-text); }
        .vm-search input::placeholder { color: var(--mn-text-3); }
        .vm-chips { display: flex; gap: 7px; margin: 0 14px 10px; }
        .vm-chip { flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px; min-height: 34px; border-radius: 13px; border: 0.5px solid var(--mn-border); background: var(--mn-surface-2); color: var(--mn-text-2); cursor: pointer; }
        .vm-chip span { font-size: 12px; font-weight: 800; }
        .vm-chip small { font-size: 11px; font-weight: 800; color: var(--mn-text-3); }
        .vm-chip.active { border-color: rgba(59,130,246,0.5); background: rgba(59,130,246,0.14); color: #3b82f6; }
        .vm-chip.active small { color: #3b82f6; }
        .vm-cards { display: flex; flex-direction: column; gap: 10px; padding: 2px 14px 14px; }
        .vm-card { background: var(--mn-surface); border: 0.5px solid var(--mn-border); border-radius: 20px; padding: 14px; }
        .vm-card.new { border-color: rgba(59,130,246,0.28); background: var(--mn-card-new); }
        .vm-top { display: flex; align-items: center; gap: 11px; }
        .vm-av { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 50%; background: rgba(136,153,187,0.16); color: var(--mn-text-2); font-size: 14px; font-weight: 600; flex-shrink: 0; }
        .vm-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
        .vm-info strong { font-size: 16px; font-weight: 800; letter-spacing: -0.25px; color: var(--mn-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .vm-info small { font-size: 13px; font-weight: 600; color: var(--mn-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .vm-right { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex-shrink: 0; }
        .vm-badge { font-size: 9px; font-weight: 900; letter-spacing: 0.5px; padding: 3px 7px; border-radius: 9px; border: 1px solid transparent; }
        .vm-badge.new { color: #3b82f6; background: rgba(59,130,246,0.14); border-color: rgba(59,130,246,0.33); }
        .vm-badge.read { color: #22c55e; background: rgba(34,197,94,0.12); border-color: rgba(34,197,94,0.33); }
        .vm-dur { font-size: 12px; font-weight: 800; color: var(--mn-text-2); padding: 3px 8px; border-radius: 10px; background: rgba(148,163,184,0.10); }
        .vm-player { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
        .vm-player[data-error="true"] { opacity: .5; }
        .vm-play { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 50%; border: 0; background: rgba(59,130,246,0.14); color: #3b82f6; cursor: pointer; flex-shrink: 0; padding: 0; box-sizing: border-box; }
        .vm-play[data-active="true"] { background: #3b82f6; color: #fff; }
        .vm-wave { display: flex; align-items: center; gap: 2px; flex: 1; height: 30px; cursor: pointer; }
        .vm-wave span { flex: 1; border-radius: 2px; background: rgba(148,163,184,0.34); }
        .vm-wave span.on { background: #3b82f6; }
        .vm-elapsed { font-size: 11px; font-weight: 700; color: var(--mn-text-2); font-variant-numeric: tabular-nums; flex-shrink: 0; min-width: 30px; text-align: right; }
        .vm-transcript { margin: 12px 0 0; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--mn-text-2); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .vm-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 14px; min-width: 0; }
        .vm-date { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; color: var(--mn-text-3); padding: 4px 8px; border-radius: 10px; background: rgba(148,163,184,0.10); white-space: nowrap; flex-shrink: 1; min-width: 0; overflow: hidden; }
        /* Voicemail action buttons — call / message / more, matching mobile. */
        .vm-action-btns { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .vm-act { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 12px; border: 1px solid transparent; cursor: pointer; flex-shrink: 0; }
        .vm-act-call { background: rgba(34,197,94,0.14); border-color: rgba(34,197,94,0.30); color: #22c55e; }
        .vm-act-call:hover { background: rgba(34,197,94,0.22); }
        .vm-act-msg { background: rgba(6,182,212,0.14); border-color: rgba(6,182,212,0.30); color: #22d3ee; }
        .vm-act-msg:hover { background: rgba(6,182,212,0.22); }
        .vm-act-more { background: rgba(148,163,184,0.12); color: var(--mn-text-2); }
        .vm-act-more:hover, .vm-act-more.open { background: rgba(148,163,184,0.20); }

        .vm-menu-wrap { position: relative; }
        .vm-menu-backdrop { position: fixed; inset: 0; z-index: 40; }
        .vm-menu { position: absolute; right: 0; bottom: 44px; z-index: 41; min-width: 210px; background: var(--mn-surface-2, var(--mn-surface)); border: 0.5px solid var(--mn-border); border-radius: 14px; box-shadow: 0 12px 32px rgba(0,0,0,0.45); padding: 6px; display: flex; flex-direction: column; }
        .vm-menu button { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; padding: 10px 12px; border: 0; background: transparent; color: var(--mn-text); font-size: 13px; border-radius: 9px; cursor: pointer; }
        .vm-menu button:hover { background: var(--mn-surface); }

        .vm-meta { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
        .vm-note-chip, .vm-rem-chip { display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 16px; padding: 7px 10px; border-radius: 10px; }
        .vm-note-chip { background: rgba(234,179,8,0.12); color: #eab308; }
        .vm-note-chip span { color: var(--mn-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .vm-note-chip em { color: var(--mn-text-3); font-style: normal; flex-shrink: 0; }
        .vm-rem-chip { background: rgba(59,130,246,0.12); color: #3b82f6; }
        .vm-rem-chip span { color: var(--mn-text); }

        .vm-edit { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; padding: 10px; border: 0.5px solid var(--mn-border); border-radius: 14px; background: var(--mn-bg); }
        .vm-edit-lbl { font-size: 11px; color: var(--mn-text-3); }
        .vm-note-input, .vm-rem-input { width: 100%; border: 0.5px solid var(--mn-border); background: var(--mn-surface) !important; color: var(--mn-text) !important; border-radius: 10px; padding: 8px 10px; font-size: 13px; outline: none; font-family: inherit; resize: vertical; }
        .vm-edit-btns { display: flex; justify-content: flex-end; gap: 8px; }
        .vm-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 10px; border: 0.5px solid var(--mn-border); background: var(--mn-surface); color: var(--mn-text); font-size: 13px; font-weight: 500; cursor: pointer; }
        .vm-btn.primary { background: #3b82f6; border-color: #3b82f6; color: #fff; }
        .vm-btn.primary:disabled { opacity: 0.5; cursor: default; }
        .vm-btn.ghost { background: transparent; }
        .vm-btn.ghost.danger { color: #ef4444; }

        .vm-alert-overlay { position: absolute; inset: 0; z-index: 60; background: rgba(3,8,18,0.72); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; padding: 22px; }
        .vm-alert { width: 100%; background: var(--mn-surface); border: 0.5px solid var(--mn-border); border-radius: 22px; padding: 22px 18px; text-align: center; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
        .vm-alert-icon { display: grid; place-items: center; width: 56px; height: 56px; margin: 0 auto 12px; border-radius: 50%; background: rgba(59,130,246,0.16); color: #3b82f6; }
        .vm-alert-title { font-size: 12px; letter-spacing: 1px; text-transform: uppercase; color: var(--mn-text-3); }
        .vm-alert-name { font-size: 20px; font-weight: 600; color: var(--mn-text); margin-top: 4px; }
        .vm-alert-label { font-size: 14px; color: var(--mn-text-2); margin-top: 6px; }
        .vm-alert-note { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--mn-text-2); margin-top: 10px; background: rgba(234,179,8,0.12); padding: 7px 10px; border-radius: 10px; }
        .vm-alert-btns { display: flex; gap: 10px; margin-top: 18px; }
        .vm-alert-btns .vm-btn { flex: 1; justify-content: center; padding: 12px; }
        .vm-alert-more { margin-top: 12px; font-size: 12px; color: var(--mn-text-3); }

        .mini-tabs { display: flex; border-top: 0.5px solid var(--mn-line); background: var(--mn-bg); }
        .mini-tabs button { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 8px 0 11px; border: 0; background: transparent; color: var(--mn-text-4); font-size: 10px; cursor: pointer; transition: color .16s ease; }
        .mini-tabs .active { color: #3b82f6; }
        .empty { text-align: center; color: var(--mn-text-3); padding: 40px 10px; font-size: 13px; }
`}</style>
    </main>
  );
}
