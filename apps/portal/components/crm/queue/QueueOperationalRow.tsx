"use client";

import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CalendarClock,
  CheckCheck,
  ChevronRight,
  ExternalLink,
  Mail,
  Megaphone,
  Phone,
  PhoneCall,
  SkipForward,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { QueueMember } from "./queueTypes";
import {
  assignedAgeLabel,
  callbackTimeLabel,
  isQueueMemberActionable,
  memberPriorityTier,
  MEMBER_STATUS_COLORS,
  MEMBER_STATUS_LABELS,
  priorityReason,
  relativeTime,
} from "./queueUtils";

export function QueueOperationalRow({
  member,
  rank,
  isTop,
  compact,
  returnTo,
  onOpenWorkspace,
  onQuickCall,
  onSkip,
  sipReady,
  acting,
}: {
  member: QueueMember;
  rank: number;
  isTop?: boolean;
  compact?: boolean;
  returnTo: string;
  onOpenWorkspace?: () => void;
  onQuickCall?: () => void;
  onSkip?: () => void;
  sipReady?: boolean;
  acting?: boolean;
}) {
  const router = useRouter();
  const contact = member.contact;
  const actionable = isQueueMemberActionable(member);
  const cb = member.callbackAt ? callbackTimeLabel(member.callbackAt) : null;
  const pr = priorityReason(member);
  const tier = memberPriorityTier(member);
  const assignedAge = assignedAgeLabel(member);

  function openWorkspace(e: React.MouseEvent) {
    e.stopPropagation();
    if (onOpenWorkspace) {
      onOpenWorkspace();
      return;
    }
    const params = new URLSearchParams({
      contactId: member.contactId,
      memberId: member.id,
      returnTo,
    });
    if (member.campaign) params.set("campaignId", member.campaign.id);
    router.push(`/crm/live-call?${params}`);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => router.push(`/crm/contacts/${member.contactId}`)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          router.push(`/crm/contacts/${member.contactId}`);
        }
      }}
      className={cn(
        "group relative w-full text-left rounded-crm-lg border transition-all",
        "mb-2",
        compact ? "px-3 py-2.5" : "px-3 py-3 sm:px-4",
        isTop && actionable && "ring-1 ring-crm-accent/35 shadow-[0_0_0_1px_rgba(99,102,241,0.12)]",
        tier === "high" && actionable && "border-crm-danger/40 bg-crm-danger/5",
        tier === "medium" && actionable && !isTop && "border-crm-warning/25 bg-crm-surface",
        tier === "low" && actionable && "border-crm-border bg-crm-surface hover:border-crm-accent/30 hover:bg-crm-accent/5",
        !actionable && "border-crm-warning/35 bg-crm-warning/10 opacity-90",
        isTop && actionable && "border-crm-accent/50 bg-crm-accent/8",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "shrink-0 font-mono tabular-nums text-crm-muted/80 pt-0.5",
            isTop ? "text-xs font-bold text-crm-accent w-7" : "text-[11px] w-6 text-right",
          )}
        >
          {rank}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              {isTop ? (
                <p className="text-[10px] font-bold uppercase tracking-wider text-crm-accent mb-0.5">
                  Next best lead
                </p>
              ) : null}
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={cn(
                    "font-semibold text-crm-text truncate",
                    isTop ? "text-base sm:text-lg" : "text-sm",
                  )}
                >
                  {contact?.displayName ?? "Unknown"}
                </span>
                {!actionable ? (
                  <span className="text-[10px] font-bold uppercase tracking-wide text-crm-warning bg-crm-warning/15 px-1.5 py-0.5 rounded">
                    Read-only
                  </span>
                ) : null}
              </div>
              {member.campaign ? (
                <p className="text-xs text-crm-muted mt-0.5 truncate flex items-center gap-1">
                  <Megaphone className="h-3 w-3 shrink-0 opacity-80" />
                  {member.campaign.name}
                  {member.campaign.priority !== "NORMAL" ? (
                    <span className="text-[10px] uppercase font-semibold text-crm-muted/90">
                      · {member.campaign.priority}
                    </span>
                  ) : null}
                </p>
              ) : null}
            </div>
            <span
              className={cn(
                "inline-flex shrink-0 items-center px-2 py-0.5 rounded-full text-[11px] font-medium",
                MEMBER_STATUS_COLORS[member.status],
              )}
            >
              {MEMBER_STATUS_LABELS[member.status]}
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-crm-muted">
            {contact?.primaryPhone ? (
              <span className="inline-flex items-center gap-1 font-mono text-crm-text/90">
                <Phone className="h-3 w-3 text-crm-muted" />
                {contact.primaryPhone}
              </span>
            ) : (
              <span className="italic text-crm-muted/70">No phone</span>
            )}
            {contact?.primaryEmail ? (
              <span className="inline-flex items-center gap-1 truncate max-w-[12rem]">
                <Mail className="h-3 w-3 shrink-0" />
                <span className="truncate">{contact.primaryEmail}</span>
              </span>
            ) : null}
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
            {contact?.crmStage ? (
              <span className="bg-crm-accent/12 text-crm-accent px-2 py-0.5 rounded-full font-medium">
                {contact.crmStage}
              </span>
            ) : null}
            {pr ? (
              <span
                className={cn(
                  "px-2 py-0.5 rounded-full font-medium",
                  tier === "high"
                    ? "bg-crm-danger/15 text-crm-danger"
                    : tier === "medium"
                      ? "bg-crm-warning/15 text-crm-warning"
                      : "bg-crm-accent/12 text-crm-accent",
                )}
              >
                {pr}
              </span>
            ) : null}
            {cb ? (
              <span
                className={cn(
                  "px-2 py-0.5 rounded-full inline-flex items-center gap-1",
                  cb.urgent
                    ? "bg-crm-danger/15 text-crm-danger font-semibold"
                    : "bg-crm-warning/15 text-crm-warning",
                )}
              >
                {cb.urgent ? <AlertCircle className="h-3 w-3" /> : <CalendarClock className="h-3 w-3" />}
                {cb.label}
              </span>
            ) : null}
            {contact?.lastDisposition ? (
              <span className="bg-crm-surface-2 text-crm-muted px-2 py-0.5 rounded-full inline-flex items-center gap-1">
                <CheckCheck className="h-3 w-3" />
                {contact.lastDisposition}
                {contact.lastDispositionAt ? ` · ${relativeTime(contact.lastDispositionAt)}` : ""}
              </span>
            ) : null}
            {member.attemptCount > 0 ? (
              <span className="bg-crm-surface-2 text-crm-muted px-2 py-0.5 rounded-full">
                {member.attemptCount} attempt{member.attemptCount !== 1 ? "s" : ""}
                {member.lastAttemptAt ? ` · ${relativeTime(member.lastAttemptAt)}` : ""}
              </span>
            ) : null}
            {assignedAge ? (
              <span className="text-crm-muted/80 px-1">{assignedAge}</span>
            ) : null}
          </div>

          {member.callbackNote ? (
            <p className="mt-1.5 text-[11px] text-crm-warning/90 italic line-clamp-1">
              &ldquo;{member.callbackNote}&rdquo;
            </p>
          ) : null}
        </div>

        <ChevronRight className="h-4 w-4 text-crm-border group-hover:text-crm-muted shrink-0 mt-1 transition-colors" />
      </div>

      <div
        className={cn(
          "mt-2 flex flex-wrap gap-1.5 border-t border-crm-border/50 pt-2",
          compact ? "opacity-100" : "sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={openWorkspace}
          disabled={acting || !actionable}
          className={cn(crm.btnPrimary, "h-8 px-2.5 py-1 text-xs")}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Workspace
        </button>
        {isTop && onQuickCall && contact?.primaryPhone ? (
          <button
            type="button"
            onClick={() => onQuickCall()}
            disabled={acting || !actionable || !sipReady}
            className="inline-flex h-8 items-center gap-1 rounded-crm bg-crm-success px-2.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-50"
            title={!sipReady ? "Register softphone to call" : undefined}
          >
            <PhoneCall className="h-3.5 w-3.5" />
            Call
          </button>
        ) : null}
        {onSkip && !compact ? (
          <button
            type="button"
            onClick={() => onSkip()}
            disabled={acting || !actionable}
            className={cn(crm.btnGhost, "h-8 px-2 text-xs")}
          >
            <SkipForward className="h-3.5 w-3.5" />
            Skip
          </button>
        ) : null}
      </div>
    </div>
  );
}
