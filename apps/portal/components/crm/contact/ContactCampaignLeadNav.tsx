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
      className="crm-contact-lead-nav fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2 sm:bottom-6 sm:right-6"
      aria-label="Campaign lead navigation"
    >
      <span className="rounded-full border border-crm-border/70 bg-crm-surface/95 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-crm-muted shadow-crm backdrop-blur-md">
        Lead {position} of {total}
      </span>
      <div className="flex items-stretch overflow-hidden rounded-crm-lg border border-crm-border/80 bg-crm-surface/95 shadow-crm backdrop-blur-md">
        <button
          type="button"
          onClick={onPrevious}
          disabled={previousDisabled || loading}
          title={previousLabel ? `Previous: ${previousLabel}` : "Previous lead"}
          className={cn(
            crm.btnGhost,
            "min-h-[2.75rem] min-w-[2.75rem] flex-col gap-0 rounded-none border-r border-crm-border/60 px-3 py-2 sm:min-w-[5.5rem]",
          )}
        >
          <ChevronLeft className="h-4 w-4" />
          <span className="hidden text-[10px] font-bold sm:inline">Prev</span>
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={nextDisabled || loading}
          title={nextLabel ? `Next: ${nextLabel}` : "Next lead"}
          className={cn(
            crm.btnPrimary,
            "min-h-[2.75rem] min-w-[2.75rem] flex-col gap-0 rounded-none px-3 py-2 sm:min-w-[5.5rem]",
          )}
        >
          <ChevronRight className="h-4 w-4" />
          <span className="hidden text-[10px] font-bold sm:inline">Next</span>
        </button>
      </div>
    </nav>
  );
}
