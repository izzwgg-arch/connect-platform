"use client";

import { ChevronDown } from "lucide-react";
import { cn } from "../cn";

export function ContactCollapsibleSection({
  id,
  title,
  summary: _summary,
  defaultOpen = false,
  badge,
  children,
}: {
  id: string;
  title: string;
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <details
      id={id}
      className="group/collapse rounded-[1.1rem] border border-crm-border/60 bg-white shadow-[0_10px_30px_-24px_rgba(15,23,42,0.35)] transition-colors open:border-crm-accent/25"
      open={defaultOpen}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-[1.1rem] px-3 py-2.5 marker:content-none hover:bg-crm-accent/5 group-open/collapse:rounded-b-none [&::-webkit-details-marker]:hidden">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-[0.15em] text-crm-muted group-open/collapse:text-crm-accent">{title}</span>
            {badge}
          </div>
        </div>
        <ChevronDown className="h-4 w-4 shrink-0 text-crm-muted transition-transform group-open/collapse:rotate-180 group-hover/collapse:text-crm-accent" />
      </summary>
      <div className={cn("border-t border-crm-border/35 px-3 py-3")}>
        {children}
      </div>
    </details>
  );
}
