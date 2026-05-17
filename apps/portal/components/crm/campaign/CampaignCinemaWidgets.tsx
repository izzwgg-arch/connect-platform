"use client";

export function CampaignCinemaRing({
  pct,
  converted,
  total,
}: {
  pct: number;
  converted: number;
  total: number;
}) {
  const size = 148;
  const stroke = 14;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const len = (pct / 100) * c;

  return (
    <div className="flex flex-col items-center gap-3 sm:items-start">
      <div className="relative" style={{ width: size, height: size }}>
        <div
          className="pointer-events-none absolute inset-[-24%] rounded-full bg-[radial-gradient(circle,rgba(52,211,153,0.4),transparent_68%)]"
          aria-hidden
        />
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="relative z-[1]">
          <defs>
            <linearGradient id="cinema-ring-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#6ee7b7" />
              <stop offset="55%" stopColor="#34d399" />
              <stop offset="100%" stopColor="#2563eb" />
            </linearGradient>
          </defs>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="rgba(255,255,255,0.07)"
            strokeWidth={stroke}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="url(#cinema-ring-grad)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${len} ${c - len}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
        <div className="absolute inset-0 z-[2] flex flex-col items-center justify-center">
          <span className="text-[2rem] font-bold tabular-nums text-white">{pct}%</span>
        </div>
      </div>
      <div>
        <p className="text-sm font-bold text-white">Conversion rate</p>
        <p className="mt-1 text-xs text-[#8b9cb3]">
          {converted} of {total} members
        </p>
      </div>
    </div>
  );
}

export function CampaignCinemaFunnel({
  stages,
}: {
  stages: { label: string; value: number; pct: number }[];
}) {
  const max = Math.max(...stages.map((s) => s.value), 1);
  const colors = ["#a5b4fc", "#818cf8", "#6366f1", "#4f46e5"];

  return (
    <div className="flex min-h-[12rem] flex-col justify-center gap-2.5 py-2">
      {stages.map((s, i) => {
        const widthPct = 38 + (s.value / max) * 58;
        return (
          <div key={s.label} className="flex items-center gap-3">
            <div
              className="h-10 rounded-lg shadow-[0_6px_20px_-4px_rgba(99,102,241,0.45)]"
              style={{
                width: `${widthPct}%`,
                background: `linear-gradient(90deg, ${colors[i] ?? colors[3]}55, ${colors[i] ?? colors[3]})`,
                clipPath: "polygon(0 0, 100% 0, 96% 100%, 0% 100%)",
              }}
            />
            <div className="min-w-[5.5rem] shrink-0 text-right">
              <p className="text-xs font-bold text-white">{s.label}</p>
              <p className="text-[10px] tabular-nums text-[#a5b4fc]">
                {s.value} · {s.pct}%
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function CampaignCinemaGauge({
  waiting,
  pct,
}: {
  waiting: number;
  pct: number;
}) {
  const w = 168;
  const h = 92;
  const stroke = 11;
  const r = (w - stroke) / 2;
  const arc = Math.PI * r;
  const len = (pct / 100) * arc;
  const tone = pct >= 66 ? "High" : pct >= 33 ? "Medium" : "Low";
  const toneColor = pct >= 66 ? "#f87171" : pct >= 33 ? "#fbbf24" : "#34d399";

  return (
    <div className="flex flex-col items-center">
      <div className="relative">
        <div
          className="pointer-events-none absolute inset-[-30%] rounded-full bg-[radial-gradient(circle,rgba(251,191,36,0.25),transparent_70%)]"
          aria-hidden
        />
        <svg width={w} height={h + 10} viewBox={`0 0 ${w} ${h + 10}`} className="relative z-[1]" aria-hidden>
          <defs>
            <linearGradient id="cinema-gauge-grad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#34d399" />
              <stop offset="45%" stopColor="#fbbf24" />
              <stop offset="100%" stopColor="#f87171" />
            </linearGradient>
          </defs>
          <path
            d={`M ${stroke / 2} ${h} A ${r} ${r} 0 0 1 ${w - stroke / 2} ${h}`}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={stroke}
            strokeLinecap="round"
          />
          <path
            d={`M ${stroke / 2} ${h} A ${r} ${r} 0 0 1 ${w - stroke / 2} ${h}`}
            fill="none"
            stroke="url(#cinema-gauge-grad)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${len} ${arc}`}
          />
        </svg>
      </div>
      <p className="-mt-1 text-[1.65rem] font-bold" style={{ color: toneColor }}>
        {tone}
      </p>
      <p className="text-xs font-medium text-[#8b9cb3]">{waiting} calls waiting</p>
      <p className="mt-0.5 text-[10px] tabular-nums text-[#6d7f99]">{pct}% queue share</p>
    </div>
  );
}
