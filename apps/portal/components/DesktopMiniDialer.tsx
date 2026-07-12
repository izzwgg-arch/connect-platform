"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Bell,
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
  Send,
  Settings,
  Voicemail,
} from "lucide-react";
import { useAppContext } from "../hooks/useAppContext";
import { useSipPhone } from "../hooks/useSipPhone";
import { apiGet, getPortalApiBaseUrl } from "../services/apiClient";
import { loadContacts, loadSmsThreads, type ContactRow, type SmsThread } from "../services/platformData";
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

  return (
    <div className="vm-player" data-error={error ? "true" : "false"}>
      <button type="button" className="vm-play" onClick={toggle} aria-label={playing ? "Pause voicemail" : "Play voicemail"}>
        {error ? <AlertCircle size={14} /> : playing ? <Pause size={15} /> : <Play size={15} />}
      </button>
      <div className="vm-progress-wrap">
        <input
          className="vm-progress"
          type="range"
          min={0}
          max={max}
          step={0.1}
          value={Math.min(current, max)}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <div className="vm-time">
          <span>{formatDuration(current)}</span>
          <span>{error ? "Can't play" : formatDuration(max)}</span>
        </div>
      </div>
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
  const [tab, setTab] = useState<TabKey>("dialer");
  const [calls, setCalls] = useState<MiniCallRow[]>([]);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [threads, setThreads] = useState<SmsThread[]>([]);
  const [voicemails, setVoicemails] = useState<MiniVoicemail[]>([]);
  const [settings, setSettings] = useState<MiniDesktopSettings>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quickReply, setQuickReply] = useState("");
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
    if (value && phone.regState === "registered") phone.dial(value);
  };

  const selectedSession = phone.sessions.find((session) => session.isActive) || phone.sessions[0] || null;
  const incomingWaiting = phone.sessions.filter((session) => session.state === "ringing" && !session.isActive);

  return (
    <main className="mini-shell">
      <header className="mini-header">
        <div className="mini-identity">
          <div className="mini-avatar">{initials(user?.name || tenant?.name)}</div>
          <div>
            <strong>{user?.name || tenant?.name || "Connect"}</strong>
            <span className={`mini-status ${registration.tone}`}>{registration.label}</span>
          </div>
        </div>
        <div className="mini-window-actions">
          <div className="settings-wrap">
            <button
              title="Mini dialer settings"
              aria-label="Mini dialer settings"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((value) => !value)}
            >
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
                  <select
                    value={phone.currentMicDeviceId}
                    onChange={(event) => updateMicDevice(event.target.value)}
                  >
                    <option value="">System default microphone</option>
                    {phone.audioInputDevices.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `Microphone ${device.deviceId.slice(0, 6)}`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="settings-field">
                  <span>Speaker / headset output</span>
                  <select
                    value={phone.currentSinkId}
                    onChange={(event) => updateSpeakerDevice(event.target.value)}
                  >
                    <option value="">System default speaker</option>
                    {phone.audioOutputDevices.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `Speaker ${device.deviceId.slice(0, 6)}`}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="settings-section-label">Ringer</div>
                <label className="settings-field">
                  <span>Ringer output (rings here even during a headset call)</span>
                  <select
                    value={ringerDeviceId}
                    onChange={(event) => updateRingerDevice(event.target.value)}
                  >
                    <option value="">System default speaker</option>
                    {phone.audioOutputDevices.map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `Speaker ${device.deviceId.slice(0, 6)}`}
                      </option>
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
                    onChange={(event) => updateRingerVolume(Number(event.target.value) / 100)}
                    style={{ width: "100%" }}
                  />
                </label>
                <div className="settings-section-label">Startup</div>
                <MiniToggle
                  checked={settings.startOnLogin !== false}
                  label="Start with Windows"
                  hint="Open Connect when this computer starts"
                  onChange={(checked) => updateDesktopSettings({ startOnLogin: checked })}
                />
                <MiniToggle
                  checked={settings.openMinimizedToTray !== false}
                  label="Open minimized"
                  hint="Start quietly in the system tray"
                  onChange={(checked) => updateDesktopSettings({ openMinimizedToTray: checked })}
                />
                <MiniToggle
                  checked={Boolean(settings.openMiniOnStartup)}
                  label="Open mini dialer"
                  hint="Show this floating dialer on startup"
                  onChange={(checked) => updateDesktopSettings({ openMiniOnStartup: checked })}
                />
              </div>
            )}
          </div>
          <button title="Always on top" onClick={() => window.connectDesktop?.window?.toggleAlwaysOnTop?.()}>
            {settings.alwaysOnTop ? <Pin size={15} /> : <PinOff size={15} />}
          </button>
          <button title="Minimize" onClick={() => window.connectDesktop?.window?.minimize?.()}><ChevronLeft size={15} /></button>
          <button title="Open full app" onClick={() => window.connectDesktop?.window?.expandToFull?.("/dashboard/voice/phone")}><Maximize2 size={15} /></button>
          <button title="Close mini window" onClick={() => window.connectDesktop?.window?.closeMini?.()}>×</button>
        </div>
      </header>

      {inCall && (
        <section className="active-card">
          <div className="active-party">
            <div className="call-avatar"><PhoneCall size={22} /></div>
            <div>
              <span>{phone.callDirection === "inbound" ? "Incoming call" : "Active call"}</span>
              <strong>{selectedSession?.remoteParty || phone.remoteParty || phone.dialpadInput || "Unknown caller"}</strong>
            </div>
          </div>
          <div className="active-meta">
            <span>{callStatusLabel(phone.callState)}</span>
            <strong>{formatDuration(timerSec)}</strong>
          </div>
          {incomingWaiting.length > 0 && (
            <div className="waiting-card">
              <Bell size={15} />
              <span>Call waiting: {incomingWaiting[0]?.remoteParty}</span>
              <button onClick={() => phone.answerSession(incomingWaiting[0]!.id)}>Answer</button>
              <button onClick={() => phone.hangupSession(incomingWaiting[0]!.id)}>Decline</button>
            </div>
          )}
          <div className="call-controls">
            <button onClick={() => phone.setMute(!phone.muted)} className={phone.muted ? "hot" : ""}>{phone.muted ? <MicOff /> : <Mic />}<span>Mute</span></button>
            <button onClick={phone.toggleHold} className={phone.onHold ? "hot" : ""}><Clock3 /><span>Hold</span></button>
            <button onClick={() => setTab("dialer")}><Plus /><span>Keypad</span></button>
            <button onClick={() => phone.transfer(prompt("Transfer to extension or number") || "")}><Send /><span>Transfer</span></button>
            <button className="danger" onClick={phone.hangup}><PhoneOff /><span>End</span></button>
          </div>
          {phone.callState === "ringing" && phone.callDirection === "inbound" && (
            <div className="answer-row">
              <button className="answer" onClick={phone.answer}>Answer</button>
              <button className="decline" onClick={phone.hangup}>Decline</button>
            </div>
          )}
        </section>
      )}

      <section className="mini-content">
        {tab === "dialer" && (
          <div className="dialer-pane">
            <input
              className="number-input"
              value={phone.dialpadInput}
              placeholder="Search or dial"
              onChange={(event) => phone.setDialpadInput(event.target.value.replace(/[^\d*#+]/g, ""))}
              onKeyDown={(event) => {
                if (event.key === "Enter") callTarget(phone.dialpadInput);
                if (event.key === "Backspace" && !phone.dialpadInput) event.preventDefault();
              }}
            />
            <select
              className="route-select"
              value={phone.selectedOutboundRouteId}
              onChange={(event) => phone.setSelectedOutboundRouteId(event.target.value)}
            >
              {routeOptions.map((route) => <option key={route.id || "none"} value={route.id}>{route.name}</option>)}
            </select>
            {dialSuggestions.length > 0 && (
              <div className="suggestions">
                {dialSuggestions.map((suggestion) => (
                  <button key={suggestion.id} onClick={() => phone.setDialpadInput(suggestion.number)}>
                    <span>{suggestion.label}</span>
                    <small>{suggestion.number} · {suggestion.meta}</small>
                  </button>
                ))}
              </div>
            )}
            <div className="keypad">
              {KEYS.map(([digit, letters]) => (
                <button key={digit} onClick={() => appendDigit(digit)}>
                  <strong>{digit}</strong>
                  <span>{letters}</span>
                </button>
              ))}
            </div>
            <div className="dialer-actions">
              <button className="call-button" disabled={phone.regState !== "registered" || !phone.dialpadInput.trim()} onClick={() => callTarget(phone.dialpadInput)}>
                <Phone size={20} />
              </button>
              <button className="delete-button" onClick={() => phone.setDialpadInput((prev) => prev.slice(0, -1))}>
                <Delete size={20} />
              </button>
            </div>
          </div>
        )}

        {tab === "calls" && (
          <div className="list-pane">
            {calls.map((call) => {
              const target = call.direction === "outgoing" ? call.toNumber : call.fromNumber;
              return (
                <article className="mini-row" key={call.rowId || call.callId || `${target}-${call.startedAt}`}>
                  <div className={`row-icon ${call.status === "missed" ? "missed" : ""}`}><PhoneIncoming size={16} /></div>
                  <div>
                    <strong>{call.fromName || target || "Unknown"}</strong>
                    <span>{call.direction || "call"} · {call.status || "completed"} · {formatDuration(call.durationSec)}</span>
                  </div>
                  <button onClick={() => target && callTarget(target)}>Call</button>
                </article>
              );
            })}
            {calls.length === 0 && <p className="empty">No recent calls yet.</p>}
          </div>
        )}

        {tab === "messages" && (
          <div className="list-pane">
            {threads.map((thread) => (
              <article className="mini-row" key={thread.id}>
                <div className="row-icon"><MessageSquare size={16} /></div>
                <div>
                  <strong>{thread.phone}</strong>
                  <span>{thread.preview}</span>
                </div>
                <button onClick={() => window.connectDesktop?.window?.expandToFull?.(`/sms?phone=${encodeURIComponent(thread.phone)}`)}>Open</button>
              </article>
            ))}
            {threads.length > 0 && (
              <div className="quick-reply">
                <input placeholder="Quick reply opens full thread" value={quickReply} onChange={(event) => setQuickReply(event.target.value)} />
                <button onClick={() => window.connectDesktop?.window?.expandToFull?.("/sms")}><Send size={15} /></button>
              </div>
            )}
            {threads.length === 0 && <p className="empty">No messages yet.</p>}
          </div>
        )}

        {tab === "voicemail" && (
          <div className="list-pane">
            {voicemails.map((vm) => (
              <article className="mini-row voicemail-row" key={vm.id}>
                <div className={`row-icon ${!vm.listened ? "new" : ""}`}><Voicemail size={16} /></div>
                <div>
                  <strong>{vm.callerName || vm.callerId}</strong>
                  <span>{shortTime(vm.receivedAt)} · {formatDuration(vm.durationSec)}</span>
                  <VoicemailPlayer src={vm.streamUrl || voicemailStreamUrl(vm.id)} durationSec={vm.durationSec} />
                </div>
                <button onClick={() => callTarget(vm.callerId)}>Call</button>
              </article>
            ))}
            <button className="open-full" onClick={() => window.connectDesktop?.window?.expandToFull?.("/voicemail")}>Open full voicemail</button>
            {voicemails.length === 0 && <p className="empty">No voicemails.</p>}
          </div>
        )}
      </section>

      <nav className="mini-tabs">
        {[
          ["dialer", Phone, "Dialer"],
          ["calls", Clock3, "Calls"],
          ["messages", MessageSquare, "Messages"],
          ["voicemail", Voicemail, "Voicemail"],
        ].map(([key, Icon, label]) => (
          <button key={String(key)} className={tab === key ? "active" : ""} onClick={() => setTab(key as TabKey)}>
            <Icon size={16} />
            <span>{label as string}</span>
          </button>
        ))}
      </nav>

      <style jsx>{`
        .mini-shell {
          height: 100vh;
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          color: #f0f4ff;
          background: #090e18;
          border: 1px solid #1e2d47;
          overflow: hidden;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .mini-header {
          -webkit-app-region: drag;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 13px 14px 11px;
          border-bottom: 0.5px solid #162036;
          background: #090e18;
        }
        .mini-identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .mini-avatar, .call-avatar, .row-icon {
          display: grid;
          place-items: center;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          background: rgba(59, 130, 246, 0.14);
          border: 1px solid rgba(59, 130, 246, 0.30);
          color: #93c5fd;
          font-weight: 500;
        }
        .mini-identity strong, .active-party strong, .mini-row strong {
          display: block;
          font-size: 15px;
          font-weight: 500;
          color: #f0f4ff;
          letter-spacing: -0.2px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .mini-status, .mini-row span, .active-party span {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: #8899bb;
        }
        .mini-status:before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #4d6088; }
        .mini-status.green:before { background: #22c55e; }
        .mini-status.yellow:before { background: #f59e0b; }
        .mini-status.red:before { background: #ef4444; }
        .mini-window-actions { -webkit-app-region: no-drag; display: flex; align-items: center; gap: 4px; }
        .settings-wrap { position: relative; }
        .mini-window-actions button {
          -webkit-app-region: no-drag;
          display: grid;
          place-items: center;
          width: 30px;
          height: 30px;
          border-radius: 10px;
          border: 0.5px solid #1e2d47;
          background: #111827;
          color: #8899bb;
          cursor: pointer;
          transition: background .16s ease, color .16s ease;
        }
        .mini-window-actions button:hover { background: #162034; color: #f0f4ff; }
        .settings-popover {
          position: absolute;
          top: 36px;
          right: 8px;
          z-index: 20;
          width: min(330px, calc(100vw - 16px));
          max-height: calc(100vh - 52px);
          overflow-y: auto;
          padding: 14px;
          border-radius: 16px;
          background: #111827;
          border: 0.5px solid #1e2d47;
          box-shadow: 0 24px 70px rgba(0,0,0,.55);
        }
        .settings-title { display: flex; align-items: center; gap: 10px; color: #f0f4ff; margin-bottom: 12px; }
        .settings-title span:last-child { display: flex; flex-direction: column; }
        .settings-title strong { font-size: 14px; font-weight: 500; }
        .settings-title small { font-size: 11px; color: #8899bb; }
        .settings-title-icon {
          display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%;
          background: rgba(59,130,246,0.14); border: 1px solid rgba(59,130,246,0.30); color: #93c5fd;
        }
        .settings-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
        .settings-field span { font-size: 12px; color: #8899bb; }
        .settings-field select, .settings-field input[type="range"] {
          width: 100%;
          height: 38px;
          border-radius: 12px;
          border: 0.5px solid #1e2d47;
          background: #162034;
          color: #f0f4ff;
          font-size: 13px;
          padding: 0 10px;
          outline: none;
        }
        .settings-field input[type="range"] { height: 26px; padding: 0; accent-color: #3b82f6; }
        .settings-section-label { font-size: 11px; font-weight: 500; color: #4d6088; text-transform: uppercase; letter-spacing: 1px; margin: 6px 0 8px; }
        .settings-popover .settings-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 0; border-top: 0.5px solid #162036; }
        .settings-popover .settings-toggle-row span { display: flex; flex-direction: column; }
        .settings-popover .settings-toggle-row strong { font-size: 13px; font-weight: 500; color: #f0f4ff; }
        .settings-popover .settings-toggle-row small { font-size: 11px; color: #8899bb; }
        .settings-popover .settings-toggle-row i { position: relative; width: 40px; height: 23px; border-radius: 999px; background: #1e2d47; transition: background .16s ease; flex-shrink: 0; }
        .settings-popover .settings-toggle-row i:after { content: ""; position: absolute; top: 2px; left: 2px; width: 19px; height: 19px; border-radius: 50%; background: #8899bb; transition: transform .16s ease, background .16s ease; }
        .settings-popover .settings-toggle-row i[data-on="true"] { background: #3b82f6; }
        .settings-popover .settings-toggle-row i[data-on="true"]:after { transform: translateX(17px); background: #fff; }

        .active-card {
          position: absolute;
          inset: 0;
          z-index: 30;
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 54px 24px 28px;
          background: #0b1330;
        }
        .active-party { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 4px; }
        .active-party .call-avatar {
          width: 116px; height: 116px; border-radius: 50%;
          background: rgba(34,197,94,0.15); border: 2px solid rgba(34,197,94,0.4); color: #22c55e;
          margin-bottom: 18px;
        }
        .active-party strong { font-size: 24px; }
        .active-party span { font-size: 12px; letter-spacing: 3px; text-transform: uppercase; color: rgba(34,197,94,0.9); justify-content: center; }
        .active-meta { display: flex; flex-direction: column; align-items: center; gap: 2px; margin-top: 6px; }
        .active-meta span { font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: #34d399; }
        .active-meta strong { font-size: 15px; color: #8899bb; font-variant-numeric: tabular-nums; }
        .waiting-card { display: flex; align-items: center; gap: 8px; margin-top: 14px; padding: 8px 12px; border-radius: 14px; background: rgba(30,45,71,0.7); border: 1px solid rgba(147,197,253,0.25); font-size: 12px; color: #dbe4ff; }
        .waiting-card button { border: 0; border-radius: 10px; padding: 6px 10px; font-size: 12px; font-weight: 500; cursor: pointer; color: #fff; }
        .waiting-card button:first-of-type { background: #22c55e; }
        .waiting-card button:last-of-type { background: #ef4444; }
        .call-controls { margin-top: auto; display: grid; grid-template-columns: repeat(3, 72px); gap: 20px 22px; justify-content: center; margin-bottom: 22px; }
        .call-controls button {
          display: flex; flex-direction: column; align-items: center; gap: 7px;
          border: 0; background: transparent; color: #8899bb; font-size: 11px; cursor: pointer;
        }
        .call-controls button > :first-child, .call-controls svg {
          display: grid; place-items: center; width: 64px; height: 64px; border-radius: 50%;
          background: rgba(30,45,71,0.55); border: 1px solid #1e2d47; color: #dbe4ff;
        }
        .call-controls .hot > :first-child, .call-controls .hot svg { background: #f0f4ff; border-color: #f0f4ff; color: #0a1128; }
        .call-controls .danger > :first-child, .call-controls .danger svg, .call-controls .decline svg { background: #ef4444; border-color: #ef4444; color: #fff; }
        .answer-row { display: flex; justify-content: space-around; width: 100%; margin-bottom: 10px; }
        .answer-row button { display: flex; flex-direction: column; align-items: center; gap: 10px; border: 0; background: transparent; color: rgba(240,244,255,0.7); font-size: 13px; cursor: pointer; }
        .answer, .answer-row button.answer { }
        .answer-row .answer:before { content: ""; }
        .answer-row button:before {
          content: ""; display: grid; place-items: center; width: 76px; height: 76px; border-radius: 50%;
        }
        .answer { color: #fff; }
        .call-controls .danger, .decline { color: #fff; }

        .mini-tabs {
          display: flex;
          border-top: 0.5px solid #162036;
          background: #090e18;
        }
        .mini-tabs button {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 3px;
          padding: 9px 0 11px;
          border: 0;
          background: transparent;
          color: #374869;
          font-size: 10px;
          cursor: pointer;
          transition: color .16s ease;
        }
        .mini-tabs .active { color: #3b82f6; }
        .mini-content { flex: 1; overflow-y: auto; overflow-x: hidden; }
        .dialer-pane { display: flex; flex-direction: column; padding: 14px 16px 10px; height: 100%; }
        .number-input, .route-select, .quick-reply input {
          width: 100%;
          height: 46px;
          border-radius: 14px;
          border: 0.5px solid #1e2d47;
          background: #111827;
          color: #f0f4ff;
          font-size: 20px;
          text-align: center;
          letter-spacing: 1px;
          outline: none;
        }
        .number-input::placeholder { color: #4d6088; font-size: 15px; letter-spacing: 0; }
        .route-select { height: 34px; font-size: 12px; margin-top: 8px; text-align: left; padding: 0 10px; color: #8899bb; }
        .suggestions { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
        .suggestions button { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 8px 10px; border: 0; border-radius: 12px; background: #111827; color: #f0f4ff; font-size: 14px; cursor: pointer; }
        .suggestions small { color: #8899bb; font-size: 12px; }
        .keypad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 16px auto 12px; width: 100%; max-width: 264px; }
        .keypad button {
          display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
          height: 62px; border-radius: 50%; border: 0.5px solid #1e2d47; background: #111827; color: #f0f4ff; cursor: pointer;
          transition: background .12s ease;
        }
        .keypad button:hover { background: #162034; }
        .keypad strong { font-size: 24px; font-weight: 500; }
        .keypad span { font-size: 9px; letter-spacing: 1.5px; color: #4d6088; }
        .dialer-actions { display: flex; align-items: center; justify-content: center; gap: 24px; margin-top: auto; padding-bottom: 4px; }
        .call-button {
          display: grid; place-items: center; width: 62px; height: 62px; border-radius: 50%;
          border: 0; background: #22c55e; color: #fff; cursor: pointer;
          box-shadow: 0 8px 20px rgba(34,197,94,0.35);
        }
        .call-button:disabled { background: #1e2d47; color: #4d6088; box-shadow: none; cursor: default; }
        .delete-button { display: grid; place-items: center; width: 48px; height: 48px; border-radius: 50%; border: 0; background: transparent; color: #8899bb; cursor: pointer; }
        .list-pane { display: flex; flex-direction: column; }
        .mini-row { display: flex; align-items: center; gap: 12px; padding: 11px 16px; border-bottom: 0.5px solid #162036; }
        .mini-row > div:nth-child(2) { flex: 1; min-width: 0; }
        .mini-row button, .open-full {
          border: 0; border-radius: 10px; padding: 7px 14px; font-size: 12px; font-weight: 500;
          background: rgba(59,130,246,0.14); color: #93c5fd; cursor: pointer;
        }
        .row-icon.missed { background: rgba(239,68,68,0.14); border-color: rgba(239,68,68,0.3); color: #fb7185; }
        .row-icon.new { background: rgba(59,130,246,0.16); border-color: rgba(59,130,246,0.4); color: #93c5fd; }
        .voicemail-row { align-items: flex-start; }
        .vm-player { display: flex; align-items: center; gap: 9px; margin-top: 8px; }
        .vm-player[data-error="true"] { opacity: .5; }
        .vm-play { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 50%; border: 0; background: rgba(59,130,246,0.14); color: #93c5fd; cursor: pointer; flex-shrink: 0; }
        .vm-progress-wrap { flex: 1; height: 5px; border-radius: 3px; background: rgba(148,163,184,0.25); overflow: hidden; }
        .vm-progress { height: 100%; background: #3b82f6; }
        .vm-time { font-size: 11px; color: #4d6088; font-variant-numeric: tabular-nums; }
        .quick-reply { display: grid; grid-template-columns: 1fr 44px; gap: 8px; padding: 10px 16px; border-top: 0.5px solid #162036; }
        .quick-reply input { height: 40px; border-radius: 20px; font-size: 14px; text-align: left; padding: 0 14px; }
        .quick-reply button { display: grid; place-items: center; border: 0; border-radius: 50%; background: #3b82f6; color: #fff; cursor: pointer; }
        .open-full { margin: 10px 16px; width: calc(100% - 32px); padding: 10px; }
        .empty { text-align: center; color: #4d6088; padding: 40px 10px; font-size: 13px; }

      `}</style>
    </main>
  );
}
