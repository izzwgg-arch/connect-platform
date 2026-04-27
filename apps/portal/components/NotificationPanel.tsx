"use client";

import { useCallback, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { StatusChip } from "./StatusChip";
import { ViewportDropdown } from "./ViewportDropdown";

const notifications = [
  { id: "n1", text: "Trunk SIP-West experiencing packet loss", tone: "warning" as const },
  { id: "n2", text: "Queue Support has 3 waiting calls", tone: "info" as const }
];

export function NotificationPanel() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closePanel = useCallback(() => setOpen(false), []);
  return (
    <div className="menu-wrap">
      <button ref={triggerRef} className="icon-btn" onClick={() => setOpen((v) => !v)} title="Notifications">
        <Bell size={16} />
      </button>
      <ViewportDropdown open={open} triggerRef={triggerRef} onClose={closePanel}>
          <div className="panel-headline">Notifications</div>
          {notifications.map((entry) => (
            <div key={entry.id} className="notification-item">
              <StatusChip tone={entry.tone} label="Alert" /> {entry.text}
            </div>
          ))}
      </ViewportDropdown>
    </div>
  );
}
