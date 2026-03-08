"use client";

import { useState } from "react";
import { StatusChip } from "./StatusChip";

const notifications = [
  { id: "n1", text: "Trunk SIP-West experiencing packet loss", tone: "warning" as const },
  { id: "n2", text: "Queue Support has 3 waiting calls", tone: "info" as const }
];

export function NotificationPanel() {
  const [open, setOpen] = useState(false);
  return (
    <div className="menu-wrap">
      <button className="btn ghost" onClick={() => setOpen((v) => !v)}>
        Notifications
      </button>
      {open ? (
        <div className="dropdown-panel">
          <div className="panel-headline">Notifications</div>
          {notifications.map((entry) => (
            <div key={entry.id} className="notification-item">
              <StatusChip tone={entry.tone} label="Alert" /> {entry.text}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
