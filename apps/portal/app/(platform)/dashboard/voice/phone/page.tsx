"use client";

import { useState } from "react";
import { DetailCard } from "../../../../../components/DetailCard";
import { PageHeader } from "../../../../../components/PageHeader";
import { PermissionGate } from "../../../../../components/PermissionGate";
import { StatusChip } from "../../../../../components/StatusChip";
import { useSipPhone } from "../../../../../hooks/useSipPhone";

const DTMF_KEYS = ["1","2","3","4","5","6","7","8","9","*","0","#"];

export default function VoicePhonePage() {
  const phone = useSipPhone();
  const [showDiag, setShowDiag] = useState(false);

  function handleDialpadKey(digit: string) {
    phone.setDialpadInput(phone.dialpadInput + digit);
    if (phone.callState === "connected") phone.sendDtmf(digit);
  }

  function handleCall() {
    const t = phone.dialpadInput.trim();
    if (t) phone.dial(t);
  }

  function handleHangup() {
    phone.hangup();
    phone.setDialpadInput("");
  }

  const regTone =
    phone.regState === "registered" ? "success"
    : phone.regState === "failed" ? "danger"
    : "info";

  const callTone =
    phone.callState === "connected" ? "success"
    : phone.callState === "ringing" || phone.callState === "dialing" ? "warning"
    : "neutral";

  return (
    <PermissionGate
      permission="can_view_calls"
      fallback={<div className="state-box">You do not have voice phone access.</div>}
    >
      <div className="stack compact-stack">
        <PageHeader
          title="Voice Phone"
          subtitle={
            phone.diag.extensionNumber
              ? `Ext ${phone.diag.extensionNumber}${phone.diag.sipUsername ? ` · ${phone.diag.sipUsername}@${phone.diag.sipDomain ?? "…"}` : ""}`
              : "Initialising…"
          }
        />

        {/* ── Error banner ───────────────────────────────────────── */}
        {phone.error && (
          <div
            className="panel"
            style={{ borderLeft: "4px solid var(--color-danger, #e53e3e)", padding: "10px 14px" }}
          >
            <span className="chip chip-danger" style={{ marginRight: 8 }}>Error</span>
            <span style={{ fontSize: 13 }}>{phone.error}</span>
          </div>
        )}

        {/* ── TURN warning ───────────────────────────────────────── */}
        {phone.diag.webrtcEnabled && !phone.diag.hasTurn && phone.regState === "registered" && (
          <div
            className="panel"
            style={{ borderLeft: "4px solid var(--color-warning, #d97706)", padding: "10px 14px" }}
          >
            <span className="chip chip-warning" style={{ marginRight: 8 }}>Warning</span>
            <span style={{ fontSize: 13 }}>
              No TURN server configured. Calls may connect but audio can fail behind strict NAT.
              Add a coturn server via Voice → Settings → WebRTC → ICE Servers.
            </span>
          </div>
        )}

        <section className="chat-layout">
          {/* ── Dialer ─────────────────────────────────────────────── */}
          <DetailCard title="Dialer">
            {/* Status row */}
            <div className="row-wrap" style={{ marginBottom: 12 }}>
              <StatusChip tone={regTone} label={regLabel(phone.regState)} />
              {phone.callState !== "idle" && (
                <StatusChip tone={callTone} label={callLabel(phone.callState)} />
              )}
              {phone.remoteParty && (
                <StatusChip tone="info" label={`📞 ${phone.remoteParty}`} />
              )}
              {phone.muted && <StatusChip tone="warning" label="Muted" />}
              {phone.diag.iceConnectionState && (
                <StatusChip
                  tone={iceTone(phone.diag.iceConnectionState)}
                  label={`ICE: ${phone.diag.iceConnectionState}`}
                />
              )}
            </div>

            {/* Number input */}
            <input
              className="input"
              type="tel"
              placeholder="Extension or number…"
              value={phone.dialpadInput}
              onChange={(e) => phone.setDialpadInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCall()}
              style={{
                marginBottom: 8,
                width: "100%",
                fontFamily: "monospace",
                fontSize: 18,
                letterSpacing: 2,
              }}
            />

            {/* DTMF keypad */}
            <div className="grid three" style={{ marginBottom: 12 }}>
              {DTMF_KEYS.map((digit) => (
                <button
                  key={digit}
                  className="btn ghost"
                  onClick={() => handleDialpadKey(digit)}
                >
                  {digit}
                </button>
              ))}
            </div>

            {/* Call actions */}
            <div className="row-actions">
              {phone.callState === "ringing" ? (
                <>
                  <button
                    className="btn"
                    onClick={phone.answer}
                    style={{ background: "var(--color-success, green)", color: "#fff" }}
                  >
                    Answer
                  </button>
                  <button className="btn ghost" onClick={handleHangup}>
                    Decline
                  </button>
                </>
              ) : phone.callState === "idle" || phone.callState === "ended" ? (
                <button
                  className="btn"
                  onClick={handleCall}
                  disabled={phone.regState !== "registered" || !phone.dialpadInput.trim()}
                >
                  Call
                </button>
              ) : (
                <>
                  <button
                    className="btn ghost"
                    onClick={() => phone.setMute(!phone.muted)}
                    disabled={phone.callState !== "connected"}
                  >
                    {phone.muted ? "Unmute" : "Mute"}
                  </button>
                  <button
                    className="btn ghost"
                    onClick={handleHangup}
                    style={{ color: "var(--color-danger, red)" }}
                  >
                    Hang up
                  </button>
                </>
              )}
            </div>
          </DetailCard>

          {/* ── Diagnostics ────────────────────────────────────────── */}
          <DetailCard title="Diagnostics">
            <button
              className="btn ghost"
              onClick={() => setShowDiag((v) => !v)}
              style={{ marginBottom: 10, fontSize: 12 }}
            >
              {showDiag ? "Hide details" : "Show details"}
            </button>

            {/* Always-visible quick summary */}
            <div className="stack compact-stack">
              <DiagRow
                label="SIP WSS URL"
                value={phone.diag.sipWssUrl ?? "NOT SET"}
                tone={phone.diag.sipWssConfigured ? "success" : "danger"}
              />
              <DiagRow
                label="SIP Domain"
                value={phone.diag.sipDomain ?? "NOT SET"}
                tone={phone.diag.sipDomainConfigured ? "success" : "danger"}
              />
              <DiagRow
                label="WebRTC enabled"
                value={phone.diag.webrtcEnabled ? "Yes" : "No"}
                tone={phone.diag.webrtcEnabled ? "success" : "danger"}
              />
              <DiagRow
                label="STUN"
                value={phone.diag.hasStun ? "Present" : "Missing"}
                tone={phone.diag.hasStun ? "success" : "warning"}
              />
              <DiagRow
                label="TURN"
                value={phone.diag.hasTurn ? "Present" : "Not configured"}
                tone={phone.diag.hasTurn ? "success" : "warning"}
              />
              <DiagRow
                label="Microphone"
                value={phone.diag.micPermission}
                tone={
                  phone.diag.micPermission === "granted" ? "success"
                  : phone.diag.micPermission === "denied" ? "danger"
                  : "warning"
                }
              />
            </div>

            {showDiag && (
              <div className="stack compact-stack" style={{ marginTop: 10 }}>
                <hr style={{ margin: "8px 0", opacity: 0.3 }} />
                <DiagRow label="Extension" value={phone.diag.extensionNumber ?? "—"} />
                <DiagRow label="SIP Username" value={phone.diag.sipUsername ?? "—"} />
                <DiagRow label="Registration" value={phone.regState} />
                <DiagRow label="Call state" value={phone.callState} />
                <DiagRow
                  label="ICE gathering"
                  value={phone.diag.iceGatheringState ?? "—"}
                />
                <DiagRow
                  label="ICE connection"
                  value={phone.diag.iceConnectionState ?? "—"}
                  tone={phone.diag.iceConnectionState ? iceTone(phone.diag.iceConnectionState) : undefined}
                />
                {phone.diag.lastRegError && (
                  <DiagRow
                    label="Last reg error"
                    value={phone.diag.lastRegError}
                    tone="danger"
                  />
                )}
                {phone.diag.lastCallError && (
                  <DiagRow
                    label="Last call error"
                    value={phone.diag.lastCallError}
                    tone="danger"
                  />
                )}
                <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                  Audio uses SIP/WebRTC over WSS port 8089. AMI provides live dashboard state.
                  ARI REST provides call-control actions. ARI WebSocket is not available on this
                  PBX build (res_ari_websockets.so absent).
                </p>
              </div>
            )}
          </DetailCard>
        </section>
      </div>
    </PermissionGate>
  );
}

// ── Small helpers ──────────────────────────────────────────────────────────

function DiagRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "success" | "warning" | "danger" | "info" | "neutral";
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, gap: 8 }}>
      <span className="muted" style={{ flexShrink: 0 }}>{label}</span>
      {tone ? (
        <StatusChip tone={tone} label={value} />
      ) : (
        <code style={{ fontSize: 11, wordBreak: "break-all" }}>{value}</code>
      )}
    </div>
  );
}

function regLabel(state: string) {
  switch (state) {
    case "connecting":    return "Connecting…";
    case "registering":  return "Registering…";
    case "registered":   return "Registered ✓";
    case "unregistering": return "Unregistering…";
    case "failed":       return "Reg. Failed ✗";
    default:             return "Idle";
  }
}

function callLabel(state: string) {
  switch (state) {
    case "dialing":   return "Dialling…";
    case "ringing":   return "Ringing…";
    case "connected": return "In Call";
    case "ended":     return "Call Ended";
    default:          return "";
  }
}

function iceTone(state: string): "success" | "warning" | "danger" | "info" | "neutral" {
  switch (state) {
    case "connected":
    case "completed": return "success";
    case "checking":  return "warning";
    case "failed":    return "danger";
    case "disconnected": return "warning";
    default:          return "neutral";
  }
}
