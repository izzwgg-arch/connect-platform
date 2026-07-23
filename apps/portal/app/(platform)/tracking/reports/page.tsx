"use client";

import { useEffect, useState } from "react";
import { BarChart3 } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm, cn } from "../../../../components/crm";
import { deliveryApi, type ReportSummary } from "../../../../services/deliveryApi";

const RANGES = [7, 14, 30, 90] as const;

type Tone = "neutral" | "accent" | "success" | "danger";

const TONE_VALUE: Record<Tone, string> = {
  neutral: "text-crm-text",
  accent: "text-crm-accent",
  success: "text-crm-success",
  danger: "text-crm-danger",
};

// Humanize a reason_code: "customer_unavailable" -> "Customer unavailable"
function humanize(code: string): string {
  const s = code.replace(/_/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Unknown";
}

function StatTile({
  label,
  value,
  tone = "neutral",
  approx = false,
}: {
  label: string;
  value: string;
  tone?: Tone;
  approx?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-crm-lg border border-crm-border bg-crm-surface-2 px-4 py-3.5">
      <span className={crm.label}>{label}</span>
      <span className={cn("text-2xl font-semibold tabular-nums leading-none", TONE_VALUE[tone])}>
        {approx ? <span className="text-crm-muted">~</span> : null}
        {value}
        {approx ? <sup className="ml-0.5 align-super text-[10px] font-medium text-crm-muted">approx</sup> : null}
      </span>
    </div>
  );
}

export default function TrackingReportsPage() {
  const [days, setDays] = useState<number>(7);
  const [data, setData] = useState<ReportSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notEnabled, setNotEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setNotEnabled(false);
    deliveryApi
      .report(days)
      .then((r) => {
        if (active) setData(r);
      })
      .catch((e) => {
        if (!active) return;
        if (e?.message === "delivery_not_enabled") setNotEnabled(true);
        else setError("Couldn't load reporting for this range.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [days]);

  const isApprox = (key: string) => Boolean(data?.approximateMetrics?.includes(key));

  const reasons = data?.topFailedReasons ?? [];
  const maxCount = reasons.reduce((m, r) => Math.max(m, r.count), 0);

  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader
        icon={<BarChart3 size={20} />}
        title="Reporting"
        subtitle="Delivery performance drawn from real telemetry — no fabricated figures."
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                className={days === r ? crm.filterPillActive : crm.filterPill}
                aria-pressed={days === r}
                onClick={() => setDays(r)}
              >
                {r} days
              </button>
            ))}
          </div>
        }
      />

      {notEnabled ? (
        <CRMCard>
          <p className="text-sm text-crm-text">Delivery isn't enabled for this tenant yet.</p>
          <p className="mt-2 text-sm text-crm-muted">
            Reporting activates once delivery tracking is switched on and the first orders flow through.
          </p>
        </CRMCard>
      ) : error ? (
        <CRMCard>
          <p className="text-sm text-crm-muted">{error}</p>
        </CRMCard>
      ) : loading ? (
        <CRMCard>
          <p className="text-sm text-crm-muted">Loading…</p>
        </CRMCard>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Orders received" value={data.ordersReceived.toLocaleString()} />
            <StatTile label="Delivered" value={data.delivered.toLocaleString()} tone="success" />
            <StatTile label="Failed" value={data.failed.toLocaleString()} tone="danger" />
            <StatTile label="Success rate" value={`${data.successRatePct}%`} tone="accent" />
            <StatTile label="First-attempt" value={`${data.firstAttemptPct}%`} tone="accent" />
            <StatTile
              label="Avg delivery (min)"
              value={String(data.avgDeliveryMinutes)}
              approx={isApprox("avgDeliveryMinutes")}
            />
            <StatTile
              label="ETA accuracy"
              value={`${data.etaAccuracyPct}%`}
              tone="accent"
              approx={isApprox("etaAccuracyPct")}
            />
          </div>

          {(isApprox("etaAccuracyPct") || isApprox("avgDeliveryMinutes")) && (
            <p className={crm.footnote}>≈ approximate — refined as more telemetry lands.</p>
          )}

          <CRMCard>
            <h2 className="text-sm font-semibold text-crm-text">Top failed reasons</h2>
            {reasons.length === 0 ? (
              <p className="mt-3 text-sm text-crm-muted">No failed deliveries in this range.</p>
            ) : (
              <div className="mt-4 flex flex-col gap-3">
                {reasons.map((r) => (
                  <div key={r.reason} className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-crm-text">{humanize(r.reason)}</span>
                      <span className="tabular-nums text-crm-muted">{r.count.toLocaleString()}</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-crm-surface-2">
                      <div
                        className="h-full rounded-full bg-crm-danger/40"
                        style={{ width: `${maxCount > 0 ? Math.max(4, (r.count / maxCount) * 100) : 0}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CRMCard>
        </>
      ) : null}
    </CRMPageShell>
  );
}
