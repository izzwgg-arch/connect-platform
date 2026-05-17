"use client";

import Link from "next/link";
import {
  Archive,
  Calendar,
  CalendarClock,
  CheckCheck,
  ExternalLink,
  Mail,
  MessageSquare,
  MessageSquareDot,
  Phone,
  Radio,
  User,
} from "lucide-react";
import { CRMCard } from "../CRMCard";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { CrmContactDetail, CrmStage, NextStep, QueueContextMember } from "./contactTypes";
import {
  callbackTimeLabel,
  formatDate,
  formatTimeAgo,
  initials,
  ownerLabel,
  stageColor,
  stageLabel,
} from "./contactFormatters";

export function ContactWorkspaceHeader({
  contact,
  stage,
  isArchived,
  nextStep,
  lastInteractionLabel,
  lastInteractionAt,
  queueMember,
  campaignName,
  canLiveWorkspace,
  sipReady,
  primaryPhone,
  primaryEmail,
  workspaceHref,
  onCall,
  onSms,
  onNote,
  onTask,
  onEdit,
  onArchive,
  onRestore,
  archivePosting,
  restorePosting,
  isAdmin,
  editing,
  saving,
  onSave,
  onCancelEdit,
}: {
  contact: CrmContactDetail;
  stage: CrmStage;
  isArchived: boolean;
  nextStep: NextStep;
  lastInteractionLabel: string | null;
  lastInteractionAt: string | null;
  queueMember: QueueContextMember | null;
  campaignName: string | null;
  canLiveWorkspace: boolean;
  sipReady: boolean;
  primaryPhone: string | null;
  primaryEmail: string | null;
  workspaceHref: string;
  onCall: () => void;
  onSms: () => void;
  onNote: () => void;
  onTask: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  archivePosting: boolean;
  restorePosting: boolean;
  isAdmin: boolean;
  editing: boolean;
  saving: boolean;
  onSave: () => void;
  onCancelEdit: () => void;
}) {
  const owner = ownerLabel(contact.assignedTo);
  const cb =
    queueMember?.callbackAt ? callbackTimeLabel(queueMember.callbackAt) : null;
  const freshness = contact.lastActivityAt
    ? formatTimeAgo(contact.lastActivityAt)
    : "No touch yet";

  return (
    <CRMCard padding="lg" className="overflow-hidden">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,auto)] lg:items-start">
        {/* Left — identity */}
        <div className="flex gap-4">
          <div
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-crm-lg text-xl font-bold text-white shadow-crm"
            style={{ background: stageColor(stage) }}
          >
            {initials(contact.displayName)}
          </div>
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight text-crm-text sm:text-[1.65rem]">
                {contact.displayName}
              </h1>
              <span
                className="rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide"
                style={{
                  background: stageColor(stage) + "22",
                  color: stageColor(stage),
                }}
              >
                {stageLabel(stage)}
              </span>
              {isArchived ? (
                <span className="rounded-full border border-crm-border bg-crm-surface-2 px-2.5 py-0.5 text-xs font-semibold uppercase text-crm-muted">
                  Archived
                </span>
              ) : null}
              {contact.doNotCall ? (
                <span className="text-xs font-bold text-crm-danger">DNC</span>
              ) : null}
              {contact.doNotSms ? (
                <span className="text-xs font-bold text-crm-warning">No SMS</span>
              ) : null}
            </div>
            {(contact.company || contact.title) && (
              <p className="text-sm text-crm-muted">
                {[contact.title, contact.company].filter(Boolean).join(" · ")}
              </p>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
              {primaryPhone ? (
                <span className="inline-flex items-center gap-1.5 font-medium tabular-nums text-crm-text">
                  <Phone className="h-3.5 w-3.5 text-crm-muted" />
                  {primaryPhone}
                </span>
              ) : (
                <span className="text-crm-warning">No phone on file</span>
              )}
              {primaryEmail ? (
                <a
                  href={`mailto:${primaryEmail}`}
                  className="inline-flex min-w-0 items-center gap-1.5 text-crm-accent hover:underline"
                >
                  <Mail className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{primaryEmail}</span>
                </a>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2 text-xs text-crm-muted">
              {owner ? (
                <span className={crm.chip}>
                  <User className="h-3 w-3" />
                  {owner}
                </span>
              ) : null}
              {(campaignName || queueMember?.campaign?.name) && (
                <span className={crm.chip}>{campaignName ?? queueMember?.campaign?.name}</span>
              )}
              <span className={crm.chip}>
                SMS {contact.doNotSms ? "opt-out" : "allowed"}
              </span>
            </div>
          </div>
        </div>

        {/* Center — operational pulse */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <PulseTile label="Next action" value={nextStep.title} detail={nextStep.detail} accent />
          <PulseTile
            label="Last interaction"
            value={lastInteractionLabel ?? "—"}
            detail={
              lastInteractionAt
                ? formatTimeAgo(lastInteractionAt)
                : "Log a call or note to establish rhythm"
            }
          />
          <PulseTile
            label="Engagement"
            value={freshness}
            detail={
              contact.lastActivityAt
                ? `Last activity ${formatDate(contact.lastActivityAt)}`
                : "No recorded activity"
            }
          />
          {cb ? (
            <PulseTile
              label="Callback"
              value={cb.label}
              detail={queueMember?.callbackNote?.slice(0, 80) ?? undefined}
              warn={cb.urgent}
            />
          ) : contact.lastDisposition ? (
            <PulseTile
              label="Last outcome"
              value={contact.lastDisposition}
              detail={
                contact.lastDispositionAt
                  ? formatDate(contact.lastDispositionAt)
                  : undefined
              }
            />
          ) : (
            <PulseTile label="Pipeline" value={stageLabel(stage)} detail="CRM stage" />
          )}
        </div>

        {/* Right — primary actions */}
        <div className="flex flex-col gap-2 lg:min-w-[210px]">
          <PrimaryActions
            isArchived={isArchived}
            canLiveWorkspace={canLiveWorkspace}
            primaryPhone={primaryPhone}
            sipReady={sipReady}
            contact={contact}
            workspaceHref={workspaceHref}
            onCall={onCall}
            onSms={onSms}
            onNote={onNote}
            onTask={onTask}
          />
          <SecondaryActions
            isArchived={isArchived}
            isAdmin={isAdmin}
            editing={editing}
            saving={saving}
            archivePosting={archivePosting}
            restorePosting={restorePosting}
            onEdit={onEdit}
            onSave={onSave}
            onCancelEdit={onCancelEdit}
            onArchive={onArchive}
            onRestore={onRestore}
          />
        </div>
      </div>
    </CRMCard>
  );
}

function PulseTile({
  label,
  value,
  detail,
  accent,
  warn,
}: {
  label: string;
  value: string;
  detail?: string;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-crm border px-3 py-2.5",
        accent
          ? "border-crm-accent/30 bg-crm-accent/8"
          : warn
            ? "border-crm-danger/35 bg-crm-danger/8"
            : "border-crm-border/80 bg-crm-surface-2/50",
      )}
    >
      <p className="text-[0.6875rem] font-bold uppercase tracking-wider text-crm-muted">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-sm font-semibold text-crm-text line-clamp-2",
          warn && "text-crm-danger",
        )}
      >
        {value}
      </p>
      {detail ? <p className="mt-0.5 text-xs text-crm-muted line-clamp-2">{detail}</p> : null}
    </div>
  );
}

function PrimaryActions({
  isArchived,
  canLiveWorkspace,
  primaryPhone,
  sipReady,
  contact,
  workspaceHref,
  onCall,
  onSms,
  onNote,
  onTask,
}: {
  isArchived: boolean;
  canLiveWorkspace: boolean;
  primaryPhone: string | null;
  sipReady: boolean;
  contact: CrmContactDetail;
  workspaceHref: string;
  onCall: () => void;
  onSms: () => void;
  onNote: () => void;
  onTask: () => void;
}) {
  return (
    <>
      {!isArchived && primaryPhone ? (
        <button
          type="button"
          onClick={onCall}
          disabled={!sipReady}
          title={!sipReady ? "Register softphone to call" : undefined}
          className={cn(crm.btnPrimary, "w-full justify-center")}
        >
          <Phone className="h-4 w-4" />
          Call
        </button>
      ) : null}
      {canLiveWorkspace && !isArchived ? (
        <Link href={workspaceHref} className={cn(crm.btnSecondary, "w-full justify-center")}>
          <Radio className="h-4 w-4" />
          Open workspace
          <ExternalLink className="h-3.5 w-3.5 opacity-70" />
        </Link>
      ) : null}
      {!isArchived ? (
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onSms}
            disabled={contact.phones.length === 0 || contact.doNotSms}
            className={cn(crm.btnSecondary, "justify-center py-2 text-xs")}
          >
            <MessageSquareDot className="h-3.5 w-3.5" />
            SMS
          </button>
          <button type="button" onClick={onNote} className={cn(crm.btnSecondary, "justify-center py-2 text-xs")}>
            <MessageSquare className="h-3.5 w-3.5" />
            Note
          </button>
          <button type="button" onClick={onTask} className={cn(crm.btnSecondary, "justify-center py-2 text-xs col-span-2")}>
            <Calendar className="h-3.5 w-3.5" />
            Schedule task
          </button>
        </div>
      ) : null}
    </>
  );
}

function SecondaryActions({
  isArchived,
  isAdmin,
  editing,
  saving,
  archivePosting,
  restorePosting,
  onEdit,
  onSave,
  onCancelEdit,
  onArchive,
  onRestore,
}: {
  isArchived: boolean;
  isAdmin: boolean;
  editing: boolean;
  saving: boolean;
  archivePosting: boolean;
  restorePosting: boolean;
  onEdit: () => void;
  onSave: () => void;
  onCancelEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 border-t border-crm-border/60 pt-3">
      {!isArchived && !editing ? (
        <button type="button" onClick={onEdit} className={cn(crm.btnGhost, "text-xs")}>
          Edit fields
        </button>
      ) : null}
      {editing ? (
        <>
          <button type="button" onClick={onCancelEdit} disabled={saving} className={cn(crm.btnGhost, "text-xs")}>
            Cancel
          </button>
          <button type="button" onClick={onSave} disabled={saving} className={cn(crm.btnPrimary, "text-xs")}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      ) : null}
      {isAdmin && !isArchived ? (
        <button
          type="button"
          onClick={onArchive}
          disabled={archivePosting}
          className={cn(crm.btnDanger, "text-xs")}
        >
          <Archive className="h-3.5 w-3.5" />
          {archivePosting ? "…" : "Archive"}
        </button>
      ) : null}
      {isAdmin && isArchived ? (
        <button type="button" onClick={onRestore} disabled={restorePosting} className={cn(crm.btnSecondary, "text-xs")}>
          {restorePosting ? "…" : "Restore"}
        </button>
      ) : null}
    </div>
  );
}
