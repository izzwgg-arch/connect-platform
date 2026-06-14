"use client";

import { useMemo } from "react";

export type CpuConsumerRow = {
  kind: "process" | "container";
  id: string;
  name: string;
  cpuPct: number;
  memoryBytes: number | null;
  detail: string | null;
};

export type ConsumerTrack = {
  key: string;
  name: string;
  kind: CpuConsumerRow["kind"];
  cpuSeries: number[];
  rankSeries: number[];
  currentRank: number;
  rankDelta: number | null;
  currentCpu: number;
};

type ThemeSlice = {
  bg: string;
  surface: string;
  border: string;
  text: string;
  textMuted: string;
  textDim: string;
};

/** Green (low) → yellow → red (high). pct is 0–100 CPU share. */
export function cpuHeatColor(pct: number, alpha = 1): string {
  const t = Math.min(1, Math.max(0, pct / 100));
  let r: number;
  let g: number;
  let b: number;
  if (t <= 0.5) {
    const u = t * 2;
    r = Math.round(34 + (234 - 34) * u);
    g = Math.round(197 + (179 - 197) * u);
    b = Math.round(94 + (8 - 94) * u);
  } else {
    const u = (t - 0.5) * 2;
    r = Math.round(234 + (239 - 234) * u);
    g = Math.round(179 + (68 - 179) * u);
    b = Math.round(8 + (68 - 8) * u);
  }
  if (alpha >= 1) return `rgb(${r}, ${g}, ${b})`;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function consumerKey(c: CpuConsumerRow): string {
  return `${c.kind}:${c.id}:${c.name}`;
}

export function buildConsumerTracks(
  consumers: CpuConsumerRow[],
  prevTracks: Record<string, { cpuSeries: number[]; rankSeries: number[]; name: string; kind: CpuConsumerRow["kind"] }>,
  maxLen = 36,
): ConsumerTrack[] {
  const ranked = [...consumers]
    .filter((c) => c.cpuPct > 0 || c.detail !== "warming up")
    .sort((a, b) => b.cpuPct - a.cpuPct);

  const rankMap = new Map<string, number>();
  ranked.forEach((c, i) => rankMap.set(consumerKey(c), i + 1));

  const allKeys = new Set<string>([...Object.keys(prevTracks), ...ranked.map(consumerKey)]);

  const tracks: ConsumerTrack[] = [];

  for (const key of allKeys) {
    const prev = prevTracks[key];
    const row = ranked.find((c) => consumerKey(c) === key);
    const cpu = row?.cpuPct ?? 0;
    const cpuSeries = [...(prev?.cpuSeries ?? []), cpu].slice(-maxLen);
    const rank = rankMap.get(key) ?? 0;
    const rankSeries = [...(prev?.rankSeries ?? []), rank > 0 ? rank : 0].slice(-maxLen);
    const prevRank = rankSeries.length > 1 ? rankSeries[rankSeries.length - 2] : 0;
    const rankDelta =
      rank > 0 && prevRank > 0 ? prevRank - rank : null;

    if (!row && cpuSeries.every((v) => v === 0) && rankSeries.every((v) => v === 0)) continue;

    tracks.push({
      key,
      name: row?.name ?? prev?.name ?? key,
      kind: row?.kind ?? prev?.kind ?? "process",
      cpuSeries,
      rankSeries,
      currentRank: rank,
      rankDelta,
      currentCpu: cpu,
    });
  }

  return tracks
    .sort((a, b) => {
      if (a.currentRank > 0 && b.currentRank > 0) return a.currentRank - b.currentRank;
      if (a.currentRank > 0) return -1;
      if (b.currentRank > 0) return 1;
      return b.currentCpu - a.currentCpu;
    })
    .slice(0, 12);
}

function fmtRankDelta(delta: number | null): string {
  if (delta == null || delta === 0) return "—";
  if (delta > 0) return `▲${delta}`;
  return `▼${Math.abs(delta)}`;
}

/** Live area chart — height follows CPU %, color green→red. */
export function CpuGradientAreaChart({
  series,
  C,
  height = 120,
  label,
}: {
  series: number[];
  C: ThemeSlice;
  height?: number;
  label?: string;
}) {
  const { areaPath, linePath, last } = useMemo(() => {
    if (series.length === 0) return { areaPath: "", linePath: "", last: 0 };
    const w = 100;
    const h = height;
    const step = series.length > 1 ? w / (series.length - 1) : w;
    const coords = series.map((v, i) => {
      const x = i * step;
      const y = h - (Math.min(100, v) / 100) * h;
      return `${x},${y}`;
    });
    const area = `M0,${h} L${coords.join(" L")} L${w},${h} Z`;
    const line = `M${coords.join(" L")}`;
    return { areaPath: area, linePath: line, last: series[series.length - 1] ?? 0 };
  }, [series, height]);

  return (
    <div>
      {label && (
        <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", marginBottom: 8 }}>
          {label}
        </div>
      )}
      <div style={{ position: "relative", height, borderRadius: 8, background: C.surface, border: `1px solid ${C.border}`, overflow: "hidden" }}>
        <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ width: "100%", height: "100%", display: "block" }}>
          <defs>
            <linearGradient id="cpuAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={cpuHeatColor(last, 0.55)} />
              <stop offset="100%" stopColor={cpuHeatColor(last, 0.05)} />
            </linearGradient>
          </defs>
          {areaPath && <path d={areaPath} fill="url(#cpuAreaGrad)" />}
          {linePath && (
            <path d={linePath} fill="none" stroke={cpuHeatColor(last)} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        <div
          style={{
            position: "absolute",
            right: 8,
            top: 8,
            fontSize: 18,
            fontWeight: 800,
            color: cpuHeatColor(last),
          }}
        >
          {last.toFixed(1)}%
        </div>
      </div>
    </div>
  );
}

/** Stacked waterfall — each column is a time slice, segments = top consumers. */
export function CpuStackedWaterfall({
  tracks,
  C,
  topN = 6,
  height = 200,
}: {
  tracks: ConsumerTrack[];
  C: ThemeSlice;
  topN?: number;
  height?: number;
}) {
  const len = tracks[0]?.cpuSeries.length ?? 0;
  if (len === 0) {
    return <div style={{ fontSize: 13, color: C.textMuted }}>Waterfall warming up…</div>;
  }

  const leaders = tracks.filter((t) => t.currentRank > 0 && t.currentRank <= topN).slice(0, topN);
  if (leaders.length === 0) {
    return <div style={{ fontSize: 13, color: C.textMuted }}>No active CPU consumers yet.</div>;
  }

  const columns = Array.from({ length: len }, (_, col) => {
    const segs = leaders.map((t) => ({
      key: t.key,
      name: t.name,
      pct: t.cpuSeries[col] ?? 0,
    }));
    const total = segs.reduce((s, x) => s + x.pct, 0);
    return { segs, total };
  });

  const maxTotal = Math.max(15, ...columns.map((c) => c.total));

  return (
    <div>
      <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height, paddingBottom: 4 }}>
        {columns.map((col, colIdx) => (
          <div
            key={colIdx}
            style={{
              flex: 1,
              minWidth: 4,
              display: "flex",
              flexDirection: "column",
              justifyContent: "flex-end",
              height: "100%",
              gap: 1,
            }}
          >
            {col.segs
              .filter((s) => s.pct > 0)
              .sort((a, b) => b.pct - a.pct)
              .map((seg) => {
                const hPct = (seg.pct / maxTotal) * 100;
                return (
                  <div
                    key={seg.key}
                    title={`${seg.name}: ${seg.pct.toFixed(1)}%`}
                    style={{
                      height: `${hPct}%`,
                      minHeight: seg.pct > 0.3 ? 2 : 0,
                      background: cpuHeatColor(seg.pct),
                      borderRadius: 2,
                      transition: "height 0.35s ease",
                    }}
                  />
                );
              })}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.textDim, marginTop: 6 }}>
        <span>older</span>
        <span>live →</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        {leaders.map((t) => (
          <span key={t.key} style={{ fontSize: 11, color: C.textMuted }}>
            <span style={{ color: cpuHeatColor(t.currentCpu), fontWeight: 700 }}>#{t.currentRank}</span> {t.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Rank position over time — lower Y = better rank (#1 at top). */
export function CpuRankPositionChart({
  tracks,
  C,
  height = 200,
  maxRank = 10,
}: {
  tracks: ConsumerTrack[];
  C: ThemeSlice;
  height?: number;
  maxRank?: number;
}) {
  const active = tracks.filter((t) => t.currentRank > 0 && t.currentRank <= maxRank).slice(0, maxRank);
  const len = active[0]?.rankSeries.length ?? 0;
  if (len === 0) return null;

  const w = 100;
  const step = len > 1 ? w / (len - 1) : w;

  return (
    <div style={{ position: "relative", height, borderRadius: 8, background: C.surface, border: `1px solid ${C.border}`, padding: "8px 8px 4px" }}>
      <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ width: "100%", height: "100%" }}>
        {Array.from({ length: maxRank }, (_, i) => {
          const y = ((i + 0.5) / maxRank) * height;
          return (
            <line
              key={i}
              x1={0}
              y1={y}
              x2={w}
              y2={y}
              stroke={C.border}
              strokeWidth={0.5}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        {active.map((t) => {
          const pts = t.rankSeries
            .map((rank, i) => {
              if (rank <= 0) return null;
              const x = i * step;
              const y = ((rank - 0.5) / maxRank) * height;
              return `${x},${y}`;
            })
            .filter(Boolean);
          if (pts.length === 0) return null;
          const cpuAtEnd = t.cpuSeries[t.cpuSeries.length - 1] ?? 0;
          return (
            <path
              key={t.key}
              d={`M${pts.join(" L")}`}
              fill="none"
              stroke={cpuHeatColor(cpuAtEnd)}
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
              opacity={0.9}
            />
          );
        })}
      </svg>
      <div style={{ position: "absolute", left: 4, top: 4, fontSize: 9, color: C.textDim, lineHeight: 1.4 }}>
        {Array.from({ length: maxRank }, (_, i) => (
          <div key={i}>#{i + 1}</div>
        ))}
      </div>
    </div>
  );
}

/** Per-consumer horizontal micro-waterfalls with position badges. */
export function CpuConsumerWaterfallRows({
  tracks,
  C,
  maxLen = 36,
}: {
  tracks: ConsumerTrack[];
  C: ThemeSlice;
  maxLen?: number;
}) {
  const rows = tracks.filter((t) => t.currentRank > 0 || t.currentCpu > 0).slice(0, 12);
  if (rows.length === 0) {
    return <div style={{ fontSize: 13, color: C.textMuted }}>Collecting CPU baseline…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {rows.map((t) => {
        const series = t.cpuSeries.slice(-maxLen);
        const max = Math.max(5, ...series);
        return (
          <div
            key={t.key}
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              background: C.surface,
              border: `1px solid ${C.border}`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  background: cpuHeatColor(t.currentCpu, 0.25),
                  border: `1px solid ${cpuHeatColor(t.currentCpu, 0.6)}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  fontWeight: 800,
                  color: cpuHeatColor(t.currentCpu),
                  flexShrink: 0,
                }}
              >
                {t.currentRank > 0 ? t.currentRank : "—"}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{t.name}</div>
                <div style={{ fontSize: 11, color: C.textMuted }}>
                  {t.kind === "container" ? "Container" : "Process"} · position {fmtRankDelta(t.rankDelta)}
                </div>
              </div>
              <div style={{ fontWeight: 800, fontSize: 16, color: cpuHeatColor(t.currentCpu) }}>
                {t.currentCpu.toFixed(1)}%
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 44 }}>
              {series.map((v, i) => (
                <div
                  key={i}
                  style={{
                    flex: 1,
                    minWidth: 2,
                    height: `${Math.max(4, (v / max) * 100)}%`,
                    background: cpuHeatColor(v),
                    borderRadius: 2,
                    opacity: i === series.length - 1 ? 1 : 0.65,
                    transition: "height 0.3s ease",
                  }}
                  title={`${v.toFixed(1)}%`}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function CpuLiveChartsPanel({
  C,
  cardStyle,
  cpuHistory,
  tracks,
  scopeNote,
}: {
  C: ThemeSlice;
  cardStyle: React.CSSProperties;
  cpuHistory: number[];
  tracks: ConsumerTrack[];
  scopeNote: string;
}) {

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em" }}>
              LIVE CPU · WATERFALLS & CHARTS
            </div>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6, maxWidth: 720 }}>{scopeNote}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: C.textDim }}>
            <span style={{ width: 48, height: 8, borderRadius: 99, background: "linear-gradient(90deg, #22c55e, #eab308, #ef4444)" }} />
            low → high
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
          <CpuGradientAreaChart series={cpuHistory} C={C} label="TOTAL CPU" />
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", marginBottom: 8 }}>
              RANK POSITIONS
            </div>
            <CpuRankPositionChart tracks={tracks} C={C} />
            <div style={{ fontSize: 10, color: C.textDim, marginTop: 6 }}>#1 top line = highest CPU rank over time</div>
          </div>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", marginBottom: 12 }}>
          STACKED CPU WATERFALL
        </div>
        <CpuStackedWaterfall tracks={tracks} C={C} />
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.08em", marginBottom: 12 }}>
          CONSUMERS BY POSITION
        </div>
        <CpuConsumerWaterfallRows tracks={tracks} C={C} />
      </div>
    </div>
  );
}
