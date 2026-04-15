"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../../../../components/PageHeader";
import { apiGet } from "../../../../services/apiClient";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
  Phone,
  PhoneOff,
  PhoneMissed,
  Wifi,
  WifiOff,
  Zap,
  ShieldCheck,
  Info,
  ArrowRight,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type HealthStatus = "good" | "warning" | "critical";

type TenantIncident = {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
  cause: string;
  suggestedAction: string;
  affectedCount: number;
  detectedAt: string;
  autoResolved: boolean;
};

type HealingAction = {
  id: string;
  type: string;
  status: string;
  plainEnglish: string;
  triggeredAt: string;
};

type HealthData = {
  tenantId: string;
  status: HealthStatus;
  statusMessage: string;
  callsToday: {
    total: number;
    answered: number;
    missed: number;
    failed: number;
    failureRate: number;
  };
  audioQuality: {
    score: number;
    label: string;
    gradeCounts: Record<string, number>;
    issueCount: number;
    iceFailures: number;
  };
  incidents: TenantIncident[];
  healingActions: HealingAction[];
  suggestedActions: string[];
  lastUpdated: string;
};

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  good: {
    bg: "#f0fdf4",
    border: "#bbf7d0",
    text: "#15803d",
    icon: CheckCircle2,
    label: "All Systems Normal",
    dotColor: "#22c55e",
  },
  warning: {
    bg: "#fffbeb",
    border: "#fde68a",
    text: "#b45309",
    icon: AlertTriangle,
    label: "Some Issues Detected",
    dotColor: "#f59e0b",
  },
  critical: {
    bg: "#fef2f2",
    border: "#fecaca",
    text: "#b91c1c",
    icon: XCircle,
    label: "Action Required",
    dotColor: "#ef4444",
  },
};

const SEVERITY_CONFIG = {
  critical: { bg: "#fef2f2", border: "#fecaca", badge: "#b91c1c", badgeBg: "#fee2e2", icon: XCircle },
  warning: { bg: "#fffbeb", border: "#fde68a", badge: "#b45309", badgeBg: "#fef3c7", icon: AlertTriangle },
  info: { bg: "#f0f9ff", border: "#bae6fd", badge: "#0369a1", badgeBg: "#e0f2fe", icon: Info },
};

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBanner({ status, message }: { status: HealthStatus; message: string }) {
  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.icon;
  return (
    <div
      style={{
        background: cfg.bg,
        border: `2px solid ${cfg.border}`,
        borderRadius: 12,
        padding: "20px 24px",
        display: "flex",
        alignItems: "center",
        gap: 16,
        marginBottom: 24,
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: "50%",
          background: cfg.dotColor + "20",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Icon size={24} color={cfg.dotColor} />
      </div>
      <div>
        <div style={{ fontWeight: 700, fontSize: 17, color: cfg.text }}>{cfg.label}</div>
        <div style={{ fontSize: 14, color: cfg.text, opacity: 0.85, marginTop: 2 }}>{message}</div>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 10,
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Icon size={16} color={color ?? "#6b7280"} />
        <span style={{ fontSize: 12, color: "#6b7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          {label}
        </span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 800, color: color ?? "#111827", lineHeight: 1 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 12, color: "#9ca3af" }}>{sub}</div>}
    </div>
  );
}

function QualityBar({ score, label }: { score: number; label: string }) {
  const color =
    score >= 85 ? "#22c55e" :
    score >= 70 ? "#84cc16" :
    score >= 50 ? "#f59e0b" : "#ef4444";

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 10,
        padding: "18px 20px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Wifi size={16} color="#6b7280" />
        <span style={{ fontSize: 12, color: "#6b7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Audio Quality
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 28, fontWeight: 800, color, lineHeight: 1 }}>{score}</span>
        <span style={{ fontSize: 13, color: "#9ca3af" }}>/100</span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            color,
            background: color + "20",
            padding: "2px 8px",
            borderRadius: 20,
            marginLeft: 4,
          }}
        >
          {label}
        </span>
      </div>
      <div style={{ marginTop: 10, height: 6, background: "#f3f4f6", borderRadius: 3 }}>
        <div
          style={{
            height: "100%",
            width: `${score}%`,
            background: color,
            borderRadius: 3,
            transition: "width 0.6s ease",
          }}
        />
      </div>
    </div>
  );
}

function IncidentCard({ incident }: { incident: TenantIncident }) {
  const cfg = SEVERITY_CONFIG[incident.severity];
  const Icon = cfg.icon;
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        background: incident.autoResolved ? "#f0fdf4" : cfg.bg,
        border: `1px solid ${incident.autoResolved ? "#bbf7d0" : cfg.border}`,
        borderRadius: 10,
        padding: "16px 20px",
        cursor: "pointer",
      }}
      onClick={() => setExpanded((v) => !v)}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ marginTop: 2 }}>
          {incident.autoResolved ? (
            <ShieldCheck size={18} color="#22c55e" />
          ) : (
            <Icon size={18} color={cfg.badge} />
          )}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: "#111827" }}>{incident.title}</span>
            {incident.autoResolved ? (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#15803d",
                  background: "#dcfce7",
                  padding: "2px 8px",
                  borderRadius: 20,
                }}
              >
                AUTO-FIXED
              </span>
            ) : (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: cfg.badge,
                  background: cfg.badgeBg,
                  padding: "2px 8px",
                  borderRadius: 20,
                  textTransform: "uppercase",
                }}
              >
                {incident.severity}
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, color: "#4b5563", marginTop: 4 }}>{incident.description}</div>

          {expanded && (
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
              <div
                style={{
                  background: "rgba(0,0,0,0.03)",
                  borderRadius: 8,
                  padding: "10px 14px",
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", marginBottom: 4, textTransform: "uppercase" }}>
                  Likely Cause
                </div>
                <div style={{ fontSize: 13, color: "#374151" }}>{incident.cause}</div>
              </div>
              {!incident.autoResolved && (
                <div
                  style={{
                    background: "#fff",
                    border: `1px solid ${cfg.border}`,
                    borderRadius: 8,
                    padding: "10px 14px",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <ArrowRight size={14} color={cfg.badge} />
                  <div style={{ fontSize: 13, color: "#111827", fontWeight: 500 }}>
                    {incident.suggestedAction}
                  </div>
                </div>
              )}
              <div style={{ fontSize: 11, color: "#9ca3af" }}>
                Detected: {new Date(incident.detectedAt).toLocaleString()}
                {incident.affectedCount > 0 && ` · ${incident.affectedCount} call(s) affected`}
              </div>
            </div>
          )}
        </div>
        <div style={{ color: "#9ca3af", fontSize: 18, fontWeight: 300, userSelect: "none" }}>
          {expanded ? "−" : "+"}
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CallHealthPage() {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const resp = await apiGet<HealthData>("/voice/health");
      setData(resp);
    } catch (e) {
      setError("Could not load health data. Please try again.");
      console.error(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(() => load(true), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading) {
    return (
      <div style={{ padding: "40px 32px", maxWidth: 900, margin: "0 auto" }}>
        <PageHeader title="System Health" subtitle="Loading health data..." />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 16, marginTop: 24 }}>
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              style={{ height: 100, background: "#f3f4f6", borderRadius: 10, animation: "pulse 1.5s infinite" }}
            />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={{ padding: "40px 32px", maxWidth: 900, margin: "0 auto" }}>
        <PageHeader title="System Health" subtitle="Could not load health data." />
        <div
          style={{
            marginTop: 24,
            padding: 20,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 10,
            color: "#b91c1c",
          }}
        >
          {error ?? "Unknown error"}
        </div>
        <button
          onClick={() => load()}
          style={{
            marginTop: 16,
            padding: "8px 16px",
            background: "#3b82f6",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  const autoFixed = data.incidents.filter((i) => i.autoResolved);
  const openIssues = data.incidents.filter((i) => !i.autoResolved);

  return (
    <div style={{ padding: "32px 32px", maxWidth: 900, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <PageHeader
          title="System Health"
          subtitle="Plain-English overview of your phone system — no technical knowledge needed."
        />
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 14px",
            background: refreshing ? "#f3f4f6" : "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            cursor: refreshing ? "default" : "pointer",
            fontSize: 13,
            color: "#6b7280",
            whiteSpace: "nowrap",
          }}
        >
          <RefreshCw size={14} style={{ animation: refreshing ? "spin 1s linear infinite" : "none" }} />
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Status Banner */}
      <StatusBanner status={data.status} message={data.statusMessage} />

      {/* Stats grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))",
          gap: 12,
          marginBottom: 24,
        }}
      >
        <StatCard
          icon={Phone}
          label="Calls Today"
          value={data.callsToday.total}
          sub="total inbound + outbound"
          color="#3b82f6"
        />
        <StatCard
          icon={CheckCircle2}
          label="Answered"
          value={data.callsToday.answered}
          sub={`${data.callsToday.total > 0 ? Math.round((data.callsToday.answered / data.callsToday.total) * 100) : 0}% answer rate`}
          color="#22c55e"
        />
        <StatCard
          icon={PhoneMissed}
          label="Missed"
          value={data.callsToday.missed}
          sub="no answer or voicemail"
          color={data.callsToday.missed > 5 ? "#f59e0b" : "#9ca3af"}
        />
        <StatCard
          icon={PhoneOff}
          label="Failed"
          value={data.callsToday.failed}
          sub={data.callsToday.failureRate > 0 ? `${data.callsToday.failureRate}% failure rate` : "no failures"}
          color={data.callsToday.failed > 0 ? "#ef4444" : "#9ca3af"}
        />
        <QualityBar score={data.audioQuality.score} label={data.audioQuality.label} />
      </div>

      {/* Issues section */}
      {openIssues.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", marginBottom: 10 }}>
            Issues Requiring Attention
            <span
              style={{
                marginLeft: 8,
                background: "#fee2e2",
                color: "#b91c1c",
                borderRadius: 20,
                padding: "2px 8px",
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              {openIssues.length}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {openIssues.map((inc) => (
              <IncidentCard key={inc.id} incident={inc} />
            ))}
          </div>
        </div>
      )}

      {/* Auto-fixed section */}
      {autoFixed.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", marginBottom: 10 }}>
            Auto-Resolved by System
            <span
              style={{
                marginLeft: 8,
                background: "#dcfce7",
                color: "#15803d",
                borderRadius: 20,
                padding: "2px 8px",
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              {autoFixed.length}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {autoFixed.map((inc) => (
              <IncidentCard key={inc.id} incident={inc} />
            ))}
          </div>
        </div>
      )}

      {/* All good state */}
      {data.incidents.length === 0 && (
        <div
          style={{
            textAlign: "center",
            padding: "32px",
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            borderRadius: 12,
            marginBottom: 24,
          }}
        >
          <CheckCircle2 size={36} color="#22c55e" style={{ margin: "0 auto 12px" }} />
          <div style={{ fontWeight: 700, color: "#15803d", fontSize: 16 }}>No Issues Found</div>
          <div style={{ color: "#4ade80", fontSize: 13, marginTop: 4 }}>
            All calls are connecting normally and audio quality is good.
          </div>
        </div>
      )}

      {/* Suggested actions */}
      {data.suggestedActions.length > 0 && (
        <div
          style={{
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: 10,
            padding: "16px 20px",
            marginBottom: 24,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 10 }}>
            Recommended Actions
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {data.suggestedActions.map((action, i) => (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <Zap size={13} color="#3b82f6" style={{ marginTop: 2, flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: "#374151" }}>{action}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Connectivity indicator */}
      {data.audioQuality.iceFailures > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 16px",
            background: "#fef9c3",
            border: "1px solid #fde047",
            borderRadius: 8,
            marginBottom: 16,
          }}
        >
          <WifiOff size={16} color="#a16207" />
          <span style={{ fontSize: 13, color: "#713f12" }}>
            {data.audioQuality.iceFailures} audio connection failure{data.audioQuality.iceFailures > 1 ? "s" : ""} detected in the last 24 hours.
            This usually means callers on remote networks cannot reach the PBX directly.
          </span>
        </div>
      )}

      {/* Footer */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
        <span style={{ fontSize: 11, color: "#9ca3af" }}>
          Last updated: {new Date(data.lastUpdated).toLocaleTimeString()} · Auto-refreshes every 60s
        </span>
        <a
          href="/calls"
          style={{ fontSize: 12, color: "#3b82f6", textDecoration: "none", display: "flex", alignItems: "center", gap: 4 }}
        >
          View Call History <ArrowRight size={12} />
        </a>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      `}</style>
    </div>
  );
}
