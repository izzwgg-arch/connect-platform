"use client";

import { useEffect, useRef, useState } from "react";
import { Phone, Mail, MessageSquare, Bell, X } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ToastNotification = {
  id: string;
  title: string;
  body?: string | null;
  route?: string | null;
  kind: string;
};

// ── Per-toast item ─────────────────────────────────────────────────────────────

function ToastItem({
  notification,
  onDismiss,
}: {
  notification: ToastNotification;
  onDismiss: (id: string) => void;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [visible, setVisible] = useState(false);

  const dismiss = () => {
    setVisible(false);
    setTimeout(() => onDismiss(notification.id), 300);
  };

  const startTimer = () => {
    timerRef.current = setTimeout(dismiss, 5000);
  };

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  };

  useEffect(() => {
    // Slide in after mount
    const raf = requestAnimationFrame(() => setVisible(true));
    startTimer();
    return () => {
      cancelAnimationFrame(raf);
      clearTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const icon = () => {
    switch (notification.kind) {
      case "CRM_INBOUND_CALL":
        return <Phone className="h-4 w-4 shrink-0 text-amber-500" />;
      case "CRM_EMAIL_REPLY":
        return <Mail className="h-4 w-4 shrink-0 text-blue-500" />;
      case "CRM_INBOUND_SMS":
        return <MessageSquare className="h-4 w-4 shrink-0 text-green-500" />;
      default:
        return <Bell className="h-4 w-4 shrink-0 text-crm-accent" />;
    }
  };

  const handleClick = () => {
    if (notification.route) {
      window.location.href = notification.route;
    }
    dismiss();
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={[
        "notification-toast-item",
        "flex items-start gap-3 rounded-crm border border-crm-border bg-crm-surface shadow-xl",
        "w-80 p-3 cursor-pointer transition-all duration-300",
        visible
          ? "translate-x-0 opacity-100"
          : "translate-x-full opacity-0",
      ].join(" ")}
      onMouseEnter={clearTimer}
      onMouseLeave={startTimer}
      onClick={handleClick}
    >
      <div className="mt-0.5">{icon()}</div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold leading-tight text-crm-text truncate">
          {notification.title}
        </p>
        {notification.body && (
          <p className="mt-0.5 text-xs text-crm-muted line-clamp-2">
            {notification.body}
          </p>
        )}
        {notification.route && (
          <p className="mt-1 text-xs font-medium text-crm-accent">
            View →
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); dismiss(); }}
        className="shrink-0 rounded p-0.5 text-crm-muted hover:text-crm-text"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ── Stack container ────────────────────────────────────────────────────────────

export function NotificationToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastNotification[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div
      className="notification-toast-stack fixed right-4 flex flex-col gap-2 z-[500]"
      style={{ top: "72px" }}
      aria-label="Notifications"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} notification={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
