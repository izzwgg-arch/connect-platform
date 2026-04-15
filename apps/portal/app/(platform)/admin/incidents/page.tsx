"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet } from "../../../../services/apiClient";

// ── Types ─────────────────────────────────────────────────────────────────────

type Severity = "critical" | "warning" | "info";
type Category = "system" | "audio" | "connectivity" | "security";

type HealingActionStatus = "attempted" | "succeeded" | "failed" | "skipped" | "rate_limited";
interface HealingAction {
  id: string;
  type: string;
  status: HealingActionStatus;
  description: string;
  plainEnglish: string;
  details: Record<string, unknown>;
  triggeredAt: string;
  resolvedAt: string | null;
  automated: boolean;
}

interface Incident {
  id: string;
  severity: Severity;
  category: Category;
  title: string;
  description: string;
  affectedTenant: string | null;
  affectedUsers: number;
  likelyCause: string;
  suggestedAction: string;
  startedAt: string;
  callCount: number;
  drillDownPath: string | null;
}

interface SystemHealth {
  api: string;
  telephony: string;
  pbxAmi: string;
  pbxAri: string;
  activeCalls: number;
  turnConfigured: boolean;
  uptimeSec: number;
}

interface IncidentSummary {
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  affectedTenants: number;
  totalCalls24h: number;
}

interface IncidentResponse {
  timestamp: string;
  health: SystemHealth;
  incidents: Incident[];
  summary: IncidentSummary;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SEV_CONFIG: Record<Severity, { color: string; bg: string; border: string; label: string; dot: string }> = {
  critical: { color: "#fca5a5", bg: "#7f1d1d22", border: "#991b1b", label: "CRITICAL", dot: "#ef4444" },
  warning:  { color: "#fde68a", bg: "#78350f22", border: "#d97706", label: "WARNING",  dot: "#f59e0b" },
  info:     { color: "#a5b4fc", bg: "#1e1b4b22", border: "#4f46e5", label: "INFO",     dot: "#6366f1" },
};

const CAT_ICON: Record<Category, string> = {
  system:       "⚙",
  audio:        "🔊",
  connectivity: "🔌",
  security:     "🛡",
};

function fmt(iso: string) {
  try {
    const d = new Date(iso);
    const ago = Date.now() - d.getTime();
    if (ago < 60_000) return "just now";
    if (ago < 3600_000) return `${Math.floor(ago / 60_000)}m ago`;
    if (ago < 86400_000) return `${Math.floor(ago / 3600_000)}h ago`;
    return d.toLocaleDateString();
  } catch { return iso; }
}

function uptimeStr(sec: number) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

// ── Health indicator ──────────────────────────────────────────────────────────

function HealthDot({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <div title={detail} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#111827", borderRadius: 8, border: "1px solid #1f2937" }}>
      <div style={{
        width: 10, height: 10, borderRadius: "50%",
        background: ok ? "#22c55e" : "#ef4444",
        boxShadow: ok ? "0 0 0 3px #14532d66" : "0 0 0 3px #7f1d1d66",
        flexShrink: 0,
      }} />
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0" }}>{label}</div>
        {detail && <div style={{ fontSize: 10, color: ok ? "#4ade80" : "#f87171" }}>{detail}</div>}
      </div>
    </div>
  );
}

// ── Status banner ─────────────────────────────────────────────────────────────

function StatusBanner({ summary, health }: { summary: IncidentSummary; health: SystemHealth }) {
  const allOk =
    summary.criticalCount === 0 &&
    summary.warningCount === 0 &&
    health.telephony === "ok" &&
    health.pbxAmi === "connected";

  return (
    <div style={{
      borderRadius: 12,
      padding: "20px 24px",
      marginBottom: 24,
      background: allOk ? "#052e16" : summary.criticalCount > 0 ? "#450a0a" : "#451a03",
      border: `1px solid ${allOk ? "#166534" : summary.criticalCount > 0 ? "#991b1b" : "#92400e"}`,
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <span style={{ fontSize: 28 }}>
          {allOk ? "✅" : summary.criticalCount > 0 ? "🚨" : "⚠️"}
        </span>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: allOk ? "#4ade80" : summary.criticalCount > 0 ? "#fca5a5" : "#fde68a" }}>
            {allOk ? "All systems operational" :
             summary.criticalCount > 0 ? `${summary.criticalCount} critical issue${summary.criticalCount > 1 ? "s" : ""} require attention` :
             `${summary.warningCount} warning${summary.warningCount > 1 ? "s" : ""} detected`}
          </div>
          <div style={{ fontSize: 13, color: "#9ca3af", marginTop: 2 }}>
            {allOk
              ? `${summary.totalCalls24h} calls in the last 24h · Telephony uptime ${uptimeStr(health.uptimeSec)}`
              : `${summary.affectedTenants} tenant(s) affected · ${summary.totalCalls24h} calls in 24h`}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {summary.criticalCount > 0 && (
          <div style={{ padding: "6px 14px", borderRadius: 8, background: "#991b1b", color: "#fca5a5", fontWeight: 700, fontSize: 13 }}>
            {summary.criticalCount} CRITICAL
          </div>
        )}
        {summary.warningCount > 0 && (
          <div style={{ padding: "6px 14px", borderRadius: 8, background: "#92400e", color: "#fde68a", fontWeight: 700, fontSize: 13 }}>
            {summary.warningCount} WARNING
          </div>
        )}
        {summary.infoCount > 0 && (
          <div style={{ padding: "6px 14px", borderRadius: 8, background: "#1e1b4b", color: "#a5b4fc", fontWeight: 700, fontSize: 13 }}>
            {summary.infoCount} INFO
          </div>
        )}
        {allOk && (
          <div style={{ padding: "6px 14px", borderRadius: 8, background: "#14532d", color: "#86efac", fontWeight: 700, fontSize: 13 }}>
            {health.activeCalls} ACTIVE CALLS
          </div>
        )}
      </div>
    </div>
  );
}

// ── Health grid ────────────────────────────────────────────────────────────────

function HealthGrid({ health, summary }: { health: SystemHealth; summary: IncidentSummary }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8, marginBottom: 28 }}>
      <HealthDot ok={health.api === "ok"} label="API" detail={health.api === "ok" ? "Serving requests" : "Not responding"} />
      <HealthDot ok={health.telephony === "ok"} label="Telephony" detail={health.telephony} />
      <HealthDot ok={health.pbxAmi === "connected"} label="PBX (AMI)" detail={health.pbxAmi} />
      <HealthDot ok={health.pbxAri === "reachable"} label="PBX (ARI)" detail={health.pbxAri} />
      <HealthDot ok={health.turnConfigured} label="TURN Relay" detail={health.turnConfigured ? "Configured" : "Not configured"} />
      <HealthDot ok={summary.totalCalls24h > 0 || health.activeCalls > 0} label="CDR Pipeline" detail={summary.totalCalls24h > 0 ? `${summary.totalCalls24h} calls recorded` : "No calls recorded"} />
    </div>
  );
}

// ── Incident card ─────────────────────────────────────────────────────────────

function IncidentCard({ incident }: { incident: Incident }) {
  const [expanded, setExpanded] = useState(false);
  const sev = SEV_CONFIG[incident.severity];

  return (
    <div style={{
      borderRadius: 10,
      border: `1px solid ${sev.border}`,
      background: "#111827",
      overflow: "hidden",
      marginBottom: 12,
    }}>
      {/* Card header — always visible */}
      <div
        onClick={() => setExpanded(e => !e)}
        style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "16px 18px", cursor: "pointer" }}
      >
        {/* Severity bar */}
        <div style={{ width: 4, alignSelf: "stretch", borderRadius: 2, background: sev.dot, flexShrink: 0 }} />

        {/* Category icon */}
        <div style={{ fontSize: 22, lineHeight: 1, flexShrink: 0, marginTop: 1 }}>
          {CAT_ICON[incident.category]}
        </div>

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <span style={{ padding: "2px 8px", borderRadius: 4, background: sev.bg, color: sev.color, fontSize: 10, fontWeight: 800, letterSpacing: "0.05em", border: `1px solid ${sev.border}` }}>
              {sev.label}
            </span>
            <span style={{ fontSize: 15, fontWeight: 700, color: "#f1f5f9" }}>
              {incident.title}
            </span>
            {incident.callCount > 0 && (
              <span style={{ fontSize: 11, color: "#9ca3af", marginLeft: 4 }}>
                {incident.callCount} call{incident.callCount !== 1 ? "s" : ""}
              </span>
            )}
          </div>

          <div style={{ fontSize: 13, color: "#cbd5e1", marginBottom: 6, lineHeight: 1.5 }}>
            {incident.description}
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11, color: "#6b7280" }}>
            {incident.affectedTenant && (
              <span>🏢 {incident.affectedTenant}{incident.affectedUsers > 0 ? ` · ${incident.affectedUsers} user${incident.affectedUsers > 1 ? "s" : ""}` : ""}</span>
            )}
            <span>⏱ {fmt(incident.startedAt)}</span>
          </div>
        </div>

        {/* Expand toggle */}
        <div style={{ fontSize: 18, color: "#4b5563", flexShrink: 0, marginTop: 2 }}>
          {expanded ? "▲" : "▼"}
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ borderTop: "1px solid #1f2937", padding: "14px 18px 14px 36px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            <div style={{ background: "#0f172a", borderRadius: 8, padding: "12px 14px" }}>
              <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>
                Likely cause
              </div>
              <div style={{ fontSize: 13, color: "#e2e8f0", lineHeight: 1.5 }}>{incident.likelyCause}</div>
            </div>
            <div style={{ background: "#0f172a", borderRadius: 8, padding: "12px 14px" }}>
              <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>
                What to do
              </div>
              <div style={{ fontSize: 13, color: "#86efac", lineHeight: 1.5 }}>{incident.suggestedAction}</div>
            </div>
          </div>

          {incident.drillDownPath && (
            <a
              href={incident.drillDownPath}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 6, background: "#1d4ed8", color: "#fff", textDecoration: "none", fontSize: 12, fontWeight: 600 }}
            >
              View Details →
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ── Healing actions panel ─────────────────────────────────────────────────────

const HEALING_STATUS_STYLE: Record<HealingActionStatus, { bg: string; color: string; label: string }> = {
  succeeded:    { bg: "#052e16", color: "#4ade80", label: "AUTO-FIXED" },
  attempted:    { bg: "#0f2e4f", color: "#60a5fa", label: "IN PROGRESS" },
  failed:       { bg: "#450a0a", color: "#fca5a5", label: "FAILED" },
  skipped:      { bg: "#1a1a1a", color: "#9ca3af", label: "SKIPPED" },
  rate_limited: { bg: "#1c1310", color: "#fb923c", label: "RATE LIMITED" },
};

function HealingActionsPanel({ actions }: { actions: HealingAction[] }) {
  if (actions.length === 0) return null;
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#9ca3af", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        ⚡ Self-Healing Actions (last 24h)
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {actions.slice(0, 8).map((action) => {
          const s = HEALING_STATUS_STYLE[action.status] ?? HEALING_STATUS_STYLE.skipped;
          return (
            <div
              key={action.id}
              style={{
                background: "#0f172a",
                border: "1px solid #1e293b",
                borderLeft: `3px solid ${s.color}`,
                borderRadius: 8,
                padding: "10px 14px",
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: s.color,
                  background: s.bg,
                  border: `1px solid ${s.color}44`,
                  padding: "2px 7px",
                  borderRadius: 4,
                  whiteSpace: "nowrap",
                  marginTop: 1,
                }}
              >
                {s.label}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, color: "#e2e8f0" }}>{action.plainEnglish}</div>
                <div style={{ fontSize: 11, color: "#4b5563", marginTop: 3 }}>
                  {new Date(action.triggeredAt).toLocaleString()}
                  {action.resolvedAt && ` · Resolved ${new Date(action.resolvedAt).toLocaleTimeString()}`}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function IncidentCenterPage() {
  const [data, setData] = useState<IncidentResponse | null>(null);
  const [healingActions, setHealingActions] = useState<HealingAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | Severity | Category>("all");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetch = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [res, healing] = await Promise.allSettled([
        apiGet<IncidentResponse>("/admin/incidents"),
        apiGet<HealingAction[]>("/admin/healing/log"),
      ]);
      if (res.status === "fulfilled") {
        setData(res.value);
        setLastUpdated(new Date().toLocaleTimeString());
      } else {
        setError(res.reason instanceof Error ? res.reason.message : "Failed to load incidents");
      }
      if (healing.status === "fulfilled") setHealingActions(healing.value);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
    intervalRef.current = setInterval(() => fetch(true), 30_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetch]);

  const visibleIncidents = data?.incidents.filter((i) => {
    if (filter === "all") return true;
    return i.severity === filter || i.category === filter;
  }) ?? [];

  return (
    <PermissionGate permission="can_manage_global_settings">
      <div style={{ padding: "24px 32px", maxWidth: 1100, margin: "0 auto" }}>
        <PageHeader
          title="Incident Center"
          subtitle="Real-time system health and issue summary — no technical knowledge required."
          actions={
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {lastUpdated && (
                <span style={{ fontSize: 11, color: "#4b5563" }}>Updated {lastUpdated}</span>
              )}
              <button
                onClick={() => fetch()}
                disabled={loading}
                style={{ background: "#1f2937", border: "1px solid #374151", borderRadius: 7, color: "#9ca3af", padding: "7px 14px", fontSize: 12, cursor: "pointer" }}
              >
                {loading ? "Refreshing…" : "↻ Refresh"}
              </button>
            </div>
          }
        />

        {error && (
          <div style={{ background: "#7f1d1d", border: "1px solid #991b1b", borderRadius: 8, padding: "12px 16px", color: "#fca5a5", marginBottom: 16, fontSize: 13 }}>
            {error}
          </div>
        )}

        {loading && !data && (
          <div style={{ color: "#4b5563", padding: "60px 0", textAlign: "center", fontSize: 14 }}>
            Loading system status…
          </div>
        )}

        {data && (
          <>
            <StatusBanner summary={data.summary} health={data.health} />
            <HealthGrid health={data.health} summary={data.summary} />

            {/* Filter bar */}
            {data.incidents.length > 0 && (
              <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
                {(["all", "critical", "warning", "info", "system", "audio", "connectivity"] as const).map((f) => {
                  const count = f === "all"
                    ? data.incidents.length
                    : data.incidents.filter((i) => i.severity === f || i.category === f).length;
                  if (count === 0 && f !== "all") return null;
                  return (
                    <button
                      key={f}
                      onClick={() => setFilter(f)}
                      style={{
                        padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: filter === f ? 700 : 400,
                        background: filter === f ? "#1d4ed8" : "#1f2937",
                        border: `1px solid ${filter === f ? "#3b82f6" : "#374151"}`,
                        color: filter === f ? "#fff" : "#9ca3af",
                        cursor: "pointer", textTransform: "capitalize",
                      }}
                    >
                      {f === "all" ? `All (${count})` : `${f} (${count})`}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Self-healing actions */}
            <HealingActionsPanel actions={healingActions} />

            {/* Incidents list */}
            <div>
              {visibleIncidents.length === 0 ? (
                <div style={{
                  background: "#052e16", border: "1px solid #166534", borderRadius: 12, padding: "32px 24px",
                  textAlign: "center",
                }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "#4ade80", marginBottom: 6 }}>
                    {filter === "all" ? "No issues detected" : `No ${filter} issues detected`}
                  </div>
                  <div style={{ fontSize: 13, color: "#6b7280" }}>
                    All monitored systems are operating normally.
                    {data.summary.totalCalls24h > 0 && ` ${data.summary.totalCalls24h} calls processed in the last 24h.`}
                  </div>
                </div>
              ) : (
                visibleIncidents.map((incident) => (
                  <IncidentCard key={incident.id} incident={incident} />
                ))
              )}
            </div>

            {/* Footer stats */}
            <div style={{ marginTop: 24, padding: "14px 18px", background: "#0f172a", borderRadius: 8, border: "1px solid #1e293b", display: "flex", gap: 24, flexWrap: "wrap" }}>
              <div>
                <span style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>Active calls</span>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#e2e8f0" }}>{data.health.activeCalls}</div>
              </div>
              <div>
                <span style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>Calls (24h)</span>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#e2e8f0" }}>{data.summary.totalCalls24h}</div>
              </div>
              <div>
                <span style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>Telephony uptime</span>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#e2e8f0" }}>{uptimeStr(data.health.uptimeSec)}</div>
              </div>
              <div>
                <span style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>TURN relay</span>
                <div style={{ fontSize: 18, fontWeight: 700, color: data.health.turnConfigured ? "#4ade80" : "#f87171" }}>
                  {data.health.turnConfigured ? "✓ Configured" : "✗ Missing"}
                </div>
              </div>
              <div>
                <span style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>Auto-healed (24h)</span>
                <div style={{ fontSize: 18, fontWeight: 700, color: "#4ade80" }}>
                  {healingActions.filter((a) => a.status === "succeeded").length}
                </div>
              </div>
              <div style={{ marginLeft: "auto" }}>
                <span style={{ fontSize: 10, color: "#374151" }}>Auto-refreshes every 30s · {data.timestamp && new Date(data.timestamp).toLocaleTimeString()}</span>
              </div>
            </div>
          </>
        )}
      </div>
    </PermissionGate>
  );
}
