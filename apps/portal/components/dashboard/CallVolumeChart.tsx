"use client";

import { useMemo, useRef, useState, useEffect } from "react";
import { TrendingUp } from "lucide-react";
import type { DateRangeKey } from "../DateRangeFilter";

export type TrafficPoint = {
  label: string;
  start: string;
  end: string;
  total: number;
  incoming: number;
  outgoing: number;
  internal: number;
  missed: number;
  canceled?: number;
};

export type TrafficData = {
  range: string;
  timezone: string;
  windowMinutes: number;
  bucketMinutes: number | null;
  totals: { total: number; incoming: number; outgoing: number; internal: number; missed: number; canceled?: number };
  points: TrafficPoint[];
};

type Props = {
  data: TrafficData | null;
  loading: boolean;
  rangeKey: DateRangeKey;
};

type HoverState = { index: number; x: number; y: number } | null;

/** Generate a smooth SVG path from points using a cardinal/Catmull-Rom interpolation. */
function smoothLine(points: Array<{ x: number; y: number }>, tension = 0.5): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`;
  const t = tension;
  const segments: string[] = [`M ${points[0]!.x} ${points[0]!.y}`];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const cp1x = p1.x + ((p2.x - p0.x) / 6) * t;
    const cp1y = p1.y + ((p2.y - p0.y) / 6) * t;
    const cp2x = p2.x - ((p3.x - p1.x) / 6) * t;
    const cp2y = p2.y - ((p3.y - p1.y) / 6) * t;
    segments.push(`C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`);
  }
  return segments.join(" ");
}

function fmtBucketLabel(point: TrafficPoint, rangeKey: DateRangeKey): string {
  const start = new Date(point.start);
  if (Number.isNaN(start.getTime())) return point.label;
  if (rangeKey === "today") {
    return start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return start.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function fmtTooltipTitle(point: TrafficPoint, rangeKey: DateRangeKey): string {
  const start = new Date(point.start);
  if (Number.isNaN(start.getTime())) return point.label;
  if (rangeKey === "today") {
    const hour = start.toLocaleTimeString([], { hour: "numeric" });
    return hour;
  }
  return start.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

export function CallVolumeChart({ data, loading, rangeKey }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 800, h: 240 });
  const [hover, setHover] = useState<HoverState>(null);

  // Resize observer for the SVG container.
  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        setSize({ w: Math.max(280, Math.floor(cr.width)), h: 240 });
      }
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const { hoverPositions, viewBox, series, gridLines, xTicks, hasData } = useMemo(() => {
    const padding = { top: 16, right: 16, bottom: 28, left: 36 };
    const innerW = Math.max(10, size.w - padding.left - padding.right);
    const innerH = Math.max(10, size.h - padding.top - padding.bottom);
    const raw = data?.points ?? [];
    const seriesDefs: Array<{ key: "incoming" | "outgoing" | "internal"; color: string; gradientId: string; }> = [
      { key: "incoming", color: "var(--dash-incoming)", gradientId: "dashV2GraphFillIncoming" },
      { key: "outgoing", color: "var(--dash-outgoing)", gradientId: "dashV2GraphFillOutgoing" },
      { key: "internal", color: "var(--dash-internal)", gradientId: "dashV2GraphFillInternal" },
    ];
    // Y-scale based on the largest single-direction value (not stacked).
    let max = 0;
    for (const p of raw) {
      max = Math.max(max, p.incoming ?? 0, p.outgoing ?? 0, p.internal ?? 0);
    }
    const niceMax = niceCeil(Math.max(1, max));

    const xFor = (i: number) =>
      raw.length <= 1 ? padding.left + innerW / 2 : padding.left + (i / (raw.length - 1)) * innerW;
    const yFor = (count: number) => padding.top + innerH - (count / niceMax) * innerH;

    const built = seriesDefs.map((def) => {
      const xy = raw.map((p, i) => ({ x: xFor(i), y: yFor(p[def.key] ?? 0) }));
      const linePathStr = smoothLine(xy, 0.5);
      const areaPathStr = xy.length === 0
        ? ""
        : `${linePathStr} L ${xy[xy.length - 1]!.x} ${padding.top + innerH} L ${xy[0]!.x} ${padding.top + innerH} Z`;
      return { ...def, xy, linePath: linePathStr, areaPath: areaPathStr };
    });

    // Hover positions are based on x for each bucket; the y of the dot will follow
    // the highest visible series at that bucket so the indicator stays visible.
    const hoverXY = raw.map((p, i) => {
      const yIncoming = yFor(p.incoming ?? 0);
      const yOutgoing = yFor(p.outgoing ?? 0);
      const yInternal = yFor(p.internal ?? 0);
      return { x: xFor(i), y: Math.min(yIncoming, yOutgoing, yInternal) };
    });

    // Y grid lines: 4 horizontal divisions
    const gridDivs = 4;
    const grid = [] as Array<{ y: number; value: number }>;
    for (let i = 0; i <= gridDivs; i++) {
      const value = (niceMax * (gridDivs - i)) / gridDivs;
      grid.push({ y: padding.top + (i * innerH) / gridDivs, value: Math.round(value) });
    }

    // X ticks: at most 8 evenly-spaced labels.
    const targetTicks = Math.min(8, raw.length);
    const tickStep = raw.length > 1 ? Math.max(1, Math.ceil(raw.length / targetTicks)) : 1;
    const ticks: Array<{ x: number; label: string; index: number }> = [];
    for (let i = 0; i < raw.length; i += tickStep) {
      ticks.push({ x: xFor(i), label: fmtBucketLabel(raw[i]!, rangeKey), index: i });
    }
    const has = raw.some((p) => (p.incoming ?? 0) + (p.outgoing ?? 0) + (p.internal ?? 0) > 0);

    return {
      hoverPositions: hoverXY,
      viewBox: `0 0 ${size.w} ${size.h}`,
      series: built,
      gridLines: grid,
      xTicks: ticks,
      hasData: has,
    };
  }, [data, size.w, size.h, rangeKey]);

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!data?.points?.length || hoverPositions.length === 0) return;
    const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    // Convert client pixels → SVG viewBox space so hover lines up regardless of CSS scaling.
    const scaleX = size.w / rect.width;
    const x = (event.clientX - rect.left) * scaleX;
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < hoverPositions.length; i++) {
      const dx = Math.abs(hoverPositions[i]!.x - x);
      if (dx < best) { best = dx; nearest = i; }
    }
    const p = hoverPositions[nearest]!;
    setHover({ index: nearest, x: p.x, y: p.y });
  };

  const handlePointerLeave = () => setHover(null);

  return (
    <section className="dash-v2-section dash-v2-graph" aria-label="Call volume">
      <div className="dash-v2-card dash-v2-graph-card">
        <header className="dash-v2-graph-head">
          <div className="dash-v2-graph-head-title">
            <span className="dash-v2-graph-icon" aria-hidden><TrendingUp size={16} /></span>
            <h2>Call Volume</h2>
          </div>
          <div className="dash-v2-graph-head-meta">
            <ul className="dash-v2-graph-legend" role="list" aria-label="Series">
              <li><span className="swatch incoming" aria-hidden /> Incoming<strong>{(data?.totals?.incoming ?? 0).toLocaleString()}</strong></li>
              <li><span className="swatch outgoing" aria-hidden /> Outgoing<strong>{(data?.totals?.outgoing ?? 0).toLocaleString()}</strong></li>
              <li><span className="swatch internal" aria-hidden /> Internal<strong>{(data?.totals?.internal ?? 0).toLocaleString()}</strong></li>
            </ul>
            <span className="dash-v2-graph-total" aria-live="polite">
              {loading && !data ? "…" : `${(data?.totals?.total ?? 0).toLocaleString()} calls`}
            </span>
          </div>
        </header>

        <div className="dash-v2-graph-plot" ref={wrapRef}>
          {!hasData ? (
            <div className="dash-v2-graph-empty">
              <span>{loading ? "Loading call volume…" : "No call data in this range yet."}</span>
            </div>
          ) : (
            <svg
              role="img"
              aria-label="Call volume over time"
              width="100%"
              height={size.h}
              viewBox={viewBox}
              preserveAspectRatio="none"
              onPointerMove={handlePointerMove}
              onPointerLeave={handlePointerLeave}
              className="dash-v2-graph-svg"
            >
              <defs>
                {series.map((s) => (
                  <linearGradient key={s.gradientId} id={s.gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"   stopColor={s.color} stopOpacity="0.28" />
                    <stop offset="60%"  stopColor={s.color} stopOpacity="0.06" />
                    <stop offset="100%" stopColor={s.color} stopOpacity="0" />
                  </linearGradient>
                ))}
              </defs>

              {/* Horizontal grid lines + Y labels */}
              {gridLines.map((g, i) => (
                <g key={`grid-${i}`}>
                  <line
                    x1={36} x2={size.w - 16}
                    y1={g.y} y2={g.y}
                    stroke="var(--dash-card-border)"
                    strokeOpacity={i === gridLines.length - 1 ? 0.7 : 0.35}
                    strokeWidth={1}
                  />
                  <text
                    x={28}
                    y={g.y + 3}
                    textAnchor="end"
                    fill="var(--console-muted)"
                    fontSize="10"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {g.value}
                  </text>
                </g>
              ))}

              {/* Area fills (drawn first so lines sit on top) */}
              {series.map((s) => (
                <path key={`fill-${s.key}`} d={s.areaPath} fill={`url(#${s.gradientId})`} />
              ))}
              {/* Lines */}
              {series.map((s) => (
                <path
                  key={`line-${s.key}`}
                  d={s.linePath}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}

              {/* X tick labels */}
              {xTicks.map((t) => (
                <text
                  key={`xt-${t.index}`}
                  x={t.x}
                  y={size.h - 10}
                  textAnchor="middle"
                  fill="var(--console-muted)"
                  fontSize="10"
                >
                  {t.label}
                </text>
              ))}

              {/* Hover indicator: vertical guide + dot per series */}
              {hover && data?.points?.[hover.index] ? (
                <g pointerEvents="none">
                  <line
                    x1={hover.x} x2={hover.x}
                    y1={16} y2={size.h - 28}
                    stroke="var(--console-accent)"
                    strokeOpacity={0.45}
                    strokeWidth={1}
                    strokeDasharray="3 3"
                  />
                  {series.map((s) => {
                    const pt = s.xy[hover.index];
                    if (!pt) return null;
                    return (
                      <g key={`dot-${s.key}`}>
                        <circle cx={pt.x} cy={pt.y} r={9} fill={s.color} fillOpacity={0.18} />
                        <circle cx={pt.x} cy={pt.y} r={4} fill={s.color} />
                      </g>
                    );
                  })}
                </g>
              ) : null}
            </svg>
          )}

          {hover && data?.points?.[hover.index] ? (
            (() => {
              const p = data.points[hover.index]!;
              // Position tooltip: stay within plot bounds
              const tooltipW = 200;
              const tooltipH = 110;
              const margin = 12;
              let left = hover.x + 14;
              let top = hover.y - tooltipH - 12;
              if (left + tooltipW > size.w - margin) left = hover.x - tooltipW - 14;
              if (top < margin) top = hover.y + 14;
              return (
                <div
                  className="dash-v2-graph-tooltip"
                  role="tooltip"
                  style={{ left: `${left}px`, top: `${top}px`, width: `${tooltipW}px` }}
                >
                  <div className="dash-v2-graph-tooltip-title">{fmtTooltipTitle(p, rangeKey)}</div>
                  <div className="dash-v2-graph-tooltip-total">
                    <span>Total</span>
                    <strong>{p.total.toLocaleString()}</strong>
                  </div>
                  <ul className="dash-v2-graph-tooltip-rows" role="list">
                    <li><span className="swatch incoming" aria-hidden /> Incoming<strong>{p.incoming.toLocaleString()}</strong></li>
                    <li><span className="swatch outgoing" aria-hidden /> Outgoing<strong>{p.outgoing.toLocaleString()}</strong></li>
                    <li><span className="swatch internal" aria-hidden /> Internal<strong>{p.internal.toLocaleString()}</strong></li>
                  </ul>
                </div>
              );
            })()
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** Round up to a "nice" number for the y-axis (1, 2, 5, 10, 20, 50, 100, …). */
function niceCeil(value: number): number {
  if (value <= 0) return 5;
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / Math.pow(10, exponent);
  let niceFraction: number;
  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return Math.max(1, niceFraction * Math.pow(10, exponent));
}
