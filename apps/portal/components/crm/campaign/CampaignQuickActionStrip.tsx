"use client";

import Link from "next/link";
import { Keyboard, ListOrdered, Megaphone, PhoneCall, Zap } from "lucide-react";
import { cn } from "../cn";
import { mk, STRIP_ACCENT } from "./campaignCinemaClasses";
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
            key: "new" as const,
            label: "New campaign",
            hint: isAdmin ? "Press N to create" : "Admin only",
            icon: Keyboard,
            kbd: isAdmin ? "N" : undefined,
            onClick: isAdmin ? onNewCampaign : undefined,
            href: undefined as string | undefined,
            disabled: !isAdmin,
          },
          {
            key: "power" as const,
            label: "Power mode",
            hint: "Outbound dialing session",
            icon: Zap,
            href: canQueue ? powerLink : undefined,
            disabled: !canQueue,
          },
          {
            key: "queue" as const,
            label: "Check queue",
            hint: queueWork > 0 ? `${queueWork} items waiting` : "Queue is clear",
            icon: ListOrdered,
            href: canQueue ? queueLink : undefined,
            disabled: !canQueue,
          },
          {
            key: "callbacks" as const,
            label: "Review callbacks",
            hint: callbacks > 0 ? `${callbacks} across programs` : "No callback pressure",
            icon: PhoneCall,
            href: canQueue ? callbackLink : undefined,
            disabled: !canQueue,
          },
        ]
      : [
          {
            key: "new" as const,
            label: "New campaign",
            hint: "Create another program",
            icon: Megaphone,
            href: isAdmin ? "/crm/campaigns" : undefined,
            onClick: isAdmin ? onNewCampaign : undefined,
            disabled: !isAdmin,
          },
          {
            key: "power" as const,
            label: "Power mode",
            hint: "Dial this program",
            icon: Zap,
            href: canQueue && campaignId ? powerLink : undefined,
            disabled: !canQueue || !campaignId,
          },
          {
            key: "queue" as const,
            label: "Check queue",
            hint: queueWork > 0 ? `${queueWork} in queue` : "Open work queue",
            icon: ListOrdered,
            href: canQueue && campaignId ? queueLink : undefined,
            disabled: !canQueue || !campaignId,
          },
          {
            key: "callbacks" as const,
            label: "Review callbacks",
            hint: callbacks > 0 ? `${callbacks} callbacks` : "Callback queue",
            icon: PhoneCall,
            href: canQueue && campaignId ? callbackLink : undefined,
            disabled: !canQueue || !campaignId,
          },
        ];

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-white/[0.06] bg-[#080b12]/90 px-3 py-3 backdrop-blur-xl sm:px-6"
      aria-label="Campaign quick actions"
    >
      <div className={cn("mx-auto max-w-[min(100%,1680px)]", mk.stripGrid)}>
        {items.map((item) => {
          const accent = STRIP_ACCENT[item.key];
          const Icon = item.icon;
          const body = (
            <>
              <span className={cn(mk.stripIcon, accent.icon)}>
                <Icon className="h-5 w-5 shrink-0" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className={mk.stripTitle}>{item.label}</span>
                  {"kbd" in item && item.kbd ? (
                    <kbd className="rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] font-bold text-[#8b9cb3]">
                      {item.kbd}
                    </kbd>
                  ) : null}
                </span>
                <span className={mk.stripHint}>{item.hint}</span>
              </span>
            </>
          );

          if (item.href && !item.disabled) {
            return (
              <Link
                key={item.key}
                href={item.href}
                className={cn(mk.stripCard, accent.card)}
              >
                {body}
              </Link>
            );
          }

          return (
            <button
              key={item.key}
              type="button"
              disabled={item.disabled}
              onClick={item.onClick}
              className={cn(mk.stripCard, accent.card, item.disabled && "cursor-not-allowed")}
            >
              {body}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
