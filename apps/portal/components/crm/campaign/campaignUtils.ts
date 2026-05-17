import type { CampaignDetail, CampaignImportHistoryRow, CampaignReportRow, WorkloadRow } from "./campaignTypes";

export function formatShortDate(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

export function formatImportTimestamp(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function campaignImportStatusLabel(s: string) {
  switch (s) {
    case "PENDING":
      return "Pending";
    case "PROCESSING":
      return "Processing";
    case "DONE":
      return "Done";
    case "PARTIAL":
      return "Partial";
    case "FAILED":
      return "Failed";
    default:
      return s;
  }
}

export function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function callbackUrgency(callbackAt: string | null): {
  label: string;
  tier: "overdue" | "due" | "scheduled" | "none";
} {
  if (!callbackAt) return { label: "No callback", tier: "none" };
  const d = new Date(callbackAt);
  const diff = d.getTime() - Date.now();
  if (diff < 0) {
    const abs = Math.abs(diff) / 1000;
    if (abs >= 86400) return { label: `Overdue ${Math.floor(abs / 86400)}d`, tier: "overdue" };
    return {
      label: `Overdue ${Math.floor(abs / 3600)}h`,
      tier: "overdue",
    };
  }
  if (diff < 3600) return { label: `Due in ${Math.floor(diff / 60000)}m`, tier: "due" };
  if (diff < 86400) return { label: `Due in ${Math.floor(diff / 3600000)}h`, tier: "due" };
  return {
    label: d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
    tier: "scheduled",
  };
}

export type CampaignHealth = {
  pending: number;
  inProgress: number;
  callback: number;
  contactedOnly: number;
  converted: number;
  skipped: number;
  dnc: number;
  total: number;
  activeQueueWork: number;
  unassignedMembers: number;
  contactedProgress: number;
  terminal: number;
  conversionPct: number;
  activeAgents: number;
};

export function deriveCampaignHealth(
  campaign: CampaignDetail,
  workload: WorkloadRow[],
): CampaignHealth {
  const sc = campaign.statusCounts;
  const pending = sc["PENDING"] ?? 0;
  const inProgress = sc["IN_PROGRESS"] ?? 0;
  const callback = sc["CALLBACK"] ?? 0;
  const contactedOnly = sc["CONTACTED"] ?? 0;
  const converted = sc["CONVERTED"] ?? 0;
  const skipped = sc["SKIPPED"] ?? 0;
  const dnc = sc["DO_NOT_CALL"] ?? 0;
  const total = campaign.memberCount;
  const unassignedRow = workload.find((w) => w.userId === null);
  const activeAgents = workload.filter((w) => w.userId != null && w.total > 0).length;

  return {
    pending,
    inProgress,
    callback,
    contactedOnly,
    converted,
    skipped,
    dnc,
    total,
    activeQueueWork: pending + inProgress,
    unassignedMembers: unassignedRow?.total ?? 0,
    contactedProgress: contactedOnly + callback + converted,
    terminal: converted + skipped + dnc,
    conversionPct: total > 0 ? Math.round((converted / total) * 100) : 0,
    activeAgents,
  };
}

export function mergeCampaignMetrics(
  campaigns: { id: string }[],
  reports: CampaignReportRow[] | null,
): Map<string, CampaignReportRow> {
  const map = new Map<string, CampaignReportRow>();
  if (!reports) return map;
  for (const r of reports) map.set(r.id, r);
  for (const c of campaigns) {
    if (!map.has(c.id)) continue;
  }
  return map;
}

export function queueHref(campaignId: string, filter?: "overdue" | "due" | "pending") {
  const params = new URLSearchParams({ campaignId });
  if (filter) params.set("filter", filter);
  return `/crm/queue?${params}`;
}

export function powerQueueHref(campaignId: string, filter?: "overdue" | "due") {
  const params = new URLSearchParams({ mode: "power", campaignId });
  if (filter) params.set("filter", filter);
  return `/crm/queue?${params}`;
}

export function lastImportLabel(rows: CampaignImportHistoryRow[]): string | null {
  const row = rows[0];
  if (!row) return null;
  return `${formatImportTimestamp(row.createdAt)}${row.fileName ? ` · ${row.fileName}` : ""}`;
}

export function memberNextAction(status: string, callbackAt: string | null): string {
  if (status === "CALLBACK" && callbackAt) {
    const { tier } = callbackUrgency(callbackAt);
    if (tier === "overdue") return "Work overdue callback";
    if (tier === "due") return "Callback due soon";
    return "Scheduled callback";
  }
  if (status === "PENDING" || status === "IN_PROGRESS") return "Open workspace";
  if (status === "CONVERTED" || status === "SKIPPED" || status === "DO_NOT_CALL") return "Review outcome";
  if (status === "CONTACTED") return "Follow up or set callback";
  return "Open workspace";
}
