"use client";

import { Keyboard, ListChecks, Copy, PhoneCall } from "lucide-react";
import Link from "next/link";
import { cn } from "../cn";
import { crm } from "../crmClasses";

const TIPS = [
  {
    icon: Keyboard,
    title: "Press N",
    body: "Create a new checklist anytime",
    tone: "text-crm-accent",
  },
  {
    icon: ListChecks,
    title: "Checklist mode",
    body: "Use guided flows in Live Call",
    tone: "text-crm-warning",
    href: "/crm/live-call",
  },
  {
    icon: Copy,
    title: "Copy steps",
    body: "Reuse proven language in playbooks",
    tone: "text-violet-300",
  },
  {
    icon: PhoneCall,
    title: "Go live",
    body: "Open Live Call Workspace",
    tone: "text-crm-success",
    href: "/crm/live-call",
  },
] as const;

export function ChecklistQuickTipsStrip() {
  return (
    <div className={crm.checklistTipsStrip}>
      <div className="flex flex-col gap-1 sm:flex-row sm:divide-x sm:divide-crm-border/35">
        {TIPS.map((tip) => {
          const Icon = tip.icon;
          const inner = (
            <>
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-crm-border/40 bg-[#060b14]/90 shadow-[0_0_16px_-6px_rgba(56,189,248,0.15)]",
                  tip.tone
                )}
              >
                <Icon size={14} />
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-semibold text-crm-text">
                  {tip.title}
                </span>
                <span className="block text-[10px] leading-snug text-crm-muted">
                  {tip.body}
                </span>
              </span>
            </>
          );

          if ("href" in tip && tip.href) {
            return (
              <Link
                key={tip.title}
                href={tip.href}
                className={cn(crm.checklistTipSegment, "no-underline")}
              >
                {inner}
              </Link>
            );
          }

          return (
            <div key={tip.title} className={crm.checklistTipSegment}>
              {inner}
            </div>
          );
        })}
      </div>
    </div>
  );
}
