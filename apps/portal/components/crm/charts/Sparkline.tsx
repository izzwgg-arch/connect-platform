"use client";

import type { CSSProperties } from "react";

export function Sparkline({
  series,
  width = 120,
  height = 28,
  stroke = 1.5,
  color = "var(--crm-accent)",
  fill = "transparent",
  className,
  ariaLabel,
}: {
  series: number[];
  width?: number;
  height?: number;
  stroke?: number;
  color?: string;
  fill?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const n = Math.max(2, series.length);
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = Math.max(1, max - min);

  const points = series.map((v, i) => {
    const x = (i / (n - 1)) * w;
    const y = h - ((v - min) / span) * h;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const d = `M ${points[0]} L ${points.slice(1).join(" ")}`;

  // Optional area under the line when fill != transparent
  const areaD = `M 0,${h} L ${points.join(" ")} L ${w},${h} Z`;

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={ariaLabel}
      className={className}
      style={{ display: "block" } as CSSProperties}
    >
      {fill !== "transparent" ? (
        <path d={areaD} fill={fill} stroke="none" />
      ) : null}
      <path d={d} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" />
    </svg>
  );
}
