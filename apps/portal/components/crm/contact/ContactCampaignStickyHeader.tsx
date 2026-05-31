"use client";

import { Archive, Mail, Megaphone, Pencil, Phone, Star, Voicemail } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { stageLabel } from "./contactFormatters";
import type { CrmStage } from "./contactTypes";

export function ContactCampaignStickyHeader({
  displayName,
  company,
  phone,
  phoneLabel,
  email,
  stage,
  campaignName,
  isArchived,
  onCall,
  callDisabled,
  onVoicemailDrop,
  voicemailDropDisabled,
  onEdit,
  onArchive,
  onRestore,
  archivePosting,
  restorePosting,
  children,
}: {
  displayName: string;
  company: string | null;
  phone: string | null;
  phoneLabel?: string | null;
  email: string | null;
  stage: CrmStage;
  campaignName: string | null;
  isArchived: boolean;
  onCall: () => void;
  callDisabled?: boolean;
  onVoicemailDrop: () => void;
  voicemailDropDisabled?: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  archivePosting?: boolean;
  restorePosting?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <header className="crm-contact-sticky-header relative shrink-0 overflow-hidden rounded-crm-lg border border-crm-border/70 bg-crm-surface/95 shadow-crm backdrop-blur-md">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.14),transparent_38%),linear-gradient(135deg,rgba(56,189,248,0.08),rgba(124,58,237,0.06)_52%,transparent)]" aria-hidden />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-crm-accent/60 via-violet-400/35 to-transparent" aria-hidden />
      <div className="relative flex flex-col gap-2 px-3 py-2.5 sm:px-4 sm:py-3">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="truncate text-base font-black tracking-tight text-crm-text sm:text-lg">
                {displayName}
              </h1>
              {!isArchived ? <Star className="h-3.5 w-3.5 shrink-0 fill-blue-500 text-blue-500" /> : null}
              <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-400">
                {stageLabel(stage)}
              </span>
              {isArchived ? (
                <span className="rounded-full border border-crm-danger/35 bg-crm-danger/10 px-2 py-0.5 text-[10px] font-bold uppercase text-crm-danger">
                  Archived
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-crm-muted">
              {company ? (
                <span className="rounded-full border border-crm-accent/20 bg-crm-accent/8 px-2 py-0.5 font-semibold text-crm-text/95">
                  {company}
                </span>
              ) : null}
              {phone ? (
                <span className="inline-flex items-center gap-1">
                  <Phone className="h-3 w-3" />
                  {phoneLabel ? <span className="font-semibold text-crm-text/80">{phoneLabel}</span> : null}
                  {phone}
                </span>
              ) : null}
              {email ? (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <Mail className="h-3 w-3 shrink-0" />
                  <span className="truncate">{email}</span>
                </span>
              ) : null}
              {campaignName ? (
                <span className={cn(crm.chip, "py-0.5 text-[10px]")}>
                  <Megaphone className="h-3 w-3" />
                  {campaignName}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            {!isArchived ? (
              <>
                <button
                  type="button"
                  onClick={onCall}
                  disabled={callDisabled}
                  className={cn(crm.btnPrimary, "py-1.5 text-xs")}
                >
                  <Phone className="h-3.5 w-3.5" />
                  Call
                </button>
                <button
                  type="button"
                  onClick={onVoicemailDrop}
                  disabled={voicemailDropDisabled}
                  className={cn(crm.btnSecondary, "py-1.5 text-xs")}
                  title="Voicemail drop"
                >
                  <Voicemail className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">VM Drop</span>
                </button>
                <button type="button" onClick={onEdit} className={cn(crm.btnGhost, "py-1.5 text-xs")} title="Edit contact">
                  <Pencil className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Edit</span>
                </button>
                <button
                  type="button"
                  onClick={onArchive}
                  disabled={archivePosting}
                  className={cn(crm.btnGhost, "py-1.5 text-xs text-crm-muted hover:text-crm-danger")}
                  title="Archive contact"
                >
                  <Archive className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{archivePosting ? "Archiving…" : "Archive"}</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={onRestore}
                disabled={restorePosting}
                className={cn(crm.btnSecondary, "py-1.5 text-xs")}
              >
                {restorePosting ? "Restoring…" : "Restore"}
              </button>
            )}
          </div>
        </div>
        {children ? <div className="border-t border-crm-border/50 pt-2">{children}</div> : null}
      </div>
    </header>
  );
}
