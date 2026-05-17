"use client";

import { CRMCard } from "../CRMCard";
import { CRMDonutChart, CRMHorizontalBars, CRMRingMetric } from "../charts";
import { CRM_CHART_COLORS } from "../charts/chartColors";
import { crm } from "../crmClasses";
import type { CampaignDetail } from "./campaignTypes";
import type { CampaignHealth } from "./campaignUtils";

export function CampaignPerformancePanel({
  campaign,
  health,
}: {
  campaign: CampaignDetail;
  health: CampaignHealth;
}) {
  const sc = campaign.statusCounts;
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

  const pacingDone = health.terminal;
  const pacingOpen = Math.max(0, health.total - pacingDone);

  return (
    <CRMCard className="p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <p className={crm.label}>Performance</p>
        <p className="text-[11px] text-crm-muted">Member status counts — no estimates</p>
      </div>
      <div className="grid gap-3 lg:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] lg:items-center">
        <div className="flex justify-center lg:justify-start">
          <CRMDonutChart
            segments={statusSegments.length ? statusSegments : [{ label: "Empty", value: 1, color: CRM_CHART_COLORS.muted }]}
            size={88}
            stroke={11}
            centerValue={health.total}
            centerLabel="members"
          />
        </div>
        <div className="min-w-0 px-1">
          <p className="text-[10px] font-bold uppercase tracking-wide text-crm-muted mb-2">Funnel</p>
          <CRMHorizontalBars items={funnelBars} />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:gap-3">
          <CRMRingMetric
            value={health.converted}
            max={health.total || 1}
            label="Converted"
            sublabel={`${health.conversionPct}%`}
            color={CRM_CHART_COLORS.success}
            size={64}
            stroke={7}
          />
          <CRMRingMetric
            value={pacingOpen}
            max={health.total || 1}
            label="Open"
            sublabel={`${pacingDone} done`}
            color={CRM_CHART_COLORS.accent}
            size={64}
            stroke={7}
          />
          <div className="col-span-2 rounded-crm border border-crm-border/70 bg-crm-surface-2/40 px-2.5 py-2">
            <p className="text-[10px] font-bold uppercase tracking-wide text-crm-muted">Callback pressure</p>
            <p className="text-xl font-bold tabular-nums text-crm-text">{health.callback}</p>
            <div className="mt-1.5 h-1.5 rounded-full bg-crm-surface-2 overflow-hidden">
              <div
                className="h-full rounded-full bg-crm-warning"
                style={{
                  width: `${health.total > 0 ? Math.min(100, (health.callback / health.total) * 100) : 0}%`,
                }}
              />
            </div>
            <p className="mt-1 text-[10px] text-crm-muted">
              Pending {sc["PENDING"] ?? 0} · In progress {sc["IN_PROGRESS"] ?? 0}
            </p>
          </div>
        </div>
      </div>
    </CRMCard>
  );
}
