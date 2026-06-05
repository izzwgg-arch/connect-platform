"use client";

import { useRouter } from "next/navigation";
import {
  Archive,
  Ban,
  ChevronLeft,
  ChevronRight,
  Edit2,
  ListOrdered,
  Mail,
  MessageSquare,
  Phone,
  PhoneCall,
  UserRound,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { initials, stageColor, stageLabel } from "./contactFormatters";
import {
  leadTimezoneBadgeShort,
  leadTimezoneDetailLabel,
  leadTimezoneBadgeTitle,
} from "./leadTimezoneDisplay";
import type { CrmStage } from "./contactTypes";
import type { ContactListRow } from "./ContactOperationalRow";
import { buildContactWorkspaceHref } from "./contactListUtils";

const CHANNEL_ACTIONS = [
  { key: "email" as const, label: "Email", icon: Mail, workspace: "email" as const },
  { key: "sms" as const, label: "SMS", icon: MessageSquare, workspace: "sms" as const },
  { key: "call" as const, label: "Call", icon: Phone, call: true as const },
];

export function ContactListDetailPanel({
  contact,
  rank,
  total,
  contactsReturnTo,
  sipReady,
  canGoPrevious,
  canGoNext,
  onPrevious,
  onNext,
  onDial,
  onEdit,
  onDelete,
  assignedLabel,
}: {
  contact: ContactListRow;
  rank: number;
  total: number;
  contactsReturnTo: string;
  sipReady: boolean;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onDial: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  assignedLabel?: string | null;
}) {
  const router = useRouter();
  const archived = !!(contact.archivedAt || contact.active === false);
  const stage = (contact.crmStage ?? "LEAD") as CrmStage;
  const tzShort = leadTimezoneBadgeShort(contact);
  const tzDetail = leadTimezoneDetailLabel(contact);

  function openWorkspace(deepLink?: Parameters<typeof buildContactWorkspaceHref>[2]) {
    router.push(buildContactWorkspaceHref(contact.id, contactsReturnTo, deepLink));
  }

  return (
    <aside className="crm-queue-detail-panel crm-contact-detail-panel custom-scrollbar" aria-label="Contact details">
      <div className="crm-queue-detail-glow" aria-hidden />

      <header className="crm-queue-detail-header">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="crm-queue-detail-status-pill crm-queue-pill crm-queue-pill-stage"
            style={{
              background: stageColor(stage) + "18",
              color: stageColor(stage),
            }}
          >
            {stageLabel(stage)}
          </span>
          {contact.doNotCall ? (
            <span className="crm-queue-pill crm-queue-pill-danger inline-flex items-center gap-1">
              <Ban className="h-3 w-3" />
              DNC
            </span>
          ) : null}
          {archived ? (
            <span className="crm-queue-pill crm-queue-pill-warning inline-flex items-center gap-1">
              <Archive className="h-3 w-3" />
              Archived
            </span>
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
          {initials(contact.displayName)}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="crm-queue-detail-name truncate">{contact.displayName}</h2>
          <p className="crm-queue-detail-sub truncate">
            {contact.company || contact.title || "No company"}
            {assignedLabel ? (
              <>
                <span className="text-crm-muted/50 mx-1.5">·</span>
                {assignedLabel}
              </>
            ) : null}
            {tzDetail ? (
              <>
                <span className="text-crm-muted/50 mx-1.5">·</span>
                <span title={leadTimezoneBadgeTitle(contact)}>
                  {tzShort ? `${tzShort} · ` : ""}
                  {tzDetail}
                </span>
              </>
            ) : null}
          </p>
        </div>
      </section>

      <section className="crm-queue-detail-contact-strip">
        <div className="crm-queue-detail-channel-row">
          {CHANNEL_ACTIONS.map(({ key, label, icon: Icon, workspace, call }) => {
            const disabled =
              archived ||
              (key === "email" && !contact.primaryEmail?.email) ||
              ((key === "sms" || key === "call") && !contact.primaryPhone?.numberRaw) ||
              (key === "call" && contact.doNotCall);
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
                      : contact.doNotCall
                        ? "Do not call"
                        : "No phone on file"
                    : key === "call" && !sipReady
                      ? "Register softphone to place calls"
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
            <span className="font-mono text-[13px]">{contact.primaryPhone?.numberRaw ?? "No phone on file"}</span>
          </div>
          <div className="crm-queue-detail-line">
            <Mail className="h-3.5 w-3.5 shrink-0 text-crm-accent" />
            <span className="truncate text-[13px]">{contact.primaryEmail?.email ?? "No email on file"}</span>
          </div>
        </div>
      </section>

      {archived ? (
        <div className="crm-queue-detail-alert">
          <Archive className="h-4 w-4 shrink-0" />
          Archived contact — open record to review history.
        </div>
      ) : null}

      <section className="crm-queue-detail-actions-card">
        <p className="crm-queue-detail-section-label">Contact actions</p>
        <button
          type="button"
          onClick={() => openWorkspace()}
          disabled={archived}
          className={cn(crm.btnPrimary, "crm-queue-detail-primary-action w-full justify-center gap-2")}
        >
          <PhoneCall className="h-4 w-4" />
          Open workspace
        </button>
        <div className="crm-queue-detail-action-grid">
          {onEdit && !archived ? (
            <button type="button" onClick={onEdit} className="crm-queue-detail-secondary-action">
              <Edit2 className="h-4 w-4" />
              Edit contact
            </button>
          ) : null}
          {onDelete && !archived ? (
            <button type="button" onClick={onDelete} className="crm-queue-detail-secondary-action crm-queue-detail-danger-action">
              <Archive className="h-4 w-4" />
              Delete
            </button>
          ) : null}
        </div>
      </section>

      <footer className="crm-queue-detail-footer">
        <button
          type="button"
          onClick={onPrevious}
          disabled={!canGoPrevious}
          className={cn(crm.btnSecondary, "crm-queue-detail-nav flex-1 justify-center gap-1.5")}
        >
          <ChevronLeft className="h-4 w-4" />
          Previous
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!canGoNext}
          className={cn(crm.btnSecondary, "crm-queue-detail-nav flex-1 justify-center gap-1.5")}
        >
          Next
          <ChevronRight className="h-4 w-4" />
        </button>
      </footer>
    </aside>
  );
}

export function ContactListDetailPlaceholder() {
  return (
    <aside className="crm-queue-detail-panel crm-contact-detail-panel crm-queue-detail-placeholder custom-scrollbar" aria-label="Contact details">
      <div className="crm-queue-detail-glow" aria-hidden />
      <div className="crm-queue-detail-placeholder-icon">
        <ListOrdered size={22} />
      </div>
      <h2>Select a contact</h2>
      <p>
        Choose a contact from the list to review details, open the workspace, or start email, SMS, or call actions.
      </p>
    </aside>
  );
}
