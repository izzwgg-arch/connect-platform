"use client";

import { Archive, ChevronRight, Clock, Mail, Phone } from "lucide-react";
import { cn } from "../cn";
import { initials, stageColor, stageLabel } from "./contactFormatters";
import {
  leadTimezoneBadgeShort,
  leadTimezoneBadgeTitle,
} from "./leadTimezoneDisplay";
import type { CrmStage } from "./contactTypes";

export type ContactListRow = {
  id: string;
  displayName: string;
  company?: string | null;
  title?: string | null;
  primaryPhone?: { numberRaw: string } | null;
  primaryEmail?: { email: string } | null;
  crmStage?: CrmStage | null;
  doNotCall?: boolean;
  lastActivityAt?: string | null;
  lastDispositionAt?: string | null;
  updatedAt?: string;
  timezoneIana?: string | null;
  timezoneLabel?: string | null;
  timezoneResolutionStatus?: "RESOLVED" | "NEEDS_REVIEW" | "MISSING_LOCATION" | null;
  archivedAt?: string | null;
  active?: boolean;
};

function timezonePillClass(contact: ContactListRow): string {
  if (contact.timezoneResolutionStatus === "RESOLVED" && (contact.timezoneLabel || contact.timezoneIana)) {
    return "crm-queue-pill-tz-resolved";
  }
  return "crm-queue-pill-tz-muted";
}

function relativeDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "—";
  const diff = Math.max(0, Date.now() - ts);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return minutes <= 1 ? "just now" : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ContactOperationalRow({
  contact,
  rank,
  isSelected,
  onSelect,
  assignedLabel,
}: {
  contact: ContactListRow;
  rank: number;
  isSelected?: boolean;
  onSelect?: () => void;
  assignedLabel?: string | null;
}) {
  const archived = !!(contact.archivedAt || contact.active === false);
  const stage = (contact.crmStage ?? "LEAD") as CrmStage;
  const tzBadge = leadTimezoneBadgeShort(contact);
  const lastTouch = contact.lastActivityAt ?? contact.lastDispositionAt ?? contact.updatedAt;

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
        archived && "crm-queue-row-readonly opacity-90",
      )}
    >
      <div className="crm-queue-row-grid">
        <span className="crm-queue-row-rank tabular-nums">{rank}</span>

        <div
          className="crm-queue-row-avatar"
          style={{
            background: `linear-gradient(135deg, ${stageColor(stage)}, color-mix(in srgb, ${stageColor(stage)} 42%, #6366f1))`,
          }}
          aria-hidden
        >
          {initials(contact.displayName)}
        </div>

        <div className="crm-queue-row-main min-w-0">
          <div className="crm-queue-row-title-line">
            <span className="crm-queue-row-name truncate">{contact.displayName}</span>
            <span className="crm-queue-pill crm-queue-pill-stage">{stageLabel(stage)}</span>
            {tzBadge ? (
              <span
                className={cn("crm-queue-pill", timezonePillClass(contact))}
                title={leadTimezoneBadgeTitle(contact)}
              >
                {tzBadge}
              </span>
            ) : contact.timezoneResolutionStatus === "NEEDS_REVIEW" ? (
              <span className="crm-queue-pill crm-queue-pill-tz-muted">Review</span>
            ) : null}
            {contact.doNotCall ? (
              <span className="crm-queue-pill crm-queue-pill-danger">DNC</span>
            ) : null}
            {archived ? (
              <span className="crm-queue-pill crm-queue-pill-warning inline-flex items-center gap-0.5">
                <Archive className="h-3 w-3" />
                Archived
              </span>
            ) : null}
          </div>
          <p className="crm-queue-row-sub truncate">
            {contact.company || contact.title || assignedLabel || "—"}
          </p>
        </div>

        <div className="crm-queue-row-phone hidden md:flex">
          <Phone className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate font-mono text-[12px]">
            {contact.primaryPhone?.numberRaw ?? "—"}
          </span>
        </div>

        <div className="crm-queue-row-email hidden lg:flex">
          <Mail className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{contact.primaryEmail?.email ?? "—"}</span>
        </div>

        <div className="crm-queue-row-meta hidden xl:flex">
          <span className="crm-queue-pill crm-queue-pill-muted inline-flex items-center gap-0.5">
            <Clock className="h-3 w-3" />
            {relativeDate(lastTouch)}
          </span>
        </div>

        <span className="crm-queue-row-status shrink-0 crm-queue-pill crm-queue-pill-stage">
          {stageLabel(stage)}
        </span>

        <ChevronRight className="crm-queue-row-chevron h-4 w-4 shrink-0" />
      </div>
    </div>
  );
}
