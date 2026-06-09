"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { StatusChip } from "./StatusChip";
import { ViewportDropdown } from "./ViewportDropdown";
import { apiGet, apiPost } from "../services/apiClient";

type CrmNotification = {
  id: string;
  title: string;
  body: string | null;
  route: string | null;
  kind: string;
  createdAt: string;
};

export function NotificationPanel() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<CrmNotification[]>([]);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closePanel = useCallback(() => setOpen(false), []);
  const loadNotifications = useCallback(async () => {
    try {
      const res = await apiGet<{ notifications: CrmNotification[] }>("/crm/notifications?limit=10");
      setNotifications(res.notifications);
    } catch {
      setNotifications([]);
    }
  }, []);
  useEffect(() => { if (open) loadNotifications(); }, [open, loadNotifications]);

  const dismiss = async (id: string) => {
    await apiPost(`/crm/notifications/${id}/dismiss`, {}).catch(() => undefined);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  };

  return (
    <div className="menu-wrap">
      <button ref={triggerRef} className="icon-btn" onClick={() => setOpen((v) => !v)} title="Notifications">
        <Bell size={16} />
      </button>
      <ViewportDropdown open={open} triggerRef={triggerRef} onClose={closePanel}>
          <div className="panel-headline">Notifications</div>
          {notifications.length === 0 ? (
            <div className="notification-item" style={{ color: "var(--text-dim)" }}>No new notifications</div>
          ) : notifications.map((entry) => (
            <div key={entry.id} className="notification-item" style={{ display: "grid", gap: 4 }}>
              <button
                type="button"
                onClick={() => {
                  if (entry.route) window.location.href = entry.route;
                }}
                style={{ all: "unset", cursor: entry.route ? "pointer" : "default" }}
              >
                <StatusChip tone={entry.kind === "CRM_WEBSITE_SUBMISSION" ? "info" : "warning"} label="CRM" />{" "}
                <strong>{entry.title}</strong>
                {entry.body ? <div style={{ marginTop: 4, fontSize: 12, color: "var(--text-dim)" }}>{entry.body}</div> : null}
              </button>
              <button
                type="button"
                onClick={() => dismiss(entry.id)}
                style={{ justifySelf: "start", border: "none", background: "transparent", color: "var(--text-dim)", fontSize: 11, cursor: "pointer", padding: 0 }}
              >
                Dismiss
              </button>
            </div>
          ))}
      </ViewportDropdown>
    </div>
  );
}
