"use client";

import { CRMCard } from "../CRMCard";
import { CRMDonutChart, CRMHorizontalBars } from "../charts";
import { CRM_CHART_COLORS } from "../charts/chartColors";
import { crm } from "../crmClasses";
import type { CampaignDetail } from "./campaignTypes";
import type { CampaignHealth } from "./campaignUtils";

/** Funnel + status mix only — roster counts live in CampaignCommandHeader snapshot. */
export function CampaignPerformancePanel({
  campaign: _campaign,
  health,
}: {
  campaign: CampaignDetail;
  health: CampaignHealth;
}) {
  const statusSegments = [
    { label: "Pending", value: health.pending, color: CRM_CHART_COLORS.muted },
    { label: "In progress", value: health.inProgress, color: CRM_CHART_COLORS.accent },
    { label: "Callback", value: health.callback, color: CRM_CHART_COLORS.warning },
    { label: "Contacted", value: health.contactedOnly, color: CRM_CHART_COLORS.violet },
    { label: "Converted", value: health.converted, color: CRM_CHART_COLORS.success },
    { label: "Skipped / DNC", value: health.skipped + health.dnc, color: CRM_CHART_COLORS.danger },
  ].filter((s) => s.value > 0);

  const funnelBars = [
    { label: "Active queue", value: health.activeQueueWork, color: CRM_CHART_COLORS.accent },
    { label: "Callbacks", value: health.callback, color: CRM_CHART_COLORS.warning },
    { label: "Contacted+", value: health.contactedProgress, color: CRM_CHART_COLORS.violet },
    { label: "Converted", value: health.converted, color: CRM_CHART_COLORS.success },
  ];

  const terminalPct =
    health.total > 0 ? Math.round((health.terminal / health.total) * 100) : 0;

  return (
    <CRMCard className="p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <p className={crm.label}>Performance</p>
        <p className="text-[11px] text-crm-muted">Status mix and funnel — counts are in live snapshot above</p>
      </div>
      <div className="grid gap-4 md:grid-cols-[minmax(0,200px)_minmax(0,1fr)] md:items-center">
        <div className="flex flex-col items-center md:items-start">
          <CRMDonutChart
            segments={statusSegments.length ? statusSegments : [{ label: "Empty", value: 1, color: CRM_CHART_COLORS.muted }]}
            size={96}
            stroke={12}
            centerLabel="Status mix"
          />
        </div>
        <div className="min-w-0 space-y-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wide text-crm-muted mb-2">Contact funnel</p>
            <CRMHorizontalBars items={funnelBars} />
          </div>
          <div className="rounded-crm border border-crm-border/70 bg-crm-surface-2/40 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-wide text-crm-muted">
              <span>Terminal outcomes</span>
              <span className="tabular-nums text-crm-text">{terminalPct}%</span>
            </div>
            <div className="mt-2 h-2 rounded-full bg-crm-surface-2 overflow-hidden">
              <div className="h-full rounded-full bg-crm-success" style={{ width: `${terminalPct}%` }} />
            </div>
            <p className="mt-1.5 text-[10px] text-crm-muted">
              Share of roster in converted, skipped, or DNC — not a forecast.
            </p>
          </div>
        </div>
      </div>
    </CRMCard>
  );
}