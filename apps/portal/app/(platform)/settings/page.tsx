"use client";

import { useEffect, useRef, useState } from "react";
import { useAppContext } from "../../../hooks/useAppContext";
import { useSipPhone } from "../../../hooks/useSipPhone";
import {
  DEFAULT_WEB_RINGTONE_ID,
  WEB_RINGTONE_OPTIONS,
  getWebIncomingRingtone,
  setWebIncomingRingtone,
  type WebRingtoneId,
} from "../../../hooks/telephonyAudioPreferences";
import { QRPairingModal } from "../../../components/QRPairingModal";
import { apiGet, apiPatch, apiPost } from "../../../services/apiClient";

// ── Types ─────────────────────────────────────────────────────────────────────

type SettingsTab = "general" | "call_forwarding" | "audio" | "greetings" | "blf";

type ForwardRule = {
  externalTo: string;
  internalTo: string;
};

type ForwardRuleSet = {
  unansweredTimeout: number;
  unanswered: ForwardRule;
  busyOrNotReg: ForwardRule;
};

type ForwardStatus = "available" | "away" | "dnd";

const FORWARD_STATUS_LABELS: Record<ForwardStatus, string> = {
  available: "Available",
  away: "Away",
  dnd: "Do Not Disturb",
};

const FWD_DESTINATIONS = [
  "Voicemail",
  "Extension",
  "Queue",
  "External number",
  "Disconnect",
];

// ── Sub-nav ───────────────────────────────────────────────────────────────────

const TABS: { key: SettingsTab; label: string; icon: string }[] = [
  { key: "general",        label: "General",        icon: "👤" },
  { key: "call_forwarding",label: "Call Forwarding", icon: "📲" },
  { key: "audio",          label: "Audio / Video",   icon: "🎙" },
  { key: "greetings",      label: "Greetings",       icon: "💬" },
  { key: "blf",            label: "BLF",             icon: "🔔" },
];

// ── General Tab ───────────────────────────────────────────────────────────────

function GeneralTab() {
  const { user, theme, setTheme } = useAppContext();
  const phone = useSipPhone();
  const [showQR, setShowQR] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [displayName, setDisplayName] = useState(user.name);
  const [language, setLanguage] = useState("en");
  const [pushEnabled, setPushEnabled] = useState(true);

  async function handleSave() {
    setSaving(true);
    setSaveMsg("");
    try {
      await apiPatch("/me/settings", { displayName, language, pushEnabled });
      setSaveMsg("Settings saved.");
    } catch {
      setSaveMsg("Save failed — changes may not persist.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ maxWidth: 600, display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Profile */}
      <section>
        <h3 style={{ fontSize: 14, fontWeight: 650, marginBottom: 14, color: "var(--text-dim)", letterSpacing: "0.5px", textTransform: "uppercase" }}>Profile</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
          <div style={{
            width: 64, height: 64, borderRadius: "50%",
            background: "var(--panel-2)", border: "1px solid var(--border)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 22, fontWeight: 700, color: "var(--text-dim)",
          }}>
            {user.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
          </div>
          <div>
            <div style={{ fontWeight: 650, fontSize: 16 }}>{user.name}</div>
            <div style={{ fontSize: 13, color: "var(--text-dim)" }}>Ext {user.extension} · {user.email}</div>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label className="label">Display Name</label>
            <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div>
            <label className="label">Language</label>
            <select className="select" value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="en">English (US)</option>
              <option value="en-gb">English (UK)</option>
              <option value="es">Español</option>
              <option value="fr">Français</option>
              <option value="de">Deutsch</option>
            </select>
          </div>
          <div>
            <label className="label">Theme</label>
            <select className="select" value={theme} onChange={(e) => setTheme(e.target.value as "dark" | "light")}>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", paddingBottom: 2 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={pushEnabled}
                onChange={(e) => setPushEnabled(e.target.checked)}
                style={{ width: 16, height: 16, cursor: "pointer" }}
              />
              Enable push notifications
            </label>
          </div>
        </div>
      </section>

      {/* Account Details */}
      <section>
        <h3 style={{ fontSize: 14, fontWeight: 650, marginBottom: 14, color: "var(--text-dim)", letterSpacing: "0.5px", textTransform: "uppercase" }}>Account Details</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, fontSize: 13 }}>
          <div>
            <label className="label">Voicemail Number</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input className="input" value="*97" readOnly style={{ flex: 1, color: "var(--text-dim)" }} />
              <button
                className="btn"
                style={{ fontSize: 12, background: "var(--success)", border: "none", padding: "0 14px" }}
                onClick={() => { phone.setDialpadInput("*97"); phone.dial("*97"); }}
              >
                Call
              </button>
            </div>
          </div>
          <div>
            <label className="label">Extension</label>
            <input className="input" value={user.extension} readOnly style={{ color: "var(--text-dim)" }} />
          </div>
        </div>
      </section>

      {/* Mobile App QR */}
      <section>
        <h3 style={{ fontSize: 14, fontWeight: 650, marginBottom: 14, color: "var(--text-dim)", letterSpacing: "0.5px", textTransform: "uppercase" }}>Mobile App</h3>
        <p style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 12 }}>
          Scan a QR code to link the ConnectComms mobile app. The QR code is single-use and expires after 5 minutes.
        </p>
        <button className="btn" onClick={() => setShowQR(true)} style={{ fontSize: 13 }}>
          📱 Show QR Code
        </button>
        {showQR ? <QRPairingModal /> : null}
      </section>

      {/* SIP / WebRTC diagnostics */}
      <section>
        <h3 style={{ fontSize: 14, fontWeight: 650, marginBottom: 14, color: "var(--text-dim)", letterSpacing: "0.5px", textTransform: "uppercase" }}>SIP / WebRTC Status</h3>
        <div style={{
          background: "var(--panel-2)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: "14px 16px",
          fontSize: 12,
          lineHeight: 1.9,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}>
          <Row k="Registration" v={phone.regState} vColor={phone.regState === "registered" ? "var(--success)" : "var(--warning)"} />
          <Row k="Extension" v={phone.diag.extensionNumber ?? "—"} />
          <Row k="SIP Domain" v={phone.diag.sipDomain ?? "—"} />
          <Row k="WSS Endpoint" v={phone.diag.sipWssUrl ?? "—"} />
          <Row k="STUN" v={phone.diag.hasStun ? "Configured" : "Not configured"} vColor={phone.diag.hasStun ? "var(--success)" : "var(--warning)"} />
          <Row k="TURN" v={phone.diag.hasTurn ? "Configured" : "Not configured"} vColor={phone.diag.hasTurn ? "var(--success)" : "var(--warning)"} />
          <Row k="Microphone" v={phone.diag.micPermission} vColor={phone.diag.micPermission === "granted" ? "var(--success)" : phone.diag.micPermission === "denied" ? "var(--danger)" : undefined} />
          {phone.diag.iceConnectionState ? <Row k="ICE State" v={phone.diag.iceConnectionState} /> : null}
          {phone.diag.lastRegError ? <Row k="Last Error" v={phone.diag.lastRegError} vColor="var(--danger)" /> : null}
        </div>
      </section>

      {/* Save */}
      <div className="row-actions">
        <button className="btn" onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save Changes"}</button>
        {saveMsg ? <span className="chip success" style={{ fontSize: 12 }}>{saveMsg}</span> : null}
      </div>
    </div>
  );
}

function Row({ k, v, vColor }: { k: string; v: string; vColor?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: "var(--text-dim)" }}>{k}</span>
      <span style={{ fontWeight: 600, color: vColor }}>{v}</span>
    </div>
  );
}

// ── Call Forwarding Tab ───────────────────────────────────────────────────────

const FORWARDING_STATUSES: ForwardStatus[] = ["available", "away", "dnd"];

function CallForwardingTab() {
  const [activeStatus, setActiveStatus] = useState<ForwardStatus>("available");
  const [rules, setRules] = useState<Record<ForwardStatus, ForwardRuleSet>>(() => ({
    available: { unansweredTimeout: 20, unanswered: { externalTo: "Voicemail", internalTo: "Voicemail" }, busyOrNotReg: { externalTo: "Voicemail", internalTo: "Same as all Calls" } },
    away:      { unansweredTimeout: 20, unanswered: { externalTo: "Voicemail", internalTo: "Voicemail" }, busyOrNotReg: { externalTo: "Voicemail", internalTo: "Same as all Calls" } },
    dnd:       { unansweredTimeout: 20, unanswered: { externalTo: "Voicemail", internalTo: "Voicemail" }, busyOrNotReg: { externalTo: "Voicemail", internalTo: "Same as all Calls" } },
  }));
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  const rule = rules[activeStatus];
  function setRule(patch: Partial<ForwardRuleSet>) {
    setRules((r) => ({ ...r, [activeStatus]: { ...r[activeStatus], ...patch } }));
  }
  function setUnanswered(patch: Partial<ForwardRule>) {
    setRule({ unanswered: { ...rule.unanswered, ...patch } });
  }
  function setBusy(patch: Partial<ForwardRule>) {
    setRule({ busyOrNotReg: { ...rule.busyOrNotReg, ...patch } });
  }

  async function handleSave() {
    setSaving(true);
    try {
      await apiPatch("/me/call-forwarding", { rules });
      setSaveMsg("Call forwarding saved.");
    } catch {
      setSaveMsg("Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ maxWidth: 560, display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Status tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
        {FORWARDING_STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setActiveStatus(s)}
            style={{
              padding: "8px 18px",
              border: "none",
              borderBottom: activeStatus === s ? "2px solid var(--accent)" : "2px solid transparent",
              background: "transparent",
              color: activeStatus === s ? "var(--accent)" : "var(--text-dim)",
              fontWeight: activeStatus === s ? 650 : 400,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {FORWARD_STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      {/* Unanswered Calls section */}
      <section>
        <h4 style={{ fontSize: 13, fontWeight: 650, marginBottom: 14, color: "var(--text-dim)" }}>Unanswered Calls</h4>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, fontSize: 13 }}>
          <label>No Answer Timeout</label>
          <input
            className="input"
            type="number"
            style={{ width: 70 }}
            value={rule.unansweredTimeout}
            min={5}
            max={120}
            onChange={(e) => setRule({ unansweredTimeout: Number(e.target.value) })}
          />
          <span style={{ color: "var(--text-dim)" }}>in seconds</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <ForwardRuleRow
            label="Forward external calls to"
            value={rule.unanswered.externalTo}
            onChange={(v) => setUnanswered({ externalTo: v })}
          />
          <ForwardRuleRow
            label="Forward internal calls to"
            value={rule.unanswered.internalTo}
            onChange={(v) => setUnanswered({ internalTo: v })}
          />
        </div>
      </section>

      <div style={{ borderTop: "1px solid var(--border)" }} />

      {/* Busy / Not Registered section */}
      <section>
        <h4 style={{ fontSize: 13, fontWeight: 650, marginBottom: 14, color: "var(--text-dim)" }}>Busy or Not Registered</h4>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <ForwardRuleRow
            label="Forward external calls to"
            value={rule.busyOrNotReg.externalTo}
            onChange={(v) => setBusy({ externalTo: v })}
          />
          <ForwardRuleRow
            label="Forward internal calls to"
            value={rule.busyOrNotReg.internalTo}
            onChange={(v) => setBusy({ internalTo: v })}
          />
        </div>
      </section>

      <div className="row-actions">
        <button className="btn" onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        {saveMsg ? <span className="chip success" style={{ fontSize: 12 }}>{saveMsg}</span> : null}
      </div>
    </div>
  );
}

function ForwardRuleRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
      <label style={{ color: "var(--text-dim)", minWidth: 220 }}>{label}</label>
      <select className="select" style={{ flex: 1, maxWidth: 200 }} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="Same as all Calls">Same as all Calls</option>
        {FWD_DESTINATIONS.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
    </div>
  );
}

// ── Audio Tab ─────────────────────────────────────────────────────────────────

function AudioTab() {
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [speakerDevices, setSpeakerDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMic, setSelectedMic] = useState("");
  const [selectedSpeaker, setSelectedSpeaker] = useState("");
  const [testPlaying, setTestPlaying] = useState(false);
  const [micTesting, setMicTesting] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [incomingRingtone, setIncomingRingtoneId] =
    useState<WebRingtoneId>(DEFAULT_WEB_RINGTONE_ID);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number>(0);

  useEffect(() => {
    setIncomingRingtoneId(getWebIncomingRingtone());
    navigator.mediaDevices?.enumerateDevices().then((devices) => {
      setMicDevices(devices.filter((d) => d.kind === "audioinput"));
      setSpeakerDevices(devices.filter((d) => d.kind === "audiooutput"));
    }).catch(() => {});
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  function testSpeaker() {
    setTestPlaying(true);
    const audio = new Audio("/test-tone.mp3");
    audio.onended = () => setTestPlaying(false);
    audio.onerror = () => setTestPlaying(false);
    audio.play().catch(() => setTestPlaying(false));
  }

  async function testMic() {
    if (micTesting) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      setMicTesting(false);
      setMicLevel(0);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setMicTesting(true);
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      function tick() {
        analyser.getByteFrequencyData(buf);
        const avg = buf.reduce((s, v) => s + v, 0) / buf.length;
        setMicLevel(Math.min(100, avg * 2));
        animFrameRef.current = requestAnimationFrame(tick);
      }
      tick();
    } catch {
      setMicTesting(false);
    }
  }

  return (
    <div style={{ maxWidth: 520, display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Microphone */}
      <section>
        <h3 style={{ fontSize: 14, fontWeight: 650, marginBottom: 14, color: "var(--text-dim)", letterSpacing: "0.5px", textTransform: "uppercase" }}>Microphone</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <label className="label">Input Device</label>
            <select className="select" value={selectedMic} onChange={(e) => setSelectedMic(e.target.value)}>
              <option value="">System Default</option>
              {micDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${d.deviceId.slice(0, 8)}`}</option>
              ))}
            </select>
          </div>
          {micTesting ? (
            <div>
              <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 5 }}>Microphone level</div>
              <div style={{ height: 8, background: "var(--border)", borderRadius: 4, overflow: "hidden" }}>
                <div style={{
                  width: `${micLevel}%`,
                  height: "100%",
                  background: micLevel > 70 ? "var(--danger)" : micLevel > 40 ? "var(--warning)" : "var(--success)",
                  borderRadius: 4,
                  transition: "width 0.05s",
                }} />
              </div>
            </div>
          ) : null}
          <button
            className="btn ghost"
            style={{ fontSize: 13, alignSelf: "flex-start" }}
            onClick={testMic}
          >
            {micTesting ? "🛑 Stop Mic Test" : "🎙 Test Microphone"}
          </button>
        </div>
      </section>

      {/* Speaker */}
      <section>
        <h3 style={{ fontSize: 14, fontWeight: 650, marginBottom: 14, color: "var(--text-dim)", letterSpacing: "0.5px", textTransform: "uppercase" }}>Speaker / Output</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <label className="label">Output Device</label>
            <select className="select" value={selectedSpeaker} onChange={(e) => setSelectedSpeaker(e.target.value)}>
              <option value="">System Default</option>
              {speakerDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || `Speaker ${d.deviceId.slice(0, 8)}`}</option>
              ))}
            </select>
          </div>
          <button
            className="btn ghost"
            style={{ fontSize: 13, alignSelf: "flex-start" }}
            onClick={testSpeaker}
            disabled={testPlaying}
          >
            {testPlaying ? "🔊 Playing…" : "🔊 Test Speaker"}
          </button>
        </div>
      </section>

      {/* Ring tone */}
      <section>
        <h3 style={{ fontSize: 14, fontWeight: 650, marginBottom: 14, color: "var(--text-dim)", letterSpacing: "0.5px", textTransform: "uppercase" }}>Ringtone</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <label className="label">Incoming Ringtone</label>
            <select
              className="select"
              value={incomingRingtone}
              onChange={(e) => {
                const next = e.target.value as WebRingtoneId;
                setWebIncomingRingtone(next);
                setIncomingRingtoneId(next);
              }}
            >
              {WEB_RINGTONE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
            Connect Default uses the bundled Connect ringtone. Classic Ring keeps the legacy generated tone.
          </div>
          <div>
            <label className="label">Ringtone Device</label>
            <select className="select">
            <option>Same as Speaker</option>
            {speakerDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || "Speaker"}</option>
            ))}
            </select>
          </div>
        </div>
      </section>

      {micDevices.length === 0 && speakerDevices.length === 0 ? (
        <div className="chip warning" style={{ fontSize: 12 }}>
          No audio devices detected. Grant microphone permission to see device options.
        </div>
      ) : null}
    </div>
  );
}

// ── Greetings Tab ─────────────────────────────────────────────────────────────

function GreetingsTab() {
  return (
    <div style={{ maxWidth: 520, display: "flex", flexDirection: "column", gap: 20 }}>
      <p style={{ fontSize: 13, color: "var(--text-dim)" }}>
        Record or upload a personal voicemail greeting. This greeting will play when callers reach your voicemail.
      </p>
      <div className="panel" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Personal Greeting</div>
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Default greeting for all callers</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn ghost" style={{ fontSize: 12 }}>▶ Play</button>
            <button className="btn ghost" style={{ fontSize: 12 }}>⬆ Upload</button>
            <button className="btn" style={{ fontSize: 12 }}>🎙 Record</button>
          </div>
        </div>
      </div>
      <div className="panel" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Away Greeting</div>
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Plays when status is Away or DND</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn ghost" style={{ fontSize: 12 }}>▶ Play</button>
            <button className="btn ghost" style={{ fontSize: 12 }}>⬆ Upload</button>
            <button className="btn" style={{ fontSize: 12 }}>🎙 Record</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── BLF Tab ───────────────────────────────────────────────────────────────────

function BlfTab() {
  const [entries, setEntries] = useState<Array<{ ext: string; label: string }>>([
    { ext: "", label: "" },
  ]);

  return (
    <div style={{ maxWidth: 520, display: "flex", flexDirection: "column", gap: 16 }}>
      <p style={{ fontSize: 13, color: "var(--text-dim)" }}>
        Configure Busy Lamp Field monitors. These appear in your phone's BLF panel to show the presence of selected extensions.
      </p>
      {entries.map((entry, i) => (
        <div key={i} style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <input
            className="input"
            style={{ width: 100 }}
            placeholder="Extension"
            value={entry.ext}
            onChange={(e) => setEntries((prev) => prev.map((en, idx) => idx === i ? { ...en, ext: e.target.value } : en))}
          />
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder="Label (optional)"
            value={entry.label}
            onChange={(e) => setEntries((prev) => prev.map((en, idx) => idx === i ? { ...en, label: e.target.value } : en))}
          />
          <button className="btn ghost" style={{ fontSize: 13 }} onClick={() => setEntries((prev) => prev.filter((_, idx) => idx !== i))}>✕</button>
        </div>
      ))}
      <div className="row-actions">
        <button className="btn ghost" style={{ fontSize: 13 }} onClick={() => setEntries((prev) => [...prev, { ext: "", label: "" }])}>+ Add BLF</button>
        <button className="btn" style={{ fontSize: 13 }}>Save BLF List</button>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>("general");

  return (
    <div style={{ display: "flex", height: "calc(100vh - 54px)", overflow: "hidden" }}>
      {/* Left sub-nav — matches 3CX Settings sidebar */}
      <div style={{
        width: 200,
        flexShrink: 0,
        borderRight: "1px solid var(--border)",
        padding: "14px 0",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        overflowY: "auto",
      }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "9px 16px",
              border: "none",
              background: tab === t.key ? "var(--panel-2)" : "transparent",
              borderLeft: `3px solid ${tab === t.key ? "var(--accent)" : "transparent"}`,
              color: tab === t.key ? "var(--text)" : "var(--text-dim)",
              fontWeight: tab === t.key ? 600 : 400,
              fontSize: 13,
              cursor: "pointer",
              textAlign: "left",
              transition: "all 0.12s",
              width: "100%",
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 28px" }}>
        {tab === "general"        ? <GeneralTab /> : null}
        {tab === "call_forwarding" ? <CallForwardingTab /> : null}
        {tab === "audio"          ? <AudioTab /> : null}
        {tab === "greetings"      ? <GreetingsTab /> : null}
        {tab === "blf"            ? <BlfTab /> : null}
      </div>
    </div>
  );
}
