"use client";

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
      <div className="border-b border-white/[0.06] px-5 py-4 sm:px-6">
        <h2 className="text-lg font-bold text-white">Performance overview</h2>
        <p className="mt-0.5 text-xs text-[#8b9cb3]">Live roster snapshot — not a forecast</p>
      </div>
      <div className={mk.perfGrid}>
        <div className={mk.perfWidget}>
          <div
            className={mk.perfWidgetGlow}
            style={{
              background:
                "radial-gradient(ellipse 80% 70% at 30% 20%, rgba(52,211,153,0.2), transparent 60%)",
            }}
          />
          <p className="relative z-[1] text-[10px] font-bold uppercase tracking-wider text-[#6d7f99]">
            Conversion ring
          </p>
          <div className="relative z-[1] mt-4 flex flex-1 items-center justify-center lg:justify-start">
            <CampaignCinemaRing
              pct={health.conversionPct}
              converted={health.converted}
              total={health.total}
            />
          </div>
        </div>

        <div className={mk.perfWidget}>
          <div
            className={mk.perfWidgetGlow}
            style={{
              background:
                "radial-gradient(ellipse 80% 70% at 50% 30%, rgba(99,102,241,0.22), transparent 65%)",
            }}
          />
          <p className="relative z-[1] text-[10px] font-bold uppercase tracking-wider text-[#6d7f99]">
            Conversion funnel
          </p>
          <div className="relative z-[1] mt-2">
            <CampaignCinemaFunnel stages={funnelStages} />
          </div>
        </div>

        <div className={mk.perfWidget}>
          <div
            className={mk.perfWidgetGlow}
            style={{
              background:
                "radial-gradient(ellipse 80% 70% at 60% 40%, rgba(251,191,36,0.18), transparent 65%)",
            }}
          />
          <p className="relative z-[1] text-[10px] font-bold uppercase tracking-wider text-[#6d7f99]">
            Live queue pressure
          </p>
          <div className="relative z-[1] mt-4 flex flex-1 items-center justify-center">
            <CampaignCinemaGauge waiting={health.activeQueueWork} pct={queuePressurePct} />
          </div>
        </div>
      </div>
    </section>
  );
}
