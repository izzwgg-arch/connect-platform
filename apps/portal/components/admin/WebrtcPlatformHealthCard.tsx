"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiGet } from "../../services/apiClient";

type PlatformHealth = {
  status: "healthy" | "degraded" | "critical";
  lastSuccessfulInbound: string | null;
  lastSuccessfulOutbound: string | null;
  activeIncidents: number;
  successRate: number | null;
  successAttempts: number;
  affectedTenants: number;
  outboundFailureCount15m: number;
  inboundFailureCount15m: number;
  globalOutageActive: boolean;
};

const STATUS_LABEL: Record<PlatformHealth["status"], string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  critical: "Critical",
};

const STATUS_COLOR: Record<PlatformHealth["status"], string> = {
  healthy: "#22c55e",
  degraded: "#f59e0b",
  critical: "#ef4444",
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function WebrtcPlatformHealthCard({ pollMs = 60_000 }: { pollMs?: number }) {
  const [health, setHealth] = useState<PlatformHealth | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ health: PlatformHealth }>("/admin/webrtc-platform/health");
      setHealth(res.health);
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), pollMs);
    return () => window.clearInterval(t);
  }, [load, pollMs]);

  if (!health) return null;

  const successPct =
    health.successRate != null ? `${Math.round(health.successRate * 100)}%` : "—";

  return (
    <article
      className="panel"
      style={{
        borderLeft: `4px solid ${STATUS_COLOR[health.status]}`,
        gridColumn: "1 / -1",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h3 style={{ marginBottom: 4 }}>WebRTC Platform Health</h3>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Rolling 15-minute cross-tenant signals from schema v2 diagnostics.
          </p>
        </div>
        <span
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: STATUS_COLOR[health.status],
            padding: "4px 10px",
            borderRadius: 6,
            background: `${STATUS_COLOR[health.status]}22`,
          }}
        >
          {STATUS_LABEL[health.status]}
          {health.globalOutageActive ? " · Outage active" : ""}
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
          gap: "8px 16px",
          marginTop: 16,
          fontSize: 12,
          color: "var(--muted, #6b7280)",
        }}
      >
        <div>
          <div style={{ fontWeight: 600, color: "inherit", opacity: 0.8 }}>Last inbound OK</div>
          <div style={{ color: "var(--text, inherit)" }}>{fmtTime(health.lastSuccessfulInbound)}</div>
        </div>
        <div>
          <div style={{ fontWeight: 600, color: "inherit", opacity: 0.8 }}>Last outbound OK</div>
          <div style={{ color: "var(--text, inherit)" }}>{fmtTime(health.lastSuccessfulOutbound)}</div>
        </div>
        <div>
          <div style={{ fontWeight: 600, color: "inherit", opacity: 0.8 }}>Active incidents</div>
          <div style={{ color: "var(--text, inherit)" }}>{health.activeIncidents}</div>
        </div>
        <div>
          <div style={{ fontWeight: 600, color: "inherit", opacity: 0.8 }}>Success rate</div>
          <div style={{ color: "var(--text, inherit)" }}>
            {successPct}
            {health.successAttempts > 0 ? ` (${health.successAttempts})` : ""}
          </div>
        </div>
        <div>
          <div style={{ fontWeight: 600, color: "inherit", opacity: 0.8 }}>Affected tenants</div>
          <div style={{ color: "var(--text, inherit)" }}>{health.affectedTenants}</div>
        </div>
        <div>
          <div style={{ fontWeight: 600, color: "inherit", opacity: 0.8 }}>Failures (15m)</div>
          <div style={{ color: "var(--text, inherit)" }}>
            ↓{health.inboundFailureCount15m} / ↑{health.outboundFailureCount15m}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 14, display: "flex", gap: 12 }}>
        <Link className="btn ghost" href="/admin/incidents" style={{ fontSize: 12 }}>
          Incident Center
        </Link>
        <Link className="btn ghost" href="/admin/call-timeline" style={{ fontSize: 12 }}>
          Diagnostics
        </Link>
      </div>
    </article>
  );
}
