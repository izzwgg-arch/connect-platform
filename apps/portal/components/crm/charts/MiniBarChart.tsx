"use client";

export function MiniBarChart({
  series,
  width = 120,
  height = 28,
  barGap = 2,
  color = "var(--crm-accent)",
  bg = "transparent",
  ariaLabel,
}: {
  series: number[];
  width?: number;
  height?: number;
  barGap?: number;
  color?: string;
  bg?: string;
  ariaLabel?: string;
}) {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const n = Math.max(1, series.length);
  const min = 0; // bars start at 0 for intuitive height
  const max = Math.max(...series, 1);
  const colW = Math.max(1, (w - (n - 1) * barGap) / n);

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={ariaLabel} style={{ display: "block" }}>
      {bg !== "transparent" ? <rect x={0} y={0} width={w} height={h} fill={bg} /> : null}
      {series.map((v, i) => {
        const x = i * (colW + barGap);
        const hh = Math.max(0, ((v - min) / (max - min)) * h);
        const y = h - hh;
        return <rect key={i} x={x} y={y} width={colW} height={hh} rx={1.5} ry={1.5} fill={color} />;
      })}
    </svg>
  );
}
