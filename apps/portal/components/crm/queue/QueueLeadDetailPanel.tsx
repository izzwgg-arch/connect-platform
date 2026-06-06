"use client";

import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Ban,
  CalendarClock,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Clock,
  Edit2,
  ListOrdered,
  Mail,
  MessageSquare,
  Phone,
  PhoneCall,
  SkipForward,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { initials, stageColor, stageLabel } from "../contact/contactFormatters";
import {
  leadTimezoneBadgeShort,
  leadTimezoneDetailLabel,
  leadTimezoneBadgeTitle,
} from "../contact/leadTimezoneDisplay";
import type { CrmStage } from "../contact/contactTypes";
import type { QueueMember } from "./queueTypes";
import {
  buildQueueContactWorkspaceHref,
  callbackTimeLabel,
  isQueueMemberActionable,
  MEMBER_STATUS_COLORS,
  MEMBER_STATUS_LABELS,
  priorityReason,
  relativeTime,
} from "./queueUtils";

const CHANNEL_ACTIONS = [
  { key: "email" as const, label: "Email", icon: Mail, workspace: "email" as const },
  { key: "sms" as const, label: "SMS", icon: MessageSquare, workspace: "sms" as const },
  { key: "call" as const, label: "Call", icon: Phone, call: true as const },
];

export function QueueLeadDetailPanel({
  member,
  rank,
  total,
  queueReturnTo,
  acting,
  sipReady,
  canGoPrevious,
  canGoNext,
  onPrevious,
  onNext,
  onAction,
  onDial,
}: {
  member: QueueMember;
  rank: number;
  total: number;
  queueReturnTo: string;
  acting: boolean;
  sipReady: boolean;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onAction: (action: string, extra?: Record<string, unknown>) => void;
  onDial: () => void;
}) {
  const router = useRouter();
  const contact = member.contact;
  const actionable = isQueueMemberActionable(member);
  const isCallback = member.status === "CALLBACK";
  const cb = member.callbackAt ? callbackTimeLabel(member.callbackAt) : null;
  const pr = priorityReason(member);
  const stage = (contact?.crmStage ?? "LEAD") as CrmStage;
  const tzShort = contact ? leadTimezoneBadgeShort(contact) : null;
  const tzDetail = contact ? leadTimezoneDetailLabel(contact) : null;

  function openWorkspace(deepLink?: Parameters<typeof buildQueueContactWorkspaceHref>[2]) {
    router.push(buildQueueContactWorkspaceHref(member, queueReturnTo, deepLink));
  }

  return (
    <aside className="crm-queue-detail-panel crm-lead-detail-panel custom-scrollbar" aria-label="Lead details">
      <div className="crm-queue-detail-glow" aria-hidden />

      <header className="crm-queue-detail-header">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "crm-queue-detail-status-pill",
              MEMBER_STATUS_COLORS[member.status],
            )}
          >
            {MEMBER_STATUS_LABELS[member.status]}
          </span>
          {member.campaign ? (
            <span className="crm-queue-detail-campaign truncate">{member.campaign.name}</span>
          ) : null}
        </div>
        <span className="crm-queue-detail-position tabular-nums">
          {rank} <span className="text-crm-muted/60">/</span> {total}
        </span>
      </header>

      <section className="crm-queue-detail-identity">
        <div
          className="crm-queue-detail-avatar"
          style={{
            background: `linear-gradient(135deg, ${stageColor(stage)}, color-mix(in srgb, ${stageColor(stage)} 38%, #6366f1))`,
          }}
        >
          {initials(contact?.displayName ?? "")}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="crm-queue-detail-name truncate">{contact?.displayName ?? "Unknown"}</h2>
          <p className="crm-queue-detail-sub truncate">
            {contact?.company ?? "No company"}
            {tzDetail ? (
              <>
                <span className="text-crm-muted/50 mx-1.5">·</span>
                <span title={contact ? leadTimezoneBadgeTitle(contact) : undefined}>
                  {tzShort ? `${tzShort} · ` : ""}
                  {tzDetail}
                </span>
              </>
            ) : null}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span
              className="crm-queue-pill crm-queue-pill-stage"
              style={{
                background: stageColor(stage) + "18",
                color: stageColor(stage),
              }}
            >
              {stageLabel(stage)}
            </span>
            {pr ? (
              <span className="crm-queue-pill crm-queue-pill-accent inline-flex items-center gap-1">
                <Sparkles className="h-3 w-3" />
                {pr}
              </span>
            ) : null}
            {cb ? (
              <span
                className={cn(
                  "crm-queue-pill inline-flex items-center gap-1",
                  cb.urgent ? "crm-queue-pill-danger" : "crm-queue-pill-warning",
                )}
              >
                {cb.urgent ? <AlertCircle className="h-3 w-3" /> : <CalendarClock className="h-3 w-3" />}
                {cb.label}
              </span>
            ) : null}
          </div>
        </div>
      </section>

      <section className="crm-queue-detail-contact-strip">
        <div className="crm-queue-detail-channel-row">
          {CHANNEL_ACTIONS.map(({ key, label, icon: Icon, workspace, call }) => {
            const disabled =
              acting ||
              !actionable ||
              (key === "email" && !contact?.primaryEmail) ||
              ((key === "sms" || key === "call") && !contact?.primaryPhone);
            return (
              <button
                key={key}
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (call) {
                    if (sipReady) openWorkspace({ action: "call" });
                    else onDial();
                  } else {
                    openWorkspace({ workspace });
                  }
                }}
                className={cn(
                  "crm-queue-detail-channel",
                  `crm-queue-detail-channel-${key}`,
                  key === "call" && "crm-queue-detail-channel-call",
                )}
                title={
                  disabled
                    ? key === "email"
                      ? "No email on file"
                      : "No phone on file"
                    : key === "call" && !sipReady
                      ? "Fill dialer — reconnect softphone to place calls"
                      : `Open ${label.toLowerCase()} workspace`
                }
              >
                <Icon className="h-4 w-4" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
        <div className="crm-queue-detail-lines">
          <div className="crm-queue-detail-line">
            <Phone className="h-3.5 w-3.5 shrink-0 text-crm-accent" />
            <span className="font-mono text-[13px]">{contact?.primaryPhone ?? "No phone on file"}</span>
          </div>
          <div className="crm-queue-detail-line">
            <Mail className="h-3.5 w-3.5 shrink-0 text-crm-accent" />
            <span className="truncate text-[13px]">{contact?.primaryEmail ?? "No email on file"}</span>
          </div>
        </div>
      </section>

      {!actionable ? (
        <div className="crm-queue-detail-alert">
          <AlertCircle className="h-4 w-4 shrink-0" />
          Archived or inactive — not actionable from queue.
        </div>
      ) : null}

      {(contact?.lastDisposition || contact?.lastActivityAt || member.attemptCount > 0) && (
        <section className="crm-queue-detail-meta">
          {contact?.lastDisposition ? (
            <span className="crm-queue-pill crm-queue-pill-muted inline-flex items-center gap-1">
              <CheckCheck className="h-3 w-3" />
              Last: {contact.lastDisposition}
              {contact.lastDispositionAt ? ` · ${relativeTime(contact.lastDispositionAt)}` : ""}
            </span>
          ) : null}
          {contact?.lastActivityAt ? (
            <span className="crm-queue-pill crm-queue-pill-muted">Active {relativeTime(contact.lastActivityAt)}</span>
          ) : null}
          {member.attemptCount > 0 ? (
            <span className="crm-queue-pill crm-queue-pill-muted">
              {member.attemptCount} attempt{member.attemptCount !== 1 ? "s" : ""}
            </span>
          ) : null}
        </section>
      )}

      {member.callbackNote ? (
        <p className="crm-queue-detail-callback-note">&ldquo;{member.callbackNote}&rdquo;</p>
      ) : null}

      <section className="crm-queue-detail-actions-card">
        <p className="crm-queue-detail-section-label">Lead actions</p>
        <button
          type="button"
          onClick={() => openWorkspace()}
          disabled={acting || !actionable}
          className={cn(crm.btnPrimary, "crm-queue-detail-primary-action w-full justify-center gap-2")}
        >
          <PhoneCall className="h-4 w-4" />
          Open workspace
        </button>
        <div className="crm-queue-detail-action-grid">
          {!isCallback ? (
            <button
              type="button"
              onClick={() => onAction("set-callback-modal")}
              disabled={acting || !actionable}
              className="crm-queue-detail-secondary-action"
            >
              <CalendarClock className="h-4 w-4" />
              Set callback
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => onAction("set-callback-modal")}
                disabled={acting || !actionable}
                className="crm-queue-detail-secondary-action"
              >
                <Edit2 className="h-4 w-4" />
                Edit callback
              </button>
              <button
                type="button"
                onClick={() => onAction("clear-callback")}
                disabled={acting || !actionable}
                className="crm-queue-detail-secondary-action"
              >
                <X className="h-4 w-4" />
                Clear
              </button>
            </>
          )}
          {!isCallback ? (
            <>
              <button
                type="button"
                onClick={() => onAction("skip")}
                disabled={acting || !actionable}
                className="crm-queue-detail-secondary-action"
              >
                <SkipForward className="h-4 w-4" />
                Skip
              </button>
              <button
                type="button"
                onClick={() => onAction("defer")}
                disabled={acting || !actionable}
                className="crm-queue-detail-secondary-action"
              >
                <Clock className="h-4 w-4" />
                Defer
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => {
              if (confirm(`Mark ${contact?.displayName ?? "this contact"} as Do Not Call?`)) {
                onAction("dnc");
              }
            }}
            disabled={acting || !actionable}
            className="crm-queue-detail-secondary-action crm-queue-detail-danger-action"
          >
            <Ban className="h-4 w-4" />
            DNC
          </button>
        </div>
      </section>

      <footer className="crm-queue-detail-footer">
        <button
          type="button"
          onClick={onPrevious}
          disabled={!canGoPrevious || acting}
          className={cn(crm.btnSecondary, "crm-queue-detail-nav flex-1 justify-center gap-1.5")}
        >
          <ChevronLeft className="h-4 w-4" />
          Previous
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!canGoNext || acting}
          className={cn(crm.btnSecondary, "crm-queue-detail-nav flex-1 justify-center gap-1.5")}
        >
          Next
          <ChevronRight className="h-4 w-4" />
        </button>
      </footer>
    </aside>
  );
}

export function QueueLeadDetailPlaceholder() {
  return (
    <aside className="crm-queue-detail-panel crm-lead-detail-panel crm-queue-detail-placeholder custom-scrollbar" aria-label="Lead details">
      <div className="crm-queue-detail-glow" aria-hidden />
      <div className="crm-queue-detail-placeholder-icon">
        <ListOrdered size={22} />
      </div>
      <h2>Select a lead</h2>
      <p>
        Choose a lead from the queue to review contact details, open the workspace, or start email, SMS, or call
        actions.
      </p>
    </aside>
  );
}
