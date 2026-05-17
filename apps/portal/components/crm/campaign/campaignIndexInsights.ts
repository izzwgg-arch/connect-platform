import type { CampaignListItem, CampaignReportRow } from "./campaignTypes";

export type CampaignPressureTone = "ok" | "default" | "warn" | "muted";

export type CampaignQueuePressure = {
  label: string;
  tone: CampaignPressureTone;
};

/** Lightweight copy from report-backed counts only — no invented overdue/analytics. */
export function getCampaignQueuePressure(
  status: CampaignListItem["status"],
  metrics: CampaignReportRow | null | undefined,
): CampaignQueuePressure {
  if (status === "DRAFT") {
    return { label: "Draft — not dialing", tone: "muted" };
  }
  if (status === "ARCHIVED") {
    return { label: "Archived program", tone: "muted" };
  }
  if (status === "COMPLETED") {
    return { label: "Program completed", tone: "muted" };
  }
  if (status === "PAUSED") {
    if (metrics && metrics.pending + metrics.callbacks > 0) {
      return {
        label: `${metrics.pending + metrics.callbacks} waiting while paused`,
        tone: "warn",
      };
    }
    return { label: "Paused — queue on hold", tone: "muted" };
  }

  if (!metrics) {
    return { label: "Metrics loading…", tone: "muted" };
  }

  const { pending, callbacks, total } = metrics;
  const roster = total || 0;

  if (pending === 0 && callbacks === 0) {
    return { label: "No queue work", tone: "ok" };
  }

  if (callbacks >= 5 || (roster >= 8 && callbacks / roster >= 0.2)) {
    return {
      label:
        callbacks === 1
          ? "High callback pressure · 1 waiting"
          : `High callback pressure · ${callbacks} waiting`,
      tone: "warn",
    };
  }

  if (pending >= 12 || (roster >= 10 && pending / roster >= 0.35)) {
    return {
      label: pending === 1 ? "Heavy queue · 1 in queue" : `Heavy queue · ${pending} in queue`,
      tone: "warn",
    };
  }

  if (callbacks > 0 && pending > 0) {
    return {
      label: `${pending} in queue · ${callbacks} callback${callbacks === 1 ? "" : "s"}`,
      tone: "default",
    };
  }

  if (callbacks > 0) {
    return {
      label: callbacks === 1 ? "1 callback waiting" : `${callbacks} callbacks waiting`,
      tone: "default",
    };
  }

  if (pending > 0) {
    return pending <= 3
      ? { label: "Queue healthy · light load", tone: "ok" }
      : { label: `${pending} in queue`, tone: "default" };
  }

  return { label: "Queue healthy", tone: "ok" };
}
