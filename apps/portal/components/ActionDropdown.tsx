"use client";

import { useCallback, useRef, useState } from "react";
import { ViewportDropdown } from "./ViewportDropdown";

export function ActionDropdown({ label, actions }: { label: string; actions: string[] }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeDropdown = useCallback(() => setOpen(false), []);
  return (
    <div className="menu-wrap">
      <button ref={triggerRef} className="btn ghost" onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      <ViewportDropdown open={open} triggerRef={triggerRef} onClose={closeDropdown}>
          {actions.map((action) => (
            <button key={action} className="dropdown-action">
              {action}
            </button>
          ))}
      </ViewportDropdown>
    </div>
  );
}
