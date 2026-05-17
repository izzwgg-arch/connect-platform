"use client";

import { CRMCard } from "../CRMCard";
import { CRMSection } from "../CRMSection";
import { CRMDonutChart, CRMChartLegend, CRMHorizontalBars, CRMRingMetric } from "../charts";
import { CRM_CHART_COLORS } from "../charts/chartColors";
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
    <CRMSection title="Performance" description="From campaign member status counts — no estimates.">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <CRMCard className="flex flex-col items-center p-4 sm:col-span-2 xl:col-span-1">
          <CRMDonutChart
            segments={statusSegments.length ? statusSegments : [{ label: "Empty", value: 1, color: CRM_CHART_COLORS.muted }]}
            size={112}
            stroke={14}
            centerValue={health.total}
            centerLabel="members"
          />
          <div className="mt-3 w-full">
            <CRMChartLegend segments={statusSegments} />
          </div>
        </CRMCard>

        <CRMCard className="p-4">
          <p className="text-[10px] font-bold uppercase tracking-wide text-crm-muted mb-3">Contact funnel</p>
          <CRMHorizontalBars items={funnelBars} />
        </CRMCard>

        <CRMCard className="p-4 flex flex-col justify-center gap-4">
          <CRMRingMetric
            value={health.converted}
            max={health.total || 1}
            label="Conversion progress"
            sublabel={`${health.conversionPct}% converted`}
            color={CRM_CHART_COLORS.success}
          />
          <CRMRingMetric
            value={pacingOpen}
            max={health.total || 1}
            label="Open workload"
            sublabel={`${pacingDone} terminal outcomes`}
            color={CRM_CHART_COLORS.accent}
          />
        </CRMCard>

        <CRMCard className="p-4 sm:col-span-2 xl:col-span-1">
          <p className="text-[10px] font-bold uppercase tracking-wide text-crm-muted mb-2">Callback pressure</p>
          <p className="text-3xl font-bold tabular-nums text-crm-text">{health.callback}</p>
          <p className="text-xs text-crm-muted mt-1">Members in CALLBACK status</p>
          <div className="mt-4 h-2 rounded-full bg-crm-surface-2 overflow-hidden">
            <div
              className="h-full rounded-full bg-crm-warning"
              style={{
                width: `${health.total > 0 ? Math.min(100, (health.callback / health.total) * 100) : 0}%`,
              }}
            />
          </div>
          <p className="mt-2 text-[11px] text-crm-muted">
            Pending {sc["PENDING"] ?? 0} · In progress {sc["IN_PROGRESS"] ?? 0}
          </p>
        </CRMCard>
      </div>
    </CRMSection>
  );
}
