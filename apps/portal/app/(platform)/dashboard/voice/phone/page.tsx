"use client";

import { useState } from "react";
import { DetailCard } from "../../../../../components/DetailCard";
import { PageHeader } from "../../../../../components/PageHeader";
import { PermissionGate } from "../../../../../components/PermissionGate";
import { StatusChip } from "../../../../../components/StatusChip";
import { useSipPhone } from "../../../../../hooks/useSipPhone";

const REG_TONE: Record<string, "success" | "warning" | "info" | "danger" | "neutral"> = {
  registered: "success",
  registering: "info",
  failed: "danger",
  idle: "warning"
};

const CALL_TONE: Record<string, "success" | "warning" | "info" | "danger" | "neutral"> = {
  connected: "success",
  ringing: "warning",
  dialing: "info",
  ended: "warning",
  idle: "info"
};

export default function VoicePhonePage() {
  const phone = useSipPhone();
  const [dialInput, setDialInput] = useState("");
  const [muted, setMuted] = useState(false);

  const appendDigit = (d: string) => {
    setDialInput((p) => p + d);
    if (phone.callState === "connected") phone.sendDtmf(d);
  };

  const handleCall = () => {
    const target = dialInput.trim();
    if (!target) return;
    phone.dial(target);
  };

  const handleHangup = () => {
    phone.hangup();
    setMuted(false);
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    phone.setMute(next);
  };

  if (!phone.webrtcEnabled) {
    return (
      <PermissionGate permission="can_view_calls" fallback={<div className="state-box">You do not have voice phone access.</div>}>
        <div className="stack compact-stack">
          <PageHeader title="Voice Phone Console" subtitle="WebRTC browser phone" />
          <div className="state-box">
            <strong>WebRTC not available</strong>
            <p style={{ marginTop: 6, fontSize: 13 }}>
              Your browser does not support WebRTC, or this page is running server-side.
              Use a modern browser (Chrome, Firefox, Edge) to access the softphone.
            </p>
          </div>
        </div>
      </PermissionGate>
    );
  }

  return (
    <PermissionGate permission="can_view_calls" fallback={<div className="state-box">You do not have voice phone access.</div>}>
      <div className="stack compact-stack">
        <PageHeader title="Voice Phone Console" subtitle="Browser WebRTC softphone" />
        <section className="chat-layout">

          {/* Status bar */}
          <DetailCard title="Status">
            <div className="row-wrap" style={{ gap: 8 }}>
              <StatusChip tone={REG_TONE[phone.regState] ?? "info"} label={`SIP: ${phone.regState}`} />
              <StatusChip tone={CALL_TONE[phone.callState] ?? "info"} label={`Call: ${phone.callState}`} />
              {phone.extension?.sipUsername && (
                <StatusChip tone="info" label={`Ext: ${phone.extension.sipUsername}`} />
              )}
              {phone.remoteParty && (
                <StatusChip tone="success" label={`Party: ${phone.remoteParty}`} />
              )}
              {muted && <StatusChip tone="warning" label="Muted" />}
            </div>
            {phone.error && (
              <p style={{ marginTop: 8, fontSize: 13, color: "var(--error, #c00)" }}>{phone.error}</p>
            )}
          </DetailCard>

          {/* Dialer */}
          <DetailCard title="Dialer">
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                value={dialInput}
                onChange={(e) => setDialInput(e.target.value)}
                placeholder="Extension or number"
                onKeyDown={(e) => e.key === "Enter" && handleCall()}
              />
              <button className="btn" onClick={handleCall} disabled={!dialInput.trim() || phone.regState !== "registered"}>
                Call
              </button>
            </div>

            <div className="grid three" style={{ gap: 6, marginBottom: 12 }}>
              {["1","2","3","4","5","6","7","8","9","*","0","#"].map((digit) => (
                <button
                  key={digit}
                  className="btn ghost"
                  style={{ padding: "10px 0", fontSize: 16 }}
                  onClick={() => appendDigit(digit)}
                >
                  {digit}
                </button>
              ))}
            </div>

            <div className="row-actions">
              {phone.callState === "ringing" && phone.remoteParty && (
                <button className="btn" onClick={() => phone.answer()}>Answer</button>
              )}
              {(phone.callState === "connected" || phone.callState === "dialing" || phone.callState === "ringing") && (
                <>
                  <button className="btn ghost" onClick={toggleMute}>
                    {muted ? "Unmute" : "Mute"}
                  </button>
                  <button className="btn" onClick={handleHangup}>Hang Up</button>
                </>
              )}
              {phone.callState === "idle" && (
                <button
                  className="btn ghost"
                  onClick={() => setDialInput("")}
                  disabled={!dialInput}
                >
                  Clear
                </button>
              )}
            </div>
          </DetailCard>

        </section>
      </div>
    </PermissionGate>
  );
}
