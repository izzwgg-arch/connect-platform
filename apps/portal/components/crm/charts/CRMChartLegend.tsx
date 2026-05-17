"use client";

import type { ChartSegment } from "./types";

export function CRMChartLegend({ segments, showZero }: { segments: ChartSegment[]; showZero?: boolean }) {
  const rows = showZero ? segments : segments.filter((s) => s.value > 0);
  if (rows.length === 0) {
    return <p className="mt-3 text-xs text-crm-muted">No data yet</p>;
  }

  return (
    <ul className="mt-3 flex flex-col gap-1.5">
      {rows.map((seg) => (
        <li key={seg.label} className="flex items-center justify-between gap-2 text-xs">
          <span className="flex min-w-0 items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: seg.color }} aria-hidden />
            <span className="truncate text-crm-muted">{seg.label}</span>
          </span>
          <span className="shrink-0 font-semibold tabular-nums text-crm-text">{seg.value}</span>
        </li>
      ))}
    </ul>
  );
}
