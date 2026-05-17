"use client";

import { cn } from "../cn";
import type { CampaignPriority, CampaignStatus } from "./campaignTypes";
import {
  CAMPAIGN_PRIORITY_CHIP,
  CAMPAIGN_PRIORITY_LABELS,
  CAMPAIGN_STATUS_CHIP,
  CAMPAIGN_STATUS_LABELS,
} from "./campaignTypes";

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        CAMPAIGN_STATUS_CHIP[status],
      )}
    >
      {CAMPAIGN_STATUS_LABELS[status]}
    </span>
  );
}

export function CampaignPriorityBadge({
  priority,
  hideNormal,
}: {
  priority: CampaignPriority;
  hideNormal?: boolean;
}) {
  if (hideNormal && priority === "NORMAL") return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        CAMPAIGN_PRIORITY_CHIP[priority],
      )}
    >
      {CAMPAIGN_PRIORITY_LABELS[priority]}
    </span>
  );
}
