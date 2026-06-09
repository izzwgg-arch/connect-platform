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
  // Keep the bell fresh even while closed so failures (e.g. an undelivered
  // voicemail drop) surface promptly via the unread indicator.
  useEffect(() => {
    void loadNotifications();
    const timer = setInterval(() => { void loadNotifications(); }, 60_000);
    return () => clearInterval(timer);
  }, [loadNotifications]);

  const dismiss = async (id: string) => {
    await apiPost(`/crm/notifications/${id}/dismiss`, {}).catch(() => undefined);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  };

  const hasUnread = notifications.length > 0;

  return (
    <div className="menu-wrap">
      <button
        ref={triggerRef}
        className="icon-btn"
        onClick={() => setOpen((v) => !v)}
        title={hasUnread ? `${notifications.length} notification${notifications.length === 1 ? "" : "s"}` : "Notifications"}
        style={{ position: "relative" }}
      >
        <Bell size={16} />
        {hasUnread ? (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: 4,
              right: 4,
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--danger)",
              boxShadow: "0 0 0 2px var(--surface, #0b0f1a)",
            }}
          />
        ) : null}
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
                <StatusChip
                  tone={
                    entry.kind === "CRM_VOICEMAIL_DROP_FAILED"
                      ? "danger"
                      : entry.kind === "CRM_WEBSITE_SUBMISSION"
                        ? "info"
                        : "warning"
                  }
                  label={entry.kind === "CRM_VOICEMAIL_DROP_FAILED" ? "Voicemail" : "CRM"}
                />{" "}
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
