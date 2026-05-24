"use client";

import Link from "next/link";
import { AlertCircle, Mail, Megaphone, ListOrdered, Phone } from "lucide-react";
import { CRMCard } from "../CRMCard";
import { crm } from "../crmClasses";
import { cn } from "../cn";
import { initials, stageColor, stageLabel } from "../contact/contactFormatters";
import type { CrmStage, LiveContact } from "./liveTypes";

export function LiveWorkspaceContactHeader({
  contact,
  isArchived,
  callerIdChecked,
  callerIdSelected,
  callerIdLoading,
  sipNotice,
  onCall,
  profileHref,
  campaignName,
  queueLabel,
}: {
  contact: LiveContact;
  isArchived: boolean;
  callerIdChecked: boolean;
  callerIdSelected: string | null;
  callerIdLoading: boolean;
  sipNotice: string | null;
  onCall: () => void;
  profileHref: string;
  campaignName?: string | null;
  queueLabel?: string | null;
}) {
  const stage = (contact?.crmStage ?? "LEAD") as CrmStage;
  const phone = contact?.primaryPhone?.numberRaw ?? contact?.phones?.find((p) => p.isPrimary)?.numberRaw ?? null;
  const email = contact?.primaryEmail?.email ?? contact?.emails?.find((e) => e.isPrimary)?.email ?? null;

  return (
    <CRMCard padding="lg" className="shadow-[0_8px_24px_rgba(0,0,0,0.12)]">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-4">
          <div
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-crm-lg text-xl font-bold text-white"
            style={{ background: stageColor(stage) }}
          >
            {initials(contact?.displayName ?? "")}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-semibold text-crm-text">{contact?.displayName ?? "Unknown"}</h2>
              <span
                className="rounded-full px-2 py-0.5 text-xs font-semibold"
                style={{ background: stageColor(stage) + "22", color: stageColor(stage) }}
              >
                {stageLabel(stage)}
              </span>
              {campaignName ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-crm-border bg-crm-surface-2/60 px-2 py-0.5 text-xs text-crm-muted">
                  <Megaphone className="h-3.5 w-3.5" />
                  {campaignName}
                </span>
              ) : null}
              {queueLabel ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-crm-border bg-crm-surface-2/60 px-2 py-0.5 text-xs text-crm-muted">
                  <ListOrdered className="h-3.5 w-3.5" />
                  {queueLabel}
                </span>
              ) : null}
              {isArchived ? (
                <span className={crm.chip}>Archived</span>
              ) : null}
              {contact.doNotCall ? (
                <span className="text-xs font-bold text-crm-danger">DNC</span>
              ) : null}
              {contact.doNotSms ? (
                <span className="text-xs font-bold text-crm-warning">No SMS</span>
              ) : null}
            </div>
            {(contact.company || contact.title) && (
              <p className="mt-1 text-sm text-crm-muted">
                {[contact.title, contact.company].filter(Boolean).join(" · ")}
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-4 text-sm">
              {phone ? (
                <span className="inline-flex items-center gap-1.5 tabular-nums text-crm-text">
                  <Phone className="h-3.5 w-3.5 text-crm-muted" />
                  {phone}
                </span>
              ) : (
                <span className="text-crm-warning">No phone on file</span>
              )}
              {email ? (
                <a href={`mailto:${email}`} className="inline-flex items-center gap-1.5 text-crm-accent hover:underline">
                  <Mail className="h-3.5 w-3.5" />
                  {email}
                </a>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          {!isArchived && phone ? (
            <button
              type="button"
              onClick={onCall}
              disabled={callerIdLoading}
              className={cn(crm.btnPrimary, "w-full sm:w-auto")}
            >
              <Phone className="h-4 w-4" />
              {callerIdLoading ? "Selecting caller ID…" : "Call"}
            </button>
          ) : null}
          <Link href={profileHref} className={cn(crm.btnSecondary, "w-full sm:w-auto justify-center")}>
            Full profile
          </Link>
        </div>
      </div>
      {callerIdChecked ? (
        <p className="mt-3 text-xs text-crm-muted">
          {callerIdSelected ? `Local presence: ${callerIdSelected}` : "Default caller ID"}
        </p>
      ) : null}
      {sipNotice ? (
        <div className="mt-3 flex items-center gap-2 rounded-crm border border-crm-warning/35 bg-crm-warning/10 px-3 py-2 text-xs text-crm-warning">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {sipNotice}
        </div>
      ) : null}
    </CRMCard>
  );
}
