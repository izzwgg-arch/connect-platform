"use client";

import Link from "next/link";
import {
  CalendarClock,
  CheckCheck,
  ExternalLink,
  ListOrdered,
  MessageSquare,
  MessageSquareDot,
  Phone,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";

export function LiveWorkspaceActionBar({
  contactName,
  isArchived,
  canCall,
  canSms,
  hasDisposition,
  queueBackHref,
  contactProfileHref,
  onCall,
  onSms,
  onNote,
  onTask,
  onDisposition,
}: {
  contactName: string;
  isArchived: boolean;
  canCall: boolean;
  canSms: boolean;
  hasDisposition: boolean;
  queueBackHref: string | null;
  contactProfileHref: string;
  onCall: () => void;
  onSms: () => void;
  onNote: () => void;
  onTask: () => void;
  onDisposition: () => void;
}) {
  return (
    <div
      className={cn(
        "sticky top-0 z-30 -mx-4 border-b border-crm-border bg-crm-bg/95 px-4 py-2 backdrop-blur-md sm:-mx-6 lg:-mx-8 lg:px-8",
        "shadow-[0_4px_24px_rgba(0,0,0,0.25)]",
      )}
      role="toolbar"
      aria-label="Live workspace actions"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold text-crm-text">{contactName}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {!isArchived && canCall ? (
            <button type="button" onClick={onCall} className={cn(crm.btnPrimary, "py-1.5 text-xs")}>
              <Phone className="h-3.5 w-3.5" />
              Call
            </button>
          ) : null}
          {!isArchived && canSms ? (
            <button type="button" onClick={onSms} className={cn(crm.btnSecondary, "py-1.5 text-xs")}>
              <MessageSquareDot className="h-3.5 w-3.5" />
              SMS
            </button>
          ) : null}
          {!isArchived ? (
            <>
              <button type="button" onClick={onNote} className={cn(crm.btnGhost, "py-1.5 text-xs")}>
                <MessageSquare className="h-3.5 w-3.5" />
                Note
              </button>
              <button type="button" onClick={onTask} className={cn(crm.btnGhost, "py-1.5 text-xs")}>
                <CalendarClock className="h-3.5 w-3.5" />
                Callback
              </button>
              <button
                type="button"
                onClick={onDisposition}
                className={cn(crm.btnGhost, "py-1.5 text-xs", hasDisposition && "border-crm-accent/40 text-crm-accent")}
              >
                <CheckCheck className="h-3.5 w-3.5" />
                Outcome
              </button>
            </>
          ) : null}
          {queueBackHref ? (
            <Link href={queueBackHref} className={cn(crm.btnSecondary, "py-1.5 text-xs")}>
              <ListOrdered className="h-3.5 w-3.5" />
              Queue
            </Link>
          ) : null}
          <Link href={contactProfileHref} className={cn(crm.btnGhost, "py-1.5 text-xs")}>
            <ExternalLink className="h-3.5 w-3.5" />
            Contact
          </Link>
        </div>
      </div>
    </div>
  );
}
