/**
 * Shared CRM campaign-member Prisma where fragments (Phase 15C).
 * Each helper mirrors one historical predicate — no semantic normalization across routes.
 */

import type { Prisma } from "@connect/db";
import { crmCampaignActiveWhere } from "./crmAggregateBounds";

export type CrmNestedCampaignWhere = Record<string, unknown>;

/** Queue "all" tab: members not in terminal dialing outcomes. */
export const CRM_CAMPAIGN_MEMBER_QUEUE_TERMINAL_STATUSES = ["CONVERTED", "DO_NOT_CALL", "SKIPPED"] as const;

/**
 * Live actionable queue work (Phase 16C): member rows whose contact is active and not archived.
 * Campaign history retains all members; this predicate only scopes agent-facing workload.
 */
export const crmCampaignMemberQueueLiveContactWhere = {
  contact: { is: { active: true, archivedAt: null } },
} as const;

/**
 * Campaign auto-completion (Phase 16D): non-terminal member rows that still block COMPLETED
 * when the contact is live. Matches `checkAndAutoCompleteCampaign` status band + Phase 16C contact scope.
 */
export const crmCampaignMemberActionableNonTerminalWhere: Prisma.CrmCampaignMemberWhereInput = {
  status: { in: ["PENDING", "IN_PROGRESS", "CALLBACK"] },
  ...crmCampaignMemberQueueLiveContactWhere,
};

const PENDING_IN_PROGRESS = ["PENDING", "IN_PROGRESS"] as const;

/** Diagnostics + total active band: PENDING, IN_PROGRESS, CALLBACK on ACTIVE campaigns. */
const ACTIVE_MEMBER_STATUSES_DIAGNOSTICS = ["PENDING", "IN_PROGRESS", "CALLBACK"] as const;

/** CALLBACK before local midnight today (tenant-wide overdue). */
export function crmCallbackOverdueWhere(
  todayStart: Date,
  campaign: CrmNestedCampaignWhere = crmCampaignActiveWhere,
) {
  return {
    status: "CALLBACK" as const,
    callbackAt: { lt: todayStart },
    campaign,
  };
}

/**
 * Reports `/crm/reports/daily` + `/crm/reports/agents` + queue "due" counts:
 * `callbackAt <= end of local day` only (includes overdue; legacy report semantics).
 */
export function crmCallbackDueLteDayEndWhere(
  dayEnd: Date,
  campaign: CrmNestedCampaignWhere = crmCampaignActiveWhere,
) {
  return {
    status: "CALLBACK" as const,
    callbackAt: { lte: dayEnd },
    campaign,
  };
}

/**
 * Tasks stats + follow-ups: strict same-calendar-day window for callbacks.
 */
export function crmCallbackDueInCalendarDayWhere(
  todayStart: Date,
  todayEnd: Date,
  campaign: CrmNestedCampaignWhere = crmCampaignActiveWhere,
) {
  return {
    status: "CALLBACK" as const,
    callbackAt: { gte: todayStart, lte: todayEnd },
    campaign,
  };
}

/** Follow-ups: tomorrow 00:00 through Saturday end-of-week (existing report semantics). */
export function crmCallbackDueRestOfWeekWhere(
  tomorrowStart: Date,
  weekEnd: Date,
  campaign: CrmNestedCampaignWhere = crmCampaignActiveWhere,
) {
  return {
    status: "CALLBACK" as const,
    callbackAt: { gte: tomorrowStart, lte: weekEnd },
    campaign,
  };
}

/** Queue upcoming: CALLBACK with time >= start of tomorrow OR unset callback time. */
export function crmCallbackUpcomingOrUnsetWhere(
  startOfTomorrow: Date,
  campaign: CrmNestedCampaignWhere,
) {
  return {
    status: "CALLBACK" as const,
    OR: [{ callbackAt: { gte: startOfTomorrow } }, { callbackAt: null }],
    campaign,
  };
}

export function crmMemberPendingOrInProgressWhere(campaign: CrmNestedCampaignWhere = crmCampaignActiveWhere) {
  return {
    status: { in: [...PENDING_IN_PROGRESS] },
    campaign,
  };
}

/** My Queue remaining (non-terminal) on ACTIVE (or scoped) campaign. */
export function crmMemberQueueNonTerminalWhere(campaign: CrmNestedCampaignWhere) {
  return {
    status: { notIn: [...CRM_CAMPAIGN_MEMBER_QUEUE_TERMINAL_STATUSES] },
    campaign,
  };
}

/** Diagnostics snapshots: active work band including CALLBACK. */
export function crmMemberDiagnosticsActiveBandWhere(campaign: CrmNestedCampaignWhere = crmCampaignActiveWhere) {
  return {
    status: { in: [...ACTIVE_MEMBER_STATUSES_DIAGNOSTICS] },
    campaign,
  };
}

/** `/crm/queue` default filter: pending lanes; smart sort includes CALLBACK rows. */
export function crmQueueFilterPendingWhere(campaign: CrmNestedCampaignWhere, smartSort: boolean) {
  return {
    status: smartSort
      ? { in: [...ACTIVE_MEMBER_STATUSES_DIAGNOSTICS] }
      : { in: [...PENDING_IN_PROGRESS] },
    campaign,
  };
}
