"use client";

/** A daily count series as a plain SVG sparkline. Tokens only — no hardcoded colors. */
export type LineChartPoint = { day: string; count: number };

export function LineChart({ series, height = 120, ariaLabel }: { series: LineChartPoint[]; height?: number; ariaLabel?: string }) {
  const W = 560;
  const H = height;
  const gradId = `lc-grad-${Math.random().toString(36).slice(2, 8)}`;

  if (!series.length) {
    return (
      <div className="dim sm" style={{ height: H, display: "grid", placeItems: "center" }}>
        No data yet for this period.
      </div>
    );
  }

  const values = series.map((p) => p.count);
  const max = Math.max(1, ...values);
  const points = series.map((p, i) => {
    const x = series.length > 1 ? (i / (series.length - 1)) * W : W;
    const y = H - 8 - (p.count / max) * (H - 20);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = points[points.length - 1]?.split(",");

  return (
    <div>
      <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label={ariaLabel || `Daily values from ${series[0]?.count} to ${series[series.length - 1]?.count}`} style={{ width: "100%", height: H }}>
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={(H - 8 - f * (H - 20)).toFixed(1)} y2={(H - 8 - f * (H - 20)).toFixed(1)} stroke="var(--border)" strokeWidth="1" />
        ))}
        <polygon points={`0,${H - 8} ${points.join(" ")} ${W},${H - 8}`} fill={`url(#${gradId})`} />
        <polyline points={points.join(" ")} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" />
        {last ? <circle cx={last[0]} cy={last[1]} r="4" fill="var(--accent)" /> : null}
      </svg>
      <div className="row xs dim mono" style={{ justifyContent: "space-between" }}>
        <span>{series[0]?.day}</span>
        <span>
          {series[series.length - 1]?.day} · {series[series.length - 1]?.count}
        </span>
      </div>
    </div>
  );
}
