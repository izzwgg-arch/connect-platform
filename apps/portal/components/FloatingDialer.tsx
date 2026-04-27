"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Info, MessageSquare, Phone, Search, X } from "lucide-react";
import { useTelephony } from "../contexts/TelephonyContext";
import { useAppContext } from "../hooks/useAppContext";
import { useAsyncResource } from "../hooks/useAsyncResource";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useSipPhone, type SipRegState } from "../hooks/useSipPhone";
import {
  getWebRingerEnabled,
  setWebRingerEnabled,
} from "../hooks/telephonyAudioPreferences";
import { loadPbxResource } from "../services/pbxData";

type PresenceState = "available" | "ringing" | "on_call" | "offline";

type BlfEntry = {
  id: string;
  name: string;
  extension: string;
  presence: PresenceState;
};

const DIALPAD: [string, string][] = [
  ["1", ""], ["2", "ABC"], ["3", "DEF"],
  ["4", "GHI"], ["5", "JKL"], ["6", "MNO"],
  ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"],
  ["*", ""], ["0", "+"], ["#", ""],
];

const PRESENCE_META: Record<PresenceState, { label: string; tone: string }> = {
  available: { label: "Available", tone: "green" },
  ringing: { label: "Ringing", tone: "yellow" },
  on_call: { label: "On Call", tone: "red" },
  offline: { label: "Offline", tone: "gray" },
};

function fmt(sec: number) {
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

function initials(value: string | null) {
  if (!value) return "?";
  const words = value.trim().split(/[\s@._-]+/).filter(Boolean);
  if (words.length > 1) return `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase();
  return (value.replace(/[^a-zA-Z0-9]/g, "")[0] ?? "?").toUpperCase();
}

function readString(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function normalizeTenantName(name: string | null | undefined): string {
  return (name ?? "").trim().toLowerCase();
}

function rowTenantMatches(row: Record<string, unknown>, tenantId: string | null | undefined, tenantName: string | null | undefined): boolean {
  if (!tenantId) return false;
  const selectedTenantName = normalizeTenantName(tenantName);
  const rowTenantName = normalizeTenantName(readString(row, ["tenantName", "tenant_name", "tenantDisplayName"]));
  if (selectedTenantName && rowTenantName) return rowTenantName === selectedTenantName;
  const directTenant = readString(row, ["tenantId", "tenant_id", "tenant", "platformTenantId", "platform_tenant_id"]);
  if (directTenant) return directTenant === tenantId;
  const nestedTenant = row.tenant;
  if (nestedTenant && typeof nestedTenant === "object") {
    const nestedId = readString(nestedTenant as Record<string, unknown>, ["id", "tenantId", "tenant_id"]);
    if (nestedId) return nestedId === tenantId;
  }
  return true;
}

function isValidTenantExtension(ext: string): boolean {
  return /^\d{3}$/.test(ext);
}

function isSystemExtensionName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized === "pbx user" ||
    /^pbx user\s+\d+$/.test(normalized) ||
    normalized.includes("invite lifecycle") ||
    normalized.includes("provisioning") ||
    normalized.includes("smoke") ||
    normalized.includes("system") ||
    normalized === "voice user" ||
    /^voice user\s+\d+$/.test(normalized)
  );
}

function mapPresence(rawState: string, ext: string, activeExts: Set<string>, ringingExts: Set<string>): PresenceState {
  if (ringingExts.has(ext)) return "ringing";
  if (activeExts.has(ext)) return "on_call";
  const state = rawState.toLowerCase();
  if (state === "not_inuse" || state === "idle" || state === "registered" || state === "0") return "available";
  if (state === "inuse" || state === "busy" || state === "onhold" || state === "1" || state === "3") return "on_call";
  if (state === "ringing" || state === "2") return "ringing";
  return "offline";
}

function statusFromRegistration(regState: SipRegState, hasError: boolean): { label: string; tone: string } {
  if (regState === "registered") return { label: "Ready", tone: "green" };
  if (regState === "connecting" || regState === "registering" || regState === "unregistering") {
    return { label: "Connecting", tone: "yellow" };
  }
  if (regState === "failed" || hasError) return { label: "Not registered", tone: "red" };
  return { label: "Offline", tone: "gray" };
}

function friendlyError(error: string | null, micPermission: string, regState: SipRegState): string | null {
  const raw = (error ?? "").toLowerCase();
  if (raw.includes("extension_not_assigned") || raw.includes("extension not assigned")) return "No extension assigned";
  if (raw.includes("microphone") || micPermission === "denied") return "Microphone permission needed";
  if (raw.includes("register") || regState === "failed") return "Phone not registered";
  if (raw.includes("connection") || raw.includes("transport") || raw.includes("websocket")) return "Connection issue";
  if (error) return "Connection issue";
  return null;
}

function MiniAvatar({ party }: { party: string | null }) {
  return <div className="fd-avatar">{initials(party)}</div>;
}

function ControlButton({
  label,
  onClick,
  active,
  disabled,
}: {
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button className="fd-control" data-active={active ? "true" : "false"} disabled={disabled} onClick={disabled ? undefined : onClick}>
      {label}
    </button>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="fd-toggle"
      data-on={checked ? "true" : "false"}
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function DiagnosticsPanel({
  phone,
}: {
  phone: ReturnType<typeof useSipPhone>;
}) {
  const rows = [
    ["TURN", phone.diag.hasTurn ? "Configured" : "Not configured"],
    ["Microphone", phone.diag.micPermission],
    ["Extension", phone.diag.extensionNumber ?? "Not assigned"],
    ["Registration", phone.regState],
    ["ICE", phone.diag.iceConnectionState ?? "Not connected"],
    ["Audio", phone.diag.remoteAudioReceiving ? "Receiving" : "Idle"],
  ];
  return (
    <div className="fd-diagnostics">
      {rows.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function BlfPanel({
  open,
  entries,
  search,
  onSearch,
  onDial,
  onMessage,
}: {
  open: boolean;
  entries: BlfEntry[];
  search: string;
  onSearch: (value: string) => void;
  onDial: (extension: string) => void;
  onMessage: (extension: string) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const rowHeight = 58;
  const viewportHeight = 430;
  const overscan = 6;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const count = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const slice = entries.slice(start, start + count);

  useEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [search]);

  return (
    <aside className="fd-blf" data-open={open ? "true" : "false"} aria-hidden={!open}>
      <div className="fd-blf-head">
        <div>
          <strong>BLF</strong>
          <span>{entries.length} extensions</span>
        </div>
      </div>
      <label className="fd-search">
        <Search size={15} />
        <input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Search name or extension" />
      </label>
      <div className="fd-blf-list" ref={scrollerRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        {entries.length === 0 ? (
          <div className="fd-empty">No tenant extensions found.</div>
        ) : (
          <div style={{ height: entries.length * rowHeight, position: "relative" }}>
            <div style={{ transform: `translateY(${start * rowHeight}px)` }}>
              {slice.map((entry) => {
                const meta = PRESENCE_META[entry.presence];
                return (
                  <div className="fd-blf-row" key={entry.id} style={{ height: rowHeight }}>
                    <button type="button" onClick={() => onDial(entry.extension)}>
                      <span className="fd-blf-ext">{entry.extension}</span>
                      <span>
                        <strong>{entry.name}</strong>
                        <em data-tone={meta.tone}><i />{meta.label}</em>
                      </span>
                    </button>
                    <button type="button" className="fd-blf-msg" title="Message" onClick={() => onMessage(entry.extension)}>
                      <MessageSquare size={15} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

export function FloatingDialer() {
  const phone = useSipPhone();
  const telephony = useTelephony();
  const { tenantId, tenant } = useAppContext();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [showDtmf, setShowDtmf] = useState(false);
  const [showXfer, setShowXfer] = useState(false);
  const [xferTarget, setXferTarget] = useState("");
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [blfOpen, setBlfOpen] = useState(false);
  const [rawBlfSearch, setRawBlfSearch] = useState("");
  const [ringerOn, setRingerOn] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const blfSearch = useDebouncedValue(rawBlfSearch, 120);

  const extState = useAsyncResource<{ rows: Record<string, unknown>[] }>(
    () => loadPbxResource("extensions"),
    [tenantId, tenant?.name],
  );

  const isInCall = phone.callState !== "idle" && phone.callState !== "ended";
  const isActive = phone.callState === "connected";
  const isIncoming = phone.callState === "ringing" && phone.callDirection === "inbound";
  const isOutgoing = phone.callState === "dialing" || (phone.callState === "ringing" && phone.callDirection === "outbound");
  const canDial = phone.regState === "registered" && phone.dialpadInput.trim().length > 0;
  const status = statusFromRegistration(phone.regState, Boolean(phone.error));
  const cleanError = friendlyError(phone.error, phone.diag.micPermission, phone.regState);

  useEffect(() => {
    setRingerOn(getWebRingerEnabled());
  }, []);

  useEffect(() => {
    if (phone.callState === "connected") {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      if (phone.callState === "idle" || phone.callState === "ended") setElapsed(0);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [phone.callState]);

  useEffect(() => {
    if ((phone.callState === "ringing" && phone.callDirection === "inbound") || phone.callState === "dialing") {
      setOpen(true);
    }
  }, [phone.callState, phone.callDirection]);

  useEffect(() => {
    if (phone.callState === "idle" || phone.callState === "ended") {
      setShowDtmf(false);
      setShowXfer(false);
      setXferTarget("");
    }
  }, [phone.callState]);

  useEffect(() => {
    if (!open || isInCall) return;
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open, isInCall]);

  const { activeExts, ringingExts } = useMemo(() => {
    const active = new Set<string>();
    const ringing = new Set<string>();
    const tenantCalls = tenantId ? telephony.activeCalls.filter((c) => c.tenantId === tenantId) : [];
    tenantCalls.forEach((call) => {
      const extensions = (call.extensions ?? []).filter(isValidTenantExtension);
      if (call.state === "up" || call.state === "held") extensions.forEach((ext) => active.add(ext));
      if (call.state === "ringing" || call.state === "dialing") extensions.forEach((ext) => ringing.add(ext));
    });
    return { activeExts: active, ringingExts: ringing };
  }, [telephony.activeCalls, tenantId]);

  const blfEntries = useMemo(() => {
    const rows = extState.status === "success" ? extState.data.rows : [];
    const mapped = rows.flatMap((row): BlfEntry[] => {
      if (!rowTenantMatches(row, tenantId, tenant?.name)) return [];
      const extension = readString(row, ["extension", "extNumber", "ext_number", "number", "sipExtension"]);
      if (!extension || !isValidTenantExtension(extension)) return [];
      const name = readString(row, ["displayName", "display_name", "name", "callerid", "callerId"]) ?? `Extension ${extension}`;
      if (isSystemExtensionName(name)) return [];
      const live = telephony.extensionList.find((entry) => entry.extension === extension);
      return [{
        id: readString(row, ["id", "uuid"]) ?? extension,
        name,
        extension,
        presence: mapPresence(live?.status ?? readString(row, ["state", "status"]) ?? "offline", extension, activeExts, ringingExts),
      }];
    });
    const fallback = mapped.length > 0 ? mapped : telephony.extensionList.flatMap((entry): BlfEntry[] => {
      if (entry.tenantId && entry.tenantId !== tenantId) return [];
      if (!isValidTenantExtension(entry.extension) || isSystemExtensionName(entry.hint || entry.extension)) return [];
      return [{
        id: entry.extension,
        name: entry.hint || `Extension ${entry.extension}`,
        extension: entry.extension,
        presence: mapPresence(entry.status ?? "offline", entry.extension, activeExts, ringingExts),
      }];
    });
    return fallback.sort((a, b) => a.extension.localeCompare(b.extension, undefined, { numeric: true }));
  }, [activeExts, extState, ringingExts, telephony.extensionList, tenant?.name, tenantId]);

  const visibleBlf = useMemo(() => {
    const query = blfSearch.trim().toLowerCase();
    if (!query) return blfEntries;
    return blfEntries.filter((entry) => entry.extension.includes(query) || entry.name.toLowerCase().includes(query));
  }, [blfEntries, blfSearch]);

  const handleDigit = useCallback((digit: string) => {
    if (phone.callState === "connected") {
      phone.sendDtmf(digit);
      return;
    }
    phone.playDtmfTone(digit);
    phone.setDialpadInput((prev) => `${prev}${digit}`);
    inputRef.current?.focus();
  }, [phone]);

  const dialTarget = useCallback((target: string) => {
    const trimmed = target.trim();
    if (!trimmed) return;
    phone.setDialpadInput(trimmed);
    setOpen(true);
    if (phone.regState === "registered") phone.dial(trimmed);
  }, [phone]);

  const updateRinger = useCallback((next: boolean) => {
    setRingerOn(next);
    setWebRingerEnabled(next);
  }, []);

  return (
    <>
      <style>{DIALER_CSS}</style>

      <button
        className="icon-btn"
        onClick={() => setOpen((value) => !value)}
        title={`Phone (${status.label})`}
        aria-label="Toggle phone dialer"
        style={{ position: "relative" }}
      >
        <Phone size={18} />
        <span className="fd-topbar-dot" data-tone={status.tone} />
        {isIncoming && <span className="fd-topbar-pulse" />}
      </button>

      {open && <div className="fd-overlay" onClick={() => !isInCall && setOpen(false)} aria-hidden />}

      {open && (
        <section
          className="fd-shell"
          data-blf-open={blfOpen ? "true" : "false"}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !isInCall) setOpen(false);
          }}
        >
          <BlfPanel
            open={blfOpen}
            entries={visibleBlf}
            search={rawBlfSearch}
            onSearch={setRawBlfSearch}
            onDial={(extension) => dialTarget(extension)}
            onMessage={(extension) => router.push(`/chat?ext=${encodeURIComponent(extension)}`)}
          />

          <div className="fd-card">
            <header className="fd-header">
              <div className="fd-status-pill" data-tone={status.tone}>
                <i />
                <span>{status.label}</span>
              </div>
              <div className="fd-header-actions">
                <button className="fd-chip-btn" type="button" onClick={() => setBlfOpen((value) => !value)} data-active={blfOpen ? "true" : "false"}>
                  BLF
                </button>
                <button className="fd-icon-plain" type="button" onClick={() => setShowDiagnostics((value) => !value)} title="Diagnostics">
                  <Info size={16} />
                </button>
                <button className="fd-icon-plain" type="button" onClick={() => setOpen(false)} aria-label="Close dialer">
                  <X size={17} />
                </button>
              </div>
            </header>

            {showDiagnostics && <DiagnosticsPanel phone={phone} />}

            {!isInCall && (
              <div className="fd-body">
                <div className="fd-number-wrap">
                  <input
                    ref={inputRef}
                    type="tel"
                    inputMode="tel"
                    placeholder="Type a number"
                    value={phone.dialpadInput}
                    onChange={(event) => phone.setDialpadInput(event.target.value)}
                    onKeyDown={(event) => {
                      const keys = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#"];
                      if (event.key === "Enter" && canDial) phone.dial(phone.dialpadInput);
                      if (keys.includes(event.key)) {
                        event.preventDefault();
                        handleDigit(event.key);
                      }
                    }}
                  />
                  {phone.dialpadInput && (
                    <button type="button" onClick={() => phone.setDialpadInput((value) => value.slice(0, -1))}>
                      Back
                    </button>
                  )}
                </div>

                {cleanError && (
                  <div className="fd-friendly-error">
                    <span>{cleanError}</span>
                    <button type="button" onClick={() => setShowDiagnostics(true)}>Details</button>
                  </div>
                )}

                <div className="fd-keypad">
                  {DIALPAD.map(([digit, letters]) => (
                    <button key={digit} type="button" onClick={() => handleDigit(digit)} onMouseDown={(event) => event.preventDefault()}>
                      <strong>{digit}</strong>
                      <span>{letters}</span>
                    </button>
                  ))}
                </div>

                <div className="fd-preferences">
                  <span>Ringer</span>
                  <Toggle checked={ringerOn} onChange={updateRinger} />
                </div>

                <button className="fd-call-btn" type="button" disabled={!canDial} onClick={() => phone.dial(phone.dialpadInput)}>
                  <Phone size={18} />
                  Call
                </button>
              </div>
            )}

            {isOutgoing && (
              <div className="fd-call-state">
                <MiniAvatar party={phone.remoteParty ?? phone.dialpadInput} />
                <strong>{phone.remoteParty ?? phone.dialpadInput}</strong>
                <span>{phone.callState === "dialing" ? "Calling" : "Ringing"}</span>
                <button className="fd-hangup" type="button" onClick={phone.hangup}>Hang up</button>
              </div>
            )}

            {isIncoming && (
              <div className="fd-call-state">
                <span className="fd-eyebrow">Incoming call</span>
                <MiniAvatar party={phone.remoteParty} />
                <strong>{phone.remoteParty ?? "Unknown caller"}</strong>
                <div className="fd-incoming-actions">
                  <button className="fd-hangup" type="button" onClick={phone.hangup}>Decline</button>
                  <button className="fd-answer" type="button" onClick={phone.answer}>Answer</button>
                </div>
              </div>
            )}

            {isActive && (
              <div className="fd-active">
                <div className="fd-active-party">
                  <MiniAvatar party={phone.remoteParty} />
                  <div>
                    <strong>{phone.remoteParty ?? "Connected"}</strong>
                    <span>{phone.onHold ? "On hold" : fmt(elapsed)}</span>
                  </div>
                </div>

                {showDtmf && (
                  <div className="fd-keypad fd-keypad-compact">
                    {DIALPAD.map(([digit, letters]) => (
                      <button key={digit} type="button" onClick={() => phone.sendDtmf(digit)}>
                        <strong>{digit}</strong>
                        <span>{letters}</span>
                      </button>
                    ))}
                  </div>
                )}

                {showXfer && (
                  <div className="fd-transfer">
                    <input
                      autoFocus
                      value={xferTarget}
                      onChange={(event) => setXferTarget(event.target.value)}
                      placeholder="Transfer to extension"
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && xferTarget.trim()) {
                          phone.transfer(xferTarget.trim());
                          setShowXfer(false);
                          setXferTarget("");
                        }
                        if (event.key === "Escape") {
                          setShowXfer(false);
                          setXferTarget("");
                        }
                      }}
                    />
                    <button type="button" disabled={!xferTarget.trim()} onClick={() => {
                      if (!xferTarget.trim()) return;
                      phone.transfer(xferTarget.trim());
                      setShowXfer(false);
                      setXferTarget("");
                    }}>
                      Transfer
                    </button>
                  </div>
                )}

                <div className="fd-controls">
                  <ControlButton label={phone.muted ? "Unmute" : "Mute"} active={phone.muted} onClick={() => phone.setMute(!phone.muted)} />
                  <ControlButton label="Keypad" active={showDtmf} onClick={() => { setShowDtmf((value) => !value); setShowXfer(false); }} />
                  <ControlButton label="Speaker" active={phone.speakerOn} onClick={phone.toggleSpeaker} />
                  <ControlButton label={phone.onHold ? "Resume" : "Hold"} active={phone.onHold} onClick={phone.toggleHold} />
                  <ControlButton label="Transfer" active={showXfer} onClick={() => { setShowXfer((value) => !value); setShowDtmf(false); }} />
                </div>

                <button className="fd-hangup fd-hangup-wide" type="button" onClick={phone.hangup}>End call</button>
              </div>
            )}
          </div>
        </section>
      )}
    </>
  );
}

const DIALER_CSS = `
@keyframes fdIn { from { opacity: 0; transform: translateY(-8px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
@keyframes fdPulse { 0%,100% { opacity: .45; transform: scale(1); } 50% { opacity: 1; transform: scale(1.16); } }
.fd-overlay { position: fixed; inset: 0; z-index: 199; background: transparent; }
.fd-topbar-dot { position: absolute; top: 3px; right: 3px; width: 8px; height: 8px; border-radius: 999px; border: 2px solid var(--panel); }
.fd-topbar-dot[data-tone="green"] { background: #22c55e; box-shadow: 0 0 8px rgba(34,197,94,.8); }
.fd-topbar-dot[data-tone="yellow"] { background: #f59e0b; }
.fd-topbar-dot[data-tone="red"] { background: #ef4444; }
.fd-topbar-dot[data-tone="gray"] { background: #64748b; }
.fd-topbar-pulse { position: absolute; inset: 0; border-radius: 9px; background: rgba(239,68,68,.18); animation: fdPulse 1s ease-in-out infinite; }
.fd-shell { --fd-bg: rgba(12,18,32,.88); --fd-card: rgba(15,23,42,.9); --fd-card-2: rgba(255,255,255,.06); --fd-border: rgba(148,163,184,.18); --fd-text: #f8fafc; --fd-muted: #9ca3af; --fd-soft: rgba(255,255,255,.08); --fd-shadow: 0 24px 70px rgba(0,0,0,.55); position: fixed; top: 62px; right: 12px; z-index: 200; width: min(calc(100vw - 24px), 690px); max-height: calc(100vh - 78px); display: flex; justify-content: flex-end; align-items: flex-start; gap: 10px; pointer-events: none; animation: fdIn .18s ease; }
:root[data-theme="light"] .fd-shell { --fd-bg: rgba(248,250,252,.96); --fd-card: rgba(255,255,255,.98); --fd-card-2: rgba(15,23,42,.04); --fd-border: rgba(15,23,42,.12); --fd-text: #0f172a; --fd-muted: #64748b; --fd-soft: rgba(15,23,42,.06); --fd-shadow: 0 24px 70px rgba(15,23,42,.16); }
.fd-card, .fd-blf { pointer-events: auto; border: 1px solid var(--fd-border); color: var(--fd-text); background: linear-gradient(145deg, var(--fd-card), var(--fd-bg)); box-shadow: var(--fd-shadow); backdrop-filter: blur(20px); }
.fd-card { width: min(342px, calc(100vw - 24px)); border-radius: 26px; overflow: hidden; }
.fd-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 15px; border-bottom: 1px solid var(--fd-border); }
.fd-status-pill { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--fd-border); background: var(--fd-card-2); border-radius: 999px; padding: 7px 10px; font-size: 12px; font-weight: 800; }
.fd-status-pill i, .fd-blf-row em i { width: 8px; height: 8px; border-radius: 99px; display: inline-block; }
.fd-status-pill[data-tone="green"] i, .fd-blf-row em[data-tone="green"] i { background: #22c55e; box-shadow: 0 0 10px rgba(34,197,94,.8); }
.fd-status-pill[data-tone="yellow"] i, .fd-blf-row em[data-tone="yellow"] i { background: #f59e0b; }
.fd-status-pill[data-tone="red"] i, .fd-blf-row em[data-tone="red"] i { background: #ef4444; }
.fd-status-pill[data-tone="gray"] i, .fd-blf-row em[data-tone="gray"] i { background: #94a3b8; }
.fd-header-actions { display: flex; align-items: center; gap: 6px; }
.fd-chip-btn, .fd-icon-plain { border: 1px solid var(--fd-border); background: var(--fd-card-2); color: var(--fd-text); cursor: pointer; border-radius: 999px; height: 32px; }
.fd-chip-btn { padding: 0 11px; font-weight: 800; font-size: 12px; }
.fd-chip-btn[data-active="true"] { color: #fff; background: linear-gradient(135deg, #6366f1, #8b5cf6); border-color: transparent; }
.fd-icon-plain { width: 32px; display: inline-flex; align-items: center; justify-content: center; }
.fd-body, .fd-active, .fd-call-state { padding: 16px; display: flex; flex-direction: column; gap: 13px; }
.fd-number-wrap { display: flex; align-items: center; gap: 8px; padding: 12px; border-radius: 20px; background: var(--fd-soft); border: 1px solid var(--fd-border); }
.fd-number-wrap input, .fd-transfer input, .fd-search input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: var(--fd-text); }
.fd-number-wrap input { text-align: center; font-size: 24px; font-weight: 850; letter-spacing: 1.6px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; caret-color: #22c55e; }
.fd-number-wrap button, .fd-friendly-error button { border: 0; background: transparent; color: var(--fd-muted); cursor: pointer; font-weight: 800; }
.fd-friendly-error { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 9px 11px; border-radius: 14px; background: rgba(245,158,11,.12); color: #f59e0b; font-size: 12px; font-weight: 800; }
.fd-keypad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; }
.fd-keypad button { border: 1px solid var(--fd-border); border-radius: 18px; background: linear-gradient(180deg, var(--fd-card-2), transparent); color: var(--fd-text); min-height: 61px; cursor: pointer; transition: transform .12s ease, border-color .12s ease, background .12s ease; }
.fd-keypad button:hover { transform: translateY(-1px); border-color: rgba(99,102,241,.55); }
.fd-keypad button:active { transform: scale(.96); }
.fd-keypad strong { display: block; font-size: 24px; line-height: 1; }
.fd-keypad span { display: block; min-height: 11px; margin-top: 5px; color: var(--fd-muted); font-size: 10px; letter-spacing: 1.6px; font-weight: 800; }
.fd-keypad-compact button { min-height: 48px; border-radius: 14px; }
.fd-keypad-compact strong { font-size: 18px; }
.fd-preferences { display: flex; align-items: center; justify-content: space-between; padding: 9px 11px; border: 1px solid var(--fd-border); background: var(--fd-card-2); border-radius: 16px; color: var(--fd-muted); font-size: 13px; font-weight: 800; }
.fd-toggle { width: 46px; height: 26px; border-radius: 999px; padding: 3px; border: 0; cursor: pointer; background: #64748b; transition: background .16s ease; }
.fd-toggle span { display: block; width: 20px; height: 20px; border-radius: 999px; background: white; box-shadow: 0 3px 10px rgba(0,0,0,.25); transition: transform .16s ease; }
.fd-toggle[data-on="true"] { background: linear-gradient(135deg, #22c55e, #10b981); }
.fd-toggle[data-on="true"] span { transform: translateX(20px); }
.fd-call-btn, .fd-answer, .fd-hangup { border: 0; cursor: pointer; color: white; font-weight: 900; border-radius: 999px; }
.fd-call-btn { min-height: 50px; display: inline-flex; align-items: center; justify-content: center; gap: 9px; background: linear-gradient(135deg, #22c55e, #059669); box-shadow: 0 16px 38px rgba(34,197,94,.28); }
.fd-call-btn:disabled { cursor: default; color: var(--fd-muted); background: var(--fd-soft); box-shadow: none; }
.fd-call-state { align-items: center; text-align: center; padding: 26px 16px 20px; }
.fd-call-state strong { font-size: 18px; }
.fd-call-state span { color: var(--fd-muted); font-size: 13px; font-weight: 800; }
.fd-eyebrow { text-transform: uppercase; letter-spacing: 1.8px; font-size: 11px !important; }
.fd-avatar { width: 58px; height: 58px; border-radius: 22px; display: flex; align-items: center; justify-content: center; color: white; font-weight: 950; background: linear-gradient(135deg, #6366f1, #8b5cf6 50%, #06b6d4); box-shadow: 0 18px 40px rgba(99,102,241,.28); }
.fd-incoming-actions { display: flex; gap: 12px; width: 100%; }
.fd-incoming-actions button { flex: 1; min-height: 46px; }
.fd-answer { background: linear-gradient(135deg, #22c55e, #059669); }
.fd-hangup { background: linear-gradient(135deg, #ef4444, #dc2626); min-height: 46px; padding: 0 18px; box-shadow: 0 16px 38px rgba(239,68,68,.28); }
.fd-hangup-wide { width: 100%; }
.fd-active-party { display: flex; align-items: center; gap: 12px; }
.fd-active-party strong, .fd-active-party span { display: block; }
.fd-active-party span { color: #22c55e; font-weight: 900; font-size: 13px; margin-top: 3px; }
.fd-controls { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.fd-control { min-height: 44px; border: 1px solid var(--fd-border); border-radius: 15px; color: var(--fd-text); background: var(--fd-card-2); cursor: pointer; font-weight: 850; }
.fd-control[data-active="true"] { color: #fff; border-color: transparent; background: linear-gradient(135deg, #6366f1, #8b5cf6); }
.fd-transfer { display: flex; gap: 8px; padding: 9px; border-radius: 15px; border: 1px solid var(--fd-border); background: var(--fd-card-2); }
.fd-transfer button { border: 0; border-radius: 12px; padding: 0 12px; color: white; background: #6366f1; font-weight: 850; }
.fd-transfer button:disabled { opacity: .45; }
.fd-diagnostics { margin: 12px 14px 0; padding: 12px; border: 1px solid var(--fd-border); border-radius: 18px; background: var(--fd-card-2); display: grid; gap: 8px; }
.fd-diagnostics div { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; color: var(--fd-muted); }
.fd-diagnostics strong { color: var(--fd-text); text-align: right; }
.fd-blf { width: 326px; max-width: calc(100vw - 24px); max-height: calc(100vh - 78px); border-radius: 24px; overflow: hidden; transform: translateX(24px) scale(.98); opacity: 0; pointer-events: none; transition: opacity .18s ease, transform .18s ease; }
.fd-blf[data-open="true"] { opacity: 1; transform: translateX(0) scale(1); pointer-events: auto; }
.fd-blf-head { padding: 14px 15px 10px; }
.fd-blf-head strong, .fd-blf-head span { display: block; }
.fd-blf-head span { color: var(--fd-muted); font-size: 12px; margin-top: 2px; }
.fd-search { display: flex; align-items: center; gap: 8px; margin: 0 12px 12px; padding: 10px 11px; border: 1px solid var(--fd-border); border-radius: 15px; background: var(--fd-card-2); color: var(--fd-muted); }
.fd-blf-list { height: min(430px, calc(100vh - 226px)); overflow: auto; border-top: 1px solid var(--fd-border); }
.fd-blf-row { display: flex; align-items: center; gap: 8px; padding: 7px 9px; }
.fd-blf-row > button:first-child { flex: 1; min-width: 0; height: 44px; border: 0; border-radius: 14px; background: transparent; color: var(--fd-text); display: flex; align-items: center; gap: 10px; text-align: left; cursor: pointer; }
.fd-blf-row > button:first-child:hover { background: var(--fd-card-2); }
.fd-blf-ext { width: 48px; height: 34px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; background: var(--fd-soft); font-weight: 950; font-variant-numeric: tabular-nums; }
.fd-blf-row strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.fd-blf-row em { display: inline-flex; align-items: center; gap: 5px; color: var(--fd-muted); font-style: normal; font-size: 11px; font-weight: 800; margin-top: 2px; }
.fd-blf-msg { width: 34px; height: 34px; border: 1px solid var(--fd-border); border-radius: 12px; background: var(--fd-card-2); color: var(--fd-muted); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.fd-empty { padding: 20px; color: var(--fd-muted); font-size: 13px; text-align: center; }
@media (max-width: 720px) {
  .fd-shell { width: calc(100vw - 20px); right: 10px; top: 58px; }
  .fd-shell[data-blf-open="true"] { flex-direction: column-reverse; align-items: flex-end; }
  .fd-blf { width: 100%; height: min(390px, calc(100vh - 430px)); }
  .fd-card { width: 100%; }
}
`;
