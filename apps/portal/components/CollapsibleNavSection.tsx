"use client";

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

type CollapsibleNavSectionProps = {
  id: string;
  label: string;
  expanded: boolean;
  onToggle: () => void;
  railMode: boolean;
  children: ReactNode;
};

export function CollapsibleNavSection({
  id,
  label,
  expanded,
  onToggle,
  railMode,
  children
}: CollapsibleNavSectionProps) {
  if (railMode) {
    return <div className="nav-section-rail">{children}</div>;
  }

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
