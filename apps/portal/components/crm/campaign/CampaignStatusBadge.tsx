"use client";

import { cn } from "../cn";
import type { CampaignPriority, CampaignStatus } from "./campaignTypes";
import {
  CAMPAIGN_PRIORITY_CHIP,
  CAMPAIGN_PRIORITY_LABELS,
  CAMPAIGN_STATUS_CHIP,
  CAMPAIGN_STATUS_DOT,
  CAMPAIGN_STATUS_INDEX_CHIP,
  CAMPAIGN_STATUS_LABELS,
} from "./campaignTypes";

export function CampaignStatusBadge({
  status,
  variant = "default",
}: {
  status: CampaignStatus;
  variant?: "default" | "index";
}) {
  if (variant === "index") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[10px] font-medium leading-none",
          CAMPAIGN_STATUS_INDEX_CHIP[status],
        )}
      >
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            CAMPAIGN_STATUS_DOT[status],
            status === "ACTIVE" && "crm-campaign-live-dot",
          )}
          aria-hidden
        />
        {CAMPAIGN_STATUS_LABELS[status]}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium",
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
