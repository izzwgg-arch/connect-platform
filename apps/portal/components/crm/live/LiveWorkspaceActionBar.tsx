"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  CalendarClock,
  CheckCheck,
  FileText,
  ListOrdered,
  Mail,
  MessageSquare,
  MessageSquareDot,
  Phone,
  Plus,
  SkipForward,
} from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";

export function LiveWorkspaceActionBar({
  contactName,
  isArchived,
  canCall,
  canSms,
  canEmail,
  hasDisposition,
  queueBackHref,
  powerDialHref,
  onCall,
  onSms,
  onEmail,
  onNote,
  onTask,
  onDisposition,
  onNextLead,
}: {
  contactName: string;
  isArchived: boolean;
  canCall: boolean;
  canSms: boolean;
  canEmail: boolean;
  hasDisposition: boolean;
  queueBackHref: string | null;
  powerDialHref: string | null;
  onCall: () => void;
  onSms: () => void;
  onEmail: () => void;
  onNote: () => void;
  onTask: () => void;
  onDisposition: () => void;
  onNextLead?: () => void;
}) {
  const actions: Array<{
    label: string;
    hint: string;
    icon: ReactNode;
    tone: string;
    disabled?: boolean;
    href?: string | null;
    title?: string;
    onClick?: () => void;
  }> = [
    {
      label: "Call",
      hint: "F2",
      icon: <Phone className="h-4 w-4" />,
      tone: "bg-emerald-500 text-white hover:bg-emerald-600",
      disabled: isArchived || !canCall,
      onClick: onCall,
    },
    {
      label: "Power Dial",
      hint: "F3",
      icon: <ListOrdered className="h-4 w-4" />,
      tone: "bg-blue-600 text-white hover:bg-blue-700",
      href: powerDialHref,
      disabled: isArchived || !powerDialHref,
    },
    {
      label: "SMS",
      hint: "F4",
      icon: <MessageSquareDot className="h-4 w-4" />,
      tone: "bg-teal-500 text-white hover:bg-teal-600",
      disabled: isArchived || !canSms,
      onClick: onSms,
    },
    {
      label: "WhatsApp",
      hint: "NA",
      icon: <MessageSquare className="h-4 w-4" />,
      tone: "bg-slate-200 text-slate-500 dark:bg-crm-surface-2 dark:text-crm-muted",
      disabled: true,
      title: "WhatsApp contact actions are not wired for this workspace yet",
    },
    {
      label: "Email",
      hint: "F6",
      icon: <Mail className="h-4 w-4" />,
      tone: "bg-violet-600 text-white hover:bg-violet-700",
      disabled: isArchived || !canEmail,
      onClick: onEmail,
    },
    {
      label: "Add Note",
      hint: "F7",
      icon: <Plus className="h-4 w-4" />,
      tone: "bg-crm-surface text-crm-text hover:bg-crm-surface-2",
      disabled: isArchived,
      onClick: onNote,
    },
    {
      label: "Disposition",
      hint: "F8",
      icon: <CheckCheck className="h-4 w-4" />,
      tone: hasDisposition
        ? "bg-amber-500 text-white hover:bg-amber-600"
        : "bg-crm-surface text-crm-text hover:bg-crm-surface-2",
      disabled: isArchived,
      onClick: onDisposition,
    },
    {
      label: "Next Lead",
      hint: "F9",
      icon: <SkipForward className="h-4 w-4" />,
      tone: "bg-crm-surface text-crm-text hover:bg-crm-surface-2",
      disabled: !queueBackHref,
      href: queueBackHref,
      onClick: onNextLead,
    },
  ];

  return (
    <div
      className={cn(
        "sticky top-0 z-30 -mx-4 border-b border-crm-border/70 bg-crm-bg/90 px-4 py-2.5 backdrop-blur-xl sm:-mx-6 lg:-mx-8 lg:px-8",
        "shadow-[0_14px_36px_-28px_rgba(15,23,42,0.65)]",
      )}
      role="toolbar"
      aria-label="Live workspace actions"
    >
      <div className="flex items-center gap-3 overflow-x-auto pb-0.5">
        <div className="hidden min-w-[10rem] shrink-0 flex-col sm:flex">
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-crm-muted">Operational cockpit</span>
          <span className="truncate text-sm font-semibold text-crm-text">{contactName}</span>
        </div>
        <div className="flex min-w-max flex-1 items-center gap-2">
          {actions.map((action) => {
            const content = (
              <>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white/18 text-current shadow-[inset_0_1px_0_rgba(255,255,255,0.24)] dark:bg-white/10">
                  {action.icon}
                </span>
                <span className="flex min-w-0 flex-col items-start leading-tight">
                  <span className="text-xs font-bold">{action.label}</span>
                  <span className="text-[10px] font-semibold uppercase opacity-70">{action.hint}</span>
                </span>
              </>
            );
            const className = cn(
              "inline-flex min-h-12 min-w-[7.75rem] items-center gap-2 rounded-2xl border border-crm-border/70 px-3 text-left shadow-[0_10px_28px_-22px_rgba(15,23,42,0.9)] transition-all",
              action.tone,
              action.disabled && "cursor-not-allowed opacity-55 hover:bg-inherit",
            );
            if (action.href && !action.disabled) {
              return (
                <Link key={action.label} href={action.href} className={className} title={action.title}>
                  {content}
                </Link>
              );
            }
            return (
              <button
                key={action.label}
                type="button"
                disabled={action.disabled}
                onClick={action.onClick}
                title={action.title}
                className={className}
              >
                {content}
              </button>
            );
          })}
          {!isArchived ? (
            <button type="button" onClick={onTask} className="inline-flex min-h-12 min-w-[7.75rem] items-center gap-2 rounded-2xl border border-crm-border/70 bg-crm-surface px-3 text-left text-crm-text transition-all hover:bg-crm-surface-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-crm-accent/12 text-crm-accent">
                <CalendarClock className="h-4 w-4" />
              </span>
              <span className="flex flex-col leading-tight">
                <span className="text-xs font-bold">Task</span>
                <span className="text-[10px] font-semibold uppercase text-crm-muted">Add</span>
              </span>
            </button>
          ) : null}
          <span className="inline-flex min-h-12 items-center gap-2 rounded-2xl border border-dashed border-crm-border/70 px-3 text-xs font-medium text-crm-muted">
            <FileText className="h-4 w-4" />
            1-6 disposition
          </span>
        </div>
      </div>
    </div>
  );
}
