"use client";

const TRACK = "var(--crm-border)";

export function CRMRingMetric({
  value,
  max,
  label,
  sublabel,
  color = "var(--crm-accent)",
  size = 88,
  stroke = 10,
}: {
  value: number;
  max: number;
  label: string;
  sublabel?: string;
  color?: string;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const pct = max > 0 ? Math.min(1, value / max) : 0;
  const len = pct * circumference;

  return (
    <div className="flex items-center gap-3">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={TRACK} strokeWidth={stroke} />
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
          <span className="text-lg font-bold tabular-nums leading-none text-crm-text">{value}</span>
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-crm-text">{label}</div>
        {sublabel ? <div className="mt-0.5 text-xs text-crm-muted">{sublabel}</div> : null}
      </div>
    </div>
  );
}
