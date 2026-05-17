"use client";

import Link from "next/link";
import {
  Calendar,
  ListOrdered,
  MessageSquare,
  MessageSquareDot,
  Phone,
  Radio,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";

export function ContactStickyActionBar({
  visible,
  contactName,
  isArchived,
  canCall,
  canSms,
  canWorkspace,
  hasEmail,
  workspaceHref,
  returnTo,
  onCall,
  onSms,
  onNote,
  onTask,
}: {
  visible: boolean;
  contactName: string;
  isArchived: boolean;
  canCall: boolean;
  canSms: boolean;
  canWorkspace: boolean;
  hasEmail: boolean;
  workspaceHref: string;
  returnTo: string | null;
  onCall: () => void;
  onSms: () => void;
  onNote: () => void;
  onTask: () => void;
}) {
  if (!visible) return null;

  return (
    <div
      className={cn(
        "sticky top-0 z-30 -mx-4 border-b border-crm-border bg-crm-bg/95 px-4 py-2 backdrop-blur-md sm:-mx-6 sm:px-6",
        "shadow-[0_4px_24px_rgba(0,0,0,0.25)]",
      )}
      role="toolbar"
      aria-label="Quick actions"
    >
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold text-crm-text">{contactName}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {!isArchived && canCall ? (
            <button type="button" onClick={onCall} className={cn(crm.btnSecondary, "py-1.5 text-xs")}>
              <Phone className="h-3.5 w-3.5" />
              Call
            </button>
          ) : null}
          {canWorkspace && !isArchived ? (
            <Link href={workspaceHref} className={cn(crm.btnPrimary, "py-1.5 text-xs")}>
              <Radio className="h-3.5 w-3.5" />
              Workspace
            </Link>
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
                <Calendar className="h-3.5 w-3.5" />
                Task
              </button>
            </>
          ) : null}
          {returnTo?.includes("/crm/queue") ? (
            <Link href={returnTo} className={cn(crm.btnGhost, "py-1.5 text-xs")}>
              <ListOrdered className="h-3.5 w-3.5" />
              Queue
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}
