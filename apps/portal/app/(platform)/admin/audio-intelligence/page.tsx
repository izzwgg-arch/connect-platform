"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilterBar } from "../../../../components/FilterBar";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { MetricCard } from "../../../../components/MetricCard";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet, apiPost } from "../../../../services/apiClient";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Rca {
  primaryCause: string;
  secondaryFactors: string[];
  confidence: string;
  evidence: Record<string, unknown>;
  suggestedAction: string;
  timeline: { callStart?: string; degradationDetected?: string; callEnd: string };
}

interface RcaCall {
  id: string;
  createdAt: string;
  tenantId: string;
  tenantName: string;
  userId: string;
  userEmail: string;
  qualityGrade: string;
  platform: string | null;
  direction: string | null;
  durationMs: number | null;
  rttMs: number | null;
  jitterMs: number | null;
  packetsLost: number | null;
  packetsReceived: number | null;
  candidateType: string | null;
  isUsingRelay: boolean | null;
  audioCodec: string | null;
  endReason: string | null;
  rca: Rca | null;
}

interface QualitySummary {
  totalReports: number;
  grades: { excellent: number; good: number; fair: number; poor: number; failed: number };
  averages: { rttMs: number | null; jitterMs: number | null; packetsLostPerCall: number | null };
  relayUsagePercent: number;
  rootCauseBreakdown: Record<string, number>;
}

interface LiveCall {
  userId: string;
  tenantId: string;
  userEmail: string;
  tenantName: string;
  platform: string;
  direction: string;
  durationMs: number;
  candidateType: string | null;
  isUsingRelay: boolean;
  rttMs: number | null;
  jitterMs: number | null;
  packetsLost: number | null;
  packetsReceived: number | null;
  packetsSent: number | null;
  bytesReceived: number | null;
  bytesSent: number | null;
  bitrateKbps: number | null;
  audioLevel: number | null;
  audioCodec: string | null;
  networkType: string | null;
  qualityGrade: string;
  ts: number;
  ageMs: number;
}

// ── Lookup maps ───────────────────────────────────────────────────────────────

const CAUSE_LABELS: Record<string, string> = {
  network_instability: "Network Instability",
  packet_loss: "Packet Loss",
  high_jitter: "High Jitter",
  high_latency: "High Latency",
  TURN_missing: "TURN Missing",
  ICE_failure: "ICE Failure",
  one_way_audio: "One-Way Audio",
  audio_route_issue: "Audio Route Issue",
  bluetooth_issue: "Bluetooth Issue",
  device_issue: "Device Issue",
  PBX_media_issue: "PBX Media Issue",
  unknown: "Unknown",
};

const ACTION_LABELS: Record<string, string> = {
  enable_TURN_relay: "Enable TURN relay",
  adjust_PBX_NAT_config: "Adjust PBX NAT config",
  avoid_Bluetooth_on_device: "Avoid Bluetooth on device",
  improve_network: "Improve network",
  investigate_firewall: "Investigate firewall",
  investigate_PBX_media_path: "Investigate PBX media path",
  check_codec_config: "Check codec config",
  check_client_network: "Check client network",
  none: "No action needed",
};

const CONFIDENCE_COLOR: Record<string, string> = {
  HIGH: "#22c55e",
  MEDIUM: "#f59e0b",
  LOW: "#94a3b8",
};

const GRADE_COLOR: Record<string, string> = {
  excellent: "#22c55e",
  good: "#22c55e",
  fair: "#f59e0b",
  poor: "#ef4444",
  failed: "#dc2626",
};

const GRADE_BG: Record<string, string> = {
  excellent: "#dcfce7",
  good: "#dcfce7",
  fair: "#fef3c7",
  poor: "#fee2e2",
  failed: "#fecaca",
};

const LIVE_GRADE_COLOR: Record<string, { bg: string; color: string; label: string }> = {
  excellent: { bg: "#dcfce7", color: "#166534", label: "EXCELLENT" },
  good:      { bg: "#dcfce7", color: "#166534", label: "GOOD" },
  fair:      { bg: "#fef3c7", color: "#92400e", label: "FAIR" },
  poor:      { bg: "#fee2e2", color: "#991b1b", label: "POOR" },
  failed:    { bg: "#fecaca", color: "#7f1d1d", label: "FAILED" },
  unknown:   { bg: "#f1f5f9", color: "#475569", label: "UNKNOWN" },
};

function fmtDuration(ms: number | null) {
  if (ms == null) return "–";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtTime(iso: string) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function fmtAgo(ageMs: number) {
  if (ageMs < 5000) return "now";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
  return `${Math.floor(ageMs / 60_000)}m ago`;
}

// ── Live calls panel ──────────────────────────────────────────────────────────

function LiveCallsPanel({ debugMode }: { debugMode: boolean }) {
  const [calls, setCalls] = useState<LiveCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLive = useCallback(async () => {
    try {
      const data = await apiGet("/admin/voice/quality/live") as LiveCall[];
      setCalls(Array.isArray(data) ? data : []);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Failed to load live calls");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLive();
    intervalRef.current = setInterval(fetchLive, 3_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchLive]);

  const degradedLive = calls.filter((c) => c.qualityGrade === "poor" || c.qualityGrade === "failed" || c.qualityGrade === "fair");

  return (
    <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0.75rem 1rem 0.5rem",
        borderBottom: "1px solid var(--border)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.625rem" }}>
          <span style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: calls.length > 0 ? "#22c55e" : "#94a3b8",
            boxShadow: calls.length > 0 ? "0 0 0 3px #bbf7d0" : undefined,
            animation: calls.length > 0 ? "pulse 2s infinite" : undefined,
          }} />
          <h3 style={{ margin: 0, fontSize: "0.875rem", fontWeight: 600 }}>
            Live Calls
          </h3>
          <span style={{ fontSize: "0.75rem", fontWeight: 400, color: "var(--text-dim)" }}>
            {calls.length === 0 ? "No active calls" : `${calls.length} active`}
          </span>
          {degradedLive.length > 0 && (
            <span style={{
              padding: "0.125rem 0.5rem",
              borderRadius: "999px",
              fontSize: "0.6875rem",
              fontWeight: 700,
              background: "#fee2e2",
              color: "#991b1b",
            }}>
              {degradedLive.length} DEGRADED
            </span>
          )}
        </div>
        <span style={{ fontSize: "0.6875rem", color: "var(--text-dim)" }}>
          Updates every 3s
        </span>
      </div>

      {loading && <LoadingSkeleton rows={2} />}
      {error && (
        <div style={{ padding: "0.75rem 1rem", color: "#ef4444", fontSize: "0.8125rem" }}>
          {error}
        </div>
      )}
      {!loading && calls.length === 0 && (
        <div style={{ padding: "1rem", fontSize: "0.8125rem", color: "var(--text-dim)", textAlign: "center" }}>
          No active calls at this moment
        </div>
      )}
      {calls.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
            <thead>
              <tr style={{ background: "var(--surface-hover)" }}>
                {["Status", "User", "Tenant", "Platform", "Duration", "RTT", "Jitter", "Loss", "ICE", "Bitrate", "Updated"].map((h) => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {calls.map((call) => {
                const g = LIVE_GRADE_COLOR[call.qualityGrade] || LIVE_GRADE_COLOR.unknown;
                const lossRate = (call.packetsLost != null && call.packetsReceived != null && call.packetsReceived > 0)
                  ? ((call.packetsLost / (call.packetsLost + call.packetsReceived)) * 100).toFixed(1) + "%"
                  : "–";
                const isExp = expanded === call.userId;
                return (
                  <>
                    <tr
                      key={call.userId}
                      onClick={() => setExpanded(isExp ? null : call.userId)}
                      style={{
                        borderBottom: isExp ? "none" : "1px solid var(--border)",
                        cursor: "pointer",
                        background: isExp ? "var(--surface-hover)" : undefined,
                        transition: "background 0.1s",
                      }}
                      onMouseOver={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
                      onMouseOut={(e) => (e.currentTarget.style.background = isExp ? "var(--surface-hover)" : "")}
                    >
                      <td style={tdStyle}>
                        <span style={{
                          display: "inline-block",
                          padding: "0.125rem 0.5rem",
                          borderRadius: "999px",
                          fontSize: "0.6875rem",
                          fontWeight: 700,
                          background: g.bg,
                          color: g.color,
                        }}>
                          {g.label}
                        </span>
                      </td>
                      <td style={tdStyle}><span style={{ fontSize: "0.75rem" }}>{call.userEmail}</span></td>
                      <td style={tdStyle}><span style={{ fontSize: "0.75rem" }}>{call.tenantName}</span></td>
                      <td style={tdStyle}><span style={{ fontSize: "0.75rem" }}>{call.platform}</span></td>
                      <td style={tdStyle}><span className="mono" style={{ fontSize: "0.75rem" }}>{fmtDuration(call.durationMs)}</span></td>
                      <td style={tdStyle}>
                        <MetricPill value={call.rttMs != null ? `${call.rttMs}ms` : "–"} warn={call.rttMs != null && call.rttMs > 200} />
                      </td>
                      <td style={tdStyle}>
                        <MetricPill value={call.jitterMs != null ? `${call.jitterMs}ms` : "–"} warn={call.jitterMs != null && call.jitterMs > 30} />
                      </td>
                      <td style={tdStyle}>
                        <MetricPill value={lossRate} warn={call.packetsLost != null && call.packetsLost > 5} />
                      </td>
                      <td style={tdStyle}>
                        <span style={{ fontSize: "0.75rem" }}>
                          {call.candidateType || "–"}
                          {call.isUsingRelay && <span style={{ marginLeft: 4, fontSize: "0.6875rem", color: "#3b82f6" }}>TURN</span>}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <span className="mono" style={{ fontSize: "0.75rem" }}>
                          {call.bitrateKbps != null ? `${call.bitrateKbps}kbps` : "–"}
                        </span>
                      </td>
                      <td style={tdStyle}>
                        <span style={{ fontSize: "0.6875rem", color: "var(--text-dim)" }}>{fmtAgo(call.ageMs)}</span>
                      </td>
                    </tr>
                    {isExp && (
                      <tr key={`${call.userId}-detail`} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td colSpan={11} style={{ padding: "0.75rem 1rem 1rem", background: "var(--surface)" }}>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1.25rem", fontSize: "0.8125rem" }}>
                            <div>
                              <h4 style={detailHeading}>Audio Metrics</h4>
                              <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                                <DetailRow label="RTT" value={call.rttMs != null ? `${call.rttMs}ms` : "–"} warn={call.rttMs != null && call.rttMs > 200} />
                                <DetailRow label="Jitter" value={call.jitterMs != null ? `${call.jitterMs}ms` : "–"} warn={call.jitterMs != null && call.jitterMs > 30} />
                                <DetailRow label="Packets lost" value={call.packetsLost != null ? String(call.packetsLost) : "–"} warn={call.packetsLost != null && call.packetsLost > 5} />
                                <DetailRow label="Packets recv" value={call.packetsReceived != null ? String(call.packetsReceived) : "–"} />
                                <DetailRow label="Packets sent" value={call.packetsSent != null ? String(call.packetsSent) : "–"} />
                                <DetailRow label="Codec" value={call.audioCodec || "–"} />
                                {call.audioLevel != null && <DetailRow label="Mic level" value={`${(call.audioLevel * 100).toFixed(1)}%`} />}
                              </div>
                            </div>
                            <div>
                              <h4 style={detailHeading}>Network</h4>
                              <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                                <DetailRow label="ICE type" value={call.candidateType || "–"} />
                                <DetailRow label="TURN relay" value={call.isUsingRelay ? "Yes" : "No"} />
                                <DetailRow label="Network type" value={call.networkType || "–"} />
                                <DetailRow label="Bitrate" value={call.bitrateKbps != null ? `${call.bitrateKbps}kbps` : "–"} />
                                {call.bytesReceived != null && <DetailRow label="Bytes recv" value={`${(call.bytesReceived / 1024).toFixed(1)} KB`} />}
                              </div>
                            </div>
                            <div>
                              <h4 style={detailHeading}>Call Info</h4>
                              <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                                <DetailRow label="Direction" value={call.direction || "–"} />
                                <DetailRow label="Platform" value={call.platform || "–"} />
                                <DetailRow label="Duration" value={fmtDuration(call.durationMs)} />
                                <DetailRow label="Last update" value={fmtAgo(call.ageMs)} />
                              </div>
                            </div>
                          </div>
                          {debugMode && (
                            <div style={{ marginTop: "0.75rem", padding: "0.75rem", background: "#0f172a", borderRadius: 6 }}>
                              <h4 style={{ ...detailHeading, color: "#94a3b8", marginBottom: "0.5rem" }}>Raw Snapshot</h4>
                              <pre style={{ fontSize: "0.6875rem", color: "#e2e8f0", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                                {JSON.stringify(call, null, 2)}
                              </pre>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function MetricPill({ value, warn }: { value: string; warn?: boolean }) {
  return (
    <span className="mono" style={{
      fontSize: "0.75rem",
      fontWeight: 600,
      color: warn ? "#ef4444" : undefined,
      background: warn ? "#fee2e2" : undefined,
      padding: warn ? "0.1rem 0.375rem" : undefined,
      borderRadius: warn ? "4px" : undefined,
    }}>
      {value}
    </span>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AudioIntelligencePage() {
  const [range, setRange] = useState<"1h" | "24h" | "7d">("24h");
  const [causeFilter, setCauseFilter] = useState("all");
  const [platformFilter, setPlatformFilter] = useState("all");
  const [tenantFilter, setTenantFilter] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [debugMode, setDebugMode] = useState(false);

  const summary = useAsyncResource<QualitySummary>(
    () => apiGet(`/admin/voice/quality/summary?range=${range}`),
    [range],
  );

  const calls = useAsyncResource<RcaCall[]>(
    () => {
      const params = new URLSearchParams({ range, limit: "300" });
      if (causeFilter !== "all") params.set("cause", causeFilter);
      if (platformFilter !== "all") params.set("platform", platformFilter);
      if (tenantFilter !== "all") params.set("tenantId", tenantFilter);
      return apiGet(`/admin/voice/quality/rca?${params.toString()}`);
    },
    [range, causeFilter, platformFilter, tenantFilter],
  );

  const rcaCalls = calls.status === "success" ? calls.data : [];

  // Grade health bar
  const gradeHealth = useMemo(() => {
    if (summary.status !== "success") return null;
    const g = summary.data.grades;
    const total = g.excellent + g.good + g.fair + g.poor + g.failed;
    if (total === 0) return null;
    return [
      { label: "Excellent", count: g.excellent, color: "#22c55e" },
      { label: "Good", count: g.good, color: "#86efac" },
      { label: "Fair", count: g.fair, color: "#f59e0b" },
      { label: "Poor", count: g.poor, color: "#ef4444" },
      { label: "Failed", count: g.failed, color: "#dc2626" },
    ].filter((s) => s.count > 0).map((s) => ({ ...s, pct: (s.count / total) * 100 }));
  }, [summary]);

  // Cause options from summary
  const causeOptions = useMemo(() => {
    if (summary.status !== "success") return [];
    return Object.entries(summary.data.rootCauseBreakdown || {})
      .sort((a, b) => b[1] - a[1])
      .map(([cause, count]) => ({ value: cause, label: `${CAUSE_LABELS[cause] || cause} (${count})` }));
  }, [summary]);

  // Unique tenants from loaded calls
  const tenantOptions = useMemo(() => {
    if (calls.status !== "success") return [];
    const seen = new Map<string, string>();
    for (const c of calls.data) seen.set(c.tenantId, c.tenantName);
    return [...seen.entries()].map(([id, name]) => ({ value: id, label: name }));
  }, [calls]);

  // Alert: any HIGH confidence poor/failed calls
  const highConfidenceAlerts = useMemo(() => {
    return rcaCalls.filter(
      (c) => (c.qualityGrade === "poor" || c.qualityGrade === "failed") && c.rca?.confidence === "HIGH",
    );
  }, [rcaCalls]);

  return (
    <PermissionGate
      permission="can_manage_global_settings"
      fallback={<div className="state-box">Platform admin access required.</div>}
    >
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>

      <div className="stack compact-stack">
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}>
          <PageHeader
            title="Audio Intelligence"
            subtitle="Platform-wide voice call quality monitoring, root cause analysis, and diagnostic insights."
          />
          <button
            onClick={() => setDebugMode((d) => !d)}
            style={{
              marginTop: "0.25rem",
              padding: "0.375rem 0.75rem",
              fontSize: "0.75rem",
              borderRadius: "0.375rem",
              border: "1px solid var(--border)",
              background: debugMode ? "#0f172a" : "var(--surface)",
              color: debugMode ? "#94a3b8" : "var(--text-dim)",
              cursor: "pointer",
              fontFamily: "monospace",
              whiteSpace: "nowrap",
            }}
          >
            {debugMode ? "✓ Debug Mode" : "Debug Mode"}
          </button>
        </div>

        {/* ── Alerts bar ───────────────────────────────────────────── */}
        {highConfidenceAlerts.length > 0 && (
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            padding: "0.625rem 1rem",
            borderRadius: "0.5rem",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            fontSize: "0.875rem",
            fontWeight: 500,
          }}>
            <span style={{ fontSize: "1.1rem" }}>⚠</span>
            <span>
              {highConfidenceAlerts.length} HIGH-confidence degraded call{highConfidenceAlerts.length !== 1 ? "s" : ""} detected
              in the last {range === "1h" ? "hour" : range === "24h" ? "24 hours" : "7 days"}.
              Causes: {[...new Set(highConfidenceAlerts.map((c) => CAUSE_LABELS[c.rca?.primaryCause || ""] || c.rca?.primaryCause || "unknown"))].join(", ")}.
            </span>
          </div>
        )}

        {/* ── LIVE CALLS PANEL ─────────────────────────────────────────── */}
        <LiveCallsPanel debugMode={debugMode} />

        {/* ── Filters ──────────────────────────────────────────────── */}
        <FilterBar>
          <label className="filter-label">
            Time Range
            <select className="input" value={range} onChange={(e) => setRange(e.target.value as "1h" | "24h" | "7d")}>
              <option value="1h">Last hour</option>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
            </select>
          </label>
          <label className="filter-label">
            Root Cause
            <select className="input" value={causeFilter} onChange={(e) => setCauseFilter(e.target.value)}>
              <option value="all">All causes</option>
              {causeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label className="filter-label">
            Platform
            <select className="input" value={platformFilter} onChange={(e) => setPlatformFilter(e.target.value)}>
              <option value="all">All platforms</option>
              <option value="WEB">Web</option>
              <option value="ANDROID">Android</option>
              <option value="IOS">iOS</option>
            </select>
          </label>
          {tenantOptions.length > 1 && (
            <label className="filter-label">
              Tenant
              <select className="input" value={tenantFilter} onChange={(e) => setTenantFilter(e.target.value)}>
                <option value="all">All tenants</option>
                {tenantOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          )}
        </FilterBar>

        {/* ── Summary tiles ─────────────────────────────────────────── */}
        {summary.status === "loading" && <LoadingSkeleton rows={2} />}
        {summary.status === "success" && (
          <>
            <section className="metric-grid">
              <MetricCard label="Total Reports" value={String(summary.data.totalReports)} />
              <MetricCard
                label="Degraded (poor + failed)"
                value={String(summary.data.grades.poor + summary.data.grades.failed)}
                meta={summary.data.totalReports
                  ? `${((summary.data.grades.poor + summary.data.grades.failed) / summary.data.totalReports * 100).toFixed(1)}%`
                  : "0%"}
              />
              <MetricCard label="Fair Quality" value={String(summary.data.grades.fair)} />
              <MetricCard
                label="Avg RTT"
                value={summary.data.averages.rttMs != null ? `${summary.data.averages.rttMs}ms` : "–"}
              />
              <MetricCard
                label="Avg Jitter"
                value={summary.data.averages.jitterMs != null ? `${summary.data.averages.jitterMs}ms` : "–"}
              />
              <MetricCard
                label="TURN Relay Usage"
                value={`${summary.data.relayUsagePercent}%`}
                meta="of all calls"
              />
            </section>

            {/* Grade health bar */}
            {gradeHealth && (
              <section className="panel" style={{ padding: "1rem" }}>
                <h3 style={sectionHeading}>Call Quality Health</h3>
                <div style={{ display: "flex", height: 20, borderRadius: 6, overflow: "hidden", gap: 1 }}>
                  {gradeHealth.map((s) => (
                    <div
                      key={s.label}
                      title={`${s.label}: ${s.count} (${s.pct.toFixed(1)}%)`}
                      style={{ width: `${s.pct}%`, background: s.color, transition: "width 0.3s" }}
                    />
                  ))}
                </div>
                <div style={{ display: "flex", gap: "1rem", marginTop: "0.5rem", flexWrap: "wrap" }}>
                  {gradeHealth.map((s) => (
                    <span key={s.label} style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.75rem" }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, display: "inline-block" }} />
                      {s.label} — {s.count}
                    </span>
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {/* ── Root Cause Distribution ────────────────────────────────── */}
        {summary.status === "success" && Object.keys(summary.data.rootCauseBreakdown || {}).length > 0 && (
          <section className="panel" style={{ padding: "1rem" }}>
            <h3 style={sectionHeading}>Root Cause Distribution</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              {Object.entries(summary.data.rootCauseBreakdown)
                .sort((a, b) => b[1] - a[1])
                .map(([cause, count]) => (
                  <button
                    key={cause}
                    onClick={() => setCauseFilter(causeFilter === cause ? "all" : cause)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.375rem",
                      padding: "0.375rem 0.75rem",
                      borderRadius: "999px",
                      fontSize: "0.8125rem",
                      fontWeight: 500,
                      border: causeFilter === cause ? "2px solid var(--accent)" : "1px solid var(--border)",
                      background: causeFilter === cause ? "var(--accent-muted)" : "var(--surface)",
                      color: "var(--text)",
                      cursor: "pointer",
                      transition: "all 0.15s",
                    }}
                  >
                    {CAUSE_LABELS[cause] || cause}
                    <span style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      minWidth: 20,
                      height: 20,
                      borderRadius: "999px",
                      fontSize: "0.6875rem",
                      fontWeight: 700,
                      background: "#ef4444",
                      color: "#fff",
                    }}>
                      {count}
                    </span>
                  </button>
                ))}
            </div>
          </section>
        )}

        {/* ── Degraded call table ───────────────────────────────────── */}
        <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "0.75rem 1rem 0.5rem", borderBottom: "1px solid var(--border)" }}>
            <h3 style={{ margin: 0, fontSize: "0.875rem", fontWeight: 600 }}>
              Degraded Calls — RCA Drill-Down
              {calls.status === "success" && (
                <span style={{ marginLeft: "0.5rem", fontSize: "0.75rem", fontWeight: 400, color: "var(--text-dim)" }}>
                  {rcaCalls.length} result{rcaCalls.length !== 1 ? "s" : ""}
                </span>
              )}
            </h3>
          </div>

          {calls.status === "loading" && <LoadingSkeleton rows={6} />}
          {calls.status === "error" && (
            <div style={{ padding: "1rem", color: "#ef4444", fontSize: "0.875rem" }}>
              Error loading calls: {calls.error}
            </div>
          )}
          {calls.status === "success" && rcaCalls.length === 0 && (
            <div className="state-box">No degraded calls in this time range with the current filters.</div>
          )}
          {calls.status === "success" && rcaCalls.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
                <thead>
                  <tr style={{ background: "var(--surface-hover)" }}>
                    {["Time", "Grade", "Primary Cause", "Confidence", "Suggested Action", "Platform", "Tenant", "User", "Duration"].map((h) => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rcaCalls.map((call) => {
                    const isExp = expanded === call.id;
                    return (
                      <RcaRow
                        key={call.id}
                        call={call}
                        isExpanded={isExp}
                        debugMode={debugMode}
                        onToggle={() => setExpanded(isExp ? null : call.id)}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </PermissionGate>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

const thStyle: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  textAlign: "left",
  fontWeight: 600,
  fontSize: "0.75rem",
  color: "var(--text-dim)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  verticalAlign: "top",
};

const sectionHeading: React.CSSProperties = {
  margin: "0 0 0.75rem",
  fontSize: "0.875rem",
  fontWeight: 600,
  color: "var(--text-dim)",
};

const detailHeading: React.CSSProperties = {
  margin: "0 0 0.5rem",
  fontSize: "0.6875rem",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--text-dim)",
};

function RcaRow({ call, isExpanded, onToggle, debugMode }: {
  call: RcaCall;
  isExpanded: boolean;
  onToggle: () => void;
  debugMode: boolean;
}) {
  const rca = call.rca;
  const hasEvidence = rca?.evidence && Object.keys(rca.evidence).length > 0;

  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          borderBottom: isExpanded ? "none" : "1px solid var(--border)",
          cursor: "pointer",
          background: isExpanded ? "var(--surface-hover)" : undefined,
          transition: "background 0.1s",
        }}
        onMouseOver={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
        onMouseOut={(e) => (e.currentTarget.style.background = isExpanded ? "var(--surface-hover)" : "")}
      >
        <td style={tdStyle}>
          <span className="mono" style={{ fontSize: "0.75rem" }}>{fmtTime(call.createdAt)}</span>
        </td>
        <td style={tdStyle}>
          <span style={{
            display: "inline-block",
            padding: "0.125rem 0.5rem",
            borderRadius: "999px",
            fontSize: "0.6875rem",
            fontWeight: 700,
            textTransform: "uppercase",
            background: GRADE_COLOR[call.qualityGrade] || "#64748b",
            color: "#fff",
          }}>
            {call.qualityGrade}
          </span>
        </td>
        <td style={tdStyle}>
          <span style={{ fontWeight: 600, fontSize: "0.8125rem" }}>
            {rca ? CAUSE_LABELS[rca.primaryCause] || rca.primaryCause : "–"}
          </span>
        </td>
        <td style={tdStyle}>
          {rca && (
            <span style={{ fontWeight: 600, fontSize: "0.75rem", color: CONFIDENCE_COLOR[rca.confidence] || "#94a3b8" }}>
              {rca.confidence}
            </span>
          )}
        </td>
        <td style={tdStyle}>
          <span style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>
            {rca ? ACTION_LABELS[rca.suggestedAction] || rca.suggestedAction : "–"}
          </span>
        </td>
        <td style={tdStyle}>
          <span style={{ fontSize: "0.75rem" }}>{call.platform || "–"}</span>
        </td>
        <td style={tdStyle}>
          <span style={{ fontSize: "0.75rem" }}>{call.tenantName}</span>
        </td>
        <td style={tdStyle}>
          <span style={{ fontSize: "0.75rem" }}>{call.userEmail}</span>
        </td>
        <td style={tdStyle}>
          <span className="mono" style={{ fontSize: "0.75rem" }}>{fmtDuration(call.durationMs)}</span>
        </td>
      </tr>

      {isExpanded && (
        <tr style={{ borderBottom: "1px solid var(--border)" }}>
          <td colSpan={9} style={{ padding: "0.75rem 1rem 1.25rem", background: "var(--surface)" }}>
            {/* Grade + RCA banner */}
            <div style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.375rem 0.875rem",
              borderRadius: "0.5rem",
              marginBottom: "1rem",
              background: GRADE_BG[call.qualityGrade] || "#f1f5f9",
              border: `1px solid ${GRADE_COLOR[call.qualityGrade] || "#64748b"}30`,
              fontSize: "0.8125rem",
              fontWeight: 600,
              color: GRADE_COLOR[call.qualityGrade] || "#64748b",
            }}>
              <span style={{ textTransform: "uppercase" }}>{call.qualityGrade}</span>
              {rca && (
                <>
                  <span style={{ opacity: 0.4 }}>·</span>
                  <span>{CAUSE_LABELS[rca.primaryCause] || rca.primaryCause}</span>
                  <span style={{ opacity: 0.4 }}>·</span>
                  <span style={{ color: CONFIDENCE_COLOR[rca.confidence] }}>{rca.confidence} confidence</span>
                  <span style={{ opacity: 0.4 }}>·</span>
                  <span style={{ fontWeight: 400, color: "var(--text-dim)" }}>
                    {ACTION_LABELS[rca.suggestedAction] || rca.suggestedAction}
                  </span>
                </>
              )}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1.25rem", fontSize: "0.8125rem" }}>
              {/* Evidence */}
              <div>
                <h4 style={detailHeading}>Evidence</h4>
                {hasEvidence ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                    {Object.entries(rca!.evidence).map(([k, v]) => (
                      <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
                        <span style={{ color: "var(--text-dim)" }}>{k.replace(/_/g, " ")}</span>
                        <span className="mono" style={{ fontWeight: 500 }}>{String(v)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div>
                    <div style={{ color: "var(--text-dim)", fontSize: "0.8125rem", marginBottom: "0.5rem" }}>
                      Raw metrics:
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                      <DetailRow label="RTT" value={call.rttMs != null ? `${call.rttMs}ms` : "not captured"} warn={call.rttMs != null && call.rttMs > 200} />
                      <DetailRow label="Jitter" value={call.jitterMs != null ? `${call.jitterMs}ms` : "not captured"} warn={call.jitterMs != null && call.jitterMs > 30} />
                      <DetailRow label="Packets lost" value={call.packetsLost != null ? String(call.packetsLost) : "not captured"} />
                      <DetailRow label="ICE type" value={call.candidateType || "not captured"} />
                    </div>
                  </div>
                )}

                {rca?.secondaryFactors && rca.secondaryFactors.length > 0 && (
                  <>
                    <h4 style={{ ...detailHeading, marginTop: "0.75rem" }}>Secondary Factors</h4>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
                      {rca.secondaryFactors.map((f) => (
                        <span key={f} style={{
                          padding: "0.125rem 0.5rem",
                          borderRadius: "999px",
                          fontSize: "0.6875rem",
                          border: "1px solid var(--border)",
                          background: "var(--surface-hover)",
                        }}>
                          {f.replace(/_/g, " ")}
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* Call details + timeline */}
              <div>
                <h4 style={detailHeading}>Call Details</h4>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                  <DetailRow label="Direction" value={call.direction || "–"} />
                  <DetailRow label="Platform" value={call.platform || "–"} />
                  <DetailRow label="ICE type" value={call.candidateType || "–"} />
                  <DetailRow label="TURN relay" value={call.isUsingRelay ? "Yes" : "No"} />
                  <DetailRow label="Codec" value={call.audioCodec || "–"} />
                  <DetailRow label="End reason" value={call.endReason || "–"} />
                </div>

                {rca?.timeline && (
                  <>
                    <h4 style={{ ...detailHeading, marginTop: "0.75rem" }}>Timeline</h4>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                      {rca.timeline.callStart && <DetailRow label="Call start" value={fmtTime(rca.timeline.callStart)} />}
                      {rca.timeline.degradationDetected && <DetailRow label="Degradation" value={fmtTime(rca.timeline.degradationDetected)} />}
                      <DetailRow label="Call end" value={fmtTime(rca.timeline.callEnd)} />
                    </div>
                  </>
                )}
              </div>

              {/* Metrics */}
              <div>
                <h4 style={detailHeading}>Network Metrics</h4>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                  <DetailRow
                    label="RTT"
                    value={call.rttMs != null ? `${call.rttMs}ms` : "–"}
                    warn={call.rttMs != null && call.rttMs > 200}
                  />
                  <DetailRow
                    label="Jitter"
                    value={call.jitterMs != null ? `${call.jitterMs}ms` : "–"}
                    warn={call.jitterMs != null && call.jitterMs > 30}
                  />
                  <DetailRow
                    label="Packets lost"
                    value={call.packetsLost != null ? String(call.packetsLost) : "–"}
                    warn={call.packetsLost != null && call.packetsLost > 5}
                  />
                  {call.packetsReceived != null && call.packetsLost != null &&
                    (call.packetsLost + call.packetsReceived) > 0 && (
                      <DetailRow
                        label="Loss %"
                        value={`${((call.packetsLost / (call.packetsLost + call.packetsReceived)) * 100).toFixed(2)}%`}
                        warn={(call.packetsLost / (call.packetsLost + call.packetsReceived)) > 0.01}
                      />
                    )}
                  <DetailRow label="Duration" value={fmtDuration(call.durationMs)} />
                </div>

                <h4 style={{ ...detailHeading, marginTop: "0.75rem" }}>Identity</h4>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
                  <DetailRow label="Tenant" value={call.tenantName} />
                  <DetailRow label="User" value={call.userEmail} />
                </div>
              </div>
            </div>

            {/* Debug mode: show full raw payload */}
            {debugMode && (
              <div style={{ marginTop: "0.75rem", padding: "0.75rem", background: "#0f172a", borderRadius: 6 }}>
                <h4 style={{ ...detailHeading, color: "#94a3b8", marginBottom: "0.5rem" }}>Raw Call Payload</h4>
                <pre style={{ fontSize: "0.6875rem", color: "#e2e8f0", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                  {JSON.stringify(call, null, 2)}
                </pre>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function DetailRow({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span className="mono" style={{ fontWeight: 500, color: warn ? "#ef4444" : undefined }}>{value}</span>
    </div>
  );
}
