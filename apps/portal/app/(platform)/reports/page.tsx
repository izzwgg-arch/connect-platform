"use client";

import { DetailCard } from "../../../components/DetailCard";
import Link from "next/link";
import { ErrorState } from "../../../components/ErrorState";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { MetricCard } from "../../../components/MetricCard";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { ScopeBadge } from "../../../components/ScopeBadge";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { loadReportsData } from "../../../services/platformData";

export default function ReportsPage() {
  const { adminScope } = useAppContext();
  const state = useAsyncResource(() => loadReportsData(adminScope), [adminScope]);
  if (state.status === "loading") return <LoadingSkeleton rows={5} />;
  if (state.status === "error") return <ErrorState message={state.error} />;
  const { metrics, scopeLabel } = state.data;

  return (
    <PermissionGate permission="can_view_reports" fallback={<div className="state-box">You do not have reports access.</div>}>
      <div className="stack">
      <PageHeader
        title="Reports"
        subtitle={`Operational reporting for calls, messaging, registrations, and usage (${scopeLabel.toLowerCase()} scope).`}
        badges={<ScopeBadge scope={scopeLabel} />}
      />
      <section className="metric-grid">
        {metrics.map((metric) => (
          <MetricCard key={metric.label} label={metric.label} value={metric.value} meta={metric.delta} />
        ))}
      </section>
      <section className="grid two">
        <DetailCard title="Call Activity">
          <ul className="list">
            <li>Use CDR report for direction/disposition filters.</li>
            <li>Use PBX call reports for per-extension performance.</li>
            <li>Trend windows: 24h / 7d / 30d from report routes.</li>
          </ul>
          <div className="row-actions">
            <Link className="btn ghost" href="/reports/cdr">Open CDR</Link>
          </div>
        </DetailCard>
        <DetailCard title="Registration Health">
          <ul className="list">
            <li>Review registered extension totals on Dashboard.</li>
            <li>Use PBX Extensions for registration-specific fields.</li>
            <li>Use SBC connectivity for transport diagnostics.</li>
          </ul>
          <div className="row-actions">
            <Link className="btn ghost" href="/pbx/extensions">Open Extensions</Link>
          </div>
        </DetailCard>
      </section>
      </div>
    </PermissionGate>
  );
}
