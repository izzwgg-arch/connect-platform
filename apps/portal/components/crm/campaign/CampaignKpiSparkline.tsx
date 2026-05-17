"use client";

/** Decorative sparkline — shape derived from label+value only (not historical data). */
export function CampaignKpiSparkline({
  seed,
  color,
  className,
}: {
  seed: string;
  color: string;
  className?: string;
}) {
  const bars: number[] = [];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  for (let i = 0; i < 12; i++) {
    h = (h * 1103515245 + 12345 + i) | 0;
    bars.push(0.25 + (Math.abs(h) % 75) / 100);
  }
  const w = 120;
  const bh = 36;
  const gap = 3;
  const barW = (w - gap * 11) / 12;

  return (
    <svg
      className={className}
      viewBox={`0 0 ${w} ${bh}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient id={`sp-${seed.replace(/\W/g, "")}`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor={color} stopOpacity="0.15" />
          <stop offset="100%" stopColor={color} stopOpacity="0.95" />
        </linearGradient>
      </defs>
      {bars.map((pct, i) => {
        const barH = pct * bh;
        return (
          <rect
            key={i}
            x={i * (barW + gap)}
            y={bh - barH}
            width={barW}
            height={barH}
            rx={2}
            fill={`url(#sp-${seed.replace(/\W/g, "")})`}
          />
        );
      })}
    </svg>
  );
}
