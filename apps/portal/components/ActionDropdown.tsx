"use client";

import { useState } from "react";

export function ActionDropdown({ label, actions }: { label: string; actions: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="menu-wrap">
      <button className="btn ghost" onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open ? (
        <div className="dropdown-panel">
          {actions.map((action) => (
            <button key={action} className="dropdown-action">
              {action}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
