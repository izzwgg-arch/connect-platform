"use client";

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

type CollapsibleNavSectionProps = {
  id: string;
  label: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
};

/**
 * One section of the sidebar. There is deliberately no `railMode` branch:
 * the collapsed icon rail renders this exact markup and hides the heading in
 * CSS. Swapping markup on the rail toggle is what made the sidebar stutter —
 * see the note in SidebarNav.tsx.
 */
export function CollapsibleNavSection({
  id,
  label,
  expanded,
  onToggle,
  children
}: CollapsibleNavSectionProps) {
  return (
    <div className={`nav-collapsible ${expanded ? "nav-collapsible-open" : ""}`}>
      <button
        type="button"
        className="nav-collapsible-head"
        aria-expanded={expanded}
        aria-controls={`${id}-panel`}
        id={`${id}-head`}
        onClick={onToggle}
      >
        <span className="nav-collapsible-label">{label}</span>
        <ChevronDown className="nav-collapsible-chevron" aria-hidden size={16} strokeWidth={2} />
      </button>
      <div className="nav-collapsible-panel" id={`${id}-panel`} role="region" aria-labelledby={`${id}-head`}>
        <div className="nav-collapsible-inner">{children}</div>
      </div>
    </div>
  );
}
