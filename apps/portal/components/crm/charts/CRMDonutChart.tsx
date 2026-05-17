"use client";

import type { ChartSegment } from "./types";

const CRM_CHART = {
  track: "var(--crm-border)",
  empty: "var(--crm-surface-2)",
} as const;

export function CRMDonutChart({
  segments,
  size = 128,
  stroke = 16,
  centerLabel,
  centerValue,
}: {
  segments: ChartSegment[];
  size?: number;
  stroke?: number;
  centerLabel?: string;
  centerValue?: string | number;
}) {
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;

  let offset = 0;
  const arcs =
    total > 0
      ? segments
          .filter((s) => s.value > 0)
          .map((seg) => {
            const len = (seg.value / total) * circumference;
            const dashoffset = -offset;
            offset += len;
            return (
              <circle
                key={seg.label}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke={seg.color}
                strokeWidth={stroke}
                strokeDasharray={`${len} ${circumference - len}`}
                strokeDashoffset={dashoffset}
                strokeLinecap="butt"
                transform={`rotate(-90 ${cx} ${cy})`}
              />
            );
          })
      : [];

  return (
    <div className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={CRM_CHART.track} strokeWidth={stroke} />
        {total === 0 ? (
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={CRM_CHART.empty} strokeWidth={stroke} strokeDasharray="4 6" />
        ) : (
          arcs
        )}
      </svg>
      {(centerLabel != null || centerValue != null) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-2 pointer-events-none">
          {centerValue != null ? (
            <span className="text-xl font-bold tabular-nums text-crm-text leading-none">{centerValue}</span>
          ) : null}
          {centerLabel ? (
            <span className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-crm-muted">{centerLabel}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}
