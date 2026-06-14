"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { useAppContext } from "../../../../hooks/useAppContext";
import { apiGet, apiPost } from "../../../../services/apiClient";

type HealthStatus = "ok" | "warning" | "critical" | "unknown";
type StorageRiskLevel = "low" | "medium" | "high" | "critical";
type ConsumerRiskLevel = "low" | "medium" | "high" | "critical";
type TrendDirection = "increasing" | "stable" | "decreasing";

type StorageDashboard = {
  totalDiskBytes: number | null;
  usedBytes: number | null;
  freeBytes: number | null;
  usedPct: number | null;
  buildCacheBytes: number | null;
  containerdBytes: number | null;
  containerdOverlayBytes: number | null;
  containerdContentBytes: number | null;
  reclaimableBytes: number;
  protectedDataBytes: number;
  riskLevel: StorageRiskLevel;
  projectedUsageAfterCleanupBytes: number | null;
  projectedRecoveryBytes: number;
  projectedFreeBytesAfterCleanup: number | null;
  largestConsumers: Array<{
    rank: number;
    path: string;
    label: string;
    sizeBytes: number | null;
    classification: string;
    risk: ConsumerRiskLevel;
    actionability: string;
    kind: string;
  }>;
  protectedAssets: Array<{
    id: string;
    label: string;
    category: string;
    pathOrRef: string;
    sizeBytes: number | null;
    status: string;
    detail: string;
  }>;
  distribution: Array<{ category: string; label: string; sizeBytes: number; pct: number }>;
  cleanupReadiness: Array<{
    category: string;
    sizeBytes: number;
    risk: ConsumerRiskLevel;
    status: string;
    classification: string;
  }>;
  operationsCenter?: OperationsCenter | null;
};

type OperationsCenter = {
  readinessScorePct: number;
  readinessLabel: string;
  readinessDetail: string;
  safetyGates: { blocked: boolean; reasons: string[] };
  snapshotStatus: { available: boolean; latestPath: string | null; latestTimestamp: string | null };
  buildCacheAnalysis: {
    totalEntries: number;
    totalBytes: number;
    referencedBytes: number;
    unusedBytes: number;
    unknownBytes: number;
    topEntries: Array<{ cacheId: string; sizeBytes: number; confidenceLabel: string; confidencePct: number }>;
  };
  dependencyGraph: {
    nodes: Array<{ service: string; containerName: string; image: string; state: string; protectedByRunningContainer: boolean }>;
    runningContainerCount: number;
    incomplete: boolean;
  };
  rollbackCoverage: Array<{ service: string; image: string; rollbackAvailable: boolean; classification: string }>;
  apkForensics: { totalBytes: number; latestReleases: Array<{ filename: string; sizeBytes: number }>; historicalReleases: Array<{ filename: string; sizeBytes: number }> };
  logForensics: { totalBytes: number; locations: Array<{ label: string; path: string; sizeBytes: number | null }> };
  confidenceDistribution: Array<{ label: string; count: number; sizeBytes: number; pct: number }>;
  riskMatrix: Array<{ category: string; risk: string; sizeBytes: number; confidenceLabel: string; blocked: boolean }>;
};

type StorageAlert = {
  code: string;
  severity: HealthStatus;
  message: string;
};

type StorageTrendPoint = {
  timestamp: string;
  scanId: string;
  diskUsedPct: number | null;
  usedBytes: number | null;
  freeBytes: number | null;
  totalBytes: number | null;
  reclaimEstimateBytes: number;
};

type StorageTrendSeries = {
  window: "24h" | "7d" | "30d";
  direction: TrendDirection;
  directionPctDelta: number | null;
  points: StorageTrendPoint[];
};

type StorageHealth = {
  timestamp: string;
  latestScan: { scanId: string; timestamp: string; hostname: string; durationMs: number } | null;
  previousScans: StorageTrendPoint[];
  trends: StorageTrendSeries[];
  alerts: StorageAlert[];
  dashboard: StorageDashboard | null;
  scanning?: boolean;
  scanError?: string | null;
  snapshotGenerating?: boolean;
  snapshotError?: string | null;
};

const SCAN_POLL_MS = 5000;
const SCAN_POLL_MAX_MS = 25 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ThemeTokens = {
  bg: string;
  surface: string;
  card: string;
  border: string;
  text: string;
  textMuted: string;
  textDim: string;
  ok: string;
  okBg: string;
  warn: string;
  warnBg: string;
  crit: string;
  critBg: string;
  info: string;
  blue: string;
  purple: string;
  glow: string;
};

const DARK: ThemeTokens = {
  bg: "#07111f",
  surface: "#0f1c2e",
  card: "#121f33",
  border: "#1e3352",
  text: "#e2e8f0",
  textMuted: "#64748b",
  textDim: "#475569",
  ok: "#22c55e",
  okBg: "#052e1633",
  warn: "#f59e0b",
  warnBg: "#45200544",
  crit: "#ef4444",
  critBg: "#45050544",
  info: "#60a5fa",
  blue: "#3b82f6",
  purple: "#a78bfa",
  glow: "0 0 24px rgba(59,130,246,0.15)",
};

const LIGHT: ThemeTokens = {
  bg: "#f1f5f9",
  surface: "#ffffff",
  card: "#ffffff",
  border: "#e2e8f0",
  text: "#0f172a",
  textMuted: "#64748b",
  textDim: "#94a3b8",
  ok: "#16a34a",
  okBg: "#dcfce7",
  warn: "#d97706",
  warnBg: "#fef3c7",
  crit: "#dc2626",
  critBg: "#fee2e2",
  info: "#2563eb",
  blue: "#2563eb",
  purple: "#7c3aed",
  glow: "0 4px 24px rgba(15,23,42,0.08)",
};

const DIST_COLORS = ["#3b82f6", "#8b5cf6", "#06b6d4", "#f59e0b", "#22c55e", "#ef4444", "#ec4899", "#64748b"];

function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function riskColor(C: ThemeTokens, risk: StorageRiskLevel | ConsumerRiskLevel): string {
  if (risk === "critical") return C.crit;
  if (risk === "high") return C.warn;
  if (risk === "medium") return C.info;
  return C.ok;
}

function severityColor(C: ThemeTokens, s: HealthStatus): string {
  if (s === "critical") return C.crit;
  if (s === "warning") return C.warn;
  if (s === "ok") return C.ok;
  return C.textMuted;
}

function severityBg(C: ThemeTokens, s: HealthStatus): string {
  if (s === "critical") return C.critBg;
  if (s === "warning") return C.warnBg;
  if (s === "ok") return C.okBg;
  return C.surface;
}

function shortClass(c: string): string {
  return c.replace("PROTECTED_NEVER_DELETE", "PROTECTED").replace("UNKNOWN_REQUIRES_REVIEW", "REVIEW").replace("SAFE_CANDIDATE", "SAFE").replace("ROLLBACK_CANDIDATE", "ROLLBACK").replace("ACTIVE_REQUIRED", "ACTIVE");
}

function KpiCard({
  C,
  label,
  value,
  sub,
  accent,
  pct,
}: {
  C: ThemeTokens;
  label: string;
  value: string;
  sub?: string;
  accent?: string;
  pct?: number;
}) {
  const color = accent ?? C.blue;
  return (
    <div
      style={{
        background: `linear-gradient(145deg, ${C.card} 0%, ${C.surface} 100%)`,
        border: `1px solid ${C.border}`,
        borderRadius: 14,
        padding: "18px 20px",
        boxShadow: C.glow,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          width: 80,
          height: 80,
          background: `radial-gradient(circle at top right, ${color}22, transparent 70%)`,
          pointerEvents: "none",
        }}
      />
      <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, marginTop: 8, color: C.text, lineHeight: 1.1 }}>{value}</div>
      {sub ? <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6 }}>{sub}</div> : null}
      {pct != null ? (
        <div style={{ height: 6, background: "rgba(148,163,184,0.2)", borderRadius: 99, marginTop: 12, overflow: "hidden" }}>
          <div style={{ width: `${Math.min(100, pct)}%`, height: "100%", background: color, borderRadius: 99 }} />
        </div>
      ) : null}
    </div>
  );
}

function DistributionChart({ C, slices }: { C: ThemeTokens; slices: StorageDashboard["distribution"] }) {
  const total = slices.reduce((s, x) => s + x.sizeBytes, 0) || 1;
  let offset = 0;
  const stops = slices.map((slice, i) => {
    const pct = (slice.sizeBytes / total) * 100;
    const start = offset;
    offset += pct;
    return `${DIST_COLORS[i % DIST_COLORS.length]} ${start}% ${offset}%`;
  });

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "center" }}>
      <div
        style={{
          width: 140,
          height: 140,
          borderRadius: "50%",
          background: slices.length ? `conic-gradient(${stops.join(", ")})` : C.border,
          flexShrink: 0,
          boxShadow: C.glow,
        }}
      />
      <div style={{ flex: 1, minWidth: 200, display: "grid", gap: 8 }}>
        {slices.map((slice, i) => (
          <div key={slice.category} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: DIST_COLORS[i % DIST_COLORS.length], flexShrink: 0 }} />
            <div style={{ flex: 1, fontWeight: 600 }}>{slice.label}</div>
            <div style={{ color: C.textMuted }}>{slice.pct}%</div>
            <div style={{ fontWeight: 700, minWidth: 72, textAlign: "right" }}>{fmtBytes(slice.sizeBytes)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TrendChart({ C, series, mode }: { C: ThemeTokens; series: StorageTrendSeries | undefined; mode: "pct" | "gb" }) {
  const points = series?.points ?? [];
  if (points.length === 0) {
    return <div style={{ color: C.textMuted, fontSize: 13, padding: "20px 0" }}>Run scans to build trend history.</div>;
  }

  const values = points.map((p) =>
    mode === "pct" ? (p.diskUsedPct ?? 0) : (p.usedBytes ?? 0) / 1e9,
  );
  const max = Math.max(...values, mode === "pct" ? 100 : 1);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 80 }}>
        {values.map((v, i) => (
          <div
            key={i}
            title={new Date(points[i]!.timestamp).toLocaleString()}
            style={{
              flex: 1,
              minWidth: 4,
              height: `${Math.max(6, (v / max) * 100)}%`,
              background: mode === "pct" && v >= 80 ? C.crit : C.blue,
              borderRadius: 3,
              opacity: i === values.length - 1 ? 1 : 0.75,
            }}
          />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 11, color: C.textDim }}>
        <span>{new Date(points[0]!.timestamp).toLocaleDateString()}</span>
        <span style={{ fontWeight: 700, color: riskColor(C, series?.direction === "increasing" ? "high" : series?.direction === "decreasing" ? "low" : "medium") }}>
          {series?.direction?.toUpperCase() ?? "STABLE"}
          {series?.directionPctDelta != null ? ` (${series.directionPctDelta > 0 ? "+" : ""}${series.directionPctDelta}%)` : ""}
        </span>
        <span>{new Date(points[points.length - 1]!.timestamp).toLocaleDateString()}</span>
      </div>
    </div>
  );
}

function Badge({ C, label, tone }: { C: ThemeTokens; label: string; tone: "ok" | "warn" | "crit" | "info" | "muted" }) {
  const color = tone === "ok" ? C.ok : tone === "warn" ? C.warn : tone === "crit" ? C.crit : tone === "info" ? C.info : C.textMuted;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 8px",
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.04em",
        color,
        background: `${color}18`,
        border: `1px solid ${color}44`,
      }}
    >
      {label}
    </span>
  );
}

export default function StorageHealthPage() {
  const { theme, setTheme } = useAppContext();
  const C = theme === "dark" ? DARK : LIGHT;
  const [health, setHealth] = useState<StorageHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [snapshotting, setSnapshotting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [trendWindow, setTrendWindow] = useState<"24h" | "7d" | "30d">("7d");

  const dash = health?.dashboard ?? null;
  const ops = dash?.operationsCenter ?? null;

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const data = await apiGet<StorageHealth>("/admin/storage-health", undefined, { timeoutMs: 30_000 });
      setHealth(data);
      setLastUpdated(new Date().toLocaleTimeString());
      if (data.scanning) setScanning(true);
      else if (!silent) setScanning(false);
      if (data.scanError) setError(data.scanError);
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load storage health");
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const runSnapshot = useCallback(async () => {
    setSnapshotting(true);
    setError(null);
    try {
      await apiPost("/admin/storage-health/snapshot", {}, undefined, { timeoutMs: 30_000 });
      const started = Date.now();
      while (Date.now() - started < 120_000) {
        const data = await load(true);
        if (!data?.snapshotGenerating && data?.dashboard?.operationsCenter?.snapshotStatus?.available) return;
        await sleep(3000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Snapshot failed");
    } finally {
      setSnapshotting(false);
    }
  }, [load]);

  const runScan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      await apiPost("/admin/storage-health/scan", {}, undefined, { timeoutMs: 30_000 });
      const started = Date.now();
      while (Date.now() - started < SCAN_POLL_MAX_MS) {
        const data = await load(true);
        if (!data) break;
        if (data.scanError) {
          throw new Error(data.scanError);
        }
        if (!data.scanning && data.dashboard) {
          await apiPost("/admin/storage-health/plan", {}, undefined, { timeoutMs: 120_000 }).catch(() => null);
          await load(true);
          return;
        }
        await sleep(SCAN_POLL_MS);
      }
      if (Date.now() - started >= SCAN_POLL_MAX_MS) {
        throw new Error("Scan is still running — refresh in a few minutes to see results.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!health?.scanning) return;
    let cancelled = false;
    setScanning(true);
    void (async () => {
      const started = Date.now();
      while (!cancelled && Date.now() - started < SCAN_POLL_MAX_MS) {
        await sleep(SCAN_POLL_MS);
        const data = await load(true);
        if (!data) break;
        if (data.scanError) {
          setError(data.scanError);
          break;
        }
        if (!data.scanning && data.dashboard) break;
      }
      if (!cancelled) setScanning(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [health?.scanning, load]);

  const activeTrend = useMemo(
    () => health?.trends?.find((t) => t.window === trendWindow),
    [health?.trends, trendWindow],
  );

  const pageStyle = useMemo<React.CSSProperties>(
    () => ({
      minHeight: "100vh",
      background: C.bg,
      color: C.text,
      fontFamily: "'Inter', system-ui, sans-serif",
    }),
    [C],
  );

  const cardStyle: React.CSSProperties = {
    background: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 12,
    padding: "18px 20px",
    boxShadow: C.glow,
  };

  const sectionTitle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    color: C.textMuted,
    letterSpacing: "0.08em",
    marginBottom: 14,
  };

  if (loading && !health) {
    return (
      <PermissionGate permission="can_view_admin_storage_health" fallback={<div className="state-box">You do not have storage health access.</div>}>
        <div style={{ ...pageStyle, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh" }}>
          <div style={{ color: C.textMuted }}>Loading storage operations dashboard…</div>
        </div>
      </PermissionGate>
    );
  }

  return (
    <PermissionGate permission="can_view_admin_storage_health" fallback={<div className="state-box">You do not have storage health access.</div>}>
      <div style={pageStyle}>
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 22, fontWeight: 800 }}>Storage Health</div>
            <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>
              Operations dashboard — read-only forensics &amp; reclaim simulation. Phase 1 does not delete anything.
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {scanning && (
              <span style={{ fontSize: 12, color: C.textMuted }}>
                Inventory scan in progress — may take up to 20 minutes on first run…
              </span>
            )}
            {lastUpdated && <span style={{ fontSize: 12, color: C.textDim }}>Updated {lastUpdated}</span>}
            <button
              type="button"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface, color: C.text, cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            >
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </button>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={scanning}
              style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface, color: C.text, cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={() => void runSnapshot()}
              disabled={scanning || snapshotting || !dash}
              style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface, color: C.text, cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            >
              {snapshotting ? "Generating…" : "Generate Snapshot"}
            </button>
            <button
              type="button"
              onClick={() => void runScan()}
              disabled={scanning}
              style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: C.blue, color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 700 }}
            >
              Scan Now
            </button>
          </div>
        </div>

        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 20 }}>
          {error ? (
            <div style={{ ...cardStyle, borderColor: C.crit, color: C.crit }}>{error}</div>
          ) : null}

          {!dash ? (
            <div style={{ ...cardStyle, textAlign: "center", padding: 48, color: C.textMuted }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8 }}>No scan data yet</div>
              Click <strong>Scan Now</strong> to inventory disk usage. Read-only — nothing will be deleted.
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
                <KpiCard
                  C={C}
                  label="STORAGE USED"
                  value={fmtBytes(dash.usedBytes)}
                  sub={`${fmtBytes(dash.totalDiskBytes)} total · ${dash.usedPct ?? "—"}%`}
                  accent={dash.usedPct != null && dash.usedPct >= 80 ? C.crit : C.blue}
                  pct={dash.usedPct ?? undefined}
                />
                <KpiCard C={C} label="AVAILABLE SPACE" value={fmtBytes(dash.freeBytes)} sub="Root filesystem free" accent={C.ok} />
                <KpiCard C={C} label="BUILD CACHE" value={fmtBytes(dash.buildCacheBytes)} sub="Docker BuildKit cache" accent={C.purple} />
                <KpiCard
                  C={C}
                  label="CONTAINERD"
                  value={fmtBytes(dash.containerdBytes)}
                  sub={
                    dash.containerdOverlayBytes != null
                      ? `Overlay ${fmtBytes(dash.containerdOverlayBytes)} · blobs ${fmtBytes(dash.containerdContentBytes)}`
                      : "Host container runtime storage"
                  }
                  accent={C.info}
                />
                <KpiCard C={C} label="RECLAIMABLE" value={fmtBytes(dash.reclaimableBytes)} sub="Safe + rollback candidates" accent={C.ok} />
                <KpiCard C={C} label="PROTECTED DATA" value={fmtBytes(dash.protectedDataBytes)} sub="Production assets locked" accent={C.crit} />
                <KpiCard
                  C={C}
                  label="RISK LEVEL"
                  value={dash.riskLevel.toUpperCase()}
                  sub="Based on disk, cache & unknowns"
                  accent={riskColor(C, dash.riskLevel)}
                />
                {ops ? (
                  <KpiCard
                    C={C}
                    label="CLEANUP READINESS"
                    value={`${ops.readinessScorePct}%`}
                    sub={ops.readinessLabel.replace(/_/g, " ")}
                    accent={ops.readinessScorePct >= 70 && !ops.safetyGates.blocked ? C.ok : C.warn}
                  />
                ) : null}
              </div>

              {ops ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
                  <div style={cardStyle}>
                    <div style={sectionTitle}>BUILD CACHE ANALYSIS</div>
                    <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
                      <div>Total: <strong>{fmtBytes(ops.buildCacheAnalysis.totalBytes)}</strong> ({ops.buildCacheAnalysis.totalEntries} entries)</div>
                      <div>Referenced: <strong>{fmtBytes(ops.buildCacheAnalysis.referencedBytes)}</strong></div>
                      <div>Unused: <strong>{fmtBytes(ops.buildCacheAnalysis.unusedBytes)}</strong></div>
                      <div>Unknown: <strong style={{ color: ops.buildCacheAnalysis.unknownBytes > 0 ? C.crit : C.text }}>{fmtBytes(ops.buildCacheAnalysis.unknownBytes)}</strong></div>
                    </div>
                  </div>
                  <div style={cardStyle}>
                    <div style={sectionTitle}>SNAPSHOT STATUS</div>
                    <div style={{ fontSize: 13, display: "grid", gap: 8 }}>
                      <div>{ops.snapshotStatus.available ? "Preflight snapshot available" : "No snapshot yet — click Generate Snapshot"}</div>
                      {ops.snapshotStatus.latestTimestamp ? <div style={{ color: C.textMuted }}>{ops.snapshotStatus.latestTimestamp}</div> : null}
                    </div>
                  </div>
                  <div style={cardStyle}>
                    <div style={sectionTitle}>SAFETY GATES</div>
                    <Badge C={C} label={ops.safetyGates.blocked ? "BLOCKED" : "PASS"} tone={ops.safetyGates.blocked ? "crit" : "ok"} />
                    {ops.safetyGates.reasons.length ? (
                      <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 12, color: C.textMuted }}>
                        {ops.safetyGates.reasons.map((r) => <li key={r}>{r}</li>)}
                      </ul>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {ops ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
                  <div style={cardStyle}>
                    <div style={sectionTitle}>DEPENDENCY GRAPH</div>
                    <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>{ops.dependencyGraph.runningContainerCount} running containers mapped</div>
                    {ops.dependencyGraph.nodes.slice(0, 12).map((n) => (
                      <div key={n.containerName} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${C.border}44`, fontSize: 12 }}>
                        <span><strong>{n.service}</strong> · {n.containerName}</span>
                        <Badge C={C} label={n.protectedByRunningContainer ? "Protected" : n.state} tone={n.protectedByRunningContainer ? "crit" : "info"} />
                      </div>
                    ))}
                  </div>
                  <div style={cardStyle}>
                    <div style={sectionTitle}>ROLLBACK COVERAGE</div>
                    {ops.rollbackCoverage.slice(0, 10).map((r) => (
                      <div key={r.service} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${C.border}44`, fontSize: 12 }}>
                        <span>{r.service} · {r.image}</span>
                        <Badge C={C} label={r.rollbackAvailable ? "Available" : "Missing"} tone={r.rollbackAvailable ? "ok" : "warn"} />
                      </div>
                    ))}
                  </div>
                  <div style={cardStyle}>
                    <div style={sectionTitle}>CONFIDENCE DISTRIBUTION</div>
                    {ops.confidenceDistribution.map((c) => (
                      <div key={c.label} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 12 }}>
                        <span>{c.label}</span>
                        <span>{c.pct}% · {fmtBytes(c.sizeBytes)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {ops ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
                  <div style={cardStyle}>
                    <div style={sectionTitle}>APK ANALYSIS</div>
                    <div style={{ marginBottom: 8 }}>Total: <strong>{fmtBytes(ops.apkForensics.totalBytes)}</strong></div>
                    <div style={{ fontSize: 12, color: C.textMuted }}>Latest: {ops.apkForensics.latestReleases.map((a) => a.filename).join(", ") || "—"}</div>
                  </div>
                  <div style={cardStyle}>
                    <div style={sectionTitle}>LOG STORAGE ANALYSIS</div>
                    <div style={{ marginBottom: 8 }}>Total: <strong>{fmtBytes(ops.logForensics.totalBytes)}</strong></div>
                    {ops.logForensics.locations.map((l) => (
                      <div key={l.path} style={{ fontSize: 12, padding: "4px 0" }}>{l.label}: {fmtBytes(l.sizeBytes)}</div>
                    ))}
                  </div>
                  <div style={cardStyle}>
                    <div style={sectionTitle}>RISK MATRIX</div>
                    {ops.riskMatrix.map((r) => (
                      <div key={r.category} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 12 }}>
                        <span>{r.category}</span>
                        <span>{fmtBytes(r.sizeBytes)} · {r.confidenceLabel}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {health?.alerts?.length ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
                  {health.alerts.map((a) => (
                    <div
                      key={`${a.code}-${a.message}`}
                      style={{
                        background: severityBg(C, a.severity),
                        border: `1px solid ${severityColor(C, a.severity)}44`,
                        borderRadius: 10,
                        padding: "14px 16px",
                      }}
                    >
                      <div style={{ fontSize: 11, fontWeight: 800, color: severityColor(C, a.severity), letterSpacing: "0.06em" }}>
                        {a.severity === "critical" ? "CRITICAL" : a.severity === "warning" ? "WARNING" : a.severity === "ok" ? "INFO" : a.severity.toUpperCase()}
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 600, marginTop: 6 }}>{a.message}</div>
                    </div>
                  ))}
                </div>
              ) : null}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
                <div style={cardStyle}>
                  <div style={sectionTitle}>STORAGE DISTRIBUTION</div>
                  <DistributionChart C={C} slices={dash.distribution} />
                </div>

                <div style={cardStyle}>
                  <div style={sectionTitle}>RECLAIM SIMULATION</div>
                  <div style={{ display: "grid", gap: 14 }}>
                    <div>
                      <div style={{ fontSize: 12, color: C.textMuted }}>Current usage</div>
                      <div style={{ fontSize: 26, fontWeight: 800 }}>{fmtBytes(dash.usedBytes)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: C.textMuted }}>Estimated usage after approved cleanup</div>
                      <div style={{ fontSize: 26, fontWeight: 800, color: C.ok }}>{fmtBytes(dash.projectedUsageAfterCleanupBytes)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: C.textMuted }}>Estimated recovery</div>
                      <div style={{ fontSize: 26, fontWeight: 800, color: C.blue }}>{fmtBytes(dash.projectedRecoveryBytes)}</div>
                    </div>
                    <div style={{ fontSize: 12, color: C.textMuted, fontStyle: "italic", borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
                      Estimate only — no cleanup has been performed. Approve and Execute remain disabled in Phase 1.
                    </div>
                  </div>
                </div>
              </div>

              <div style={cardStyle}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
                  <div style={sectionTitle}>DISK TREND</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {(["24h", "7d", "30d"] as const).map((w) => (
                      <button
                        key={w}
                        type="button"
                        onClick={() => setTrendWindow(w)}
                        style={{
                          padding: "6px 12px",
                          borderRadius: 8,
                          border: `1px solid ${trendWindow === w ? C.blue : C.border}`,
                          background: trendWindow === w ? `${C.blue}22` : C.surface,
                          color: trendWindow === w ? C.blue : C.textMuted,
                          cursor: "pointer",
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                      >
                        {w}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 20 }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, marginBottom: 8 }}>Disk usage %</div>
                    <TrendChart C={C} series={activeTrend} mode="pct" />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, marginBottom: 8 }}>Disk usage GB</div>
                    <TrendChart C={C} series={activeTrend} mode="gb" />
                  </div>
                </div>
              </div>

              <div style={cardStyle}>
                <div style={sectionTitle}>TOP STORAGE CONSUMERS</div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${C.border}`, color: C.textMuted, textAlign: "left" }}>
                        <th style={{ padding: "8px 10px" }}>Path</th>
                        <th style={{ padding: "8px 10px" }}>Size</th>
                        <th style={{ padding: "8px 10px" }}>Classification</th>
                        <th style={{ padding: "8px 10px" }}>Risk</th>
                        <th style={{ padding: "8px 10px" }}>Actionability</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dash.largestConsumers.map((row) => (
                        <tr key={row.rank} style={{ borderBottom: `1px solid ${C.border}55` }}>
                          <td style={{ padding: "10px", fontFamily: "monospace", fontSize: 12, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }} title={row.path}>
                            {row.path}
                          </td>
                          <td style={{ padding: "10px", fontWeight: 700 }}>{fmtBytes(row.sizeBytes)}</td>
                          <td style={{ padding: "10px" }}>
                            <Badge C={C} label={shortClass(row.classification)} tone={row.classification.includes("PROTECTED") ? "crit" : row.classification.includes("SAFE") ? "ok" : "warn"} />
                          </td>
                          <td style={{ padding: "10px" }}>
                            <Badge C={C} label={row.risk.toUpperCase()} tone={row.risk === "critical" ? "crit" : row.risk === "low" ? "ok" : row.risk === "medium" ? "info" : "warn"} />
                          </td>
                          <td style={{ padding: "10px" }}>
                            <Badge
                              C={C}
                              label={row.actionability === "locked" ? "Locked" : row.actionability === "eligible" ? "Review" : "Review"}
                              tone={row.actionability === "locked" ? "crit" : row.actionability === "eligible" ? "ok" : "warn"}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
                <div style={cardStyle}>
                  <div style={sectionTitle}>PROTECTION STATUS</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {dash.protectedAssets.slice(0, 12).map((asset) => (
                      <div
                        key={asset.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          padding: "10px 12px",
                          borderRadius: 8,
                          background: C.critBg,
                          border: `1px solid ${C.crit}33`,
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{asset.label}</div>
                          <div style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace" }}>{asset.pathOrRef}</div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{fmtBytes(asset.sizeBytes)}</div>
                          <Badge C={C} label={asset.status === "protected" ? "Protected" : "Locked"} tone="crit" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={cardStyle}>
                  <div style={sectionTitle}>CLEANUP READINESS</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {dash.cleanupReadiness.map((row) => (
                      <div
                        key={row.category}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr auto auto auto",
                          gap: 12,
                          alignItems: "center",
                          padding: "10px 12px",
                          borderRadius: 8,
                          background: C.surface,
                          border: `1px solid ${C.border}`,
                          fontSize: 13,
                        }}
                      >
                        <div style={{ fontWeight: 700 }}>{row.category}</div>
                        <div>{fmtBytes(row.sizeBytes)}</div>
                        <Badge C={C} label={row.risk.toUpperCase()} tone={row.risk === "critical" ? "crit" : row.risk === "low" ? "ok" : "warn"} />
                        <Badge
                          C={C}
                          label={row.status === "blocked" ? "Blocked" : row.status === "eligible" ? "Eligible" : "Review Required"}
                          tone={row.status === "blocked" ? "crit" : row.status === "eligible" ? "ok" : "warn"}
                        />
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: 14, fontSize: 12, color: C.textMuted }}>
                    Approve returns <strong>501</strong> · Execute returns <strong>403</strong> — execution controls disabled in Phase 1.
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </PermissionGate>
  );
}
