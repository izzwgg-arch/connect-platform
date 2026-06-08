"use client";

import type { LucideIcon } from "lucide-react";
import { ArrowDown, ArrowLeftRight, ArrowUp, PhoneMissed, XCircle } from "lucide-react";
import { cn } from "../crm/cn";
import { crm } from "../crm/crmClasses";

type Accent = "blue" | "green" | "violet" | "rose" | "amber";

type KpiTotals = {
  incoming: number | null;
  outgoing: number | null;
  internal: number | null;
  missed: number | null;
  canceled: number | null;
};

type Props = {
  totals: KpiTotals;
  loading?: boolean;
};

const TILE_DEFS: Array<{ accent: Accent; key: keyof KpiTotals; label: string; icon: LucideIcon }> = [
  { accent: "blue", key: "incoming", label: "Incoming", icon: ArrowDown },
  { accent: "green", key: "outgoing", label: "Outgoing", icon: ArrowUp },
  { accent: "violet", key: "internal", label: "Internal", icon: ArrowLeftRight },
  { accent: "rose", key: "missed", label: "Missed", icon: PhoneMissed },
  { accent: "amber", key: "canceled", label: "Canceled", icon: XCircle },
];

function fmtNumber(value: number | null, loading: boolean): string {
  if (loading && value === null) return "…";
  if (value === null || value === undefined) return "—";
  return value.toLocaleString();
}

function KpiTile({
  label,
  value,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  accent: Accent;
}) {
  return (
    <div className={cn(crm.queueCountPill, `crm-queue-kpi-${accent}`, "relative overflow-hidden bg-crm-surface-2")}>
      <span className="flex w-full items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="crm-queue-kpi-label block text-[10px] font-bold uppercase tracking-wide text-crm-muted">
            {label}
          </span>
          <span className="crm-queue-kpi-value mt-1 block text-2xl font-bold tabular-nums leading-none tracking-tight">
            {value}
          </span>
        </span>
        <span className="crm-queue-kpi-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-crm border border-crm-border/55 bg-crm-surface/70 text-crm-accent">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
      </span>
    </div>
  );
}

export function CallActivityRow({ totals, loading = false }: Props) {
  return (
    <section className="dash-v2-section dash-v2-kpi-row" aria-label="Call activity">
      <header className="dash-v2-section-head">
        <h2>Call Activity</h2>
      </header>
      <section
        className="crm-queue-kpi-strip grid w-full grid-cols-2 items-stretch gap-3 md:grid-cols-3 xl:grid-cols-5"
        aria-label="Call activity metrics"
      >
        {TILE_DEFS.map((def) => (
          <KpiTile
            key={def.key}
            label={def.label}
            value={fmtNumber(totals[def.key], loading)}
            icon={def.icon}
            accent={def.accent}
          />
        ))}
      </section>
    </section>
  );
}
