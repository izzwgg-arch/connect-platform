"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  PhoneOff,
  Play,
  Pin,
  PinOff,
  Plus,
  Search,
  Send,
  Settings,
  Voicemail,
} from "lucide-react";
import { useAppContext } from "../hooks/useAppContext";
import { useSipPhone } from "../hooks/useSipPhone";
import { apiGet, getPortalApiBaseUrl } from "../services/apiClient";
import { loadContacts, loadSmsThreads, type ContactRow, type SmsThread } from "../services/platformData";
import { MiniChat } from "./chat/MiniChat";
import { readAuthToken } from "../services/session";
import {
  getWebRingerOutputDeviceId,
  setWebRingerOutputDeviceId,
  getWebRingerVolume,
  setWebRingerVolume,
} from "../hooks/telephonyAudioPreferences";

type TabKey = "dialer" | "calls" | "messages" | "voicemail";

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
};

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

function useCallTimer(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [active]);
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

function VoicemailPlayer({ src, durationSec }: { src: string; durationSec: number }) {
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
      .then(() => setPlaying(true))
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

function MiniToggle({
  checked,
  label,
  hint,
  onChange,
}: {
  checked: boolean;
  label: string;
  hint: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button type="button" className="settings-toggle-row" onClick={() => onChange(!checked)}>
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <i data-on={checked ? "true" : "false"} />
    </button>
  );
}

export function DesktopMiniDialer() {
  const phone = useSipPhone();
  const { user, tenant, adminScope } = useAppContext();
  // The pop-out window has its own storage and cannot read the portal's theme
  // choice, so it stays on the mobile-style dark palette. Pin the document theme
  // to dark too, so reused/global-styled controls (chat, form inputs) match.
  const [miniTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    const el = document.documentElement;
    const prev = el.getAttribute("data-theme");
    el.setAttribute("data-theme", "dark");
    return () => { if (prev) el.setAttribute("data-theme", prev); else el.removeAttribute("data-theme"); };
  }, []);
  const [tab, setTab] = useState<TabKey>("dialer");
  const [calls, setCalls] = useState<MiniCallRow[]>([]);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [threads, setThreads] = useState<SmsThread[]>([]);
  const [voicemails, setVoicemails] = useState<MiniVoicemail[]>([]);
  const [vmQuery, setVmQuery] = useState("");
  const [vmFilter, setVmFilter] = useState<"all" | "new" | "urgent" | "old">("all");
  const [settings, setSettings] = useState<MiniDesktopSettings>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quickReply, setQuickReply] = useState("");
  const [lastDialed, setLastDialed] = useState("");
  const inCall = phone.callState === "ringing" || phone.callState === "dialing" || phone.callState === "connected";
  const timerSec = useCallTimer(phone.callState === "connected");

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
      .then((result) => setVoicemails(Array.isArray(result.voicemails) ? result.voicemails : []))
      .catch(() => setVoicemails([]));
  }, [adminScope]);

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

  useEffect(() => {
    if (phone.callState === "ringing") setTab("dialer");
  }, [phone.callState]);

  const appendDigit = (digit: string) => {
    phone.setDialpadInput((prev) => `${prev}${digit}`);
    phone.playDtmfTone(digit);
  };

  const callTarget = (target: string) => {
    const value = target.trim();
    if (value && phone.regState === "registered") { phone.dial(value); setLastDialed(value); }
  };

  const selectedSession = phone.sessions.find((session) => session.isActive) || phone.sessions[0] || null;
  const incomingWaiting = phone.sessions.filter((session) => session.state === "ringing" && !session.isActive);

  return (
    <main className={"mini-shell" + (miniTheme === "light" ? " mini-light" : "")}>
      <div className="mini-titlebar">
        <div className="mini-drag" />
        <div className="mini-winbtns">
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
                  <input type="range" min={0} max={100} value={Math.round(ringerVolume * 100)} onChange={(e) => updateRingerVolume(Number(e.target.value) / 100)} style={{ width: "100%" }} />
                </label>
                <div className="settings-section-label">Startup</div>
                <MiniToggle checked={settings.startOnLogin !== false} label="Start with Windows" hint="Open Connect when this computer starts" onChange={(c) => updateDesktopSettings({ startOnLogin: c })} />
                <MiniToggle checked={settings.openMinimizedToTray !== false} label="Open minimized" hint="Start quietly in the system tray" onChange={(c) => updateDesktopSettings({ openMinimizedToTray: c })} />
                <MiniToggle checked={Boolean(settings.openMiniOnStartup)} label="Open mini dialer" hint="Show this floating dialer on startup" onChange={(c) => updateDesktopSettings({ openMiniOnStartup: c })} />
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
            <div className="call-rings"><span /><span /></div>
            <div className="call-label">Incoming call</div>
            <div className="call-avatar-lg green">{initials(selectedSession?.remoteParty || phone.remoteParty || "?")}</div>
            <strong className="call-name">{selectedSession?.remoteParty || phone.remoteParty || "Unknown caller"}</strong>
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
              <button onClick={() => setTab("dialer")}><span><Grid3x3 size={22} /></span>Keypad</button>
              <button className={phone.onHold ? "hot" : ""} onClick={phone.toggleHold}><span><Pause size={22} /></span>{phone.onHold ? "Resume" : "Hold"}</button>
              <button onClick={() => phone.transfer(prompt("Transfer to extension or number") || "")}><span><Send size={22} /></span>Transfer</button>
              <button onClick={() => setTab("dialer")}><span><Plus size={22} /></span>Add call</button>
            </div>
            <button className="round-btn hangup" onClick={phone.hangup}><Phone size={26} style={{ transform: "rotate(135deg)" }} /></button>
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
              return (
                <article className="mini-row" key={call.rowId || call.callId || `${target}-${call.startedAt}`}>
                  <div className={`row-icon ${missed ? "missed" : ""}`}>{call.direction === "outgoing" ? <PhoneCall size={16} /> : <PhoneIncoming size={16} />}</div>
                  <div className="row-main">
                    <strong>{call.fromName || target || "Unknown"}</strong>
                    <span>{call.direction || "call"} &#183; {call.status || "completed"} &#183; {formatDuration(call.durationSec)}</span>
                  </div>
                  <div className="row-time">{shortTime(call.startedAt)}</div>
                  <button className="row-call" onClick={() => target && callTarget(target)}><Phone size={17} /></button>
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
                      <span className="vm-av">{initials(vm.callerName || vm.callerId)}</span>
                      <div className="vm-info">
                        <strong>{vm.callerName || vm.callerId}</strong>
                        <small>{vm.callerId}</small>
                      </div>
                      <div className="vm-right">
                        {!vm.listened ? <span className="vm-badge new">NEW</span> : <span className="vm-badge read">READ</span>}
                        <span className="vm-dur">{formatDuration(vm.durationSec)}</span>
                      </div>
                    </div>
                    <VoicemailPlayer src={vm.streamUrl || voicemailStreamUrl(vm.id)} durationSec={vm.durationSec} />
                    {vm.transcription ? <p className="vm-transcript">{vm.transcription}</p> : null}
                    <div className="vm-actions">
                      <span className="vm-date"><Clock3 size={12} /> {shortTime(vm.receivedAt)}</span>
                      <button className="vm-callback" onClick={() => callTarget(vm.callerId)}><Phone size={13} /> Call back</button>
                    </div>
                  </div>
                ))}
              </div>
              {list.length === 0 && <p className="empty">No voicemails.</p>}
            </div>
          );
        })()}
      </section>

      <nav className="mini-tabs">
        {([["calls", Clock3, "Recents"], ["messages", MessageSquare, "Chat"], ["voicemail", Voicemail, "Voicemail"], ["dialer", Phone, "Dialer"]] as const).map(([key, Icon, label]) => (
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
        .settings-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0; border: 0 !important; border-top: 0.5px solid var(--mn-line) !important; background: transparent !important; width: 100%; text-align: left; cursor: pointer; color: var(--mn-text); }
        .settings-toggle-row span { display: flex; flex-direction: column; }
        .settings-toggle-row strong { font-size: 13px; font-weight: 500; }
        .settings-toggle-row small { font-size: 11px; color: var(--mn-text-2); }
        .settings-toggle-row i { position: relative; width: 40px; height: 23px; border-radius: 999px; background: var(--mn-border); flex-shrink: 0; transition: background .16s ease; }
        .settings-toggle-row i:after { content: ""; position: absolute; top: 2px; left: 2px; width: 19px; height: 19px; border-radius: 50%; background: var(--mn-text-2); transition: transform .16s ease, background .16s ease; }
        .settings-toggle-row i[data-on="true"] { background: #3b82f6; }
        .settings-toggle-row i[data-on="true"]:after { transform: translateX(17px); background: #fff; }

        .call-screen { position: absolute; inset: 0; z-index: 40; display: flex; flex-direction: column; align-items: center; padding: 40px 24px 26px; }
        .call-screen.incoming { background: #0b1330; }
        .call-screen.active { background: #0a1128; }
        .call-rings { position: absolute; top: 120px; width: 250px; height: 250px; border-radius: 50%; border: 1px solid rgba(34,197,94,0.18); }
        .call-rings span { position: absolute; top: 22px; left: 22px; width: 206px; height: 206px; border-radius: 50%; border: 1px solid rgba(34,197,94,0.28); }
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

        .mini-content { flex: 1; overflow-y: auto; overflow-x: hidden; }
        .screen { display: flex; flex-direction: column; }
        .screen-title { font-size: 24px; font-weight: 500; letter-spacing: -0.4px; padding: 16px 18px 10px; }
        .dialer-pane { padding: 14px 16px 10px; height: 100%; display: flex; flex-direction: column; --keyh: 56px; }
        .dialer-pane.with-suggestions { --keyh: 50px; }
        .number-input { width: 100%; height: 44px; border-radius: 14px; border: 0.5px solid var(--mn-border); background: var(--mn-surface) !important; color: var(--mn-text) !important; font-size: 20px; text-align: center; letter-spacing: 1px; outline: none; }
        .number-input::placeholder { color: var(--mn-text-3) !important; font-size: 15px; letter-spacing: 0; }
        .route-select { width: 100%; height: 34px; border-radius: 10px; border: 0.5px solid var(--mn-border); background: var(--mn-surface) !important; color: var(--mn-text-2) !important; font-size: 12px; padding: 0 10px; margin-top: 8px; outline: none; }
        .suggestions { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 2px; }
        .suggestions button { display: flex; align-items: center; gap: 11px; padding: 9px 12px; border: 0.5px solid var(--mn-border); border-radius: 14px; background: var(--mn-surface); color: var(--mn-text); cursor: pointer; text-align: left; } .suggestions button > :global(svg) { color: var(--mn-text-3); flex-shrink: 0; } .sugg-av { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 50%; background: rgba(136,153,187,0.16); color: var(--mn-text-2); font-size: 13px; font-weight: 500; flex-shrink: 0; } .sugg-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; } .sugg-main strong { font-size: 15px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .sugg-main small { font-size: 13px; color: var(--mn-text-2); }
        
        .keypad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin: auto auto 2px; width: 100%; max-width: 300px; }
        .keypad button { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; height: var(--keyh); border-radius: 12px; border: 0; background: transparent; color: var(--mn-text); cursor: pointer; }
        .keypad button:hover { background: var(--mn-surface-2); }
        .keypad strong { font-size: 30px; font-weight: 400; line-height: 1; }
        .keypad span { font-size: 9px; letter-spacing: 2px; color: var(--mn-text-3); font-weight: 500; }
        .dialer-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; justify-content: center; align-items: center; margin: 4px auto 6px; width: 100%; max-width: 300px; }
        .call-button { grid-column: 2; justify-self: center; display: grid; place-items: center; width: 60px; height: 60px; border-radius: 50%; border: 0; background: #22c55e; color: #fff; cursor: pointer; box-shadow: 0 8px 20px rgba(34,197,94,0.35); }
        .call-button:disabled { background: var(--mn-border); color: var(--mn-text-3); box-shadow: none; cursor: default; }
        .delete-button { grid-column: 3; justify-self: center; display: grid; place-items: center; width: 52px; height: 52px; border-radius: 50%; border: 0.5px solid var(--mn-border); background: rgba(30,45,71,0.55); color: var(--mn-text-2); cursor: pointer; }

        .list-pane { display: flex; flex-direction: column; }
        .mini-row { display: flex; align-items: center; gap: 12px; padding: 11px 16px; border-bottom: 0.5px solid var(--mn-line); }
        .row-icon { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: rgba(59,130,246,0.14); border: 1px solid rgba(59,130,246,0.3); color: #93c5fd; flex-shrink: 0; }
        .row-icon.missed { background: rgba(239,68,68,0.14); border-color: rgba(239,68,68,0.3); color: #fb7185; }
        .row-icon.new { background: rgba(59,130,246,0.16); border-color: rgba(59,130,246,0.4); color: #93c5fd; }
        .row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
        .row-main strong { font-size: 15px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; }
        .row-main span { font-size: 12px; color: var(--mn-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .row-preview { color: var(--mn-text-2); }
        .row-time { font-size: 12px; color: var(--mn-text-3); flex-shrink: 0; }
        .row-call { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; border: 0; background: rgba(59,130,246,0.14); color: #93c5fd; cursor: pointer; flex-shrink: 0; }
        .unread-dot { width: 8px; height: 8px; border-radius: 50%; background: #3b82f6; flex-shrink: 0; }

        .vm-screen { padding: 0; }
        .vm-header { text-align: center; padding: 14px 16px 10px; }
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
        .vm-callback { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 800; color: #3b82f6; padding: 6px 11px; border-radius: 12px; border: 0; background: rgba(59,130,246,0.14); cursor: pointer; white-space: nowrap; flex-shrink: 0; }

        .mini-tabs { display: flex; border-top: 0.5px solid var(--mn-line); background: var(--mn-bg); }
        .mini-tabs button { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 8px 0 11px; border: 0; background: transparent; color: var(--mn-text-4); font-size: 10px; cursor: pointer; transition: color .16s ease; }
        .mini-tabs .active { color: #3b82f6; }
        .empty { text-align: center; color: var(--mn-text-3); padding: 40px 10px; font-size: 13px; }
`}</style>
    </main>
  );
}
