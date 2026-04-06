"use client";

import { useEffect, useRef, useState } from "react";
import { useSipPhone } from "../hooks/useSipPhone";

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const REG_COLOR: Record<string, string> = {
  registered:       "var(--success)",
  registering:      "var(--warning)",
  connecting:       "var(--warning)",
  unregistering:    "var(--warning)",
  failed:           "var(--danger)",
  idle:             "var(--text-dim)",
};

// ── Dialpad ───────────────────────────────────────────────────────────────────

const DIALPAD: [string, string][][] = [
  [["1", ""], ["2", "ABC"], ["3", "DEF"]],
  [["4", "GHI"], ["5", "JKL"], ["6", "MNO"]],
  [["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"]],
  [["*", ""], ["0", "+"], ["#", ""]],
];

function DialButton({ digit, sub, onClick }: { digit: string; sub: string; onClick: (d: string) => void }) {
  return (
    <button
      className="dialpad-key"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onClick(digit)}
      style={{
        background: "var(--panel-2)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "10px 6px",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 1,
        transition: "background 0.12s",
        color: "var(--text)",
        userSelect: "none",
      }}
    >
      <span style={{ fontSize: 18, fontWeight: 600, lineHeight: 1 }}>{digit}</span>
      {sub ? <span style={{ fontSize: 9, color: "var(--text-dim)", letterSpacing: "0.8px" }}>{sub}</span> : null}
    </button>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function FloatingDialer() {
  const [open, setOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const phone = useSipPhone();

  // Call timer
  useEffect(() => {
    if (phone.callState === "connected") {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      if (phone.callState === "ended" || phone.callState === "idle") setElapsed(0);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phone.callState]);

  // Flash the dialer open when an incoming call arrives
  useEffect(() => {
    if (phone.callState === "ringing") setOpen(true);
  }, [phone.callState]);

  function handleKey(digit: string) {
    phone.setDialpadInput(phone.dialpadInput + digit);
    if (phone.callState === "connected") phone.sendDtmf(digit);
  }

  function handleBackspace() {
    phone.setDialpadInput(phone.dialpadInput.slice(0, -1));
  }

  const isInCall = phone.callState !== "idle" && phone.callState !== "ended";
  const canDial = phone.regState === "registered" && phone.dialpadInput.trim().length > 0;

  // Button icon color based on reg state
  const regDot = REG_COLOR[phone.regState] ?? "var(--text-dim)";

  return (
    <>
      {/* Toggle button in topbar */}
      <button
        className="icon-btn"
        onClick={() => setOpen((v) => !v)}
        title={`Phone (${phone.regState})`}
        aria-label="Toggle softphone"
        style={{ position: "relative" }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 16.92v3a2 2 0 01-2.18 2 19.8 19.8 0 01-8.63-3.07A19.5 19.5 0 013.07 10.8 19.8 19.8 0 01.02 2.18 2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.9.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.91.34 1.85.573 2.81.7A2 2 0 0122 14h0v2.92z"/>
        </svg>
        {/* Reg status dot */}
        <span style={{
          position: "absolute",
          top: 4,
          right: 4,
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: regDot,
          border: "2px solid var(--panel)",
        }} />
        {/* Ringing pulse */}
        {phone.callState === "ringing" ? (
          <span style={{
            position: "absolute",
            inset: 0,
            borderRadius: 8,
            animation: "presence-pulse 1s infinite",
            background: "rgba(234,96,104,0.18)",
          }} />
        ) : null}
      </button>

      {/* Slide-out dialer panel */}
      {open ? (
        <div
          style={{
            position: "fixed",
            top: 60,
            right: 12,
            width: 280,
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            boxShadow: "var(--shadow)",
            zIndex: 200,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Header */}
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
            background: "var(--panel-2)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: regDot, display: "inline-block" }} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                {phone.regState === "registered" ? "Registered" :
                 phone.regState === "registering" ? "Registering…" :
                 phone.regState === "connecting" ? "Connecting…" :
                 phone.regState === "failed" ? "Reg Failed" : "Softphone"}
              </span>
              {phone.diag.extensionNumber ? (
                <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Ext {phone.diag.extensionNumber}</span>
              ) : null}
            </div>
            <button className="icon-btn" onClick={() => setOpen(false)} style={{ fontSize: 16, lineHeight: 1 }}>✕</button>
          </div>

          <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>

            {/* Active call banner */}
            {isInCall ? (
              <div style={{
                background: phone.callState === "ringing" ? "rgba(234,96,104,0.12)" : "rgba(52,194,123,0.12)",
                border: `1px solid ${phone.callState === "ringing" ? "var(--danger)" : "var(--success)"}`,
                borderRadius: 8,
                padding: "8px 12px",
                textAlign: "center",
              }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {phone.callState === "ringing" ? "📞 Incoming Call" :
                   phone.callState === "dialing" ? "Dialing…" :
                   phone.callState === "connected" ? "On Call" : phone.callState}
                </div>
                {phone.remoteParty ? (
                  <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>{phone.remoteParty}</div>
                ) : null}
                {phone.callState === "connected" ? (
                  <div style={{ fontSize: 11, color: "var(--success)", marginTop: 2 }}>{fmtDuration(elapsed)}</div>
                ) : null}
              </div>
            ) : null}

            {/* Errors */}
            {phone.error ? (
              <div className="chip danger" style={{ fontSize: 12 }}>{phone.error}</div>
            ) : null}

            {/* Input display */}
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                className="input"
                style={{ flex: 1, fontSize: 18, letterSpacing: 2, fontWeight: 600, textAlign: "center" }}
                value={phone.dialpadInput}
                onChange={(e) => phone.setDialpadInput(e.target.value)}
                placeholder="Enter number"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canDial) phone.dial(phone.dialpadInput);
                  if (e.key === "Backspace") phone.setDialpadInput(phone.dialpadInput.slice(0, -1));
                }}
                readOnly={isInCall}
              />
              {phone.dialpadInput.length > 0 && !isInCall ? (
                <button
                  className="icon-btn"
                  onClick={handleBackspace}
                  title="Backspace"
                  style={{ fontSize: 16 }}
                >
                  ⌫
                </button>
              ) : null}
            </div>

            {/* Dialpad grid */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
              {DIALPAD.flat().map(([digit, sub]) => (
                <DialButton key={digit} digit={digit} sub={sub} onClick={handleKey} />
              ))}
            </div>

            {/* Action buttons */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {/* Answer (incoming) */}
              {phone.callState === "ringing" ? (
                <button
                  className="btn"
                  style={{ background: "var(--success)", border: "none", gridColumn: "1", fontSize: 13 }}
                  onClick={() => phone.answer()}
                >
                  Answer
                </button>
              ) : null}

              {/* Dial / Hangup */}
              {phone.callState === "idle" || phone.callState === "ended" ? (
                <button
                  className="btn"
                  style={{ gridColumn: "1 / -1", background: "var(--success)", border: "none", fontSize: 15, letterSpacing: 0.5 }}
                  onClick={() => phone.dial(phone.dialpadInput)}
                  disabled={!canDial}
                >
                  Call
                </button>
              ) : (
                <button
                  className="btn"
                  style={{
                    gridColumn: phone.callState === "ringing" ? "2" : "1 / -1",
                    background: "var(--danger)",
                    border: "none",
                    fontSize: 13
                  }}
                  onClick={() => phone.hangup()}
                >
                  {phone.callState === "ringing" ? "Decline" : "Hang Up"}
                </button>
              )}
            </div>

            {/* In-call controls */}
            {phone.callState === "connected" ? (
              <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                <button
                  className="btn ghost"
                  style={{ fontSize: 12, flex: 1, background: phone.muted ? "rgba(234,96,104,0.12)" : undefined }}
                  onClick={() => phone.setMute(!phone.muted)}
                >
                  {phone.muted ? "🔇 Muted" : "🎙 Mute"}
                </button>
              </div>
            ) : null}

            {/* In-call quality stats */}
            {phone.callState === "connected" && (
              <div style={{
                fontSize: 11,
                borderTop: "1px solid var(--border)",
                paddingTop: 8,
                display: "flex",
                flexDirection: "column",
                gap: 3,
              }}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {phone.diag.isUsingRelay ? (
                    <span style={{ padding: "1px 6px", borderRadius: 4, background: "rgba(16,185,129,0.12)", color: "var(--success)", fontSize: 10, fontWeight: 600 }}>
                      TURN Relay ✓
                    </span>
                  ) : phone.diag.selectedCandidateType ? (
                    <span style={{ padding: "1px 6px", borderRadius: 4, background: "var(--panel-2)", color: "var(--text-dim)", fontSize: 10 }}>
                      ICE: {phone.diag.selectedCandidateType}
                    </span>
                  ) : null}
                  {phone.diag.rttMs !== null ? (
                    <span style={{ padding: "1px 6px", borderRadius: 4, background: "var(--panel-2)", color: phone.diag.rttMs > 300 ? "var(--warning)" : "var(--text-dim)", fontSize: 10 }}>
                      RTT {phone.diag.rttMs}ms
                    </span>
                  ) : null}
                  {phone.diag.jitterMs !== null ? (
                    <span style={{ padding: "1px 6px", borderRadius: 4, background: "var(--panel-2)", color: phone.diag.jitterMs > 30 ? "var(--warning)" : "var(--text-dim)", fontSize: 10 }}>
                      Jitter {phone.diag.jitterMs}ms
                    </span>
                  ) : null}
                  {phone.diag.packetsLost !== null && phone.diag.packetsLost > 0 ? (
                    <span style={{ padding: "1px 6px", borderRadius: 4, background: "rgba(239,68,68,0.1)", color: "var(--danger)", fontSize: 10 }}>
                      ✕ {phone.diag.packetsLost} lost
                    </span>
                  ) : null}
                </div>
                {phone.diag.iceConnectionState && phone.diag.iceConnectionState !== "connected" && phone.diag.iceConnectionState !== "completed" ? (
                  <span style={{ color: "var(--warning)", fontSize: 10 }}>ICE: {phone.diag.iceConnectionState}</span>
                ) : null}
              </div>
            )}

            {/* Pre-call readiness summary */}
            {!isInCall && (
              <div style={{
                fontSize: 11,
                color: "var(--text-dim)",
                borderTop: "1px solid var(--border)",
                paddingTop: 8,
                display: "flex",
                flexDirection: "column",
                gap: 3,
              }}>
                {phone.diag.sipWssUrl ? (
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    WSS: {phone.diag.sipWssUrl}
                  </span>
                ) : null}
                {!phone.diag.hasTurn ? (
                  <span style={{ color: "var(--warning)" }}>⚠ No TURN — audio may fail behind NAT</span>
                ) : (
                  <span style={{ color: "var(--success)" }}>✓ TURN configured</span>
                )}
                {phone.diag.micPermission === "denied" ? (
                  <span style={{ color: "var(--danger)" }}>✕ Microphone denied</span>
                ) : phone.diag.micPermission === "granted" ? (
                  <span style={{ color: "var(--success)" }}>✓ Microphone ready</span>
                ) : null}
                {phone.diag.lastRegError ? (
                  <span style={{ color: "var(--danger)" }}>✕ {phone.diag.lastRegError}</span>
                ) : null}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* Click-outside overlay */}
      {open ? (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 199 }}
          onClick={() => setOpen(false)}
          aria-hidden
        />
      ) : null}
    </>
  );
}
