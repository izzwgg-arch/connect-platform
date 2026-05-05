"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Bell,
  ChevronLeft,
  Clock3,
  Delete,
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
  Voicemail,
} from "lucide-react";
import { useAppContext } from "../hooks/useAppContext";
import { useSipPhone } from "../hooks/useSipPhone";
import { apiGet, getPortalApiBaseUrl } from "../services/apiClient";
import { loadContacts, loadSmsThreads, type ContactRow, type SmsThread } from "../services/platformData";
import { readAuthToken } from "../services/session";

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
    audio.preload = "metadata";
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

export function DesktopMiniDialer() {
  const phone = useSipPhone();
  const { user, tenant, adminScope } = useAppContext();
  const [tab, setTab] = useState<TabKey>("dialer");
  const [calls, setCalls] = useState<MiniCallRow[]>([]);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [threads, setThreads] = useState<SmsThread[]>([]);
  const [voicemails, setVoicemails] = useState<MiniVoicemail[]>([]);
  const [settings, setSettings] = useState<{ alwaysOnTop?: boolean }>({});
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
          color: #e5eefb;
          background:
            radial-gradient(circle at 10% 0%, rgba(33, 150, 243, 0.20), transparent 34%),
            radial-gradient(circle at 100% 20%, rgba(16, 185, 129, 0.15), transparent 28%),
            #07111f;
          border: 1px solid rgba(148, 163, 184, 0.18);
          overflow: hidden;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .mini-header {
          -webkit-app-region: drag;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 14px 10px;
          border-bottom: 1px solid rgba(148, 163, 184, 0.10);
          backdrop-filter: blur(16px);
        }
        .mini-identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .mini-avatar, .call-avatar, .row-icon {
          display: grid;
          place-items: center;
          width: 36px;
          height: 36px;
          border-radius: 16px;
          background: linear-gradient(135deg, rgba(56, 189, 248, 0.35), rgba(16, 185, 129, 0.18));
          border: 1px solid rgba(125, 211, 252, 0.28);
          box-shadow: 0 16px 30px rgba(0, 0, 0, 0.22);
          font-weight: 800;
        }
        .mini-identity strong, .active-party strong, .mini-row strong { display: block; font-size: 13px; color: #f8fafc; }
        .mini-status, .mini-row span, .active-party span { display: block; margin-top: 2px; font-size: 11px; color: #94a3b8; }
        .mini-status:before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: #94a3b8; }
        .mini-status.green:before { background: #22c55e; box-shadow: 0 0 12px rgba(34,197,94,.75); }
        .mini-status.yellow:before { background: #f59e0b; }
        .mini-status.red:before { background: #ef4444; }
        .mini-window-actions { -webkit-app-region: no-drag; display: flex; gap: 5px; }
        button {
          border: 0;
          color: inherit;
          cursor: pointer;
          transition: transform .16s ease, background .16s ease, border-color .16s ease;
        }
        button:hover { transform: translateY(-1px); }
        button:disabled { opacity: .45; cursor: not-allowed; transform: none; }
        .mini-window-actions button {
          width: 28px;
          height: 28px;
          border-radius: 10px;
          background: rgba(15, 23, 42, 0.76);
          border: 1px solid rgba(148, 163, 184, 0.14);
        }
        .active-card {
          margin: 12px;
          padding: 14px;
          border-radius: 24px;
          background: rgba(15, 23, 42, 0.74);
          border: 1px solid rgba(125, 211, 252, 0.18);
          box-shadow: 0 24px 60px rgba(0,0,0,.28);
        }
        .active-party, .active-meta, .waiting-card, .answer-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .active-meta { margin-top: 12px; color: #94a3b8; font-size: 12px; }
        .active-meta strong { color: #f8fafc; font-size: 18px; font-variant-numeric: tabular-nums; }
        .waiting-card {
          margin-top: 12px;
          padding: 9px;
          border-radius: 16px;
          background: rgba(59, 130, 246, .12);
          border: 1px solid rgba(96,165,250,.18);
          font-size: 12px;
        }
        .waiting-card button, .answer-row button {
          padding: 7px 10px;
          border-radius: 12px;
          background: rgba(255,255,255,.08);
        }
        .call-controls {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 8px;
          margin-top: 14px;
        }
        .call-controls button {
          min-height: 58px;
          border-radius: 16px;
          background: rgba(255,255,255,.07);
          border: 1px solid rgba(255,255,255,.08);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 5px;
          font-size: 10px;
        }
        .call-controls svg { width: 16px; height: 16px; }
        .call-controls .hot { background: rgba(245,158,11,.2); }
        .call-controls .danger, .decline { background: linear-gradient(135deg, #ef4444, #b91c1c); color: #fff; }
        .answer { background: linear-gradient(135deg, #22c55e, #15803d); color: #fff; }
        .answer-row { margin-top: 12px; }
        .answer-row button { flex: 1; font-weight: 800; }
        .mini-tabs {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 7px;
          padding: 8px 12px 12px;
          border-top: 1px solid rgba(148, 163, 184, 0.10);
          background: rgba(7, 17, 31, 0.72);
          backdrop-filter: blur(16px);
        }
        .mini-tabs button {
          padding: 9px 5px;
          border-radius: 16px;
          background: rgba(15, 23, 42, .62);
          border: 1px solid rgba(148, 163, 184, .10);
          color: #94a3b8;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 5px;
          font-size: 11px;
        }
        .mini-tabs .active {
          color: #e0f2fe;
          background: rgba(14, 165, 233, .18);
          border-color: rgba(56, 189, 248, .34);
        }
        .mini-content { flex: 1; min-height: 0; overflow: auto; padding: 12px 12px 14px; }
        .dialer-pane { display: flex; flex-direction: column; gap: 10px; }
        .number-input, .route-select, .quick-reply input {
          width: 100%;
          box-sizing: border-box;
          padding: 12px 14px;
          border-radius: 18px;
          border: 1px solid rgba(148,163,184,.16);
          background: rgba(15,23,42,.72);
          color: #f8fafc;
          outline: none;
        }
        .number-input { font-size: 22px; text-align: center; letter-spacing: .04em; }
        .suggestions { display: flex; flex-direction: column; gap: 6px; min-height: 0; }
        .suggestions button {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          padding: 8px 10px;
          border-radius: 14px;
          background: rgba(255,255,255,.05);
        }
        .suggestions small { color: #94a3b8; text-align: right; }
        .keypad {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 9px;
        }
        .keypad button {
          height: 58px;
          border-radius: 20px;
          background: rgba(15, 23, 42, .78);
          border: 1px solid rgba(148, 163, 184, .12);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
        }
        .keypad strong { font-size: 21px; }
        .keypad span { color: #64748b; font-size: 9px; height: 11px; }
        .dialer-actions {
          display: grid;
          grid-template-columns: 1fr 64px;
          gap: 10px;
          align-items: center;
        }
        .call-button {
          height: 54px;
          border-radius: 20px;
          background: linear-gradient(135deg, #22c55e, #16a34a);
          color: #fff;
          box-shadow: 0 18px 30px rgba(34,197,94,.28);
        }
        .delete-button {
          height: 54px;
          border-radius: 20px;
          background: rgba(255,255,255,.07);
          border: 1px solid rgba(255,255,255,.10);
        }
        .list-pane { display: flex; flex-direction: column; gap: 8px; }
        .mini-row {
          display: grid;
          grid-template-columns: 42px 1fr auto;
          gap: 9px;
          align-items: center;
          padding: 10px;
          border-radius: 18px;
          background: rgba(15, 23, 42, .64);
          border: 1px solid rgba(148, 163, 184, .10);
        }
        .mini-row button, .open-full {
          padding: 8px 10px;
          border-radius: 13px;
          background: rgba(56, 189, 248, .16);
          color: #bae6fd;
        }
        .row-icon { width: 36px; height: 36px; border-radius: 14px; }
        .row-icon.missed { background: rgba(239,68,68,.18); }
        .row-icon.new { background: rgba(34,197,94,.20); }
        .vm-player {
          margin-top: 9px;
          display: grid;
          grid-template-columns: 34px 1fr;
          gap: 9px;
          align-items: center;
          padding: 8px;
          border-radius: 16px;
          background: linear-gradient(135deg, rgba(14,165,233,.13), rgba(99,102,241,.08));
          border: 1px solid rgba(125, 211, 252, .18);
          box-shadow: inset 0 1px 0 rgba(255,255,255,.06);
        }
        .vm-player[data-error="true"] {
          background: rgba(239, 68, 68, .10);
          border-color: rgba(248, 113, 113, .24);
        }
        .vm-play {
          width: 34px;
          height: 34px;
          border-radius: 14px;
          display: grid;
          place-items: center;
          color: #e0f2fe;
          background: linear-gradient(135deg, rgba(56,189,248,.32), rgba(14,165,233,.16));
          border: 1px solid rgba(125,211,252,.24);
          box-shadow: 0 10px 24px rgba(14,165,233,.13);
        }
        .vm-progress-wrap { min-width: 0; display: grid; gap: 5px; }
        .vm-progress {
          width: 100%;
          height: 4px;
          accent-color: #38bdf8;
          cursor: pointer;
        }
        .vm-time {
          display: flex;
          justify-content: space-between;
          color: #8fb3c8;
          font-size: 10px;
          font-weight: 800;
          letter-spacing: .02em;
        }
        .quick-reply { display: grid; grid-template-columns: 1fr 42px; gap: 8px; margin-top: 8px; }
        .open-full { margin-top: 4px; width: 100%; }
        .empty { text-align: center; color: #94a3b8; padding: 32px 10px; }
      `}</style>
    </main>
  );
}
