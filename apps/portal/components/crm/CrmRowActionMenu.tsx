"use client";

import { useCallback, useRef, useState } from "react";
import { Archive, Edit2, MoreHorizontal } from "lucide-react";
import { ViewportDropdown } from "../ViewportDropdown";
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setOpen(false), []);

  if (!onEdit && !onArchive) return null;

  return (
    <div className={cn("relative", className)} onClick={(e) => e.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        className={cn(crm.btnGhost, "h-9 w-9 p-0")}
        aria-label={`Actions for ${label}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      <ViewportDropdown
        open={open}
        triggerRef={triggerRef}
        onClose={closeMenu}
        width={152}
        sideOffset={4}
        className="crm-row-action-menu-panel"
      >
        <div role="menu">
          {onEdit ? (
            <button
              type="button"
              role="menuitem"
              disabled={editDisabled}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-crm-text hover:bg-crm-surface-2/80 disabled:opacity-50"
              onClick={() => {
                closeMenu();
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
                closeMenu();
                onArchive();
              }}
            >
              <Archive className="h-3.5 w-3.5" />
              {archiveLabel}
            </button>
          ) : null}
        </div>
      </ViewportDropdown>
    </div>
  );
}
