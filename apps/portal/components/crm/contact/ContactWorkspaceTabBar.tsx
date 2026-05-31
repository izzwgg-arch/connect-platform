"use client";

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import {
  splitWorkspaceTabs,
  WORKSPACE_TABS,
  type ContactWorkspaceTab,
  type WorkspaceTabDef,
} from "./contactWorkspaceHelpers";

export function ContactWorkspaceTabBar({
  activeTab,
  onSelect,
  tabs = WORKSPACE_TABS,
  primaryCount,
  className,
}: {
  activeTab: ContactWorkspaceTab;
  onSelect: (tab: ContactWorkspaceTab) => void;
  tabs?: WorkspaceTabDef[];
  primaryCount?: number;
  className?: string;
}) {
  const { primary, overflow } = splitWorkspaceTabs(tabs, primaryCount);
  const overflowActive = overflow.some((t) => t.id === activeTab);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  function selectTab(tab: ContactWorkspaceTab) {
    onSelect(tab);
    setMenuOpen(false);
  }

  const tabButtonClass = (active: boolean) =>
    cn(
      "rounded-xl px-3 py-2 text-xs font-bold transition-colors",
      active
        ? "bg-crm-accent text-white shadow-sm"
        : "text-crm-muted hover:bg-crm-surface hover:text-crm-text",
    );

  return (
    <div className={cn("crm-contact-tab-bar flex flex-wrap items-center gap-1", className)}>
      {primary.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => selectTab(tab.id)}
          className={tabButtonClass(activeTab === tab.id)}
          aria-current={activeTab === tab.id ? "page" : undefined}
        >
          {tab.shortLabel ?? tab.label}
        </button>
      ))}
      {overflow.length > 0 ? (
        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className={cn(
              tabButtonClass(overflowActive),
              "inline-flex items-center gap-1",
              overflowActive && "ring-1 ring-crm-accent/30",
            )}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
          >
            {overflowActive
              ? (overflow.find((t) => t.id === activeTab)?.shortLabel ??
                overflow.find((t) => t.id === activeTab)?.label ??
                "More")
              : "More"}
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              className="absolute right-0 top-full z-40 mt-1 flex min-w-[10rem] flex-col rounded-xl border border-crm-border bg-crm-surface p-1 shadow-crm"
            >
              {overflow.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="menuitem"
                  onClick={() => selectTab(tab.id)}
                  className={cn(
                    crm.btnGhost,
                    "justify-start px-3 py-2 text-xs font-semibold",
                    activeTab === tab.id && "bg-crm-accent/10 text-crm-accent",
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
