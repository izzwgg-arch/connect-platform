"use client";

import { cn } from "../cn";
import { mk } from "./campaignCinemaClasses";
import type { CampaignDetail } from "./campaignTypes";
import type { CampaignHealth } from "./campaignUtils";
import {
  CampaignCinemaFunnel,
  CampaignCinemaGauge,
  CampaignCinemaRing,
} from "./CampaignCinemaWidgets";

export function CampaignPerformancePanel({
  campaign: _campaign,
  health,
}: {
  campaign: CampaignDetail;
  health: CampaignHealth;
}) {
  const funnelStages = [
    {
      label: "Active queue",
      value: health.activeQueueWork,
      pct: health.total > 0 ? Math.round((health.activeQueueWork / health.total) * 100) : 0,
    },
    {
      label: "Callbacks",
      value: health.callback,
      pct: health.total > 0 ? Math.round((health.callback / health.total) * 100) : 0,
    },
    {
      label: "Contacted+",
      value: health.contactedProgress,
      pct: health.total > 0 ? Math.round((health.contactedProgress / health.total) * 100) : 0,
    },
    {
      label: "Converted",
      value: health.converted,
      pct: health.conversionPct,
    },
  ];

  const queuePressurePct =
    health.total > 0 ? Math.min(100, Math.round((health.activeQueueWork / health.total) * 100)) : 0;

  return (
    <section className={mk.perfShell} aria-label="Performance overview">
      <div className="crm-cinema-perf-header">
        <h2 className={mk.perfSectionTitle}>Performance overview</h2>
        <p className={mk.perfSectionSub}>Live roster snapshot — not a forecast</p>
      </div>
      <div className={mk.perfGrid}>
        <div className={mk.perfWidget}>
          <div className={cn(mk.perfWidgetGlow, "cinema-perf-glow--ring")} />
          <p className="relative z-[1] cinema-widget-label">Conversion ring</p>
          <div className="relative z-[1] mt-4 flex flex-1 items-center justify-center lg:justify-start">
            <CampaignCinemaRing
              pct={health.conversionPct}
              converted={health.converted}
              total={health.total}
            />
          </div>
        </div>

        <div className={mk.perfWidget}>
          <div className={cn(mk.perfWidgetGlow, "cinema-perf-glow--funnel")} />
          <p className="relative z-[1] cinema-widget-label">Conversion funnel</p>
          <div className="relative z-[1] mt-2">
            <CampaignCinemaFunnel stages={funnelStages} />
          </div>
        </div>

        <div className={mk.perfWidget}>
          <div className={cn(mk.perfWidgetGlow, "cinema-perf-glow--gauge")} />
          <p className="relative z-[1] cinema-widget-label">Live queue pressure</p>
          <div className="relative z-[1] mt-4 flex flex-1 items-center justify-center">
            <CampaignCinemaGauge waiting={health.activeQueueWork} pct={queuePressurePct} />
          </div>
        </div>
      </div>
    </section>
  );
}
