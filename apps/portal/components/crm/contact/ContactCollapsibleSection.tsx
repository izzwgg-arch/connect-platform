"use client";

import { useEffect, useRef, useState } from "react";
import type { MouseEvent, PointerEvent, ReactNode } from "react";
import { ChevronDown, GripVertical } from "lucide-react";
import { cn } from "../cn";

export function ContactCollapsibleSection({
  id,
  title,
  summary: _summary,
  defaultOpen = false,
  badge,
  children,
  dragEnabled = false,
  dragVisual = "idle",
  onSummaryPointerDown,
  onSummaryClick,
}: {
  id: string;
  title: string;
  summary?: ReactNode;
  defaultOpen?: boolean;
  badge?: ReactNode;
  children: ReactNode;
  dragEnabled?: boolean;
  dragVisual?: "idle" | "dragging" | "drop-before" | "drop-after";
  onSummaryPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onSummaryClick?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const [pinnedOpen, setPinnedOpen] = useState(defaultOpen);
  const [previewOpen, setPreviewOpen] = useState(false);
  const hoverTimerRef = useRef<number | null>(null);
  const isOpen = pinnedOpen || previewOpen;

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current != null) window.clearTimeout(hoverTimerRef.current);
    };
  }, []);

  function clearHoverTimer() {
    if (hoverTimerRef.current != null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }

  function handleMouseEnter() {
    if (pinnedOpen) return;
    clearHoverTimer();
    hoverTimerRef.current = window.setTimeout(() => setPreviewOpen(true), 120);
  }

  function handleMouseLeave() {
    clearHoverTimer();
    if (!pinnedOpen) setPreviewOpen(false);
  }

  function handleSummaryClick(event: MouseEvent<HTMLElement>) {
    onSummaryClick?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    setPreviewOpen(false);
    setPinnedOpen((open) => !open);
  }

  function handleSummaryPointerDown(event: PointerEvent<HTMLElement>) {
    clearHoverTimer();
    setPreviewOpen(false);
    onSummaryPointerDown?.(event);
  }

  return (
    <details
      id={id}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={cn(
        "group/collapse rounded-2xl border border-crm-border/60 bg-white shadow-[0_10px_30px_-24px_rgba(15,23,42,0.35)] transition-colors open:border-crm-accent/25",
        previewOpen && !pinnedOpen && "crm-contact-rail-section-previewing",
        dragVisual === "dragging" && "crm-contact-rail-section-dragging",
        dragVisual === "drop-before" && "crm-contact-rail-section-drop-before",
        dragVisual === "drop-after" && "crm-contact-rail-section-drop-after",
      )}
      open={isOpen}
    >
      <summary
        onPointerDown={handleSummaryPointerDown}
        onClick={handleSummaryClick}
        className={cn(
          "flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-3 py-2.5 marker:content-none hover:bg-crm-accent/5 group-open/collapse:rounded-b-none [&::-webkit-details-marker]:hidden",
          dragEnabled && "cursor-grab active:cursor-grabbing",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-bold tracking-[-0.01em] text-crm-text group-open/collapse:text-crm-accent">{title}</span>
            {badge}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {dragEnabled ? (
            <GripVertical className="h-3.5 w-3.5 text-crm-muted/70 transition-colors group-hover/collapse:text-crm-accent" aria-hidden />
          ) : null}
          <ChevronDown className="h-4 w-4 text-crm-muted transition-transform group-open/collapse:rotate-180 group-hover/collapse:text-crm-accent" />
        </div>
      </summary>
      <div className={cn("border-t border-crm-border/35 px-3 py-3")}>
        {children}
      </div>
    </details>
  );
}
