"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../../services/apiClient";

export type WebrtcAdminIncident = {
  id: string;
  severity: "critical" | "warning";
  failureType: string;
  direction: string;
  title: string;
  description: string;
  affectedTenantId: string;
  affectedTenantName: string | null;
  affectedExtensions: string[];
  affectedUserCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  latestSipCode: number | null;
  latestSipReason: string | null;
  suggestedAction: string;
  drillDownPath: string;
  sampleEventIds: string[];
};

type Props = {
  /** Poll interval ms (default 60s) */
  pollMs?: number;
  className?: string;
};

export function WebrtcIncidentBanner({ pollMs = 60_000, className }: Props) {
  const [incidents, setIncidents] = useState<WebrtcAdminIncident[]>([]);
  const [dismissingId, setDismissingId] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    try {
      const res = await apiGet<{ incidents: WebrtcAdminIncident[] }>("/admin/webrtc-incidents/active");
      setIncidents(res.incidents ?? []);
    } catch {
      if (!silent) setIncidents([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(true), pollMs);
    return () => window.clearInterval(t);
  }, [load, pollMs]);

  const dismiss = async (id: string) => {
    setDismissingId(id);
    try {
      await apiPost(`/admin/webrtc-incidents/${id}/dismiss`, {});
      setIncidents((prev) => prev.filter((i) => i.id !== id));
    } finally {
      setDismissingId(null);
    }
  };

  if (incidents.length === 0) return null;

  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
      {incidents.map((inc) => {
        const critical = inc.severity === "critical";
        return (
          <div
            key={inc.id}
            role="alert"
            style={{
              borderRadius: 12,
              padding: "16px 20px",
              border: `1px solid ${critical ? "#991b1b" : "#92400e"}`,
              background: critical ? "#450a0a" : "#451a03",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: critical ? "#fca5a5" : "#fde68a" }}>
                  {critical ? "Critical" : "Warning"} · WebRTC calling · {inc.direction}
                </div>
                <div style={{ fontSize: 17, fontWeight: 700, color: "#fef2f2", marginTop: 4 }}>{inc.title}</div>
              </div>
              <button
                type="button"
                onClick={() => void dismiss(inc.id)}
                disabled={dismissingId === inc.id}
                style={{
                  alignSelf: "flex-start",
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: "1px solid #6b7280",
                  background: "transparent",
                  color: "#e5e7eb",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                {dismissingId === inc.id ? "Dismissing…" : "Dismiss"}
              </button>
            </div>
            <div style={{ fontSize: 13, color: "#d1d5db", lineHeight: 1.5 }}>{inc.description}</div>
            <div style={{ fontSize: 12, color: "#9ca3af", display: "flex", flexWrap: "wrap", gap: "8px 16px" }}>
              <span>Tenant: {inc.affectedTenantName ?? inc.affectedTenantId}</span>
              {inc.affectedExtensions.length > 0 && (
                <span>Extensions: {inc.affectedExtensions.join(", ")}</span>
              )}
              <span>Count: {inc.occurrenceCount}</span>
              <span>First: {new Date(inc.firstSeenAt).toLocaleString()}</span>
              <span>Last: {new Date(inc.lastSeenAt).toLocaleString()}</span>
              {inc.latestSipCode != null && (
                <span>SIP: {inc.latestSipCode}{inc.latestSipReason ? ` ${inc.latestSipReason}` : ""}</span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "#cbd5e1" }}>
              <strong>Next:</strong> {inc.suggestedAction}
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12 }}>
              <Link href={inc.drillDownPath} style={{ color: "#93c5fd", textDecoration: "underline" }}>
                Open diagnostics
              </Link>
              <Link href="/admin/incidents" style={{ color: "#93c5fd", textDecoration: "underline" }}>
                Incident Center
              </Link>
              {inc.sampleEventIds[0] && (
                <Link
                  href={`/admin/call-timeline?eventId=${encodeURIComponent(inc.sampleEventIds[0])}`}
                  style={{ color: "#93c5fd", textDecoration: "underline" }}
                >
                  Latest event
                </Link>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
