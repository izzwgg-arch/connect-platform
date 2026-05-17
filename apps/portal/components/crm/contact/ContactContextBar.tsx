"use client";

import Link from "next/link";
import { ArrowLeft, ListOrdered, Megaphone } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { QueueContextMember } from "./contactTypes";

export function ContactContextBar({
  returnTo,
  queueMember,
  campaignName,
  onBack,
}: {
  returnTo: string | null;
  queueMember: QueueContextMember | null;
  campaignName: string | null;
  onBack: () => void;
}) {
  const fromQueue = returnTo?.includes("/crm/queue") ?? false;
  const hasContext = fromQueue || queueMember || campaignName;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <button type="button" onClick={onBack} className={cn(crm.btnGhost, "px-0")}>
        <ArrowLeft className="h-4 w-4" />
        {fromQueue ? "Back to queue" : "Back to contacts"}
      </button>
      {hasContext ? (
        <div className="flex flex-wrap items-center gap-2">
          {fromQueue && returnTo ? (
            <Link
              href={returnTo}
              className={cn(crm.chip, "hover:border-crm-accent/40 hover:text-crm-accent")}
            >
              <ListOrdered className="h-3 w-3" />
              Queue context
            </Link>
          ) : null}
          {(campaignName || queueMember?.campaign?.name) && (
            <span className={crm.chip}>
              <Megaphone className="h-3 w-3" />
              {campaignName ?? queueMember?.campaign?.name}
            </span>
          )}
          {queueMember?.status === "CALLBACK" && queueMember.callbackAt ? (
            <span className="rounded-full border border-crm-warning/40 bg-crm-warning/10 px-2.5 py-0.5 text-xs font-medium text-crm-warning">
              Callback scheduled
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
