"use client";

import { useEffect, useRef, useState } from "react";
import { Archive, Edit2, MoreHorizontal } from "lucide-react";
import { cn } from "./cn";
import { crm } from "./crmClasses";

export function CrmRowActionMenu({
  label,
  onEdit,
  onArchive,
  archiveLabel = "Archive",
  editDisabled = false,
  archiveDisabled = false,
  className,
}: {
  label: string;
  onEdit?: () => void;
  onArchive?: () => void;
  archiveLabel?: string;
  editDisabled?: boolean;
  archiveDisabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!onEdit && !onArchive) return null;

  return (
    <div ref={rootRef} className={cn("relative", className)} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={cn(crm.btnGhost, "h-9 w-9 p-0")}
        aria-label={`Actions for ${label}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open ? (
        <div
          className="absolute right-0 z-20 mt-1 min-w-[9.5rem] rounded-crm border border-crm-border bg-crm-surface py-1 shadow-lg"
          role="menu"
        >
          {onEdit ? (
            <button
              type="button"
              role="menuitem"
              disabled={editDisabled}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-crm-text hover:bg-crm-surface-2/80 disabled:opacity-50"
              onClick={() => {
                setOpen(false);
                onEdit();
              }}
            >
              <Edit2 className="h-3.5 w-3.5" />
              Edit
            </button>
          ) : null}
          {onArchive ? (
            <button
              type="button"
              role="menuitem"
              disabled={archiveDisabled}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-crm-danger hover:bg-crm-danger/10 disabled:opacity-50"
              onClick={() => {
                setOpen(false);
                onArchive();
              }}
            >
              <Archive className="h-3.5 w-3.5" />
              {archiveLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
