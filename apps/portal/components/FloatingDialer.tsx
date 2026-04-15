"use client";

import { useEffect, useRef, useState } from "react";
import { useSipPhone } from "../hooks/useSipPhone";

// ─── Design tokens (match phone page) ────────────────────────────────────────

const T = {
  bg:        "linear-gradient(160deg, #0d1117 0%, #161b2e 60%, #0d1117 100%)",
  surface:   "rgba(255,255,255,0.05)",
  border:    "rgba(255,255,255,0.08)",
  text:      "#f1f5f9",
  textSec:   "#94a3b8",
  accent:    "#7c3aed",
  accentSoft:"rgba(124,58,237,0.22)",
  accentGlow:"rgba(124,58,237,0.30)",
  green:     "#10b981",
  greenSoft: "rgba(16,185,129,0.15)",
  amber:     "#f59e0b",
  amberSoft: "rgba(245,158,11,0.15)",
  red:       "#ef4444",
  redSoft:   "rgba(239,68,68,0.14)",
  redGlow:   "rgba(239,68,68,0.45)",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(sec: number) {
  return `${String(Math.floor(sec/60)).padStart(2,"0")}:${String(sec%60).padStart(2,"0")}`;
}

function initials(s: string | null) {
  if (!s) return "?";
  const w = s.trim().split(/[\s@._-]+/);
  if (w.length >= 2) return (w[0][0]+w[1][0]).toUpperCase();
  return (s.replace(/[^a-zA-Z0-9]/g,"")[0] ?? "?").toUpperCase();
}

// ─── Compact circular control button ─────────────────────────────────────────

function Btn({
  icon, label, onClick, active = false, danger = false, disabled = false,
}: {
  icon: React.ReactNode; label: string;
  onClick?: () => void; active?: boolean; danger?: boolean; disabled?: boolean;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      title={label}
      style={{
        display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", gap: 4, padding: "10px 4px",
        borderRadius: 14, border: "none", cursor: disabled ? "default" : "pointer",
        background: danger ? (active ? T.redSoft : "rgba(239,68,68,0.07)")
                  : active ? T.accentSoft : T.surface,
        color: danger ? T.red : active ? "#a78bfa" : disabled ? "rgba(148,163,184,0.3)" : T.textSec,
        boxShadow: active
          ? (danger ? `0 0 0 1px ${T.red}55, 0 2px 12px ${T.redGlow}55`
                    : `0 0 0 1px ${T.accent}66, 0 2px 10px ${T.accentGlow}`)
          : `0 0 0 1px ${T.border}`,
        opacity: disabled ? 0.38 : 1,
        transition: "all 0.15s",
        flex: 1, minWidth: 0,
      }}
    >
      <span style={{ fontSize: 18, lineHeight: 1, display: "flex" }}>{icon}</span>
      <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.2px", lineHeight: 1 }}>{label}</span>
    </button>
  );
}

// ─── Mini avatar ──────────────────────────────────────────────────────────────

function MiniAvatar({ party }: { party: string | null }) {
  return (
    <div style={{
      width: 38, height: 38, borderRadius: "50%", flexShrink: 0,
      background: "linear-gradient(135deg, #7c3aed, #a855f7, #6366f1)",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 14, fontWeight: 700, color: "#fff",
      boxShadow: "0 0 0 2px rgba(124,58,237,0.25), 0 3px 12px rgba(124,58,237,0.3)",
    }}>
      {initials(party)}
    </div>
  );
}

// ─── DTMF grid (compact, shown inside active call) ────────────────────────────

const DIALPAD: [string,string][] = [
  ["1",""],["2","ABC"],["3","DEF"],
  ["4","GHI"],["5","JKL"],["6","MNO"],
  ["7","PQRS"],["8","TUV"],["9","WXYZ"],
  ["*",""],["0","+"],["#",""],
];

function DtmfPad({ onKey }: { onKey: (d:string)=>void }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 5 }}>
      {DIALPAD.map(([d,s]) => (
        <button key={d} onClick={() => onKey(d)}
          style={{
            padding: "8px 0", borderRadius: 10,
            border: `1px solid ${T.border}`,
            background: "rgba(255,255,255,0.05)", color: T.text,
            cursor: "pointer", display: "flex", flexDirection: "column",
            alignItems: "center", gap: 1,
          }}>
          <span style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.1 }}>{d}</span>
          {s && <span style={{ fontSize: 8, opacity: 0.4, letterSpacing: 1 }}>{s}</span>}
        </button>
      ))}
    </div>
  );
}

// ─── SVG Icons ────────────────────────────────────────────────────────────────

function IcMic({ muted }: { muted: boolean }) {
  return muted ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="1" y1="1" x2="23" y2="23"/>
      <path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6"/>
      <path d="M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23"/>
      <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
      <path d="M19 10v2a7 7 0 01-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
    </svg>
  );
}

function IcKeypad() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9.5" y="2" width="5" height="5" rx="1"/>
      <rect x="17" y="2" width="5" height="5" rx="1"/><rect x="2" y="9.5" width="5" height="5" rx="1"/>
      <rect x="9.5" y="9.5" width="5" height="5" rx="1"/><rect x="17" y="9.5" width="5" height="5" rx="1"/>
      <rect x="2" y="17" width="5" height="5" rx="1"/><rect x="9.5" y="17" width="5" height="5" rx="1"/>
      <rect x="17" y="17" width="5" height="5" rx="1"/>
    </svg>
  );
}

function IcSpeaker({ on }: { on: boolean }) {
  return on ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
      <path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
      <path d="M15.54 8.46a5 5 0 010 7.07"/>
    </svg>
  );
}

function IcHold({ held }: { held: boolean }) {
  return held ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
    </svg>
  );
}

function IcTransfer() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="17 1 21 5 17 9"/>
      <path d="M3 11V9a4 4 0 014-4h14"/>
      <polyline points="7 23 3 19 7 15"/>
      <path d="M21 13v2a4 4 0 01-4 4H3"/>
    </svg>
  );
}

function IcEndCall() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.68 13.31a16 16 0 003.41 2.6l1.27-1.27a2 2 0 012.11-.45c.91.34 1.85.57 2.81.7a2 2 0 011.72 2v3a2 2 0 01-2.18 2A19.8 19.8 0 012 5.18 2 2 0 014 3h3a2 2 0 012 1.72c.13.96.36 1.9.7 2.81a2 2 0 01-.45 2.11L8.09 10.9a16 16 0 002.59 2.41z"/>
      <line x1="23" y1="1" x2="1" y2="23"/>
    </svg>
  );
}

function IcAnswer() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 01-2.18 2 19.8 19.8 0 01-8.63-3.07A19.5 19.5 0 013.07 10.8 19.8 19.8 0 01.02 2.18 2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.9.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.34 1.85.573 2.81.7A2 2 0 0122 14h0v2.92z"/>
    </svg>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function FloatingDialer() {
  const [open, setOpen]           = useState(false);
  const [elapsed, setElapsed]     = useState(0);
  const [showDtmf, setShowDtmf]   = useState(false);
  const [showXfer, setShowXfer]   = useState(false);
  const [xferTarget, setXferTarget] = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const phone = useSipPhone();

  // ── Timer ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (phone.callState === "connected") {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      if (phone.callState === "idle" || phone.callState === "ended") setElapsed(0);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phone.callState]);

  // ── Auto-open ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (phone.callState === "ringing" && phone.callDirection === "inbound") setOpen(true);
    if (phone.callState === "dialing") setOpen(true);
  }, [phone.callState, phone.callDirection]);

  // ── Reset DTMF/xfer when call ends ────────────────────────────────────────
  useEffect(() => {
    if (phone.callState === "idle" || phone.callState === "ended") {
      setShowDtmf(false);
      setShowXfer(false);
      setXferTarget("");
    }
  }, [phone.callState]);

  // ── Key handler ───────────────────────────────────────────────────────────
  function handleKey(digit: string) {
    if (phone.callState === "connected") {
      phone.sendDtmf(digit);
    } else {
      phone.playDtmfTone(digit);
      phone.setDialpadInput(phone.dialpadInput + digit);
    }
  }

  const isInCall   = phone.callState !== "idle" && phone.callState !== "ended";
  const isActive   = phone.callState === "connected";
  const isIncoming = phone.callState === "ringing" && phone.callDirection === "inbound";
  const isOutgoing = phone.callState === "dialing" ||
    (phone.callState === "ringing" && phone.callDirection === "outbound");
  const canDial    = phone.regState === "registered" && phone.dialpadInput.trim().length > 0;

  const regDotColor = phone.regState === "registered" ? T.green
    : phone.regState === "failed" ? T.red
    : T.amber;

  return (
    <>
      <style>{`
        @keyframes fp-pulse {
          0%,100%{transform:scale(1);opacity:.7}
          50%{transform:scale(1.15);opacity:1}
        }
        @keyframes fp-fadein {
          from{opacity:0;transform:translateY(-6px)}
          to{opacity:1;transform:translateY(0)}
        }
      `}</style>

      {/* ── Topbar phone button ──────────────────────────────────────────── */}
      <button
        className="icon-btn"
        onClick={() => setOpen((v) => !v)}
        title={`Softphone (${phone.regState})`}
        aria-label="Toggle softphone"
        style={{ position: "relative" }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 16.92v3a2 2 0 01-2.18 2 19.8 19.8 0 01-8.63-3.07A19.5 19.5 0 013.07 10.8 19.8 19.8 0 01.02 2.18 2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.9.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.34 1.85.573 2.81.7A2 2 0 0122 14h0v2.92z"/>
        </svg>
        {/* Registration dot */}
        <span style={{
          position: "absolute", top: 3, right: 3,
          width: 7, height: 7, borderRadius: "50%",
          background: regDotColor,
          border: "2px solid var(--panel)",
          boxShadow: phone.regState === "registered" ? `0 0 4px ${T.green}` : undefined,
        }} />
        {/* Incoming ring pulse */}
        {isIncoming && (
          <span style={{
            position: "absolute", inset: 0, borderRadius: 8,
            background: "rgba(239,68,68,0.18)",
            animation: "fp-pulse 1s ease-in-out infinite",
          }} />
        )}
      </button>

      {/* ── Dropdown panel ───────────────────────────────────────────────── */}
      {open && (
        <div style={{
          position: "fixed", top: 58, right: 12,
          width: 280,
          background: T.bg,
          border: `1px solid ${T.border}`,
          borderRadius: 16,
          boxShadow: "0 12px 48px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04)",
          zIndex: 200, overflow: "hidden",
          animation: "fp-fadein 0.18s ease",
        }}>

          {/* ── Header bar ─────────────────────────────────────────────── */}
          <div style={{
            display: "flex", alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 12px 10px 14px",
            borderBottom: `1px solid ${T.border}`,
            background: "rgba(255,255,255,0.03)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: regDotColor, flexShrink: 0,
                boxShadow: phone.regState === "registered" ? `0 0 4px ${T.green}` : undefined }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: T.text }}>
                {phone.regState === "registered"
                  ? `Ext ${phone.diag.extensionNumber ?? "–"}`
                  : phone.regState === "registering" ? "Registering…"
                  : phone.regState === "connecting" ? "Connecting…"
                  : phone.regState === "failed" ? "Reg Failed"
                  : "Softphone"}
              </span>
            </div>
            <button onClick={() => setOpen(false)}
              style={{ background: "none", border: "none", color: T.textSec, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "2px 4px" }}>
              ✕
            </button>
          </div>

          {/* ── IDLE / KEYPAD ──────────────────────────────────────────── */}
          {!isInCall && (
            <div style={{ padding: "12px 12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
              {/* Number input */}
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  className="input"
                  type="tel"
                  placeholder="Extension or number…"
                  value={phone.dialpadInput}
                  onChange={(e) => phone.setDialpadInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canDial) phone.dial(phone.dialpadInput);
                    if (e.key === "Backspace") phone.setDialpadInput(phone.dialpadInput.slice(0,-1));
                    const keys=["0","1","2","3","4","5","6","7","8","9","*","#"];
                    if (keys.includes(e.key)) { e.preventDefault(); handleKey(e.key); }
                  }}
                  style={{ flex: 1, fontSize: 17, letterSpacing: 2, fontWeight: 600, textAlign: "center",
                    fontFamily: "monospace", background: "rgba(255,255,255,0.05)", color: T.text, border: `1px solid ${T.border}` }}
                />
                {phone.dialpadInput && (
                  <button onClick={() => phone.setDialpadInput(phone.dialpadInput.slice(0,-1))}
                    style={{ background: "none", border: "none", color: T.textSec, cursor: "pointer", fontSize: 16, padding: 4 }}>⌫</button>
                )}
              </div>

              {/* Compact dialpad */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 5 }}>
                {DIALPAD.map(([d,s]) => (
                  <button key={d} onClick={() => handleKey(d)}
                    onMouseDown={(e) => e.preventDefault()}
                    style={{
                      padding: "8px 0", borderRadius: 10,
                      border: `1px solid ${T.border}`,
                      background: "rgba(255,255,255,0.05)", color: T.text,
                      cursor: "pointer", display: "flex", flexDirection: "column",
                      alignItems: "center", gap: 1, userSelect: "none",
                    }}>
                    <span style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.1 }}>{d}</span>
                    {s && <span style={{ fontSize: 8, opacity: 0.4, letterSpacing: 1 }}>{s}</span>}
                  </button>
                ))}
              </div>

              {/* Call button */}
              <button
                onClick={() => phone.dial(phone.dialpadInput)}
                disabled={!canDial}
                style={{
                  padding: "11px", borderRadius: 50, border: "none",
                  background: canDial
                    ? "linear-gradient(135deg, #10b981, #059669)"
                    : "rgba(255,255,255,0.06)",
                  color: canDial ? "#fff" : T.textSec,
                  fontSize: 14, fontWeight: 700, cursor: canDial ? "pointer" : "default",
                  boxShadow: canDial ? "0 3px 16px rgba(16,185,129,0.45)" : "none",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                  transition: "all 0.15s",
                }}>
                <IcAnswer /> Call
              </button>

              {/* Status footer */}
              <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 10, color: T.textSec,
                borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
                {!phone.diag.hasTurn
                  ? <span style={{ color: T.amber }}>⚠ No TURN — audio may fail behind NAT</span>
                  : <span style={{ color: T.green }}>✓ TURN configured</span>}
                {phone.diag.micPermission === "denied" && <span style={{ color: T.red }}>✕ Microphone denied</span>}
                {phone.diag.micPermission === "granted" && <span style={{ color: T.green }}>✓ Microphone ready</span>}
                {phone.error && <span style={{ color: T.red }}>✕ {phone.error}</span>}
              </div>
            </div>
          )}

          {/* ── OUTGOING CALL ──────────────────────────────────────────── */}
          {isOutgoing && (
            <div style={{ padding: "20px 14px 18px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
              {/* Pulsing glow */}
              <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div style={{
                  position: "absolute", width: 80, height: 80, borderRadius: "50%",
                  background: "radial-gradient(circle, rgba(124,58,237,0.25) 0%, transparent 70%)",
                  animation: "fp-pulse 2s ease-in-out infinite",
                }} />
                <MiniAvatar party={phone.remoteParty ?? phone.dialpadInput} />
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>
                  {phone.remoteParty ?? phone.dialpadInput}
                </div>
                <div style={{ fontSize: 11, color: T.textSec, marginTop: 3, letterSpacing: 1 }}>
                  {phone.callState === "dialing" ? "Calling…" : "Ringing…"}
                </div>
              </div>
              <button onClick={phone.hangup} style={{
                width: 48, height: 48, borderRadius: "50%", border: "none",
                background: "linear-gradient(135deg, #ef4444, #dc2626)",
                color: "#fff", cursor: "pointer", fontSize: 18,
                boxShadow: `0 3px 16px ${T.redGlow}`,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <IcEndCall />
              </button>
            </div>
          )}

          {/* ── INCOMING CALL ──────────────────────────────────────────── */}
          {isIncoming && (
            <div style={{ padding: "20px 14px 18px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, color: T.textSec, textTransform: "uppercase" }}>
                Incoming Call
              </div>
              <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div style={{
                  position: "absolute", width: 80, height: 80, borderRadius: "50%",
                  background: "radial-gradient(circle, rgba(16,185,129,0.22) 0%, transparent 70%)",
                  animation: "fp-pulse 1.5s ease-in-out infinite",
                }} />
                <MiniAvatar party={phone.remoteParty} />
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>
                {phone.remoteParty ?? "Unknown"}
              </div>
              <div style={{ display: "flex", gap: 20, marginTop: 4 }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
                  <button onClick={phone.hangup} style={{
                    width: 50, height: 50, borderRadius: "50%", border: "none",
                    background: "linear-gradient(135deg, #ef4444, #dc2626)",
                    color: "#fff", cursor: "pointer",
                    boxShadow: `0 3px 14px ${T.redGlow}`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}><IcEndCall /></button>
                  <span style={{ fontSize: 10, color: T.textSec }}>Decline</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5 }}>
                  <button onClick={phone.answer} style={{
                    width: 50, height: 50, borderRadius: "50%", border: "none",
                    background: "linear-gradient(135deg, #10b981, #059669)",
                    color: "#fff", cursor: "pointer",
                    boxShadow: "0 3px 14px rgba(16,185,129,0.5)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}><IcAnswer /></button>
                  <span style={{ fontSize: 10, color: T.textSec }}>Answer</span>
                </div>
              </div>
            </div>
          )}

          {/* ── ACTIVE CALL ────────────────────────────────────────────── */}
          {isActive && (
            <div style={{ padding: "14px 12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>

              {/* Caller row */}
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <MiniAvatar party={phone.remoteParty} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: T.text,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {phone.remoteParty ?? "Unknown"}
                  </div>
                  <div style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%",
                      background: phone.onHold ? T.amber : T.green,
                      boxShadow: phone.onHold ? undefined : `0 0 4px ${T.green}`,
                      flexShrink: 0 }} />
                    <span style={{ color: phone.onHold ? T.amber : T.green, fontWeight: 600 }}>
                      {phone.onHold ? "On Hold" : fmt(elapsed)}
                    </span>
                    {phone.diag.qualityGrade && !phone.onHold && (
                      <span style={{
                        padding: "1px 5px", borderRadius: 4, fontSize: 9, fontWeight: 700,
                        letterSpacing: "0.3px", textTransform: "uppercase",
                        background: phone.diag.qualityGrade === "excellent" || phone.diag.qualityGrade === "good" ? T.greenSoft : T.amberSoft,
                        color: phone.diag.qualityGrade === "excellent" || phone.diag.qualityGrade === "good" ? T.green : T.amber,
                      }}>
                        {phone.diag.qualityGrade}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* DTMF pad (expandable) */}
              {showDtmf && <DtmfPad onKey={(d) => phone.sendDtmf(d)} />}

              {/* Transfer input (expandable) */}
              {showXfer && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 0" }}>
                  <div style={{ fontSize: 11, color: T.textSec, fontWeight: 600 }}>Transfer to:</div>
                  <input
                    autoFocus
                    className="input"
                    placeholder="Extension…"
                    value={xferTarget}
                    onChange={(e) => setXferTarget(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && xferTarget.trim()) {
                        phone.transfer(xferTarget.trim());
                        setShowXfer(false); setXferTarget("");
                      }
                      if (e.key === "Escape") { setShowXfer(false); setXferTarget(""); }
                    }}
                    style={{ fontSize: 16, letterSpacing: 2, fontFamily: "monospace", textAlign: "center",
                      background: "rgba(255,255,255,0.05)", color: T.text, border: `1px solid ${T.border}` }}
                  />
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => { setShowXfer(false); setXferTarget(""); }}
                      style={{ flex: 1, padding: "7px", borderRadius: 8, border: `1px solid ${T.border}`,
                        background: "none", color: T.textSec, cursor: "pointer", fontSize: 12 }}>Cancel</button>
                    <button
                      onClick={() => { if (xferTarget.trim()) { phone.transfer(xferTarget.trim()); setShowXfer(false); setXferTarget(""); }}}
                      disabled={!xferTarget.trim()}
                      style={{ flex: 2, padding: "7px", borderRadius: 8, border: "none",
                        background: T.accent, color: "#fff", cursor: xferTarget.trim() ? "pointer" : "default",
                        opacity: xferTarget.trim() ? 1 : 0.5, fontSize: 12, fontWeight: 600 }}>
                      Transfer
                    </button>
                  </div>
                </div>
              )}

              {/* Row 1: Mute | Keypad | Speaker */}
              <div style={{ display: "flex", gap: 6 }}>
                <Btn icon={<IcMic muted={phone.muted} />} label={phone.muted ? "Unmute" : "Mute"}
                  active={phone.muted} onClick={() => phone.setMute(!phone.muted)} />
                <Btn icon={<IcKeypad />} label="Keypad"
                  active={showDtmf} onClick={() => { setShowDtmf(v=>!v); setShowXfer(false); }} />
                <Btn icon={<IcSpeaker on={phone.speakerOn} />} label="Speaker"
                  active={phone.speakerOn} onClick={() => phone.toggleSpeaker()} />
              </div>

              {/* Row 2: Hold | Transfer */}
              <div style={{ display: "flex", gap: 6 }}>
                <Btn icon={<IcHold held={phone.onHold} />} label={phone.onHold ? "Resume" : "Hold"}
                  active={phone.onHold} onClick={phone.toggleHold} />
                <Btn icon={<IcTransfer />} label="Transfer"
                  active={showXfer} onClick={() => { setShowXfer(v=>!v); setShowDtmf(false); }} />
              </div>

              {/* End Call */}
              <button onClick={phone.hangup} style={{
                padding: "11px", borderRadius: 50, border: "none",
                background: "linear-gradient(135deg, #ef4444, #dc2626)",
                color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer",
                boxShadow: `0 3px 18px ${T.redGlow}`,
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                transition: "transform 0.1s",
              }}
                onMouseDown={(e) => { (e.currentTarget as HTMLElement).style.transform = "scale(0.97)"; }}
                onMouseUp={(e) => { (e.currentTarget as HTMLElement).style.transform = ""; }}
              >
                <IcEndCall /> End Call
              </button>

              {/* Live stats strip */}
              {(phone.diag.rttMs != null || phone.diag.isUsingRelay || phone.diag.packetsLost) && (
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap", borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
                  {phone.diag.isUsingRelay && (
                    <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 9, fontWeight: 600,
                      background: T.greenSoft, color: T.green }}>TURN ✓</span>
                  )}
                  {phone.diag.rttMs != null && (
                    <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 9,
                      background: "rgba(255,255,255,0.05)", color: phone.diag.rttMs > 300 ? T.amber : T.textSec }}>
                      RTT {phone.diag.rttMs}ms
                    </span>
                  )}
                  {phone.diag.jitterMs != null && (
                    <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 9,
                      background: "rgba(255,255,255,0.05)", color: phone.diag.jitterMs > 30 ? T.amber : T.textSec }}>
                      Jit {phone.diag.jitterMs}ms
                    </span>
                  )}
                  {phone.diag.packetsLost != null && phone.diag.packetsLost > 0 && (
                    <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 9,
                      background: T.redSoft, color: T.red }}>
                      ✕ {phone.diag.packetsLost} lost
                    </span>
                  )}
                  {phone.diag.audioCodec && (
                    <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 9,
                      background: "rgba(255,255,255,0.05)", color: T.textSec }}>
                      {phone.diag.audioCodec}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Click-outside to close */}
      {open && (
        <div style={{ position: "fixed", inset: 0, zIndex: 199 }}
          onClick={() => setOpen(false)} aria-hidden />
      )}
    </>
  );
}
