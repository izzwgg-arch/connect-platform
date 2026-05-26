"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { AlertCircle, Clock, Mail, Megaphone, ListOrdered, MapPin, Phone, ShieldCheck, UserRound } from "lucide-react";
import { CRMCard } from "../CRMCard";
import { crm } from "../crmClasses";
import { cn } from "../cn";
import { formatTimeAgo, initials, ownerLabel, stageColor, stageLabel } from "../contact/contactFormatters";
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
  const contactAny = contact as LiveContact & {
    assignedTo?: Parameters<typeof ownerLabel>[0];
    lastActivityAt?: string | null;
    city?: string | null;
    state?: string | null;
    location?: string | null;
  };
  const owner = ownerLabel(contactAny.assignedTo) ?? "Unassigned";
  const location = contactAny.location ?? ([contactAny.city, contactAny.state].filter(Boolean).join(", ") || "Local time unknown");
  const lastTouch = contactAny.lastActivityAt ? formatTimeAgo(contactAny.lastActivityAt) : "No activity yet";

  return (
    <CRMCard padding="lg" className="relative overflow-hidden border-crm-border/70 shadow-[0_22px_60px_-42px_rgba(15,23,42,0.75)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_0%_0%,rgba(56,189,248,0.11),transparent_32%),radial-gradient(circle_at_88%_0%,rgba(124,58,237,0.09),transparent_34%)]" />
      <div className="relative flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 gap-4">
          <div
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl text-xl font-bold text-white shadow-[0_18px_34px_-22px_rgba(15,23,42,0.9)] ring-4 ring-white/50 dark:ring-white/10"
            style={{ background: `linear-gradient(135deg, ${stageColor(stage)}, #6366f1)` }}
          >
            {initials(contact?.displayName ?? "")}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-2xl font-bold tracking-tight text-crm-text sm:text-3xl">{contact?.displayName ?? "Unknown"}</h2>
              <span
                className="rounded-full px-2.5 py-1 text-xs font-bold shadow-sm"
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
              <p className="mt-1 text-sm font-medium text-crm-muted">
                {[contact.title, contact.company].filter(Boolean).join(" · ")}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-3 text-sm">
              {phone ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-crm-border/70 bg-crm-surface-2/60 px-2.5 py-1 tabular-nums text-crm-text">
                  <Phone className="h-3.5 w-3.5 text-crm-muted" />
                  {phone}
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full border border-crm-warning/40 bg-crm-warning/10 px-2.5 py-1 text-crm-warning">No phone on file</span>
              )}
              {email ? (
                <a href={`mailto:${email}`} className="inline-flex items-center gap-1.5 rounded-full border border-crm-border/70 bg-crm-surface-2/60 px-2.5 py-1 text-crm-accent hover:underline">
                  <Mail className="h-3.5 w-3.5" />
                  {email}
                </a>
              ) : null}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-crm-muted sm:grid-cols-4">
              <HeaderStat icon={<ShieldCheck className="h-3.5 w-3.5" />} label="Engagement" value={contact.doNotCall ? "DNC" : "Callable"} />
              <HeaderStat icon={<UserRound className="h-3.5 w-3.5" />} label="Owner" value={owner} />
              <HeaderStat icon={<MapPin className="h-3.5 w-3.5" />} label="Location" value={location} />
              <HeaderStat icon={<Clock className="h-3.5 w-3.5" />} label="Last touch" value={lastTouch} />
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2 lg:min-w-[10rem] lg:items-end">
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

function HeaderStat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-crm-border/60 bg-crm-surface-2/55 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-crm-muted">
        {icon}
        {label}
      </div>
      <div className="mt-1 truncate text-xs font-semibold text-crm-text">{value}</div>
    </div>
  );
}
