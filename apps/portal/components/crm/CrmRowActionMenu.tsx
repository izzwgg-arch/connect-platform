"use client";

import { useCallback, useRef, useState } from "react";
import { Edit2, MoreHorizontal, Trash2 } from "lucide-react";
import { ViewportDropdown } from "../ViewportDropdown";
import { cn } from "./cn";
import { crm } from "./crmClasses";

export function CrmRowActionMenu({
  label,
  onEdit,
  onDelete,
  deleteLabel = "Delete",
  editDisabled = false,
  deleteDisabled = false,
  className,
}: {
  label: string;
  onEdit?: () => void;
  onDelete?: () => void;
  deleteLabel?: string;
  editDisabled?: boolean;
  deleteDisabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setOpen(false), []);

  if (!onEdit && !onDelete) return null;

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
          {onDelete ? (
            <button
              type="button"
              role="menuitem"
              disabled={deleteDisabled}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-crm-danger hover:bg-crm-danger/10 disabled:opacity-50"
              onClick={() => {
                closeMenu();
                onDelete();
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {deleteLabel}
            </button>
          ) : null}
        </div>
      </ViewportDropdown>
    </div>
  );
}
