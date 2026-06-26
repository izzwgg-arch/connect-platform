"use client";

import {
  AlertCircle,
  CalendarClock,
  ChevronRight,
  Mail,
  Megaphone,
  Phone,
} from "lucide-react";
import { cn } from "../cn";
import {
  leadTimezoneBadgeShort,
  leadTimezoneBadgeTitle,
} from "../contact/leadTimezoneDisplay";
import type { CrmStage } from "../contact/contactTypes";
import type { QueueMember } from "./queueTypes";
import { avatarGradient, initials, stageColor, stageLabel } from "../contact/contactFormatters";
import {
  callbackTimeLabel,
  isQueueMemberActionable,
  memberPriorityTier,
  priorityReason,
  relativeTime,
} from "./queueUtils";

function timezonePillClass(contact: NonNullable<QueueMember["contact"]>): string {
  if (contact.timezoneResolutionStatus === "RESOLVED" && (contact.timezoneLabel || contact.timezoneIana)) {
    return "crm-queue-pill-tz-resolved";
  }
  return "crm-queue-pill-tz-muted";
}

export function QueueOperationalRow({
  member,
  rank,
  isTop,
  isSelected,
  onSelect,
  onOpenWorkspace,
}: {
  member: QueueMember;
  rank: number;
  isTop?: boolean;
  isSelected?: boolean;
  returnTo?: string;
  onSelect?: () => void;
  onOpenWorkspace?: () => void;
  onQuickCall?: () => void;
  onSkip?: () => void;
  sipReady?: boolean;
  acting?: boolean;
  compact?: boolean;
}) {
  const contact = member.contact;
  const actionable = isQueueMemberActionable(member);
  const cb = member.callbackAt ? callbackTimeLabel(member.callbackAt) : null;
  const pr = priorityReason(member);
  const tier = memberPriorityTier(member);
  const stage = (contact?.crmStage ?? "LEAD") as CrmStage;
  const tzBadge = contact ? leadTimezoneBadgeShort(contact) : null;

  function handleRowActivate() {
    onSelect?.();
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleRowActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleRowActivate();
        }
      }}
      className={cn(
        "crm-queue-row group",
        isSelected && "crm-queue-row-selected",
        isTop && actionable && "crm-queue-row-top",
        tier === "high" && actionable && !isSelected && "crm-queue-row-urgent",
        !actionable && "crm-queue-row-readonly",
      )}
    >
      <div className="crm-queue-row-grid">
        <span className="crm-queue-row-rank tabular-nums">{rank}</span>

        <div
          className="crm-queue-row-avatar"
          style={{
            background: avatarGradient(contact?.id ?? contact?.displayName),
          }}
          aria-hidden
        >
          {initials(contact?.displayName ?? "")}
        </div>

        <div className="crm-queue-row-main min-w-0">
          <div className="crm-queue-row-title-line">
            {isTop ? <span className="crm-queue-row-ribbon">Next</span> : null}
            <span className="crm-queue-row-name truncate">{contact?.displayName ?? "Unknown"}</span>
            {contact?.crmStage ? (
              <span className="crm-queue-pill crm-queue-pill-stage">{stageLabel(stage)}</span>
            ) : null}
            {tzBadge ? (
              <span
                className={cn("crm-queue-pill", timezonePillClass(contact!))}
                title={leadTimezoneBadgeTitle(contact!)}
              >
                {tzBadge}
              </span>
            ) : contact?.timezoneResolutionStatus === "NEEDS_REVIEW" ? (
              <span className="crm-queue-pill crm-queue-pill-tz-muted">Review</span>
            ) : null}
            {!actionable ? (
              <span className="crm-queue-pill crm-queue-pill-warning">Read-only</span>
            ) : null}
            {pr && tier !== "low" ? (
              <span
                className={cn(
                  "crm-queue-pill hidden sm:inline-flex",
                  tier === "high" ? "crm-queue-pill-danger" : "crm-queue-pill-accent",
                )}
              >
                {pr}
              </span>
            ) : null}
          </div>
          <p className="crm-queue-row-sub truncate">
            {member.campaign ? (
              <>
                <Megaphone className="inline h-3 w-3 shrink-0 opacity-70" />
                <span className="ml-0.5">{member.campaign.name}</span>
              </>
            ) : null}
            {contact?.company ? (
              <span className="text-crm-muted/80">
                {member.campaign ? " · " : ""}
                {contact.company}
              </span>
            ) : null}
          </p>
        </div>

        <div className="crm-queue-row-phone hidden md:flex">
          <Phone className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-mono">
            {contact?.primaryPhone ?? "—"}
          </span>
        </div>

        <div className="crm-queue-row-email hidden lg:flex">
          <Mail className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{contact?.primaryEmail ?? "—"}</span>
        </div>

        <div className="crm-queue-row-meta hidden xl:flex flex-wrap gap-1">
          {cb ? (
            <span
              className={cn(
                "crm-queue-pill",
                cb.urgent ? "crm-queue-pill-danger" : "crm-queue-pill-warning",
              )}
            >
              {cb.urgent ? <AlertCircle className="h-3 w-3" /> : <CalendarClock className="h-3 w-3" />}
              {cb.label}
            </span>
          ) : null}
          {member.attemptCount > 0 && member.lastAttemptAt ? (
            <span className="crm-queue-pill crm-queue-pill-muted">{relativeTime(member.lastAttemptAt)}</span>
          ) : null}
        </div>

        <div className="crm-queue-row-status shrink-0">
          {contact?.lastDisposition ? (
            <span className="crm-queue-row-disposition truncate">{contact.lastDisposition}</span>
          ) : (
            <span className="crm-queue-row-disposition crm-queue-row-disposition-empty">None</span>
          )}
        </div>

        <button
          type="button"
          className="crm-queue-row-chevron-button shrink-0"
          onClick={(event) => {
            event.stopPropagation();
            onOpenWorkspace?.();
          }}
          aria-label={`Open workspace for ${contact?.displayName ?? "lead"}`}
          title="Open workspace"
        >
          <ChevronRight className="crm-queue-row-chevron h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
