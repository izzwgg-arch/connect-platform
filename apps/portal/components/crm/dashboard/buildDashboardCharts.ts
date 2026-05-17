import type { BarItem } from "../charts/CRMHorizontalBars";
import { CRM_CHART_COLORS } from "../charts/chartColors";
import type { ChartSegment } from "../charts/types";

export type PipelineStats = {
  total: number;
  leads: number;
  mine: number;
  recentlyAdded: number;
};

export type FollowUpShape = {
  callbacks: { overdue: { count: number }; dueToday: { count: number } };
  tasks: { overdue: { count: number }; dueToday: { count: number } };
};

export type DailyActivity = {
  dispositionsToday: number;
  callsLinkedToday: number;
  contactsCreatedToday: number;
  tasksDueToday: number;
  overdueTasks: number;
};

export function buildPipelineSegments(stats: PipelineStats): ChartSegment[] {
  const other = Math.max(0, stats.total - stats.leads);
  return [
    { label: "Leads", value: stats.leads, color: CRM_CHART_COLORS.accent },
    { label: "Other contacts", value: other, color: CRM_CHART_COLORS.muted },
  ];
}

export function buildGrowthSegments(stats: PipelineStats): ChartSegment[] {
  const established = Math.max(0, stats.total - stats.recentlyAdded);
  return [
    { label: "New (7d)", value: stats.recentlyAdded, color: CRM_CHART_COLORS.success },
    { label: "Established", value: established, color: CRM_CHART_COLORS.violet },
  ];
}

export function buildCampaignSegments(campaigns: { status: string }[]): ChartSegment[] {
  const active = campaigns.filter((c) => c.status === "ACTIVE").length;
  const paused = campaigns.filter((c) => c.status === "PAUSED").length;
  const other = Math.max(0, campaigns.length - active - paused);
  return [
    { label: "Active", value: active, color: CRM_CHART_COLORS.success },
    { label: "Paused", value: paused, color: CRM_CHART_COLORS.warning },
    { label: "Other", value: other, color: CRM_CHART_COLORS.muted },
  ];
}

export function buildFollowUpBars(data: FollowUpShape): BarItem[] {
  return [
    { label: "Overdue callbacks", value: data.callbacks.overdue.count, color: CRM_CHART_COLORS.danger },
    { label: "Callbacks due today", value: data.callbacks.dueToday.count, color: CRM_CHART_COLORS.warning },
    { label: "Overdue tasks", value: data.tasks.overdue.count, color: CRM_CHART_COLORS.danger },
    { label: "Tasks due today", value: data.tasks.dueToday.count, color: CRM_CHART_COLORS.accent },
  ];
}

export function buildTodayActivityBars(daily: DailyActivity): BarItem[] {
  return [
    { label: "Outcomes", value: daily.dispositionsToday, color: CRM_CHART_COLORS.success },
    { label: "Calls linked", value: daily.callsLinkedToday, color: CRM_CHART_COLORS.accent },
    { label: "New contacts", value: daily.contactsCreatedToday, color: CRM_CHART_COLORS.violet },
    { label: "Tasks due", value: daily.tasksDueToday, color: CRM_CHART_COLORS.warning },
    { label: "Overdue tasks", value: daily.overdueTasks, color: CRM_CHART_COLORS.danger },
  ];
}
