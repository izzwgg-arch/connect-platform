"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { useAppContext } from "../../../../hooks/useAppContext";
import { apiGet } from "../../../../services/apiClient";
import {
  buildConsumerTracks,
  cpuHeatColor,
  CpuLiveChartsPanel,
  type ConsumerTrack,
  type CpuConsumerRow,
} from "./CpuLiveCharts";
import { seedDevConsumerTrackState, seedDevMetricHistory } from "./devChartSeed";
import { isLocalhostDev } from "../../../../lib/localDev";

type HealthStatus = "ok" | "warning" | "critical" | "unknown";

type DiskMount = {
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPct: number;
};

type ServiceProbe = {
  id: string;
  label: string;
  status: HealthStatus;
  latencyMs: number | null;
  detail: string | null;
  endpoint: string;
};

type CpuConsumersSnapshot = {
  scope: "host_processes" | "container_processes" | "docker_containers" | "unavailable";
  scopeNote: string;
  consumers: CpuConsumer[];
  sampledAt: string;
};

type ServerHealthData = {
  timestamp: string;
  overallStatus: HealthStatus;
  systemHealth: HealthStatus;
  serverHealth: HealthStatus;
  host: {
    timestamp: string;
    hostname: string;
    platform: string;
    arch: string;
    uptimeSec: number;
    cpuCount: number;
    cpuUsagePct: number | null;
    loadAvg: [number, number, number];
    memory: {
      totalBytes: number;
      usedBytes: number;
      freeBytes: number;
      usedPct: number;
      cgroupLimited: boolean;
    };
    storage: DiskMount[];
    processMemory: { heapUsedBytes: number; rssBytes: number };
    cpuConsumers: CpuConsumersSnapshot;
  };
  services: ServiceProbe[];
  deployQueue: {
    status: HealthStatus;
    runningCount: number;
    queuedCount: number;
    detail: string | null;
  } | null;
};

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
};

function statusColor(C: ThemeTokens, s: HealthStatus): string {
  if (s === "ok") return C.ok;
  if (s === "warning") return C.warn;
  if (s === "critical") return C.crit;
  return C.textMuted;
}

function statusBg(C: ThemeTokens, s: HealthStatus): string {
  if (s === "ok") return C.okBg;
  if (s === "warning") return C.warnBg;
  if (s === "critical") return C.critBg;
  return C.surface;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function HeatSparkline({ values, height = 36 }: { values: number[]; height?: number }) {
  if (values.length === 0) return null;
  const max = Math.max(1, ...values);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height, marginTop: 8 }}>
      {values.map((v, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            minWidth: 2,
            height: `${Math.max(4, (v / max) * 100)}%`,
            background: cpuHeatColor(v),
            borderRadius: 2,
            opacity: i === values.length - 1 ? 1 : 0.7,
            transition: "height 0.3s ease, background 0.3s ease",
          }}
        />
      ))}
    </div>
  );
}

function MetricBar({ pct, color, maxPct = 100 }: { pct: number; color: string; maxPct?: number }) {
  const width = maxPct > 0 ? Math.min(100, (pct / maxPct) * 100) : 0;
  return (
    <div style={{ height: 8, background: "rgba(148,163,184,0.2)", borderRadius: 99, overflow: "hidden", marginTop: 10 }}>
      <div style={{ width: `${width}%`, height: "100%", background: color, borderRadius: 99, transition: "width 0.4s ease" }} />
    </div>
  );
}

function HealthBanner({
  C,
  label,
  status,
  detail,
}: {
  C: ThemeTokens;
  label: string;
  status: HealthStatus;
  detail?: string;
}) {
  const color = statusColor(C, status);
  return (
    <div
      style={{
        background: statusBg(C, status),
        border: `1px solid ${color}44`,
        borderRadius: 10,
        padding: "14px 16px",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <div style={{ width: 10, height: 10, borderRadius: 99, background: color, flexShrink: 0 }} />
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          {label}
        </div>
        <div style={{ fontSize: 18, fontWeight: 800, color: color, marginTop: 2 }}>
          {status.toUpperCase()}
        </div>
        {detail && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>{detail}</div>}
      </div>
    </div>
  );
}

export default function ServerHealthPage() {
  const { theme, setTheme } = useAppContext();
  const C = theme === "dark" ? DARK : LIGHT;
  const [data, setData] = useState<ServerHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [memHistory, setMemHistory] = useState<number[]>([]);
  const [consumerTrackState, setConsumerTrackState] = useState<
    Record<string, { cpuSeries: number[]; rankSeries: number[]; name: string; kind: CpuConsumerRow["kind"] }>
  >({});
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const resp = await apiGet<ServerHealthData>("/admin/server-health", undefined, { timeoutMs: 30_000 });
      setData(resp);
      setLastUpdated(new Date().toLocaleTimeString());
      const cpu = resp.host.cpuUsagePct ?? 0;
      const mem = resp.host.memory.usedPct;
      const devPreview = isLocalhostDev();
      setCpuHistory((prev) => {
        const next = [...prev.slice(-35), cpu];
        if (devPreview && next.length < 12) return seedDevMetricHistory(cpu > 0 ? cpu : 28);
        return next;
      });
      setMemHistory((prev) => {
        const next = [...prev.slice(-35), mem];
        if (devPreview && next.length < 12) return seedDevMetricHistory(mem > 0 ? mem : 54);
        return next;
      });
      const consumers = resp.host.cpuConsumers?.consumers ?? [];
      setConsumerTrackState((prev) => {
        if (devPreview && Object.keys(prev).length < 3) {
          return seedDevConsumerTrackState(consumers);
        }
        const tracks = buildConsumerTracks(consumers, prev);
        const next: Record<string, { cpuSeries: number[]; rankSeries: number[]; name: string; kind: CpuConsumerRow["kind"] }> = {};
        for (const t of tracks) {
          next[t.key] = {
            cpuSeries: t.cpuSeries,
            rankSeries: t.rankSeries,
            name: t.name,
            kind: t.kind,
          };
        }
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load server health");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    timerRef.current = setInterval(() => load(true), 5000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [load]);

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
    padding: "16px 18px",
  };

  if (loading && !data) {
    return (
      <PermissionGate permission="can_view_admin_server_health">
        <div style={{ ...pageStyle, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh" }}>
          <div style={{ textAlign: "center", color: C.textMuted }}>Loading server health…</div>
        </div>
      </PermissionGate>
    );
  }

  if (error && !data) {
    return (
      <PermissionGate permission="can_view_admin_server_health">
        <div style={{ ...pageStyle, padding: "40px 32px" }}>
          <div style={{ ...cardStyle, maxWidth: 560, borderColor: C.crit }}>
            <div style={{ fontWeight: 700, color: C.crit, marginBottom: 8 }}>Failed to load Server Health</div>
            <div style={{ marginBottom: 16 }}>{error}</div>
            <button
              onClick={() => load()}
              style={{ padding: "8px 16px", background: C.blue, color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 600 }}
            >
              Retry
            </button>
          </div>
        </div>
      </PermissionGate>
    );
  }

  if (!data) return null;

  const host = data.host;
  const cpuPct = host.cpuUsagePct ?? 0;
  const memPct = host.memory.usedPct;
  const storageMax = host.storage.reduce((m, s) => Math.max(m, s.usedPct), 0);
  const consumerTracks: ConsumerTrack[] = buildConsumerTracks(
    host.cpuConsumers?.consumers ?? [],
    consumerTrackState,
  );

  return (
    <PermissionGate permission="can_view_admin_server_health">
      <div style={pageStyle}>
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 22, fontWeight: 800 }}>Server Health</div>
            <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>
              Live CPU, memory, storage, and service probes · {host.hostname}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {refreshing && <span style={{ fontSize: 12, color: C.textMuted }}>Refreshing…</span>}
            {lastUpdated && <span style={{ fontSize: 12, color: C.textDim }}>Updated {lastUpdated}</span>}
            <button
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: `1px solid ${C.border}`,
                background: C.surface,
                color: C.text,
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </button>
            <button
              onClick={() => load(true)}
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                border: "none",
                background: C.blue,
                color: "#fff",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              Refresh
            </button>
          </div>
        </div>

        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
            <HealthBanner C={C} label="Overall" status={data.overallStatus} />
            <HealthBanner C={C} label="System resources" status={data.systemHealth} />
            <HealthBanner C={C} label="Services" status={data.serverHealth} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
            <div style={cardStyle}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em" }}>CPU USAGE</div>
              <div style={{ fontSize: 32, fontWeight: 800, marginTop: 6, color: cpuHeatColor(cpuPct) }}>
                {host.cpuUsagePct != null ? `${host.cpuUsagePct}%` : "—"}
              </div>
              <div style={{ fontSize: 12, color: C.textMuted }}>
                {host.cpuCount} cores · load {host.loadAvg.map((n) => n.toFixed(2)).join(" / ")}
              </div>
              <MetricBar pct={cpuPct} color={cpuHeatColor(cpuPct)} />
              <HeatSparkline values={cpuHistory} />
            </div>

            <div style={cardStyle}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em" }}>RAM USAGE</div>
              <div style={{ fontSize: 32, fontWeight: 800, marginTop: 6 }}>{memPct}%</div>
              <div style={{ fontSize: 12, color: C.textMuted }}>
                {fmtBytes(host.memory.usedBytes)} used of {fmtBytes(host.memory.totalBytes)}
                {host.memory.cgroupLimited ? " (container limit)" : ""}
              </div>
              <MetricBar pct={memPct} color={statusColor(C, memPct >= 85 ? "warning" : "ok")} />
              <HeatSparkline values={memHistory} />
            </div>

            <div style={cardStyle}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em" }}>STORAGE</div>
              <div style={{ fontSize: 32, fontWeight: 800, marginTop: 6 }}>{storageMax}%</div>
              <div style={{ fontSize: 12, color: C.textMuted }}>
                Peak utilization across {host.storage.length} mount{host.storage.length === 1 ? "" : "s"}
              </div>
              <MetricBar pct={storageMax} color={statusColor(C, storageMax >= 90 ? "warning" : "ok")} />
            </div>
          </div>

          <CpuLiveChartsPanel
            C={C}
            cardStyle={cardStyle}
            cpuHistory={cpuHistory}
            tracks={consumerTracks}
            scopeNote={host.cpuConsumers?.scopeNote ?? "CPU consumer data loading…"}
          />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div style={cardStyle}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", marginBottom: 12 }}>
                SERVICE HEALTH
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {data.services.map((svc) => (
                  <div
                    key={svc.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 12px",
                      borderRadius: 8,
                      background: statusBg(C, svc.status),
                      border: `1px solid ${statusColor(C, svc.status)}33`,
                    }}
                  >
                    <div style={{ width: 8, height: 8, borderRadius: 99, background: statusColor(C, svc.status) }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{svc.label}</div>
                      <div style={{ fontSize: 11, color: C.textMuted }}>{svc.detail ?? svc.endpoint}</div>
                    </div>
                    <div style={{ fontSize: 11, color: C.textMuted }}>
                      {svc.latencyMs != null ? `${svc.latencyMs}ms` : "—"}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={cardStyle}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", marginBottom: 12 }}>
                SYSTEM INFORMATION
              </div>
              <div style={{ display: "grid", gap: 10, fontSize: 13 }}>
                <div><span style={{ color: C.textMuted }}>Hostname</span><div style={{ fontWeight: 600 }}>{host.hostname}</div></div>
                <div><span style={{ color: C.textMuted }}>Platform</span><div>{host.platform} ({host.arch})</div></div>
                <div><span style={{ color: C.textMuted }}>Uptime</span><div>{fmtUptime(host.uptimeSec)}</div></div>
                <div><span style={{ color: C.textMuted }}>API process RSS</span><div>{fmtBytes(host.processMemory.rssBytes)}</div></div>
                <div><span style={{ color: C.textMuted }}>API heap</span><div>{fmtBytes(host.processMemory.heapUsedBytes)}</div></div>
                {data.deployQueue && (
                  <div>
                    <span style={{ color: C.textMuted }}>Deploy queue</span>
                    <div>
                      {data.deployQueue.runningCount} running · {data.deployQueue.queuedCount} queued
                      {data.deployQueue.detail ? ` · ${data.deployQueue.detail}` : ""}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", marginBottom: 12 }}>
              STORAGE MOUNTS
            </div>
            {host.storage.length === 0 ? (
              <div style={{ color: C.textMuted, fontSize: 13 }}>No mount paths available on this host.</div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {host.storage.map((mount) => (
                  <div key={mount.path} style={{ padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
                      <span style={{ fontWeight: 600 }}>{mount.path}</span>
                      <span style={{ color: C.textMuted }}>{mount.usedPct}%</span>
                    </div>
                    <MetricBar pct={mount.usedPct} color={statusColor(C, mount.usedPct >= 90 ? "warning" : "ok")} />
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>
                      {fmtBytes(mount.usedBytes)} used · {fmtBytes(mount.freeBytes)} free · {fmtBytes(mount.totalBytes)} total
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ fontSize: 11, color: C.textDim, textAlign: "center" }}>
            Samples every 5s from cached host collector · service probes cached 8s · snapshot {data.timestamp}
          </div>
        </div>
      </div>
    </PermissionGate>
  );
}
