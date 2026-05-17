"use client";

import Link from "next/link";
import { Keyboard, ListOrdered, Megaphone, PhoneCall, Zap } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { powerQueueHref, queueHref } from "./campaignUtils";

export function CampaignQuickActionStrip({
  variant,
  campaignId,
  canQueue,
  isAdmin,
  queueWork = 0,
  callbacks = 0,
  onNewCampaign,
}: {
  variant: "index" | "detail";
  campaignId?: string;
  canQueue: boolean;
  isAdmin: boolean;
  queueWork?: number;
  callbacks?: number;
  onNewCampaign?: () => void;
}) {
  const queueLink = campaignId ? queueHref(campaignId) : "/crm/queue";
  const powerLink = campaignId ? powerQueueHref(campaignId) : "/crm/queue?mode=power";
  const callbackLink = campaignId
    ? `${queueHref(campaignId)}&filter=overdue`
    : "/crm/queue?filter=overdue";

  const items =
    variant === "index"
      ? [
          {
            key: "new",
            label: "New campaign",
            hint: isAdmin ? "Press N" : "Admin only",
            icon: <Keyboard className="h-3.5 w-3.5 shrink-0 text-crm-muted" />,
            kbd: isAdmin ? "N" : undefined,
            onClick: isAdmin ? onNewCampaign : undefined,
            href: undefined as string | undefined,
            disabled: !isAdmin,
          },
          {
            key: "callbacks",
            label: "Review callbacks",
            hint: callbacks > 0 ? `${callbacks} across programs` : "No callback pressure",
            icon: <PhoneCall className="h-3.5 w-3.5 shrink-0 text-crm-warning" />,
            href: canQueue ? callbackLink : undefined,
            disabled: !canQueue,
          },
          {
            key: "queue",
            label: "Queue work",
            hint: queueWork > 0 ? `${queueWork} items waiting` : "Queue is clear",
            icon: <ListOrdered className="h-3.5 w-3.5 shrink-0 text-crm-accent" />,
            href: canQueue ? queueLink : undefined,
            disabled: !canQueue,
          },
          {
            key: "power",
            label: "Power mode",
            hint: campaignId ? "Dial this program" : "Open power queue",
            icon: <Zap className="h-3.5 w-3.5 shrink-0 text-crm-accent" />,
            href: canQueue && campaignId ? powerLink : canQueue ? "/crm/queue?mode=power" : undefined,
            disabled: !canQueue,
          },
        ]
      : [
          {
            key: "new",
            label: "New campaign",
            hint: "Create another program",
            icon: <Megaphone className="h-3.5 w-3.5 shrink-0 text-crm-muted" />,
            href: isAdmin ? "/crm/campaigns" : undefined,
            onClick: isAdmin ? onNewCampaign : undefined,
            disabled: !isAdmin,
          },
          {
            key: "power",
            label: "Power mode",
            hint: "Outbound dialing session",
            icon: <Zap className="h-3.5 w-3.5 shrink-0 text-crm-accent" />,
            href: canQueue && campaignId ? powerLink : undefined,
            disabled: !canQueue || !campaignId,
          },
          {
            key: "queue",
            label: "Check queue",
            hint: queueWork > 0 ? `${queueWork} in queue` : "Open work queue",
            icon: <ListOrdered className="h-3.5 w-3.5 shrink-0 text-crm-accent" />,
            href: canQueue && campaignId ? queueLink : undefined,
            disabled: !canQueue || !campaignId,
          },
          {
            key: "callbacks",
            label: "Review callbacks",
            hint: callbacks > 0 ? `${callbacks} callbacks` : "Callback queue",
            icon: <PhoneCall className="h-3.5 w-3.5 shrink-0 text-crm-warning" />,
            href: canQueue && campaignId ? callbackLink : undefined,
            disabled: !canQueue || !campaignId,
          },
        ];

  return (
    <nav className={crm.campaignQuickStrip} aria-label="Campaign quick actions">
      {items.map((item) => {
        const inner = (
          <>
            <span className="flex items-center gap-1.5">
              {item.icon}
              <span className={crm.campaignQuickStripLabel}>{item.label}</span>
              {"kbd" in item && item.kbd ? (
                <kbd className={crm.campaignQuickStripKbd}>{item.kbd}</kbd>
              ) : null}
            </span>
            <span className={crm.campaignQuickStripHint}>{item.hint}</span>
          </>
        );

        if (item.href && !item.disabled) {
          return (
            <Link key={item.key} href={item.href} className={crm.campaignQuickStripItem}>
              {inner}
            </Link>
          );
        }

        return (
          <button
            key={item.key}
            type="button"
            disabled={item.disabled}
            onClick={item.onClick}
            className={cn(
              crm.campaignQuickStripItem,
              item.disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
            )}
          >
            {inner}
          </button>
        );
      })}
    </nav>
  );
}
