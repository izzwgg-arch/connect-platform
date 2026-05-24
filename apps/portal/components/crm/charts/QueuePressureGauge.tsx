"use client";

import type { CSSProperties } from "react";

/**
 * QueuePressureGauge — radial gauge with 3-state interpretation.
 * Theme-aware via CRM CSS variables. No external chart libs.
 */
export function QueuePressureGauge({
  value,
  max = 200,
  thresholds = { low: 25, moderate: 75 },
  size = 140,
  stroke = 12,
  className,
}: {
  value: number;
  max?: number;
  thresholds?: { low: number; moderate: number };
  size?: number;
  stroke?: number;
  className?: string;
}) {
  const v = Math.max(0, Math.min(max, Number.isFinite(value) ? value : 0));
  const pct = max > 0 ? v / max : 0;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const len = pct * circumference;

  const COLOR = {
    neutral: "var(--crm-accent)",
    success: "var(--crm-success)",
    warning: "var(--crm-warning)",
    danger: "var(--crm-danger)",
  } as const;
  type ToneKey = keyof typeof COLOR;

  let tone: ToneKey = "neutral";
  if (v <= thresholds.low) tone = "success"; // low
  else if (v <= thresholds.moderate) tone = "warning"; // moderate
  else tone = "danger"; // elevated

  const color = COLOR[tone];

  const trackStyle: CSSProperties = { filter: "drop-shadow(0 1px 0 rgba(255,255,255,0.06))" };

  return (
    <div className={className} style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--crm-border)" strokeWidth={stroke} style={trackStyle} />
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeDasharray={`${len} ${circumference - len}`}
            strokeLinecap="round"
            transform={`rotate(-90 ${cx} ${cy})`}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold tabular-nums leading-none text-crm-text">{v}</span>
          <span className="mt-1 text-[10px] font-bold uppercase tracking-wider text-crm-muted">Queue pressure</span>
          <span
            className={
              tone === "danger"
                ? "text-crm-danger"
                : tone === "warning"
                ? "text-crm-warning"
                : "text-crm-success"
            }
            style={{ fontSize: 12, fontWeight: 700 }}
          >
            {tone === "danger" ? "Elevated" : tone === "warning" ? "Moderate" : "Low"}
          </span>
        </div>
      </div>
    </div>
  );
}
