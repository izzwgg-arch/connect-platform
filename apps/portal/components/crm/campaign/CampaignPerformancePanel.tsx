"use client";

import { CRMHorizontalBars } from "../charts";
import { CRMRingMetric } from "../charts/CRMRingMetric";
import { CRM_CHART_COLORS } from "../charts/chartColors";
import { crm } from "../crmClasses";
import { cn } from "../cn";
import type { CampaignDetail } from "./campaignTypes";
import type { CampaignHealth } from "./campaignUtils";

/** Integrated performance surface — conversion ring, funnel, queue pressure (real health only). */
export function CampaignPerformancePanel({
  campaign: _campaign,
  health,
}: {
  campaign: CampaignDetail;
  health: CampaignHealth;
}) {
  const funnelBars = [
    { label: "Active queue", value: health.activeQueueWork, color: CRM_CHART_COLORS.accent },
    { label: "Callbacks", value: health.callback, color: CRM_CHART_COLORS.warning },
    { label: "Contacted+", value: health.contactedProgress, color: CRM_CHART_COLORS.violet },
    { label: "Converted", value: health.converted, color: CRM_CHART_COLORS.success },
  ];

  const queuePressurePct =
    health.total > 0 ? Math.min(100, Math.round((health.activeQueueWork / health.total) * 100)) : 0;
  const callbackSharePct =
    health.total > 0 ? Math.min(100, Math.round((health.callback / health.total) * 100)) : 0;

  return (
    <section className={crm.campaignPerformanceSurface} aria-label="Campaign performance">
      <div className={crm.campaignPerformanceSurfaceInner}>
        <div className={crm.campaignPerformanceZone}>
          <p className={crm.label}>Conversion</p>
          <div className="mt-3 flex flex-col items-center sm:items-start">
            <CRMRingMetric
              value={health.conversionPct}
              max={100}
              label={`${health.conversionPct}% converted`}
              sublabel={`${health.converted} of ${health.total} members`}
              color="var(--crm-success)"
              size={104}
              stroke={11}
            />
          </div>
        </div>

        <div className={crm.campaignPerformanceZone}>
          <p className={crm.label}>Contact funnel</p>
          <div className="mt-3 min-w-0">
            <CRMHorizontalBars items={funnelBars} />
          </div>
          <p className="mt-3 text-[10px] leading-snug text-crm-muted">
            Counts from live roster status — not a forecast.
          </p>
        </div>

        <div className={crm.campaignPerformanceZone}>
          <p className={crm.label}>Queue pressure</p>
          <div className="mt-3 space-y-3">
            <PressureMeter
              label="Active queue work"
              value={health.activeQueueWork}
              pct={queuePressurePct}
              tone="accent"
            />
            <PressureMeter
              label="Callbacks"
              value={health.callback}
              pct={callbackSharePct}
              tone="warn"
            />
          </div>
          <p className="mt-3 text-[10px] leading-snug text-crm-muted">
            Share of roster in pending + in progress, and in CALLBACK.
          </p>
        </div>
      </div>
    </section>
  );
}

function PressureMeter({
  label,
  value,
  pct,
  tone,
}: {
  label: string;
  value: number;
  pct: number;
  tone: "accent" | "warn";
}) {
  const barClass = tone === "warn" ? "bg-crm-warning" : "bg-crm-accent";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-crm-text">{label}</span>
        <span className="tabular-nums font-bold text-crm-text">
          {value}
          <span className="ml-1 text-[10px] font-semibold text-crm-muted">({pct}%)</span>
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-crm-surface-2">
        <div className={cn("h-full rounded-full transition-[width] duration-500", barClass)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
