"use client";

import { Mail, Megaphone, Phone, Star } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { stageLabel } from "./contactFormatters";
import type { CrmStage } from "./contactTypes";

export function ContactCampaignStickyHeader({
  displayName,
  company,
  phone,
  email,
  stage,
  campaignName,
  isArchived,
  onCall,
  onSms,
  onEmail,
  onNote,
  callDisabled,
  smsDisabled,
  emailDisabled,
  children,
}: {
  displayName: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  stage: CrmStage;
  campaignName: string | null;
  isArchived: boolean;
  onCall: () => void;
  onSms: () => void;
  onEmail: () => void;
  onNote: () => void;
  callDisabled?: boolean;
  smsDisabled?: boolean;
  emailDisabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <header className="crm-contact-sticky-header shrink-0 rounded-crm-lg border border-crm-border/70 bg-crm-surface/95 shadow-crm backdrop-blur-md">
      <div className="flex flex-col gap-2 px-3 py-2.5 sm:px-4 sm:py-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
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
              {company ? <span className="truncate font-medium text-crm-text/90">{company}</span> : null}
              {phone ? (
                <span className="inline-flex items-center gap-1">
                  <Phone className="h-3 w-3" />
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
          <div className="flex flex-wrap items-center gap-1.5">
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
                  onClick={onSms}
                  disabled={smsDisabled}
                  className={cn(crm.btnSecondary, "py-1.5 text-xs")}
                >
                  SMS
                </button>
                <button
                  type="button"
                  onClick={onEmail}
                  disabled={emailDisabled}
                  className={cn(crm.btnSecondary, "py-1.5 text-xs")}
                >
                  Email
                </button>
                <button type="button" onClick={onNote} className={cn(crm.btnGhost, "py-1.5 text-xs")}>
                  Note
                </button>
              </>
            ) : null}
          </div>
        </div>
        {children ? <div className="border-t border-crm-border/50 pt-2">{children}</div> : null}
      </div>
    </header>
  );
}
