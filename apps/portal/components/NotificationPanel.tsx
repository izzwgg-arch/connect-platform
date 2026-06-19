"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { StatusChip } from "./StatusChip";
import { ViewportDropdown } from "./ViewportDropdown";
import { apiGet, apiPost } from "../services/apiClient";
import {
  NotificationToastStack,
  type ToastNotification,
} from "./NotificationToast";

type CrmNotification = {
  id: string;
  title: string;
  body: string | null;
  route: string | null;
  kind: string;
  createdAt: string;
};

function kindChip(kind: string): { tone: "danger" | "info" | "warning" | "success"; label: string } {
  switch (kind) {
    case "CRM_VOICEMAIL_DROP_FAILED":
      return { tone: "danger", label: "Voicemail" };
    case "CRM_WEBSITE_SUBMISSION":
      return { tone: "info", label: "Form" };
    case "CRM_INBOUND_SMS":
      return { tone: "info", label: "SMS" };
    case "CRM_EMAIL_REPLY":
      return { tone: "info", label: "Email" };
    case "CRM_INBOUND_CALL":
      return { tone: "warning", label: "Call" };
    case "CRM_BULK_EMAIL_COMPLETED":
      return { tone: "success", label: "Email" };
    default:
      return { tone: "warning", label: "CRM" };
  }
}

export function NotificationPanel() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<CrmNotification[]>([]);
  const [total, setTotal] = useState(0);
  const [toasts, setToasts] = useState<ToastNotification[]>([]);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Track which IDs we've already shown a toast for (persists across polls).
  const seenIdsRef = useRef<Set<string>>(new Set());
  const closePanel = useCallback(() => setOpen(false), []);

  const loadNotifications = useCallback(async () => {
    try {
      const res = await apiGet<{ notifications: CrmNotification[]; total?: number }>(
        "/crm/notifications?limit=20",
      );
      const incoming = res.notifications ?? [];
      setNotifications(incoming);
      setTotal(res.total ?? incoming.length);

      // Diff against seen IDs — queue toasts for newly arrived notifications.
      const newItems = incoming.filter((n) => !seenIdsRef.current.has(n.id));
      if (newItems.length > 0 && seenIdsRef.current.size > 0) {
        // seenIdsRef is non-empty = not first load, so these are genuinely new.
        setToasts((prev) => [
          ...prev,
          ...newItems.map((n) => ({
            id: n.id,
            title: n.title,
            body: n.body,
            route: n.route,
            kind: n.kind,
          })),
        ]);
      }
      // Mark all incoming IDs as seen regardless.
      incoming.forEach((n) => seenIdsRef.current.add(n.id));
    } catch {
      // Silently ignore — users without CRM access will hit 403 here.
    }
  }, []);

  useEffect(() => { if (open) loadNotifications(); }, [open, loadNotifications]);

  // Poll every 60s even when closed so the badge stays fresh.
  useEffect(() => {
    void loadNotifications();
    const timer = setInterval(() => { void loadNotifications(); }, 60_000);
    return () => clearInterval(timer);
  }, [loadNotifications]);

  const dismiss = async (id: string) => {
    await apiPost(`/crm/notifications/${id}/dismiss`, {}).catch(() => undefined);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    setTotal((prev) => Math.max(0, prev - 1));
    seenIdsRef.current.delete(id);
  };

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const badgeCount = total;
  const badgeLabel = badgeCount > 99 ? "99+" : String(badgeCount);

  return (
    <>
      {/* Toast stack — always rendered, positioned fixed at top-right */}
      <NotificationToastStack toasts={toasts} onDismiss={dismissToast} />

      <div className="menu-wrap">
        <button
          ref={triggerRef}
          className="icon-btn"
          onClick={() => setOpen((v) => !v)}
          title={
            badgeCount > 0
              ? `${badgeCount} notification${badgeCount === 1 ? "" : "s"}`
              : "Notifications"
          }
          style={{ position: "relative" }}
        >
          <Bell size={16} />
          {badgeCount > 0 && (
            <span
              aria-label={`${badgeCount} notifications`}
              style={{
                position: "absolute",
                top: 2,
                right: 2,
                minWidth: "1rem",
                height: "1rem",
                borderRadius: "9999px",
                background: "var(--danger)",
                color: "#fff",
                fontSize: "10px",
                fontWeight: 700,
                lineHeight: "1rem",
                textAlign: "center",
                padding: "0 3px",
                boxShadow: "0 0 0 2px var(--surface, #0b0f1a)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {badgeLabel}
            </span>
          )}
        </button>

        <ViewportDropdown open={open} triggerRef={triggerRef} onClose={closePanel}>
          <div className="panel-headline">Notifications</div>
          {notifications.length === 0 ? (
            <div className="notification-item" style={{ color: "var(--text-dim)" }}>
              No new notifications
            </div>
          ) : (
            notifications.map((entry) => {
              const chip = kindChip(entry.kind);
              return (
                <div
                  key={entry.id}
                  className="notification-item"
                  style={{ display: "grid", gap: 4 }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (entry.route) window.location.href = entry.route;
                    }}
                    style={{
                      all: "unset",
                      cursor: entry.route ? "pointer" : "default",
                    }}
                  >
                    <StatusChip tone={chip.tone} label={chip.label} />{" "}
                    <strong>{entry.title}</strong>
                    {entry.body ? (
                      <div
                        style={{
                          marginTop: 4,
                          fontSize: 12,
                          color: "var(--text-dim)",
                        }}
                      >
                        {entry.body}
                      </div>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    onClick={() => dismiss(entry.id)}
                    style={{
                      justifySelf: "start",
                      border: "none",
                      background: "transparent",
                      color: "var(--text-dim)",
                      fontSize: 11,
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              );
            })
          )}
        </ViewportDropdown>
      </div>
    </>
  );
}
