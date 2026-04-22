"use client";

/**
 * MultiCallPanel
 * ----------------------------------------------------------------------------
 * Compact multi-call control strip rendered beside the primary softphone UI.
 *
 * Shows:
 *   - Ringing inbound calls with Answer / Decline buttons (call-waiting).
 *   - All non-active held calls with Resume / Hang up buttons.
 *
 * The currently active call continues to be rendered by the primary dialer
 * (single-call UI). This panel only renders when there is at least one
 * ringing or held call that the user needs to act on.
 */

import React from "react";
import type { MultiCallSession, SipPhoneActions, SipPhoneState } from "../hooks/useSipPhone";

export interface MultiCallPanelProps {
  phone: SipPhoneState & SipPhoneActions;
}

const T = {
  surface: "rgba(255,255,255,0.04)",
  border: "rgba(255,255,255,0.08)",
  textPrimary: "#f1f5f9",
  textSec: "#94a3b8",
  green: "#10b981",
  greenSoft: "rgba(16,185,129,0.15)",
  amber: "#f59e0b",
  amberSoft: "rgba(245,158,11,0.15)",
  red: "#ef4444",
  redSoft: "rgba(239,68,68,0.15)",
};

function initials(s: string | null) {
  if (!s) return "?";
  const words = s.trim().split(/[\s@._-]+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const clean = s.replace(/[^a-zA-Z0-9]/g, "");
  return (clean[0] ?? "?").toUpperCase();
}

function CallRow({
  session,
  badge,
  badgeColor,
  badgeBg,
  primaryLabel,
  primaryColor,
  primaryBg,
  onPrimary,
  secondaryLabel,
  secondaryColor,
  secondaryBg,
  onSecondary,
}: {
  session: MultiCallSession;
  badge: string;
  badgeColor: string;
  badgeBg: string;
  primaryLabel: string;
  primaryColor: string;
  primaryBg: string;
  onPrimary: () => void;
  secondaryLabel: string;
  secondaryColor: string;
  secondaryBg: string;
  onSecondary: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        background: T.surface,
        border: `1px solid ${T.border}`,
        borderRadius: 12,
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: "50%",
          background: "linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        {initials(session.remoteParty)}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              color: T.textPrimary,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 180,
            }}
          >
            {session.remoteParty || "Unknown"}
          </span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: "2px 8px",
              borderRadius: 999,
              background: badgeBg,
              color: badgeColor,
              letterSpacing: "0.5px",
              textTransform: "uppercase",
            }}
          >
            {badge}
          </span>
        </div>
        <div style={{ color: T.textSec, fontSize: 12 }}>
          {session.direction === "inbound" ? "Incoming" : "Outgoing"}
        </div>
      </div>
      <button
        type="button"
        onClick={onSecondary}
        style={{
          padding: "6px 12px",
          borderRadius: 8,
          border: `1px solid ${secondaryColor}`,
          background: secondaryBg,
          color: secondaryColor,
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {secondaryLabel}
      </button>
      <button
        type="button"
        onClick={onPrimary}
        style={{
          padding: "6px 14px",
          borderRadius: 8,
          border: `1px solid ${primaryColor}`,
          background: primaryBg,
          color: primaryColor,
          fontSize: 12,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        {primaryLabel}
      </button>
    </div>
  );
}

export function MultiCallPanel({ phone }: MultiCallPanelProps) {
  const ringing = phone.sessions.filter((s) => phone.ringingSessionIds.includes(s.id));
  const held = phone.sessions.filter((s) => phone.heldSessionIds.includes(s.id));

  if (ringing.length === 0 && held.length === 0) return null;

  return (
    <div
      data-testid="multi-call-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: 12,
        background: "rgba(0,0,0,0.25)",
        border: `1px solid ${T.border}`,
        borderRadius: 16,
      }}
    >
      {ringing.length > 0 && (
        <>
          <div style={{ color: T.textSec, fontSize: 11, fontWeight: 700, letterSpacing: "0.8px", textTransform: "uppercase", paddingLeft: 4 }}>
            Incoming Call Waiting
          </div>
          {ringing.map((s) => (
            <CallRow
              key={s.id}
              session={s}
              badge="Ringing"
              badgeColor={T.amber}
              badgeBg={T.amberSoft}
              primaryLabel="Answer"
              primaryColor={T.green}
              primaryBg={T.greenSoft}
              onPrimary={() => phone.answerSession(s.id)}
              secondaryLabel="Decline"
              secondaryColor={T.red}
              secondaryBg={T.redSoft}
              onSecondary={() => phone.hangupSession(s.id)}
            />
          ))}
        </>
      )}
      {held.length > 0 && (
        <>
          <div style={{ color: T.textSec, fontSize: 11, fontWeight: 700, letterSpacing: "0.8px", textTransform: "uppercase", paddingLeft: 4, marginTop: ringing.length > 0 ? 6 : 0 }}>
            On Hold
          </div>
          {held.map((s) => (
            <CallRow
              key={s.id}
              session={s}
              badge="Held"
              badgeColor={T.amber}
              badgeBg={T.amberSoft}
              primaryLabel="Resume"
              primaryColor={T.green}
              primaryBg={T.greenSoft}
              onPrimary={() => phone.resumeSession(s.id)}
              secondaryLabel="Hang up"
              secondaryColor={T.red}
              secondaryBg={T.redSoft}
              onSecondary={() => phone.hangupSession(s.id)}
            />
          ))}
        </>
      )}
    </div>
  );
}

export default MultiCallPanel;
