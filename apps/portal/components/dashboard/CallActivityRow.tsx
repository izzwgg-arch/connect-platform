"use client";

import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowLeftRight, PhoneMissed, XCircle } from "lucide-react";

type Tone = "incoming" | "outgoing" | "internal" | "missed" | "canceled";

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

const TILE_DEFS: Array<{ tone: Tone; key: keyof KpiTotals; label: string; icon: ReactNode }> = [
  { tone: "incoming", key: "incoming", label: "Incoming", icon: <ArrowDown size={16} aria-hidden /> },
  { tone: "outgoing", key: "outgoing", label: "Outgoing", icon: <ArrowUp size={16} aria-hidden /> },
  { tone: "internal", key: "internal", label: "Internal", icon: <ArrowLeftRight size={16} aria-hidden /> },
  { tone: "missed",   key: "missed",   label: "Missed",   icon: <PhoneMissed size={16} aria-hidden /> },
  { tone: "canceled", key: "canceled", label: "Canceled", icon: <XCircle size={16} aria-hidden /> },
];

function fmtNumber(value: number | null, loading: boolean): string {
  if (loading && value === null) return "…";
  if (value === null || value === undefined) return "—";
  return value.toLocaleString();
}

export function CallActivityRow({ totals, loading = false }: Props) {
  return (
    <section className="dash-v2-section dash-v2-kpi-row" aria-label="Call activity">
      <header className="dash-v2-section-head">
        <h2>Call Activity</h2>
      </header>
      <div className="dash-v2-kpi-grid">
        {TILE_DEFS.map((def) => {
          const value = totals[def.key];
          return (
            <div key={def.key} className={`dash-v2-kpi-card tone-${def.tone}`}>
              <div className="dash-v2-kpi-card-head">
                <span className={`dash-v2-kpi-icon tone-${def.tone}`} aria-hidden>{def.icon}</span>
                <span className="dash-v2-kpi-label">{def.label}</span>
              </div>
              <span className="dash-v2-kpi-value">{fmtNumber(value, loading)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
