"use client";

import { ChevronDown } from "lucide-react";
import { cn } from "../cn";

export function ContactCollapsibleSection({
  id,
  title,
  summary,
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
      className="group/collapse rounded-xl border border-crm-border/60 bg-crm-surface/40 transition-colors open:border-crm-accent/35 open:bg-crm-surface-2/45"
      open={defaultOpen}
    >
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 rounded-xl px-3 py-2.5 marker:content-none hover:bg-crm-surface-2/45 group-open/collapse:rounded-b-none [&::-webkit-details-marker]:hidden">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-[0.14em] text-crm-muted group-open/collapse:text-crm-accent">{title}</span>
            {badge}
          </div>
          {summary ? (
            <div className="mt-1 text-sm leading-snug text-crm-text group-open/collapse:text-crm-muted">{summary}</div>
          ) : null}
        </div>
        <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-crm-muted transition-transform group-open/collapse:rotate-180" />
      </summary>
      <div className={cn("border-t border-crm-border/50 px-3 py-3", summary ? "" : "pt-0")}>
        {children}
      </div>
    </details>
  );
}
