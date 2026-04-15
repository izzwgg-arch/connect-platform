"use client";

import { useMemo, useState } from "react";
import { FilterBar } from "../../../../components/FilterBar";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { MetricCard } from "../../../../components/MetricCard";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet } from "../../../../services/apiClient";

// ── Types ────────────────────────────────────────────────────────────────────

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

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function fmtDuration(ms: number | null) {
  if (ms == null) return "–";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTime(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function CallQualityRcaPage() {
  const [range, setRange] = useState<"1h" | "24h" | "7d">("24h");
  const [causeFilter, setCauseFilter] = useState("all");
  const [platformFilter, setPlatformFilter] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  // Fetch summary
  const summary = useAsyncResource<QualitySummary>(
    () => apiGet(`/admin/voice/quality/summary?range=${range}`),
    [range],
  );

  // Fetch RCA calls
  const calls = useAsyncResource<RcaCall[]>(
    () => apiGet(`/admin/voice/quality/rca?range=${range}&limit=200${causeFilter !== "all" ? `&cause=${causeFilter}` : ""}${platformFilter !== "all" ? `&platform=${platformFilter}` : ""}`),
    [range, causeFilter, platformFilter],
  );

  const rcaCalls = calls.status === "success" ? calls.data : [];

  // Derive available causes from summary
  const causeOptions = useMemo(() => {
    if (summary.status !== "success" || !summary.data.rootCauseBreakdown) return [];
    return Object.entries(summary.data.rootCauseBreakdown)
      .sort((a, b) => b[1] - a[1])
      .map(([cause, count]) => ({ value: cause, label: `${CAUSE_LABELS[cause] || cause} (${count})` }));
  }, [summary]);

  return (
    <PermissionGate permission="can_view_admin" fallback={<div className="state-box">Admin access required.</div>}>
      <div className="stack compact-stack">
        <PageHeader
          title="Call Quality — Root Cause Analysis"
          subtitle="Every degraded or bad call is analyzed with a structured RCA tied to real telemetry evidence."
        />

        {/* ── Filters ─────────────────────────────────────────────── */}
        <FilterBar>
          <label className="filter-label">
            Time Range
            <select className="input" value={range} onChange={(e) => setRange(e.target.value as "1h" | "24h" | "7d")}>
              <option value="1h">Last 1 hour</option>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
            </select>
          </label>
          <label className="filter-label">
            Root Cause
            <select className="input" value={causeFilter} onChange={(e) => setCauseFilter(e.target.value)}>
              <option value="all">All causes</option>
              {causeOptions.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
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
        </FilterBar>

        {/* ── Summary Cards ───────────────────────────────────────── */}
        {summary.status === "loading" && <LoadingSkeleton rows={2} />}
        {summary.status === "success" && (
          <section className="metric-grid">
            <MetricCard label="Total Reports" value={String(summary.data.totalReports)} />
            <MetricCard
              label="Degraded"
              value={String(summary.data.grades.poor + summary.data.grades.failed)}
              meta={summary.data.totalReports ? `${((summary.data.grades.poor + summary.data.grades.failed) / summary.data.totalReports * 100).toFixed(1)}%` : "0%"}
            />
            <MetricCard label="Fair" value={String(summary.data.grades.fair)} />
            <MetricCard label="Avg RTT" value={summary.data.averages.rttMs != null ? `${summary.data.averages.rttMs}ms` : "–"} />
            <MetricCard label="Avg Jitter" value={summary.data.averages.jitterMs != null ? `${summary.data.averages.jitterMs}ms` : "–"} />
            <MetricCard label="TURN Relay" value={`${summary.data.relayUsagePercent}%`} meta="of calls" />
          </section>
        )}

        {/* ── Root Cause Breakdown ────────────────────────────────── */}
        {summary.status === "success" && Object.keys(summary.data.rootCauseBreakdown || {}).length > 0 && (
          <section className="panel" style={{ padding: "1rem" }}>
            <h3 style={{ margin: "0 0 0.75rem", fontSize: "0.875rem", fontWeight: 600, color: "var(--text-dim)" }}>
              Root Cause Distribution
            </h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              {Object.entries(summary.data.rootCauseBreakdown).sort((a, b) => b[1] - a[1]).map(([cause, count]) => (
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
                    background: GRADE_COLOR.poor,
                    color: "#fff",
                  }}>
                    {count}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* ── Call List ───────────────────────────────────────────── */}
        {calls.status === "loading" && <LoadingSkeleton rows={6} />}
        {calls.status === "error" && (
          <div className="state-box" style={{ color: "#ef4444" }}>Error loading calls: {calls.error}</div>
        )}
        {calls.status === "success" && rcaCalls.length === 0 && (
          <div className="state-box">No degraded calls found in this time range.</div>
        )}
        {calls.status === "success" && rcaCalls.length > 0 && (
          <section className="panel" style={{ padding: 0, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--surface-hover)" }}>
                  <th style={thStyle}>Time</th>
                  <th style={thStyle}>Grade</th>
                  <th style={thStyle}>Primary Cause</th>
                  <th style={thStyle}>Confidence</th>
                  <th style={thStyle}>Action</th>
                  <th style={thStyle}>Platform</th>
                  <th style={thStyle}>Tenant</th>
                  <th style={thStyle}>User</th>
                  <th style={thStyle}>Duration</th>
                </tr>
              </thead>
              <tbody>
                {rcaCalls.map((call) => {
                  const isExpanded = expanded === call.id;
                  return (
                    <RcaRow
                      key={call.id}
                      call={call}
                      isExpanded={isExpanded}
                      onToggle={() => setExpanded(isExpanded ? null : call.id)}
                    />
                  );
                })}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </PermissionGate>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const thStyle: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  textAlign: "left",
  fontWeight: 600,
  fontSize: "0.75rem",
  color: "var(--text-dim)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const tdStyle: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  verticalAlign: "top",
};

// ── Row component ────────────────────────────────────────────────────────────

function RcaRow({ call, isExpanded, onToggle }: { call: RcaCall; isExpanded: boolean; onToggle: () => void }) {
  const rca = call.rca;

  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          borderBottom: isExpanded ? "none" : "1px solid var(--border)",
          cursor: "pointer",
          transition: "background 0.1s",
          background: isExpanded ? "var(--surface-hover)" : undefined,
        }}
        onMouseOver={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
        onMouseOut={(e) => (e.currentTarget.style.background = isExpanded ? "var(--surface-hover)" : "")}
      >
        <td style={tdStyle}>
          <span className="mono text-sm">{fmtTime(call.createdAt)}</span>
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
          <span style={{ fontWeight: 600 }}>
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
          <span className="mono text-sm">{fmtDuration(call.durationMs)}</span>
        </td>
      </tr>

      {/* ── Expanded detail row ──────────────────────────────── */}
      {isExpanded && (
        <tr style={{ borderBottom: "1px solid var(--border)" }}>
          <td colSpan={9} style={{ padding: "0.75rem 1rem 1rem", background: "var(--surface)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1rem", fontSize: "0.8125rem" }}>

              {/* Evidence */}
              <div>
                <h4 style={detailHeading}>Evidence</h4>
                {rca?.evidence && Object.keys(rca.evidence).length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                    {Object.entries(rca.evidence).map(([k, v]) => (
                      <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
                        <span style={{ color: "var(--text-dim)" }}>{k.replace(/_/g, " ")}</span>
                        <span className="mono" style={{ fontWeight: 500 }}>{String(v)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span style={{ color: "var(--text-dim)" }}>No evidence captured</span>
                )}
              </div>

              {/* Secondary factors + call details */}
              <div>
                <h4 style={detailHeading}>Secondary Factors</h4>
                {rca?.secondaryFactors && rca.secondaryFactors.length > 0 ? (
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
                ) : (
                  <span style={{ color: "var(--text-dim)" }}>None</span>
                )}

                <h4 style={{ ...detailHeading, marginTop: "0.75rem" }}>Call Details</h4>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                  <DetailRow label="Direction" value={call.direction || "–"} />
                  <DetailRow label="ICE Type" value={call.candidateType || "–"} />
                  <DetailRow label="TURN Relay" value={call.isUsingRelay ? "Yes" : "No"} />
                  <DetailRow label="Codec" value={call.audioCodec || "–"} />
                  <DetailRow label="End Reason" value={call.endReason || "–"} />
                </div>
              </div>

              {/* Timeline + metrics */}
              <div>
                <h4 style={detailHeading}>Timeline</h4>
                {rca?.timeline ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                    {rca.timeline.callStart && (
                      <DetailRow label="Call Start" value={fmtTime(rca.timeline.callStart)} />
                    )}
                    {rca.timeline.degradationDetected && (
                      <DetailRow label="Degradation" value={fmtTime(rca.timeline.degradationDetected)} />
                    )}
                    <DetailRow label="Call End" value={fmtTime(rca.timeline.callEnd)} />
                  </div>
                ) : (
                  <span style={{ color: "var(--text-dim)" }}>–</span>
                )}

                <h4 style={{ ...detailHeading, marginTop: "0.75rem" }}>Metrics</h4>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                  <DetailRow label="RTT" value={call.rttMs != null ? `${call.rttMs}ms` : "–"} warn={call.rttMs != null && call.rttMs > 200} />
                  <DetailRow label="Jitter" value={call.jitterMs != null ? `${call.jitterMs}ms` : "–"} warn={call.jitterMs != null && call.jitterMs > 30} />
                  <DetailRow
                    label="Packet Loss"
                    value={call.packetsLost != null ? String(call.packetsLost) : "–"}
                    warn={call.packetsLost != null && call.packetsLost > 10}
                  />
                  {call.packetsReceived != null && call.packetsLost != null && (call.packetsLost + call.packetsReceived) > 0 && (
                    <DetailRow
                      label="Loss %"
                      value={`${((call.packetsLost / (call.packetsLost + call.packetsReceived)) * 100).toFixed(2)}%`}
                      warn={(call.packetsLost / (call.packetsLost + call.packetsReceived)) > 0.01}
                    />
                  )}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Small helpers ────────────────────────────────────────────────────────────

const detailHeading: React.CSSProperties = {
  margin: "0 0 0.5rem",
  fontSize: "0.6875rem",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--text-dim)",
};

function DetailRow({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span className="mono" style={{ fontWeight: 500, color: warn ? "#ef4444" : undefined }}>{value}</span>
    </div>
  );
}
