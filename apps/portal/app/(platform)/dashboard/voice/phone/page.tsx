"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "../../../../../components/PageHeader";
import { PermissionGate } from "../../../../../components/PermissionGate";
import { StatusChip } from "../../../../../components/StatusChip";
import { useSipPhone } from "../../../../../hooks/useSipPhone";

// ─── Constants ───────────────────────────────────────────────────────────────

const DTMF_KEYS = ["1","2","3","4","5","6","7","8","9","*","0","#"];
const DTMF_SUBS: Record<string,string> = {
  "1":" ","2":"ABC","3":"DEF","4":"GHI","5":"JKL","6":"MNO",
  "7":"PQRS","8":"TUV","9":"WXYZ","*":"","0":"+","#":"",
};

// ─── Theme tokens (dark-first, override with light class if needed) ───────────

const T = {
  bg:        "linear-gradient(160deg, #0d1117 0%, #161b2e 60%, #0d1117 100%)",
  surface:   "rgba(255,255,255,0.04)",
  border:    "rgba(255,255,255,0.08)",
  textPrimary: "#f1f5f9",
  textSec:   "#94a3b8",
  accent:    "#7c3aed",
  accentSoft:"rgba(124,58,237,0.22)",
  accentGlow:"rgba(124,58,237,0.35)",
  green:     "#10b981",
  greenSoft: "rgba(16,185,129,0.15)",
  amber:     "#f59e0b",
  amberSoft: "rgba(245,158,11,0.15)",
  red:       "#ef4444",
  redSoft:   "rgba(239,68,68,0.15)",
  redGlow:   "rgba(239,68,68,0.45)",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTimer(sec: number) {
  const m = Math.floor(sec / 60).toString().padStart(2,"0");
  const s = (sec % 60).toString().padStart(2,"0");
  return `${m}:${s}`;
}

function initials(s: string | null) {
  if (!s) return "?";
  const words = s.trim().split(/[\s@._-]+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const clean = s.replace(/[^a-zA-Z0-9]/g,"");
  return (clean[0] ?? "?").toUpperCase();
}

// ─── CallAvatar ───────────────────────────────────────────────────────────────

function CallAvatar({ party, size = 80 }: { party: string | null; size?: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: "linear-gradient(135deg, #7c3aed 0%, #a855f7 50%, #6366f1 100%)",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.38, fontWeight: 700, color: "#fff",
      letterSpacing: "-0.5px",
      boxShadow: `0 0 0 3px rgba(124,58,237,0.25), 0 8px 32px rgba(124,58,237,0.35)`,
      flexShrink: 0, userSelect: "none",
    }}>
      {initials(party)}
    </div>
  );
}

// ─── CtrlButton ───────────────────────────────────────────────────────────────

function CtrlButton({
  icon, label, onClick, active = false, danger = false, disabled = false, accent = false,
}: {
  icon: React.ReactNode; label: string;
  onClick?: () => void; active?: boolean; danger?: boolean; disabled?: boolean; accent?: boolean;
}) {
  const bg   = danger  ? (active ? T.redSoft  : "rgba(239,68,68,0.08)")
             : active  ? T.accentSoft
             : T.surface;
  const col  = danger  ? T.red
             : active  ? "#a78bfa"
             : disabled ? "rgba(148,163,184,0.35)"
             : T.textSec;
  const ring = danger && active ? `0 0 0 1.5px ${T.red}, 0 4px 16px ${T.redGlow}`
             : active           ? `0 0 0 1.5px ${T.accent}, 0 4px 16px ${T.accentGlow}`
             : `0 0 0 1px ${T.border}`;

  return (
    <button
      onClick={disabled ? undefined : onClick}
      style={{
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        gap: 7, width: "100%", padding: "16px 6px 14px",
        background: bg, color: col,
        border: "none", borderRadius: 18,
        boxShadow: ring,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.38 : 1,
        transition: "all 0.18s cubic-bezier(.4,0,.2,1)",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <span style={{ fontSize: 22, lineHeight: 1, display: "flex" }}>{icon}</span>
      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.3px", lineHeight: 1 }}>{label}</span>
    </button>
  );
}

// ─── Transfer modal ───────────────────────────────────────────────────────────

function TransferModal({
  onTransfer, onClose,
}: { onTransfer: (t: string) => void; onClose: () => void }) {
  const [val, setVal] = useState("");
  return (
    <div style={{
      position: "absolute", inset: 0, zIndex: 10,
      background: "rgba(0,0,0,0.72)", backdropFilter: "blur(8px)",
      borderRadius: 20, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", padding: 24, gap: 16,
    }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: T.textPrimary }}>Blind Transfer</div>
      <div style={{ fontSize: 13, color: T.textSec, textAlign: "center" }}>
        Enter extension or number to transfer to
      </div>
      <input
        autoFocus
        className="input"
        style={{ width: "100%", fontSize: 20, letterSpacing: 2, textAlign: "center", fontFamily: "monospace" }}
        placeholder="Extension…"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && val.trim()) { onTransfer(val.trim()); onClose(); }
          if (e.key === "Escape") onClose();
        }}
      />
      <div style={{ display: "flex", gap: 10, width: "100%" }}>
        <button className="btn ghost" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
        <button
          className="btn"
          onClick={() => { if (val.trim()) { onTransfer(val.trim()); onClose(); } }}
          disabled={!val.trim()}
          style={{ flex: 2, background: T.accent, border: "none", color: "#fff" }}
        >
          Transfer Now
        </button>
      </div>
    </div>
  );
}

// ─── ActiveCallScreen ─────────────────────────────────────────────────────────

function ActiveCallScreen({
  phone, timerSec, onKey,
}: {
  phone: ReturnType<typeof useSipPhone>;
  timerSec: number;
  onKey: (d: string) => void;
}) {
  const [showDtmf, setShowDtmf] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [dtmfDisplay, setDtmfDisplay] = useState("");
  const [addCallToast, setAddCallToast] = useState(false);

  function handleDtmfKey(d: string) {
    onKey(d);
    setDtmfDisplay((prev) => (prev + d).slice(-12));
  }

  const statusLabel = phone.onHold ? "On Hold"
    : phone.callState === "connected" ? "Connected"
    : phone.callState === "dialing" ? "Calling…"
    : "Ringing…";

  const statusColor = phone.onHold ? T.amber : T.green;

  return (
    <div style={{
      position: "relative",
      display: "flex", flexDirection: "column",
      height: "100%", minHeight: 560,
      background: T.bg,
      borderRadius: 20, overflow: "hidden",
    }}>
      {/* Ambient radial glow behind avatar */}
      <div style={{
        position: "absolute", top: 60, left: "50%", transform: "translateX(-50%)",
        width: 260, height: 260, borderRadius: "50%",
        background: phone.onHold
          ? "radial-gradient(circle, rgba(245,158,11,0.18) 0%, transparent 70%)"
          : "radial-gradient(circle, rgba(124,58,237,0.22) 0%, transparent 70%)",
        pointerEvents: "none", transition: "background 0.6s",
      }} />

      {/* ── TOP SECTION ───────────────────────────────── */}
      <div style={{ padding: "40px 24px 20px", textAlign: "center", position: "relative", zIndex: 1 }}>
        <CallAvatar party={phone.remoteParty} size={88} />

        <div style={{ marginTop: 18, fontSize: 24, fontWeight: 700, color: T.textPrimary, letterSpacing: "-0.3px" }}>
          {phone.remoteParty ?? "Unknown"}
        </div>

        {/* Status + timer row */}
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
          <span style={{
            display: "inline-block", width: 7, height: 7, borderRadius: "50%",
            background: statusColor,
            boxShadow: phone.onHold ? undefined : `0 0 6px ${statusColor}`,
          }} />
          <span style={{ color: statusColor, fontSize: 13, fontWeight: 600 }}>{statusLabel}</span>
          {phone.callState === "connected" && !phone.onHold && (
            <>
              <span style={{ color: "rgba(148,163,184,0.4)", fontSize: 13 }}>·</span>
              <span style={{ color: T.textSec, fontSize: 13, fontFamily: "monospace", fontWeight: 500 }}>
                {fmtTimer(timerSec)}
              </span>
            </>
          )}
        </div>

        {/* Quality badge */}
        {phone.diag.qualityGrade && phone.callState === "connected" && (
          <div style={{ marginTop: 8, display: "flex", justifyContent: "center", gap: 8 }}>
            <span style={{
              padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700,
              letterSpacing: "0.5px", textTransform: "uppercase",
              background: phone.diag.qualityGrade === "excellent" || phone.diag.qualityGrade === "good"
                ? T.greenSoft : phone.diag.qualityGrade === "fair" ? T.amberSoft : T.redSoft,
              color: phone.diag.qualityGrade === "excellent" || phone.diag.qualityGrade === "good"
                ? T.green : phone.diag.qualityGrade === "fair" ? T.amber : T.red,
            }}>
              {phone.diag.qualityGrade}
            </span>
            {phone.diag.isUsingRelay && (
              <span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 11, background: T.accentSoft, color: "#a78bfa", fontWeight: 600 }}>
                TURN ✓
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── DTMF EXPANDED PAD ────────────────────────── */}
      {showDtmf && (
        <div style={{
          margin: "0 20px 8px", padding: 16,
          background: "rgba(255,255,255,0.04)",
          borderRadius: 16, border: `1px solid ${T.border}`,
        }}>
          {dtmfDisplay && (
            <div style={{
              fontFamily: "monospace", fontSize: 20, letterSpacing: 4,
              textAlign: "center", color: T.textPrimary, marginBottom: 12, minHeight: 28,
            }}>
              {dtmfDisplay}
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            {DTMF_KEYS.map((d) => (
              <button
                key={d}
                onClick={() => handleDtmfKey(d)}
                style={{
                  padding: "11px 0", borderRadius: 12,
                  border: `1px solid ${T.border}`,
                  background: "rgba(255,255,255,0.06)",
                  color: T.textPrimary, cursor: "pointer",
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
                  transition: "background 0.1s",
                }}
              >
                <span style={{ fontSize: 17, fontWeight: 700, lineHeight: 1.1 }}>{d}</span>
                <span style={{ fontSize: 8, opacity: 0.45, letterSpacing: 1 }}>{DTMF_SUBS[d]}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── SPACER ───────────────────────────────────── */}
      <div style={{ flex: 1, minHeight: 12 }} />

      {/* ── AUDIO DEVICE BAR (shown when speaker is active) ── */}
      {phone.speakerOn && (
        <div style={{
          margin: "0 20px 8px", padding: "8px 14px",
          background: T.accentSoft, borderRadius: 10,
          border: `1px solid ${T.accent}33`,
          display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#a78bfa",
        }}>
          <span style={{ fontSize: 16 }}>🔊</span>
          <span style={{ fontWeight: 600 }}>Speaker On</span>
          {phone.audioOutputDevices.length > 1 && (
            <select
              style={{ marginLeft: "auto", background: "transparent", color: "#a78bfa", border: "none", fontSize: 11, cursor: "pointer" }}
              value={phone.currentSinkId}
              onChange={(e) => phone.setAudioSinkId(e.target.value)}
            >
              {phone.audioOutputDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId} style={{ background: "#1a1d2e" }}>
                  {d.label || `Device ${d.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* ── CONTROLS ─────────────────────────────────── */}
      <div style={{ padding: "0 20px 20px", position: "relative", zIndex: 1 }}>
        {/* Row 1 */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 12 }}>
          <CtrlButton
            icon={<MicIcon muted={phone.muted} />}
            label={phone.muted ? "Unmute" : "Mute"}
            active={phone.muted}
            onClick={() => phone.setMute(!phone.muted)}
          />
          <CtrlButton
            icon={<KeypadIcon />}
            label="Keypad"
            active={showDtmf}
            onClick={() => setShowDtmf((v) => !v)}
          />
          <CtrlButton
            icon={<SpeakerIcon on={phone.speakerOn} />}
            label="Speaker"
            active={phone.speakerOn}
            onClick={() => phone.toggleSpeaker()}
          />
        </div>

        {/* Row 2 */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 20 }}>
          <CtrlButton
            icon={<AddCallIcon />}
            label="Add Call"
            disabled
            onClick={() => { setAddCallToast(true); setTimeout(() => setAddCallToast(false), 2500); }}
          />
          <CtrlButton
            icon={<HoldIcon held={phone.onHold} />}
            label={phone.onHold ? "Resume" : "Hold"}
            active={phone.onHold}
            onClick={phone.toggleHold}
          />
          <CtrlButton
            icon={<TransferIcon />}
            label="Transfer"
            active={showTransfer}
            onClick={() => setShowTransfer((v) => !v)}
          />
        </div>

        {/* End Call */}
        <button
          onClick={phone.hangup}
          style={{
            width: "100%", padding: "16px", borderRadius: 50, border: "none",
            background: "linear-gradient(135deg, #ef4444, #dc2626)",
            color: "#fff", fontSize: 16, fontWeight: 700, cursor: "pointer",
            boxShadow: `0 4px 24px ${T.redGlow}`,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
            transition: "transform 0.1s, box-shadow 0.15s",
            letterSpacing: "0.3px",
          }}
          onMouseDown={(e) => { (e.currentTarget as HTMLElement).style.transform = "scale(0.97)"; }}
          onMouseUp={(e) => { (e.currentTarget as HTMLElement).style.transform = ""; }}
        >
          <EndCallIcon /> End Call
        </button>

        {/* Add-call toast */}
        {addCallToast && (
          <div style={{
            marginTop: 10, padding: "8px 14px", borderRadius: 10,
            background: T.amberSoft, color: T.amber, fontSize: 12, textAlign: "center",
          }}>
            Multi-call not yet supported on this endpoint
          </div>
        )}
      </div>

      {/* Transfer overlay */}
      {showTransfer && (
        <TransferModal
          onTransfer={(t) => phone.transfer(t)}
          onClose={() => setShowTransfer(false)}
        />
      )}
    </div>
  );
}

// ─── Keypad Screen ────────────────────────────────────────────────────────────

function KeypadScreen({
  phone, onKey,
}: { phone: ReturnType<typeof useSipPhone>; onKey: (d: string) => void }) {
  const regOk = phone.regState === "registered";
  const regColor = regOk ? T.green
    : phone.regState === "failed" ? T.red
    : T.amber;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%" }}>
      {/* Registration row */}
      <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, paddingBottom: 4 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: regColor, flexShrink: 0,
          boxShadow: regOk ? `0 0 5px ${regColor}` : undefined }} />
        <span style={{ color: T.textSec }}>
          {regOk
            ? `Registered · Ext ${phone.diag.extensionNumber ?? "–"}`
            : regLabel(phone.regState)}
        </span>
      </div>

      {/* Number display */}
      <input
        id="sip-dialpad-input"
        className="input"
        type="tel"
        placeholder="Extension or number…"
        value={phone.dialpadInput}
        onChange={(e) => phone.setDialpadInput(e.target.value)}
        autoComplete="off"
        style={{ fontSize: 22, letterSpacing: 3, textAlign: "center", fontFamily: "monospace", fontWeight: 600 }}
      />

      {/* DTMF grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
        {DTMF_KEYS.map((d) => (
          <button key={d} className="btn ghost"
            onClick={() => onKey(d)}
            style={{ padding: "11px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
            <span style={{ fontSize: 17, fontWeight: 700 }}>{d}</span>
            <span style={{ fontSize: 9, opacity: 0.45, letterSpacing: 1 }}>{DTMF_SUBS[d]}</span>
          </button>
        ))}
      </div>

      {/* Backspace + Call */}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn ghost"
          onClick={() => phone.setDialpadInput(phone.dialpadInput.slice(0, -1))}
          style={{ minWidth: 48 }} title="Backspace">⌫</button>
        <button className="btn"
          onClick={() => { const t = phone.dialpadInput.trim(); if (t) phone.dial(t); }}
          disabled={!regOk || !phone.dialpadInput.trim()}
          style={{ flex: 1, fontSize: 15, fontWeight: 600 }}>
          📞 Call
        </button>
      </div>

      {phone.error && (
        <div style={{ padding: "8px 12px", borderRadius: 8, background: T.redSoft, color: T.red, fontSize: 13 }}>
          {phone.error}
        </div>
      )}
    </div>
  );
}

// ─── Outgoing Screen ──────────────────────────────────────────────────────────

function OutgoingScreen({ phone, onCancel }: { phone: ReturnType<typeof useSipPhone>; onCancel: () => void }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", gap: 20, flex: 1, padding: "40px 24px",
      background: T.bg, borderRadius: 20, minHeight: 400,
    }}>
      {/* Pulsing glow ring */}
      <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{
          position: "absolute", width: 130, height: 130, borderRadius: "50%",
          background: "radial-gradient(circle, rgba(124,58,237,0.25) 0%, transparent 70%)",
          animation: "pulse 2s ease-in-out infinite",
        }} />
        <CallAvatar party={phone.remoteParty ?? phone.dialpadInput} size={88} />
      </div>

      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 26, fontWeight: 700, color: T.textPrimary, marginBottom: 6 }}>
          {phone.remoteParty ?? phone.dialpadInput}
        </div>
        <div style={{ fontSize: 14, color: T.textSec, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 500 }}>
          {phone.callState === "dialing" ? "Calling…" : "Ringing…"}
        </div>
      </div>

      <button onClick={onCancel} style={{
        marginTop: 16, width: 68, height: 68, borderRadius: "50%",
        background: "linear-gradient(135deg, #ef4444, #dc2626)",
        border: "none", cursor: "pointer", fontSize: 26, color: "#fff",
        boxShadow: `0 4px 24px ${T.redGlow}`,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <EndCallIcon />
      </button>
      <span style={{ fontSize: 12, color: T.textSec }}>Tap to cancel</span>
    </div>
  );
}

// ─── Incoming Screen ──────────────────────────────────────────────────────────

function IncomingScreen({
  phone, onAnswer, onDecline,
}: { phone: ReturnType<typeof useSipPhone>; onAnswer: () => void; onDecline: () => void }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", gap: 18, flex: 1, padding: "40px 24px",
      background: T.bg, borderRadius: 20, minHeight: 400,
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 2, color: T.textSec, textTransform: "uppercase" }}>
        Incoming Call
      </div>

      {/* Pulsing ring */}
      <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{
          position: "absolute", width: 130, height: 130, borderRadius: "50%",
          background: "radial-gradient(circle, rgba(16,185,129,0.2) 0%, transparent 70%)",
          animation: "pulse 1.6s ease-in-out infinite",
        }} />
        <CallAvatar party={phone.remoteParty} size={88} />
      </div>

      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 26, fontWeight: 700, color: T.textPrimary }}>
          {phone.remoteParty ?? "Unknown"}
        </div>
      </div>

      <div style={{ display: "flex", gap: 32, marginTop: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <button onClick={onDecline} style={{
            width: 68, height: 68, borderRadius: "50%",
            background: "linear-gradient(135deg, #ef4444, #dc2626)",
            border: "none", cursor: "pointer", fontSize: 26, color: "#fff",
            boxShadow: `0 4px 20px ${T.redGlow}`,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <EndCallIcon />
          </button>
          <span style={{ fontSize: 12, color: T.textSec }}>Decline</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <button onClick={onAnswer} style={{
            width: 68, height: 68, borderRadius: "50%",
            background: "linear-gradient(135deg, #10b981, #059669)",
            border: "none", cursor: "pointer", fontSize: 26, color: "#fff",
            boxShadow: `0 4px 20px rgba(16,185,129,0.5)`,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <AnswerIcon />
          </button>
          <span style={{ fontSize: 12, color: T.textSec }}>Answer</span>
        </div>
      </div>
    </div>
  );
}

// ─── Ended Screen ─────────────────────────────────────────────────────────────

function EndedScreen() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, flex: 1, padding: 40, opacity: 0.7 }}>
      <span style={{ fontSize: 36 }}>📵</span>
      <span style={{ fontSize: 15, color: T.textSec }}>Call Ended</span>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function VoicePhonePage() {
  const phone = useSipPhone();
  const [showDiag, setShowDiag] = useState(false);

  // Call timer
  const [timerSec, setTimerSec] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (phone.callState === "connected") {
      setTimerSec(0);
      timerRef.current = setInterval(() => setTimerSec((s) => s + 1), 1000);
    } else {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      if (phone.callState === "idle") setTimerSec(0);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phone.callState]);

  // Global keyboard handler — digits → DTMF tones; Enter → dial; Escape → hangup
  const handleKeyboardDtmf = useCallback((e: KeyboardEvent) => {
    const tgt = e.target as HTMLElement;
    if (tgt.tagName === "INPUT" && tgt.id !== "sip-dialpad-input") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (DTMF_KEYS.includes(e.key)) {
      e.preventDefault();
      handleKey(e.key);
    } else if (e.key === "Enter") {
      if (phone.callState === "idle" || phone.callState === "ended") {
        const t = phone.dialpadInput.trim();
        if (t && phone.regState === "registered") phone.dial(t);
      }
    } else if (e.key === "Escape") {
      if (phone.callState !== "idle" && phone.callState !== "ended") phone.hangup();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone.callState, phone.dialpadInput, phone.regState]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyboardDtmf);
    return () => window.removeEventListener("keydown", handleKeyboardDtmf);
  }, [handleKeyboardDtmf]);

  function handleKey(digit: string) {
    if (phone.callState === "connected") {
      phone.sendDtmf(digit);
    } else {
      phone.playDtmfTone(digit);
      phone.setDialpadInput((prev) => prev + digit);
    }
  }

  // Screen routing
  const isOutgoing = phone.callState === "dialing" ||
    (phone.callState === "ringing" && phone.callDirection === "outbound");
  const isIncoming = phone.callState === "ringing" && phone.callDirection === "inbound";
  const isActive   = phone.callState === "connected";
  const isEnded    = phone.callState === "ended";
  const isKeypad   = !isOutgoing && !isIncoming && !isActive && !isEnded;

  return (
    <PermissionGate
      permission="can_view_calls"
      fallback={<div className="state-box">You do not have voice phone access.</div>}
    >
      {/* CSS animations */}
      <style>{`
        @keyframes pulse {
          0%,100% { transform: scale(1); opacity:0.7; }
          50%      { transform: scale(1.12); opacity:1; }
        }
        @keyframes fadeSlideIn {
          from { opacity:0; transform:translateY(10px); }
          to   { opacity:1; transform:translateY(0); }
        }
      `}</style>

      <div className="stack compact-stack">
        <PageHeader
          title="Voice Phone"
          subtitle={
            phone.diag.extensionNumber
              ? `Ext ${phone.diag.extensionNumber}${phone.diag.sipDomain ? ` · ${phone.diag.sipDomain}` : ""}`
              : "Initialising…"
          }
        />

        <section style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 16, alignItems: "start" }}>

          {/* ── Phone Widget ──────────────────────────────── */}
          <div style={{
            borderRadius: 20, overflow: "hidden",
            border: `1px solid ${T.border}`,
            boxShadow: "0 8px 40px rgba(0,0,0,0.4)",
            animation: "fadeSlideIn 0.3s ease",
            minHeight: 560,
            display: "flex", flexDirection: "column",
            background: T.bg,
          }}>
            {isKeypad   && <div style={{ padding: 20, flex: 1 }}><KeypadScreen phone={phone} onKey={handleKey} /></div>}
            {isOutgoing && <OutgoingScreen phone={phone} onCancel={phone.hangup} />}
            {isIncoming && <IncomingScreen phone={phone} onAnswer={phone.answer} onDecline={phone.hangup} />}
            {isActive   && <ActiveCallScreen phone={phone} timerSec={timerSec} onKey={handleKey} />}
            {isEnded    && <EndedScreen />}
          </div>

          {/* ── Diagnostics ──────────────────────────────── */}
          <div className="panel" style={{ fontSize: 13, alignSelf: "start" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <strong>Diagnostics</strong>
              <button className="btn ghost" onClick={() => setShowDiag((v) => !v)} style={{ fontSize: 11 }}>
                {showDiag ? "Hide" : "Show"}
              </button>
            </div>

            <div className="stack compact-stack">
              <DiagRow label="Registration" value={regLabel(phone.regState)}
                tone={phone.regState === "registered" ? "success" : phone.regState === "failed" ? "danger" : "info"} />
              <DiagRow label="Call State" value={phone.callState}
                tone={phone.callState === "connected" ? "success" : phone.callState === "idle" ? "neutral" : "warning"} />
              {phone.callDirection && <DiagRow label="Direction" value={phone.callDirection} tone="info" />}
              <DiagRow label="WebRTC" value={phone.diag.webrtcEnabled ? "Enabled" : "Disabled"}
                tone={phone.diag.webrtcEnabled ? "success" : "danger"} />
              <DiagRow label="STUN" value={phone.diag.hasStun ? "Present" : "Missing"}
                tone={phone.diag.hasStun ? "success" : "warning"} />
              <DiagRow label="TURN" value={phone.diag.hasTurn ? "Present" : "Not configured"}
                tone={phone.diag.hasTurn ? "success" : "warning"} />
              <DiagRow label="Microphone" value={phone.diag.micPermission}
                tone={phone.diag.micPermission === "granted" ? "success" : phone.diag.micPermission === "denied" ? "danger" : "warning"} />
            </div>

            {showDiag && (
              <div className="stack compact-stack" style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
                <DiagRow label="SIP WSS" value={phone.diag.sipWssUrl ?? "NOT SET"}
                  tone={phone.diag.sipWssConfigured ? "success" : "danger"} />
                <DiagRow label="SIP Domain" value={phone.diag.sipDomain ?? "NOT SET"}
                  tone={phone.diag.sipDomainConfigured ? "success" : "danger"} />
                <DiagRow label="Extension" value={phone.diag.extensionNumber ?? "—"} />
                <DiagRow label="SIP User" value={phone.diag.sipUsername ?? "—"} />
                {phone.diag.iceConnectionState && (
                  <DiagRow label="ICE" value={phone.diag.iceConnectionState}
                    tone={iceTone(phone.diag.iceConnectionState)} />
                )}
                {phone.callState === "connected" && (
                  <>
                    {phone.diag.audioCodec && <DiagRow label="Codec" value={phone.diag.audioCodec} />}
                    {phone.diag.rttMs != null && <DiagRow label="RTT" value={`${phone.diag.rttMs}ms`}
                      tone={phone.diag.rttMs > 300 ? "danger" : phone.diag.rttMs > 150 ? "warning" : "success"} />}
                    {phone.diag.jitterMs != null && <DiagRow label="Jitter" value={`${phone.diag.jitterMs}ms`}
                      tone={phone.diag.jitterMs > 50 ? "warning" : "success"} />}
                    {phone.diag.packetsLost != null && phone.diag.packetsLost > 0 && (
                      <DiagRow label="Pkt Lost" value={String(phone.diag.packetsLost)} tone="danger" />
                    )}
                    {phone.diag.bitrateKbps != null && <DiagRow label="Bitrate" value={`${phone.diag.bitrateKbps} kbps`} />}
                    {phone.diag.qualityGrade && <DiagRow label="Quality" value={phone.diag.qualityGrade}
                      tone={phone.diag.qualityGrade === "excellent" || phone.diag.qualityGrade === "good" ? "success" : "warning"} />}
                  </>
                )}
                {phone.error && <DiagRow label="Error" value={phone.error} tone="danger" />}
                {phone.diag.lastRegError && <DiagRow label="Reg Error" value={phone.diag.lastRegError} tone="danger" />}
              </div>
            )}

            {phone.diag.webrtcEnabled && !phone.diag.hasTurn && phone.regState === "registered" && (
              <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 8, background: T.amberSoft, color: T.amber, fontSize: 12 }}>
                ⚠ No TURN server — audio may fail behind strict NAT.
              </div>
            )}
          </div>

        </section>
      </div>
    </PermissionGate>
  );
}

// ─── SVG Icons ────────────────────────────────────────────────────────────────

function MicIcon({ muted }: { muted: boolean }) {
  return muted ? (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="1" y1="1" x2="23" y2="23"/>
      <path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6"/>
      <path d="M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23"/>
      <line x1="12" y1="19" x2="12" y2="23"/>
      <line x1="8" y1="23" x2="16" y2="23"/>
    </svg>
  ) : (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
      <path d="M19 10v2a7 7 0 01-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/>
      <line x1="8" y1="23" x2="16" y2="23"/>
    </svg>
  );
}

function KeypadIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9.5" y="2" width="5" height="5" rx="1"/>
      <rect x="17" y="2" width="5" height="5" rx="1"/><rect x="2" y="9.5" width="5" height="5" rx="1"/>
      <rect x="9.5" y="9.5" width="5" height="5" rx="1"/><rect x="17" y="9.5" width="5" height="5" rx="1"/>
      <rect x="2" y="17" width="5" height="5" rx="1"/><rect x="9.5" y="17" width="5" height="5" rx="1"/>
      <rect x="17" y="17" width="5" height="5" rx="1"/>
    </svg>
  );
}

function SpeakerIcon({ on }: { on: boolean }) {
  return on ? (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
      <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>
    </svg>
  ) : (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
      <path d="M15.54 8.46a5 5 0 010 7.07"/>
    </svg>
  );
}

function HoldIcon({ held }: { held: boolean }) {
  return held ? (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>
  ) : (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
    </svg>
  );
}

function AddCallIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.8 19.8 0 01-8.63-3.07A19.5 19.5 0 013.07 10.8 19.8 19.8 0 01.02 2.18 2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.9.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.34 1.85.573 2.81.7A2 2 0 0122 14h0v2.92z"/>
      <line x1="19" y1="2" x2="19" y2="8"/><line x1="16" y1="5" x2="22" y2="5"/>
    </svg>
  );
}

function TransferIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="17 1 21 5 17 9"/>
      <path d="M3 11V9a4 4 0 014-4h14"/>
      <polyline points="7 23 3 19 7 15"/>
      <path d="M21 13v2a4 4 0 01-4 4H3"/>
    </svg>
  );
}

function EndCallIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.68 13.31a16 16 0 003.41 2.6l1.27-1.27a2 2 0 012.11-.45c.91.34 1.85.57 2.81.7a2 2 0 011.72 2v3a2 2 0 01-2.18 2A19.8 19.8 0 012 5.18 2 2 0 014 3h3a2 2 0 012 1.72c.13.96.36 1.9.7 2.81a2 2 0 01-.45 2.11L8.09 10.9a16 16 0 002.59 2.41z"/>
      <line x1="23" y1="1" x2="1" y2="23"/>
    </svg>
  );
}

function AnswerIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.8 19.8 0 01-8.63-3.07A19.5 19.5 0 013.07 10.8 19.8 19.8 0 01.02 2.18 2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.9.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.34 1.85.573 2.81.7A2 2 0 0122 14h0v2.92z"/>
    </svg>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function DiagRow({ label, value, tone }: {
  label: string; value: string;
  tone?: "success" | "warning" | "danger" | "info" | "neutral";
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, gap: 8 }}>
      <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{label}</span>
      {tone
        ? <StatusChip tone={tone} label={value} />
        : <code style={{ fontSize: 11, wordBreak: "break-all" }}>{value}</code>}
    </div>
  );
}

function regLabel(s: string) {
  switch (s) {
    case "connecting":     return "Connecting…";
    case "registering":    return "Registering…";
    case "registered":     return "Registered ✓";
    case "unregistering":  return "Unregistering…";
    case "failed":         return "Reg. Failed ✗";
    default:               return "Idle";
  }
}

function iceTone(s: string): "success" | "warning" | "danger" | "neutral" {
  switch (s) {
    case "connected": case "completed": return "success";
    case "checking":  return "warning";
    case "failed":    return "danger";
    case "disconnected": return "warning";
    default: return "neutral";
  }
}
