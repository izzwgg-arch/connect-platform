"use client";

import Link from "next/link";
import { GitBranch, ArrowRight, AlertTriangle, Clock } from "lucide-react";

export type IvrAnalyticsData = {
  range: string;
  totals: {
    ivrCalls: number;
    optionsPressed: number;
    timeouts: number;
    invalidEntries: number;
    directDials: number;
    dropOffs: number;
  };
  topOptions: Array<{ digit: string; count: number; label: string | null }>;
};

type Props = {
  data: IvrAnalyticsData | null;
  loading: boolean;
};

export function IvrAnalyticsCard({ data, loading }: Props) {
  const totals = data?.totals;
  const top = data?.topOptions ?? [];
  const maxCount = top.reduce((m, o) => Math.max(m, o.count), 0) || 1;
  const completionRate = totals && totals.ivrCalls > 0
    ? Math.round((totals.optionsPressed / totals.ivrCalls) * 100)
    : null;

  return (
    <section className="dash-v2-section dash-v2-ivr" aria-label="IVR analytics">
      <header className="dash-v2-section-head">
        <h2>IVR Analytics</h2>
        <span className="dash-v2-section-sub">Caller selections and drop-offs</span>
      </header>
      <div className="dash-v2-card dash-v2-ivr-card">
        <div className="dash-v2-ivr-grid">
          <div className="dash-v2-ivr-summary">
            <div className="dash-v2-ivr-stat">
              <span className="dash-v2-ivr-stat-icon" aria-hidden><GitBranch size={14} /></span>
              <span className="dash-v2-ivr-stat-label">Total IVR calls</span>
              <span className="dash-v2-ivr-stat-value">{loading && !data ? "…" : (totals?.ivrCalls ?? 0).toLocaleString()}</span>
            </div>
            <div className="dash-v2-ivr-stat">
              <span className="dash-v2-ivr-stat-label">Options pressed</span>
              <span className="dash-v2-ivr-stat-value">{loading && !data ? "…" : (totals?.optionsPressed ?? 0).toLocaleString()}</span>
              {completionRate !== null ? <span className="dash-v2-ivr-stat-meta">{completionRate}% completion</span> : null}
            </div>
            <div className="dash-v2-ivr-stat warn">
              <span className="dash-v2-ivr-stat-icon warn" aria-hidden><Clock size={14} /></span>
              <span className="dash-v2-ivr-stat-label">Timeouts</span>
              <span className="dash-v2-ivr-stat-value">{loading && !data ? "…" : (totals?.timeouts ?? 0).toLocaleString()}</span>
            </div>
            <div className="dash-v2-ivr-stat danger">
              <span className="dash-v2-ivr-stat-icon danger" aria-hidden><AlertTriangle size={14} /></span>
              <span className="dash-v2-ivr-stat-label">Invalid entries</span>
              <span className="dash-v2-ivr-stat-value">{loading && !data ? "…" : (totals?.invalidEntries ?? 0).toLocaleString()}</span>
            </div>
          </div>

          <div className="dash-v2-ivr-options">
            <div className="dash-v2-ivr-options-head">Most-selected options</div>
            {top.length === 0 ? (
              <div className="dash-v2-ivr-empty">No IVR selections in this range.</div>
            ) : (
              <ul className="dash-v2-ivr-bars" role="list">
                {top.map((opt) => {
                  const pct = Math.round((opt.count / maxCount) * 100);
                  return (
                    <li key={opt.digit} className="dash-v2-ivr-bar-row">
                      <span className="dash-v2-ivr-bar-digit">{opt.digit}</span>
                      <span className="dash-v2-ivr-bar-label">{opt.label || `Option ${opt.digit}`}</span>
                      <span className="dash-v2-ivr-bar-track" aria-hidden>
                        <span className="dash-v2-ivr-bar-fill" style={{ width: `${pct}%` }} />
                      </span>
                      <span className="dash-v2-ivr-bar-count">{opt.count}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
        <Link href="/pbx/ivr-routing" className="dash-v2-comm-cta">
          Manage IVR routing <ArrowRight size={14} aria-hidden />
        </Link>
      </div>
    </section>
  );
}
