"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";

export function ContactCampaignLeadNav({
  visible,
  position,
  total,
  previousLabel,
  nextLabel,
  onPrevious,
  onNext,
  previousDisabled,
  nextDisabled,
  loading,
}: {
  visible: boolean;
  position: number;
  total: number;
  previousLabel?: string | null;
  nextLabel?: string | null;
  onPrevious: () => void;
  onNext: () => void;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
  loading?: boolean;
}) {
  if (!visible || total <= 1) return null;

  return (
    <nav
      className="crm-contact-lead-nav fixed bottom-4 right-4 z-40 flex items-center overflow-hidden rounded-full border border-crm-border/75 bg-crm-surface/95 text-xs shadow-crm backdrop-blur-md sm:bottom-5 sm:right-5"
      aria-label="Campaign lead navigation"
    >
      <span className="hidden border-r border-crm-border/60 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide text-crm-muted sm:inline-flex">
        {position}/{total}
      </span>
      <button
        type="button"
        onClick={onPrevious}
        disabled={previousDisabled || loading}
        title={previousLabel ? `Previous: ${previousLabel}` : "Previous lead"}
        className={cn(
          crm.btnGhost,
          "h-9 min-w-9 rounded-none border-r border-crm-border/60 px-2.5 py-1.5",
        )}
      >
        <ChevronLeft className="h-4 w-4" />
        <span className="sr-only">Previous lead</span>
      </button>
      <span className="px-2 py-1.5 text-[10px] font-bold text-crm-muted sm:hidden">
        {position}/{total}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={nextDisabled || loading}
        title={nextLabel ? `Next: ${nextLabel}` : "Next lead"}
        className={cn(crm.btnGhost, "h-9 min-w-9 rounded-none border-l border-crm-border/60 px-2.5 py-1.5 text-crm-accent")}
      >
        <ChevronRight className="h-4 w-4" />
        <span className="sr-only">Next lead</span>
      </button>
    </nav>
  );
}
