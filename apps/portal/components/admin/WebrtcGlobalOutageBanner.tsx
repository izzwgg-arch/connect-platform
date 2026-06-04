"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../../services/apiClient";

export type GlobalWebrtcOutage = {
  id: string;
  severity: "critical" | "warning";
  failureType: string;
  title: string;
  diagnosisSummary: string;
  firstSeenAt: string;
  lastSeenAt: string;
  affectedTenantCount: number;
  affectedUserCount: number;
  activeIncidentCount: number;
  outboundFailureCount: number;
  inboundFailureCount: number;
  sdpFailureCount: number;
  successRate: number | null;
  successAttempts: number;
  latestDiagnosisCategory: string | null;
  latestSipCode: number | null;
  latestSipReason: string | null;
  sampleDiagEventIds: string[];
  sampleFlightIds: string[];
  suggestedAction: string;
  reasons: string[];
};

type Props = {
  pollMs?: number;
  className?: string;
};

export function WebrtcGlobalOutageBanner({ pollMs = 45_000, className }: Props) {
  const [outage, setOutage] = useState<GlobalWebrtcOutage | null>(null);
  const [dismissing, setDismissing] = useState(false);

  const load = useCallback(async (silent = false) => {
    try {
      const res = await apiGet<{ outage: GlobalWebrtcOutage | null }>("/admin/webrtc-platform/outage/active");
      setOutage(res.outage ?? null);
    } catch {
      if (!silent) setOutage(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(true), pollMs);
    return () => window.clearInterval(t);
  }, [load, pollMs]);

  const dismiss = async () => {
    if (!outage) return;
    setDismissing(true);
    try {
      await apiPost(`/admin/webrtc-platform/outage/${outage.id}/dismiss`, {});
      setOutage(null);
    } finally {
      setDismissing(false);
    }
  };

  if (!outage) return null;

  const critical = outage.severity === "critical";
  const successPct =
    outage.successRate != null ? `${Math.round(outage.successRate * 100)}%` : "—";

  return (
    <div
      className={className}
      role="alert"
      style={{
        borderRadius: 14,
        padding: "20px 24px",
        marginBottom: 20,
        border: `2px solid ${critical ? "#dc2626" : "#d97706"}`,
        background: critical
          ? "linear-gradient(135deg, #450a0a 0%, #7f1d1d 100%)"
          : "linear-gradient(135deg, #451a03 0%, #78350f 100%)",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        boxShadow: critical ? "0 0 24px rgba(220, 38, 38, 0.25)" : "0 0 16px rgba(217, 119, 6, 0.2)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 800,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: critical ? "#fca5a5" : "#fde68a",
            }}
          >
            {critical ? "Platform incident" : "Platform warning"} · GLOBAL_WEBRTC_OUTAGE
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#fef2f2", marginTop: 6, lineHeight: 1.3 }}>
            {outage.title}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void dismiss()}
          disabled={dismissing}
          style={{
            alignSelf: "flex-start",
            padding: "8px 16px",
            borderRadius: 8,
            border: "1px solid #9ca3af",
            background: "rgba(0,0,0,0.25)",
            color: "#f3f4f6",
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {dismissing ? "Dismissing…" : "Dismiss for me"}
        </button>
      </div>

      <div style={{ fontSize: 14, color: "#e5e7eb", lineHeight: 1.55 }}>{outage.diagnosisSummary}</div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
          gap: "10px 20px",
          fontSize: 12,
          color: "#d1d5db",
        }}
      >
        <span>First seen: {new Date(outage.firstSeenAt).toLocaleString()}</span>
        <span>Last seen: {new Date(outage.lastSeenAt).toLocaleString()}</span>
        <span>Affected tenants: {outage.affectedTenantCount}</span>
        <span>Affected users: {outage.affectedUserCount}</span>
        <span>Active incidents: {outage.activeIncidentCount}</span>
        <span>Outbound failures (15m): {outage.outboundFailureCount}</span>
        <span>Inbound failures (15m): {outage.inboundFailureCount}</span>
        <span>SDP failures (15m): {outage.sdpFailureCount}</span>
        <span>
          Success rate: {successPct}
          {outage.successAttempts > 0 ? ` (${outage.successAttempts} attempts)` : ""}
        </span>
        {outage.latestDiagnosisCategory && (
          <span>Latest diagnosis: {outage.latestDiagnosisCategory}</span>
        )}
        {outage.latestSipCode != null && (
          <span>
            Latest SIP: {outage.latestSipCode}
            {outage.latestSipReason ? ` ${outage.latestSipReason}` : ""}
          </span>
        )}
      </div>

      {outage.reasons.length > 0 && (
        <div style={{ fontSize: 11, color: "#9ca3af" }}>
          Triggers: {outage.reasons.join(", ")}
        </div>
      )}

      <div style={{ fontSize: 13, color: "#cbd5e1" }}>
        <strong>Next:</strong> {outage.suggestedAction}
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
        <Link href="/admin/incidents" style={{ color: "#93c5fd", fontWeight: 600, textDecoration: "underline" }}>
          Incident Center
        </Link>
        <Link href="/admin/call-flight" style={{ color: "#93c5fd", fontWeight: 600, textDecoration: "underline" }}>
          Call Flight
        </Link>
        <Link href="/admin/call-timeline" style={{ color: "#93c5fd", fontWeight: 600, textDecoration: "underline" }}>
          Diagnostics
        </Link>
        {outage.sampleDiagEventIds[0] && (
          <Link
            href={`/admin/call-timeline?eventId=${encodeURIComponent(outage.sampleDiagEventIds[0])}`}
            style={{ color: "#93c5fd", textDecoration: "underline" }}
          >
            Sample diagnostic
          </Link>
        )}
      </div>
    </div>
  );
}
