"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet } from "../../../../services/apiClient";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

type Hstatus = "ok" | "degraded" | "down" | "warning" | "critical" | "missing" | "unknown";

type GlobalHealth = {
  api: { status: Hstatus; label: string; lastIncident: string | null };
  database: { status: Hstatus; label: string; lastIncident: string | null };
  pbx: { status: Hstatus; label: string; lastIncident: string | null };
  ami: { status: Hstatus; label: string; lastIncident: string | null; lastError: string | null };
  ari: { status: Hstatus; label: string; lastIncident: string | null; lastError: string | null };
  sbc: { status: Hstatus; label: string; lastIncident: string | null };
  turn: { status: Hstatus; label: string; lastIncident: string | null };
  workers: { status: Hstatus; label: string; lastIncident: string | null };
  webrtc: { status: Hstatus; label: string; lastIncident: string | null; iceFailures24h: number };
};

type OpsIncident = {
  id: string; title: string; severity: "critical" | "warning" | "info";
  tenantId: string | null; tenantName: string | null;
  affectedExtension: string | null; affectedUser: string | null;
  firstSeen: string; lastSeen: string;
  status: "active" | "recovering" | "resolved";
  healingStatus: "none" | "attempted" | "succeeded" | "failed";
  likelyCause: string; suggestedAction: string;
  callCount: number; category: string;
};

type HourlyBucket = { hour: string; total: number; failed: number; missed: number };
type IceHour = { hour: string; count: number };

type OpsData = {
  timestamp: string;
  globalHealth: GlobalHealth;
  incidents: OpsIncident[];
  aiSummary: { whatHappening: string; whoAffected: string; likelyCause: string; recommendation: string; generatedAt: string };
  callAnalytics: {
    activeCalls: number; totalToday: number; answeredToday: number; failedToday: number; missedToday: number;
    avgDurationSec: number; failureRate: number;
    byDirection: { inbound: number; outbound: number; internal: number; unknown: number };
    hourlyBuckets: HourlyBucket[];
  };
  mediaAnalytics: {
    iceFailures24h: number; relayCount: number; directCount: number; poorQuality: number;
    gradeCounts: { excellent: number; good: number; fair: number; poor: number };
    icePerHour: IceHour[]; avgRttMs: number | null; avgJitterMs: number | null; totalReports: number;
  };
  pbxSignaling: {
    amiConnected: boolean; ariConnected: boolean; activeExtensions: number; activeQueues: number;
    activeCalls: number; uptimeSec: number; lastAmiEventAt: string | null; lastAmiError: string | null;
  };
  tenantHealth: Array<{
    tenantId: string; tenantName: string; status: "good" | "warning" | "critical";
    activeCalls: number; failedCalls: number; missedCalls: number; totalCalls: number;
    audioIssues: number; lastIncident: string | null;
  }>;
  timeline: Array<{
    id: string; eventType: string; description: string;
    tenantName: string | null; timestamp: string; severity: "critical" | "warning" | "info";
    automated: boolean;
  }>;
  healingLog: Array<{
    id: string; type: string; status: string; plainEnglish: string; description: string;
    triggeredAt: string; resolvedAt: string | null; automated: boolean;
  }>;
  security: { turnMissing: boolean; iceFailures24h: number; note: string };
  meta: { totalTenants: number; dbOk: boolean; telephonyReachable: boolean };
};

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN TOKENS
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  bg: "#07111f",
  surface: "#0f1c2e",
  card: "#121f33",
  border: "#1e3352",
  borderLight: "#253d5e",
  text: "#e2e8f0",
  textMuted: "#64748b",
  textDim: "#334155",
  ok: "#22c55e",
  okBg: "#052e1633",
  okBorder: "#16653444",
  warn: "#f59e0b",
  warnBg: "#45200544",
  warnBorder: "#78350f55",
  crit: "#ef4444",
  critBg: "#45050544",
  critBorder: "#7f1d1d55",
  info: "#60a5fa",
  infoBg: "#0f2a4f44",
  infoBorder: "#1e40af44",
  blue: "#3b82f6",
  purple: "#a78bfa",
  teal: "#14b8a6",
  orange: "#fb923c",
};

function statusColor(s: Hstatus): string {
  if (s === "ok") return C.ok;
  if (s === "degraded" || s === "warning") return C.warn;
  if (s === "down" || s === "critical" || s === "missing") return C.crit;
  return "#94a3b8"; // unknown
}

function statusBg(s: Hstatus): string {
  if (s === "ok") return C.okBg;
  if (s === "degraded" || s === "warning") return C.warnBg;
  if (s === "down" || s === "critical" || s === "missing") return C.critBg;
  return "#1e293b44";
}

function severityColor(s: "critical" | "warning" | "info"): string {
  return s === "critical" ? C.crit : s === "warning" ? C.warn : C.info;
}

function fmtAgo(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return "just now";
    if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
    return new Date(iso).toLocaleDateString();
  } catch { return iso; }
}

function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

// ─────────────────────────────────────────────────────────────────────────────
// REUSABLE PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 800, color: C.textMuted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 12 }}>
      {children}
    </div>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px 20px", ...style }}>
      {children}
    </div>
  );
}

function StatNumber({ value, label, color, sub }: { value: string | number; label: string; color?: string; sub?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 800, color: color ?? C.text, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.textMuted }}>{sub}</div>}
    </div>
  );
}

function Pill({ status, label, detail, onClick }: { status: Hstatus; label: string; detail?: string | null; onClick?: () => void }) {
  const col = statusColor(status);
  const bg = statusBg(status);
  return (
    <button
      onClick={onClick}
      title={detail ?? undefined}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "5px 12px", borderRadius: 20,
        background: bg, border: `1px solid ${col}33`,
        cursor: onClick ? "pointer" : "default",
        transition: "all 0.15s",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: col, boxShadow: `0 0 6px ${col}88`, flexShrink: 0, display: "block" }} />
      <span style={{ fontSize: 11, fontWeight: 700, color: col }}>{label}</span>
      {status !== "ok" && detail && (
        <span style={{ fontSize: 9, color: col, opacity: 0.75 }}>!</span>
      )}
    </button>
  );
}

// SVG Sparkline
function Sparkline({ data, color, width = 140, height = 40 }: { data: number[]; color: string; width?: number; height?: number }) {
  if (!data || data.length < 2) return <div style={{ width, height, background: C.surface, borderRadius: 4 }} />;
  const max = Math.max(...data, 1);
  const step = width / (data.length - 1);
  const pts = data.map((v, i) => `${i * step},${height - (v / max) * (height - 4) - 2}`).join(" ");
  const fillPts = `0,${height} ` + pts + ` ${width},${height}`;
  return (
    <svg width={width} height={height} style={{ overflow: "visible", display: "block" }}>
      <defs>
        <linearGradient id={`grad-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon points={fillPts} fill={`url(#grad-${color.replace("#", "")})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {/* Last value dot */}
      <circle cx={(data.length - 1) * step} cy={height - (data[data.length - 1] / max) * (height - 4) - 2} r={2.5} fill={color} />
    </svg>
  );
}

// Mini bar
function MiniBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div style={{ height: 6, background: C.surface, borderRadius: 3, overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${Math.min(pct, 100)}%`, background: color, borderRadius: 3, transition: "width 0.4s" }} />
    </div>
  );
}

// Status dot
function Dot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: ok ? C.ok : C.crit, display: "block", flexShrink: 0, boxShadow: `0 0 5px ${ok ? C.ok : C.crit}66` }} />
      <span style={{ fontSize: 12, color: ok ? C.ok : C.crit, fontWeight: 600 }}>{label}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — GLOBAL HEALTH STRIP
// ─────────────────────────────────────────────────────────────────────────────

function GlobalHealthStrip({ health }: { health: GlobalHealth }) {
  const pills = [
    { key: "api", ...health.api },
    { key: "database", ...health.database },
    { key: "pbx", ...health.pbx },
    { key: "ami", ...health.ami },
    { key: "ari", ...health.ari },
    { key: "sbc", ...health.sbc },
    { key: "turn", ...health.turn },
    { key: "workers", ...health.workers },
    { key: "webrtc", ...health.webrtc },
  ] as Array<{ key: string; status: Hstatus; label: string; lastIncident: string | null }>;

  const allOk = pills.every((p) => p.status === "ok");

  return (
    <div style={{
      background: allOk ? "#051a0e" : "#110a05",
      borderBottom: `1px solid ${allOk ? "#0f3320" : "#2a1206"}`,
      padding: "8px 24px",
      display: "flex",
      alignItems: "center",
      gap: 6,
      flexWrap: "wrap",
      overflowX: "auto",
    }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, marginRight: 6, whiteSpace: "nowrap", letterSpacing: "0.08em" }}>
        SYSTEM STATUS
      </span>
      {pills.map((p) => (
        <Pill key={p.key} status={p.status} label={p.label} detail={p.lastIncident} />
      ))}
      <div style={{ marginLeft: "auto", fontSize: 10, color: C.textDim, whiteSpace: "nowrap" }}>
        {allOk ? "✓ All systems operational" : "⚠ Issues detected"}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2a — LIVE INCIDENTS
// ─────────────────────────────────────────────────────────────────────────────

const HEALING_BADGE: Record<string, { label: string; color: string }> = {
  succeeded: { label: "AUTO-FIXED", color: C.ok },
  attempted: { label: "HEALING…", color: C.blue },
  failed: { label: "HEAL FAILED", color: C.crit },
  none: { label: "MANUAL", color: C.textMuted },
};

function IncidentCard({ incident }: { incident: OpsIncident }) {
  const [open, setOpen] = useState(false);
  const col = severityColor(incident.severity);
  const statusColors = { active: C.crit, recovering: C.warn, resolved: C.ok };
  const hb = HEALING_BADGE[incident.healingStatus] ?? HEALING_BADGE.none;

  return (
    <div
      style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderLeft: `3px solid ${col}`,
        borderRadius: 10,
        marginBottom: 8,
        overflow: "hidden",
        cursor: "pointer",
        transition: "border-color 0.15s",
      }}
      onClick={() => setOpen((v) => !v)}
    >
      <div style={{ padding: "12px 16px", display: "flex", alignItems: "flex-start", gap: 12 }}>
        {/* Severity dot */}
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: col, boxShadow: `0 0 8px ${col}66`, flexShrink: 0, marginTop: 4 }} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{incident.title}</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: col, background: col + "22", padding: "2px 7px", borderRadius: 4 }}>
              {incident.severity.toUpperCase()}
            </span>
            <span style={{ fontSize: 10, fontWeight: 700, color: statusColors[incident.status], background: statusColors[incident.status] + "22", padding: "2px 7px", borderRadius: 4 }}>
              {incident.status.toUpperCase()}
            </span>
            <span style={{ fontSize: 10, fontWeight: 700, color: hb.color, background: hb.color + "18", padding: "2px 7px", borderRadius: 4 }}>
              {hb.label}
            </span>
          </div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {incident.tenantName && (
              <span style={{ fontSize: 11, color: C.textMuted }}>🏢 {incident.tenantName}</span>
            )}
            {incident.callCount > 0 && (
              <span style={{ fontSize: 11, color: C.textMuted }}>📞 {incident.callCount} call{incident.callCount !== 1 ? "s" : ""}</span>
            )}
            <span style={{ fontSize: 11, color: C.textMuted }}>⏱ {fmtAgo(incident.lastSeen)}</span>
          </div>
        </div>
        <span style={{ color: C.textMuted, fontSize: 14, flexShrink: 0 }}>{open ? "▲" : "▼"}</span>
      </div>

      {open && (
        <div style={{ borderTop: `1px solid ${C.border}`, padding: "12px 16px 14px 36px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ background: C.bg, borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>Likely Cause</div>
            <div style={{ fontSize: 13, color: C.text, lineHeight: 1.5 }}>{incident.likelyCause}</div>
          </div>
          <div style={{ background: C.bg, border: `1px solid ${C.ok}33`, borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>What to Do</div>
            <div style={{ fontSize: 13, color: C.ok, lineHeight: 1.5 }}>{incident.suggestedAction}</div>
          </div>
          {incident.category === "audio" && (
            <a href="/admin/audio-intelligence" style={{ fontSize: 12, color: C.blue, textDecoration: "none" }}>
              → Open Audio Intelligence
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function LiveIncidentsPanel({ incidents }: { incidents: OpsIncident[] }) {
  const active = incidents.filter((i) => i.status !== "resolved");
  const resolved = incidents.filter((i) => i.status === "resolved");

  return (
    <Card style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <SectionLabel>Live Incidents</SectionLabel>
      <div style={{ flex: 1, overflowY: "auto", maxHeight: 440 }}>
        {incidents.length === 0 ? (
          <div style={{ textAlign: "center", padding: "32px 0" }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>✅</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.ok }}>No active incidents</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>All systems nominal</div>
          </div>
        ) : (
          <>
            {active.map((i) => <IncidentCard key={i.id} incident={i} />)}
            {resolved.length > 0 && (
              <>
                <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", margin: "12px 0 8px" }}>
                  Recently Resolved
                </div>
                {resolved.map((i) => <IncidentCard key={i.id} incident={i} />)}
              </>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2b — AI OPERATOR SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

function AiSummaryCard({ summary, incidents }: { summary: OpsData["aiSummary"]; incidents: OpsIncident[] }) {
  const critCount = incidents.filter((i) => i.severity === "critical").length;
  const warnCount = incidents.filter((i) => i.severity === "warning").length;
  const headerColor = critCount > 0 ? C.crit : warnCount > 0 ? C.warn : C.ok;
  const headerText = critCount > 0 ? "Critical Issues Detected" : warnCount > 0 ? "Warnings Active" : "All Clear";

  return (
    <Card style={{
      background: `linear-gradient(135deg, ${C.card} 0%, #0a1628 100%)`,
      border: `1px solid ${headerColor}33`,
      height: "100%",
      display: "flex",
      flexDirection: "column",
      gap: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <span style={{ fontSize: 22 }}>🤖</span>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.1em" }}>AI Operator Summary</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: headerColor }}>{headerText}</div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, flex: 1 }}>
        {[
          { label: "What's Happening", icon: "🔍", value: summary.whatHappening, color: C.text },
          { label: "Who Is Affected", icon: "👥", value: summary.whoAffected, color: C.text },
          { label: "Most Likely Cause", icon: "⚠️", value: summary.likelyCause, color: C.warn },
          { label: "Recommended Action", icon: "✅", value: summary.recommendation, color: C.ok },
        ].map(({ label, icon, value, color }) => (
          <div key={label} style={{ background: C.bg, borderRadius: 8, padding: "12px 14px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>
              {icon} {label}
            </div>
            <div style={{ fontSize: 13, color, lineHeight: 1.6 }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 10, color: C.textDim, marginTop: 12 }}>
        Generated from live data · {fmtAgo(summary.generatedAt)}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3a — CALL ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────

function CallAnalyticsPanel({ ca }: { ca: OpsData["callAnalytics"] }) {
  const totalSparkline = ca.hourlyBuckets.map((b) => b.total);
  const failedSparkline = ca.hourlyBuckets.map((b) => b.failed);
  const missedSparkline = ca.hourlyBuckets.map((b) => b.missed);
  const totalMax = Math.max(...ca.byDirection.inbound ? Object.values(ca.byDirection) : [1]);

  return (
    <Card>
      <SectionLabel>Call Analytics — Last 24h</SectionLabel>
      {/* Big stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
        <div style={{ background: C.bg, borderRadius: 8, padding: "12px 14px" }}>
          <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", marginBottom: 4 }}>Active Now</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: C.blue }}>{ca.activeCalls}</div>
        </div>
        <div style={{ background: C.bg, borderRadius: 8, padding: "12px 14px" }}>
          <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", marginBottom: 4 }}>Total Today</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: C.text }}>{ca.totalToday}</div>
        </div>
        <div style={{ background: C.bg, borderRadius: 8, padding: "12px 14px" }}>
          <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", marginBottom: 4 }}>Failed</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: ca.failedToday > 0 ? C.crit : C.text }}>{ca.failedToday}</div>
          {ca.failureRate > 0 && <div style={{ fontSize: 10, color: C.crit }}>{ca.failureRate}% rate</div>}
        </div>
        <div style={{ background: C.bg, borderRadius: 8, padding: "12px 14px" }}>
          <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", marginBottom: 4 }}>Missed</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: ca.missedToday > 0 ? C.warn : C.text }}>{ca.missedToday}</div>
        </div>
      </div>

      {/* Sparklines */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
        {[
          { label: "Calls/hr", data: totalSparkline, color: C.blue },
          { label: "Failures/hr", data: failedSparkline, color: C.crit },
          { label: "Missed/hr", data: missedSparkline, color: C.warn },
        ].map(({ label, data, color }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 11, color: C.textMuted, width: 72, flexShrink: 0 }}>{label}</span>
            <div style={{ flex: 1 }}>
              <Sparkline data={data} color={color} width={220} height={32} />
            </div>
            <span style={{ fontSize: 11, color, fontWeight: 700, width: 30, textAlign: "right" }}>
              {Math.max(...data)}
            </span>
          </div>
        ))}
      </div>

      {/* Direction breakdown */}
      <div>
        <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", marginBottom: 8 }}>Direction Mix</div>
        {([["Inbound", ca.byDirection.inbound, C.ok], ["Outbound", ca.byDirection.outbound, C.blue], ["Internal", ca.byDirection.internal, C.purple]] as [string, number, string][]).map(([label, count, color]) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 11, color: C.textMuted, width: 58, flexShrink: 0 }}>{label}</span>
            <div style={{ flex: 1 }}><MiniBar pct={ca.totalToday > 0 ? (count / ca.totalToday) * 100 : 0} color={color} /></div>
            <span style={{ fontSize: 11, color, fontWeight: 700, width: 32, textAlign: "right" }}>{count}</span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 12, fontSize: 11, color: C.textMuted }}>
        Avg talk time: {ca.avgDurationSec > 0 ? `${Math.floor(ca.avgDurationSec / 60)}m ${ca.avgDurationSec % 60}s` : "—"}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3b — MEDIA / WEBRTC ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────

function MediaAnalyticsPanel({ ma }: { ma: OpsData["mediaAnalytics"] }) {
  const iceSparkline = ma.icePerHour.map((b) => b.count);
  const totalRelay = ma.relayCount + ma.directCount;
  const relayPct = totalRelay > 0 ? Math.round((ma.relayCount / totalRelay) * 100) : 0;
  const totalGrades = Object.values(ma.gradeCounts).reduce((s, v) => s + v, 0);

  return (
    <Card>
      <SectionLabel>Media / WebRTC Analytics — Last 24h</SectionLabel>

      {/* Big stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
        <div style={{ background: C.bg, borderRadius: 8, padding: "12px 14px" }}>
          <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", marginBottom: 4 }}>ICE Failures</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: ma.iceFailures24h > 0 ? C.crit : C.text }}>{ma.iceFailures24h}</div>
        </div>
        <div style={{ background: C.bg, borderRadius: 8, padding: "12px 14px" }}>
          <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", marginBottom: 4 }}>Poor Quality</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: ma.poorQuality > 0 ? C.warn : C.text }}>{ma.poorQuality}</div>
        </div>
        <div style={{ background: C.bg, borderRadius: 8, padding: "12px 14px" }}>
          <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", marginBottom: 4 }}>Reports</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: C.text }}>{ma.totalReports}</div>
        </div>
      </div>

      {/* ICE failures sparkline */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: C.textMuted }}>ICE Failures / hr</span>
          <span style={{ fontSize: 11, color: C.crit, fontWeight: 700 }}>{ma.iceFailures24h} total</span>
        </div>
        <Sparkline data={iceSparkline} color={C.crit} width={280} height={36} />
      </div>

      {/* Relay vs Direct */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", marginBottom: 8 }}>Relay vs Direct</div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            {[["TURN Relay", ma.relayCount, C.warn], ["Direct", ma.directCount, C.ok]] .map(([label, count, color]) => (
              <div key={String(label)} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: C.textMuted, width: 72, flexShrink: 0 }}>{label}</span>
                <div style={{ flex: 1 }}><MiniBar pct={totalRelay > 0 ? (Number(count) / totalRelay) * 100 : 0} color={String(color)} /></div>
                <span style={{ fontSize: 11, color: String(color), fontWeight: 700 }}>{count}</span>
              </div>
            ))}
          </div>
          <div style={{ textAlign: "center", minWidth: 56 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: relayPct > 50 ? C.warn : C.ok }}>{relayPct}%</div>
            <div style={{ fontSize: 9, color: C.textMuted }}>relay rate</div>
          </div>
        </div>
      </div>

      {/* Quality distribution */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", marginBottom: 8 }}>Quality Distribution</div>
        {([["Excellent", ma.gradeCounts.excellent, "#22c55e"], ["Good", ma.gradeCounts.good, "#84cc16"], ["Fair", ma.gradeCounts.fair, C.warn], ["Poor", ma.gradeCounts.poor, C.crit]] as [string, number, string][]).map(([g, n, col]) => (
          <div key={g} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
            <span style={{ fontSize: 11, color: C.textMuted, width: 58, flexShrink: 0 }}>{g}</span>
            <div style={{ flex: 1 }}><MiniBar pct={totalGrades > 0 ? (n / totalGrades) * 100 : 0} color={col} /></div>
            <span style={{ fontSize: 11, color: col, fontWeight: 700, width: 24, textAlign: "right" }}>{n}</span>
          </div>
        ))}
      </div>

      {/* RTT / Jitter */}
      <div style={{ display: "flex", gap: 12 }}>
        {ma.avgRttMs != null && (
          <div style={{ background: C.bg, borderRadius: 7, padding: "8px 12px", flex: 1 }}>
            <div style={{ fontSize: 9, color: C.textMuted, textTransform: "uppercase" }}>Avg RTT</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: ma.avgRttMs > 200 ? C.warn : C.ok }}>{ma.avgRttMs}ms</div>
          </div>
        )}
        {ma.avgJitterMs != null && (
          <div style={{ background: C.bg, borderRadius: 7, padding: "8px 12px", flex: 1 }}>
            <div style={{ fontSize: 9, color: C.textMuted, textTransform: "uppercase" }}>Avg Jitter</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: ma.avgJitterMs > 30 ? C.warn : C.ok }}>{ma.avgJitterMs}ms</div>
          </div>
        )}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4a — PBX / SIGNALING
// ─────────────────────────────────────────────────────────────────────────────

function PbxSignalingPanel({ pbx }: { pbx: OpsData["pbxSignaling"] }) {
  return (
    <Card>
      <SectionLabel>PBX / Signaling</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Dot ok={pbx.amiConnected} label={pbx.amiConnected ? "AMI Connected" : "AMI Disconnected"} />
        <Dot ok={pbx.ariConnected} label={pbx.ariConnected ? "ARI Connected" : "ARI Unreachable"} />

        {pbx.lastAmiError && (
          <div style={{ fontSize: 11, color: C.crit, background: C.critBg, border: `1px solid ${C.critBorder}`, borderRadius: 6, padding: "6px 10px" }}>
            Last Error: {pbx.lastAmiError}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, marginTop: 8 }}>
          {[
            { label: "Active Calls", value: pbx.activeCalls, color: C.blue },
            { label: "Extensions", value: pbx.activeExtensions, color: C.text },
            { label: "Queues", value: pbx.activeQueues, color: C.text },
            { label: "Uptime", value: fmtUptime(pbx.uptimeSec), color: C.ok },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ background: C.bg, borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: 20, fontWeight: 800, color }}>{value}</div>
            </div>
          ))}
        </div>

        {pbx.lastAmiEventAt && (
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
            Last AMI event: {fmtAgo(pbx.lastAmiEventAt)}
          </div>
        )}

        <div style={{ marginTop: 8 }}>
          <a href="/admin/pbx" style={{ fontSize: 12, color: C.blue, textDecoration: "none" }}>→ PBX Console</a>
        </div>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4b — SECURITY / ABUSE
// ─────────────────────────────────────────────────────────────────────────────

function SecurityPanel({ security, health }: { security: OpsData["security"]; health: GlobalHealth }) {
  const items = [
    { label: "TURN Relay", ok: !security.turnMissing, detail: security.turnMissing ? "No TURN server configured" : "TURN relay active" },
    { label: "WebRTC Health", ok: health.webrtc.status === "ok", detail: health.webrtc.lastIncident ?? "No issues" },
    { label: "ICE Failures (24h)", ok: security.iceFailures24h === 0, detail: `${security.iceFailures24h} failure${security.iceFailures24h !== 1 ? "s" : ""}` },
  ];

  return (
    <Card>
      <SectionLabel>Security / Abuse</SectionLabel>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
        {items.map(({ label, ok, detail }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: C.bg, borderRadius: 8, padding: "10px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: ok ? C.ok : C.warn, display: "block", flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: C.text }}>{label}</span>
            </div>
            <span style={{ fontSize: 11, color: ok ? C.ok : C.warn }}>{detail}</span>
          </div>
        ))}
      </div>

      <div style={{
        background: C.infoBg, border: `1px solid ${C.infoBorder}`,
        borderRadius: 8, padding: "10px 14px",
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.info, marginBottom: 6 }}>
          📊 Full Security Metrics
        </div>
        <div style={{ fontSize: 12, color: C.text, marginBottom: 8 }}>
          Login failures, rate limit hits, provisioning abuse, and suspicious extension behavior are available in the Grafana Security dashboard.
        </div>
        <a
          href="http://45.14.194.179:3010/d/security-abuse"
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 12, color: C.blue }}
        >
          → Open Security Dashboard
        </a>
      </div>

      {security.iceFailures24h > 0 && (
        <div style={{ marginTop: 12, background: C.critBg, border: `1px solid ${C.critBorder}`, borderRadius: 8, padding: "10px 14px" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.crit, marginBottom: 4 }}>
            Audio Security Risk
          </div>
          <div style={{ fontSize: 12, color: C.text }}>
            {security.iceFailures24h} ICE failures may indicate firewall blocking or attempted media path manipulation.
          </div>
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — TENANT HEALTH TABLE
// ─────────────────────────────────────────────────────────────────────────────

function TenantHealthTable({ tenants }: { tenants: OpsData["tenantHealth"] }) {
  const statusConfig = {
    good: { color: C.ok, bg: C.okBg, label: "GOOD" },
    warning: { color: C.warn, bg: C.warnBg, label: "WARN" },
    critical: { color: C.crit, bg: C.critBg, label: "CRIT" },
  };

  if (tenants.length === 0) {
    return (
      <Card>
        <SectionLabel>Tenant Health</SectionLabel>
        <div style={{ textAlign: "center", padding: "24px 0", color: C.textMuted, fontSize: 13 }}>
          No tenant data in the last 24 hours.
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <SectionLabel>Tenant Health — Last 24h</SectionLabel>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              {["Tenant", "Status", "Total Calls", "Failed", "Missed", "Audio Issues", "Last Issue"].map((h) => (
                <th key={h} style={{ textAlign: "left", padding: "8px 12px", fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: `1px solid ${C.border}`, fontWeight: 700 }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tenants.map((t, i) => {
              const sc = statusConfig[t.status];
              return (
                <tr
                  key={t.tenantId}
                  style={{ background: i % 2 === 0 ? "transparent" : C.surface + "44", cursor: "pointer" }}
                  onClick={() => {/* TODO: tenant drill-down */}}
                >
                  <td style={{ padding: "10px 12px", color: C.text, fontWeight: 600 }}>{t.tenantName}</td>
                  <td style={{ padding: "10px 12px" }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: sc.color, background: sc.bg, padding: "3px 8px", borderRadius: 4 }}>
                      {sc.label}
                    </span>
                  </td>
                  <td style={{ padding: "10px 12px", color: C.text }}>{t.totalCalls}</td>
                  <td style={{ padding: "10px 12px", color: t.failedCalls > 0 ? C.crit : C.textMuted }}>{t.failedCalls}</td>
                  <td style={{ padding: "10px 12px", color: t.missedCalls > 2 ? C.warn : C.textMuted }}>{t.missedCalls}</td>
                  <td style={{ padding: "10px 12px", color: t.audioIssues > 0 ? C.warn : C.textMuted }}>{t.audioIssues}</td>
                  <td style={{ padding: "10px 12px", color: C.textMuted }}>{t.lastIncident ? fmtAgo(t.lastIncident) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — INCIDENT TIMELINE
// ─────────────────────────────────────────────────────────────────────────────

const TIMELINE_ICONS: Record<string, string> = {
  call_failed: "📞",
  ice_failure: "🔴",
  healing_succeeded: "✅",
  healing_attempted: "🔄",
  healing_failed: "❌",
  healing_rate_limited: "⏸",
  zombie_call_evicted: "🧟",
  ami_reconnect_detected: "🔌",
  ari_reconnect_detected: "🔌",
  pbx_degraded_detected: "⚠️",
  high_failure_rate_detected: "📈",
};

function IncidentTimeline({ events }: { events: OpsData["timeline"] }) {
  return (
    <Card>
      <SectionLabel>Incident Timeline</SectionLabel>
      {events.length === 0 ? (
        <div style={{ textAlign: "center", padding: "24px 0", color: C.textMuted, fontSize: 13 }}>
          No events in the last 24 hours.
        </div>
      ) : (
        <div style={{ position: "relative", paddingLeft: 24, maxHeight: 360, overflowY: "auto" }}>
          {/* Vertical line */}
          <div style={{ position: "absolute", left: 9, top: 0, bottom: 0, width: 2, background: C.border }} />

          {events.map((ev, i) => {
            const col = severityColor(ev.severity);
            const icon = TIMELINE_ICONS[ev.eventType] ?? (ev.automated ? "⚡" : "•");
            return (
              <div key={ev.id} style={{ position: "relative", marginBottom: 14 }}>
                {/* Dot on timeline */}
                <div style={{
                  position: "absolute", left: -20, top: 2,
                  width: 10, height: 10, borderRadius: "50%",
                  background: col, border: `2px solid ${C.card}`,
                  boxShadow: `0 0 6px ${col}55`,
                }} />
                <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <span style={{ fontSize: 14, flexShrink: 0 }}>{icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: C.text, lineHeight: 1.4 }}>{ev.description}</div>
                    <div style={{ display: "flex", gap: 10, marginTop: 3, flexWrap: "wrap" }}>
                      {ev.tenantName && <span style={{ fontSize: 10, color: C.textMuted }}>{ev.tenantName}</span>}
                      {ev.automated && <span style={{ fontSize: 10, color: C.info }}>⚡ auto</span>}
                      <span style={{ fontSize: 10, color: C.textDim }}>{fmtAgo(ev.timestamp)}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — EXPLORER
// ─────────────────────────────────────────────────────────────────────────────

function ExplorerPanel() {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"call" | "session">("session");

  function handleSearch() {
    if (!query.trim()) return;
    if (type === "session") {
      window.open(`/admin/call-timeline?q=${encodeURIComponent(query.trim())}`, "_blank");
    } else {
      window.open(`/calls?q=${encodeURIComponent(query.trim())}`, "_blank");
    }
  }

  return (
    <Card>
      <SectionLabel>Explorer — Search Calls & Diagnostics</SectionLabel>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ display: "flex", gap: 2, background: C.surface, borderRadius: 8, padding: 2 }}>
          {(["session", "call"] as const).map((t) => (
            <button key={t} onClick={() => setType(t)} style={{ padding: "6px 14px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: type === t ? C.blue : "transparent", color: type === t ? "#fff" : C.textMuted, transition: "all 0.15s" }}>
              {t === "session" ? "Session / User" : "Call History"}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, minWidth: 240, display: "flex", gap: 8 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder={type === "session" ? "Email, session ID, user ID…" : "Phone number, tenant, linkedId…"}
            style={{
              flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
              color: C.text, padding: "9px 14px", fontSize: 13, outline: "none",
            }}
          />
          <button
            onClick={handleSearch}
            style={{ padding: "9px 20px", background: C.blue, border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
          >
            Search
          </button>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <a href="/admin/audio-intelligence" style={{ fontSize: 12, color: C.blue, padding: "9px 14px", background: C.infoBg, border: `1px solid ${C.infoBorder}`, borderRadius: 8, textDecoration: "none" }}>
            Audio Intelligence →
          </a>
          <a href="/reports/cdr" style={{ fontSize: 12, color: C.textMuted, padding: "9px 14px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, textDecoration: "none" }}>
            CDR Reports →
          </a>
          <a href="/admin/call-timeline" style={{ fontSize: 12, color: C.textMuted, padding: "9px 14px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, textDecoration: "none" }}>
            Call Timeline →
          </a>
        </div>
      </div>
      <div style={{ marginTop: 10, fontSize: 11, color: C.textMuted }}>
        Session search: enter an email or session ID to see full WebRTC call timeline and ICE diagnostics.
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — SELF-HEALING ENGINE
// ─────────────────────────────────────────────────────────────────────────────

const HEAL_STATUS: Record<string, { color: string; label: string; bg: string }> = {
  succeeded: { color: C.ok, label: "FIXED", bg: C.okBg },
  attempted: { color: C.blue, label: "IN PROGRESS", bg: C.infoBg },
  failed: { color: C.crit, label: "FAILED", bg: C.critBg },
  rate_limited: { color: C.warn, label: "RATE LIMITED", bg: C.warnBg },
  skipped: { color: C.textMuted, label: "SKIPPED", bg: C.surface },
};

function HealingEnginePanel({ log }: { log: OpsData["healingLog"] }) {
  const succeeded = log.filter((a) => a.status === "succeeded").length;
  const failed = log.filter((a) => a.status === "failed").length;
  const active = log.filter((a) => a.status === "attempted").length;

  return (
    <Card>
      <SectionLabel>Self-Healing Engine — Last 24h</SectionLabel>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 16 }}>
        {[["Auto-Fixed", succeeded, C.ok], ["Active", active, C.blue], ["Failed", failed, C.crit]].map(([label, val, col]) => (
          <div key={String(label)} style={{ background: C.bg, borderRadius: 8, padding: "10px 14px", textAlign: "center" }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: String(col) }}>{val}</div>
            <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase" }}>{label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 280, overflowY: "auto" }}>
        {log.length === 0 ? (
          <div style={{ textAlign: "center", padding: "16px 0", color: C.textMuted, fontSize: 13 }}>
            No healing actions in the last 24 hours. System is stable.
          </div>
        ) : (
          log.slice(0, 12).map((action) => {
            const hs = HEAL_STATUS[action.status] ?? HEAL_STATUS.skipped;
            return (
              <div key={action.id} style={{ background: C.bg, border: `1px solid ${C.border}`, borderLeft: `3px solid ${hs.color}`, borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "flex-start", gap: 10 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: hs.color, background: hs.bg, padding: "2px 7px", borderRadius: 4, whiteSpace: "nowrap", flexShrink: 0, marginTop: 1 }}>
                  {hs.label}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: C.text, lineHeight: 1.4 }}>{action.plainEnglish}</div>
                  <div style={{ fontSize: 10, color: C.textDim, marginTop: 3 }}>{fmtAgo(action.triggeredAt)}</div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div style={{ marginTop: 12, fontSize: 11, color: C.textMuted, lineHeight: 1.5 }}>
        Rules active: zombie call eviction · AMI/ARI reconnect monitoring · call failure rate detection · ICE restart (client-side, max 2 attempts/call)
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────────────────────────

export default function OpsCenterPage() {
  const [data, setData] = useState<OpsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const resp = await apiGet<OpsData>("/admin/ops-center");
      setData(resp);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load ops data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    timerRef.current = setInterval(() => load(true), 30_000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [load]);

  const pageStyle: React.CSSProperties = {
    minHeight: "100vh",
    background: C.bg,
    color: C.text,
    fontFamily: "'Inter', system-ui, sans-serif",
  };

  if (loading && !data) {
    return (
      <PermissionGate permission="can_manage_global_settings">
        <div style={{ ...pageStyle, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⚡</div>
            <div style={{ fontSize: 15, color: C.textMuted }}>Loading Ops Center…</div>
          </div>
        </div>
      </PermissionGate>
    );
  }

  if (error && !data) {
    return (
      <PermissionGate permission="can_manage_global_settings">
        <div style={{ ...pageStyle, padding: "40px 32px" }}>
          <div style={{ background: C.critBg, border: `1px solid ${C.critBorder}`, borderRadius: 10, padding: "20px 24px", maxWidth: 600 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.crit, marginBottom: 8 }}>Failed to load Ops Center</div>
            <div style={{ fontSize: 13, color: C.text, marginBottom: 16 }}>{error}</div>
            <button onClick={() => load()} style={{ padding: "8px 18px", background: C.blue, border: "none", borderRadius: 8, color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 700 }}>
              Retry
            </button>
          </div>
        </div>
      </PermissionGate>
    );
  }

  if (!data) return null;

  const critCount = data.incidents.filter((i) => i.severity === "critical").length;
  const warnCount = data.incidents.filter((i) => i.severity === "warning").length;

  return (
    <PermissionGate permission="can_manage_global_settings">
      <div style={pageStyle}>
        {/* ── Section 0: Page Header ── */}
        <div style={{ padding: "14px 24px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <span style={{ fontSize: 20 }}>⚡</span>
            <div>
              <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: C.text }}>Ops Center</h1>
              <div style={{ fontSize: 11, color: C.textMuted }}>Live system diagnostics · Auto-refreshes every 30s</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {critCount > 0 && (
              <span style={{ fontSize: 11, fontWeight: 700, color: C.crit, background: C.critBg, border: `1px solid ${C.critBorder}`, padding: "4px 10px", borderRadius: 6 }}>
                {critCount} CRITICAL
              </span>
            )}
            {warnCount > 0 && (
              <span style={{ fontSize: 11, fontWeight: 700, color: C.warn, background: C.warnBg, border: `1px solid ${C.warnBorder}`, padding: "4px 10px", borderRadius: 6 }}>
                {warnCount} WARNING
              </span>
            )}
            {lastUpdated && <span style={{ fontSize: 11, color: C.textMuted }}>Updated {lastUpdated}</span>}
            <button
              onClick={() => load(true)}
              disabled={refreshing}
              style={{ padding: "6px 14px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 7, color: C.textMuted, fontSize: 12, cursor: "pointer", opacity: refreshing ? 0.6 : 1 }}
            >
              {refreshing ? "…" : "↻ Refresh"}
            </button>
          </div>
        </div>

        {/* ── Section 1: Global Health Strip ── */}
        <GlobalHealthStrip health={data.globalHealth} />

        {/* Page content */}
        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 20 }}>

          {/* ── Section 2: Primary Focus Row ── */}
          <div style={{ display: "grid", gridTemplateColumns: "3fr 2fr", gap: 16 }}>
            <LiveIncidentsPanel incidents={data.incidents} />
            <AiSummaryCard summary={data.aiSummary} incidents={data.incidents} />
          </div>

          {/* ── Section 3: Core Analytics Row ── */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <CallAnalyticsPanel ca={data.callAnalytics} />
            <MediaAnalyticsPanel ma={data.mediaAnalytics} />
          </div>

          {/* ── Section 4: System + Security Row ── */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <PbxSignalingPanel pbx={data.pbxSignaling} />
            <SecurityPanel security={data.security} health={data.globalHealth} />
          </div>

          {/* ── Section 5: Tenant Health ── */}
          <TenantHealthTable tenants={data.tenantHealth} />

          {/* ── Section 6 + 9: Timeline + Healing ── */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <IncidentTimeline events={data.timeline} />
            <HealingEnginePanel log={data.healingLog} />
          </div>

          {/* ── Section 7: Explorer ── */}
          <ExplorerPanel />

          {/* ── Footer ── */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderTop: `1px solid ${C.border}`, marginTop: 4 }}>
            <div style={{ fontSize: 11, color: C.textDim }}>
              {data.meta.totalTenants} tenants · DB: {data.meta.dbOk ? "✓" : "✗"} · Telephony: {data.meta.telephonyReachable ? "✓" : "✗"} · {data.timestamp && new Date(data.timestamp).toLocaleString()}
            </div>
            <div style={{ display: "flex", gap: 16 }}>
              <a href="http://45.14.194.179:3010" target="_blank" rel="noreferrer" style={{ fontSize: 11, color: C.blue, textDecoration: "none" }}>Grafana →</a>
              <a href="http://45.14.194.179:9090" target="_blank" rel="noreferrer" style={{ fontSize: 11, color: C.textMuted, textDecoration: "none" }}>Prometheus →</a>
            </div>
          </div>
        </div>
      </div>
    </PermissionGate>
  );
}
