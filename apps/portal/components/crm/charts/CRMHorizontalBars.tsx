"use client";

export type BarItem = {
  label: string;
  value: number;
  color: string;
};

export function CRMHorizontalBars({
  items,
  maxValue,
}: {
  items: BarItem[];
  maxValue?: number;
}) {
  const peak = maxValue ?? Math.max(1, ...items.map((i) => i.value));

  return (
    <ul className="flex w-full flex-col gap-3">
      {items.map((item) => {
        const pct = peak > 0 ? Math.min(100, (item.value / peak) * 100) : 0;
        return (
          <li key={item.label}>
            <div className="mb-1 flex items-center justify-between gap-2 text-xs">
              <span className="truncate text-crm-muted">{item.label}</span>
              <span className="shrink-0 font-semibold tabular-nums text-crm-text">{item.value}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-crm-surface-2">
              <div
                className="h-full rounded-full transition-[width] duration-300 ease-out"
                style={{ width: `${pct}%`, backgroundColor: item.color }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
