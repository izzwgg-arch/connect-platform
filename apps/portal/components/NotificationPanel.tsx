"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { StatusChip } from "./StatusChip";
import { ViewportDropdown } from "./ViewportDropdown";
import { navigateToInternalRoute } from "../lib/safeRoute";
import { apiGet, apiPatch, apiPost } from "../services/apiClient";
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

type ActivityNotification = {
  id: string;
  kind: "ACTIVITY_CHAT" | "ACTIVITY_VOICEMAIL" | "ACTIVITY_MISSED";
  title: string;
  body: string | null;
  route: string;
};

// Shared with the mini dialer bell: dismissed missed-call ids live in localStorage
// so clearing them in one surface clears them in the other.
const MISSED_DISMISS_KEY = "cc-mini-missed-dismissed";
function loadIdSet(key: string): Set<string> {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(key) : null;
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? (arr as string[]) : []);
  } catch { return new Set(); }
}
function saveIdSet(key: string, set: Set<string>): void {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* ignore */ }
}
// "+18456627080" -> "845-662-7080" for display; names pass through.
function fmtTitle(sIn: string): string {
  const v = sIn || "";
  if (/[a-z]/i.test(v)) return v;
  const digits = v.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length === 10) return `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`;
  return v;
}

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
    case "ACTIVITY_CHAT":
      return { tone: "info", label: "Chat" };
    case "ACTIVITY_VOICEMAIL":
      return { tone: "warning", label: "Voicemail" };
    case "ACTIVITY_MISSED":
      return { tone: "danger", label: "Missed" };
    default:
      return { tone: "warning", label: "CRM" };
  }
}

export function NotificationPanel() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<CrmNotification[]>([]);
  const [activity, setActivity] = useState<ActivityNotification[]>([]);
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

  // Same items the mini dialer bell shows: New chats, new voicemails, missed calls.
  const loadActivity = useCallback(async () => {
    const [chatsR, vmsR, callsR] = await Promise.allSettled([
      apiGet<{ threads?: Array<{ id: string; isNew?: boolean; participantName?: string; lastMessage?: string; type?: string; externalSmsE164?: string | null }> }>("/chat/threads"),
      apiGet<{ voicemails?: Array<{ id: string; listened?: boolean; callerName?: string | null; callerId?: string }> }>("/voice/voicemail?folder=inbox&page=1&pageSize=20"),
      apiGet<{ items?: Array<{ callId?: string; rowId?: string; direction?: string; status?: string; fromName?: string | null; fromNumber?: string | null; startedAt?: string }> }>("/calls/history?page=1&pageSize=20"),
    ]);
    const items: ActivityNotification[] = [];
    if (chatsR.status === "fulfilled") {
      for (const t of chatsR.value.threads || []) {
        if (!t.isNew) continue;
        items.push({
          id: `chat:${t.id}`,
          kind: "ACTIVITY_CHAT",
          title: fmtTitle(t.participantName || "Chat"),
          body: t.lastMessage || "New message",
          route: t.type === "SMS" && t.externalSmsE164 ? `/sms?phone=${encodeURIComponent(t.externalSmsE164)}` : "/chat",
        });
      }
    }
    if (vmsR.status === "fulfilled") {
      for (const v of vmsR.value.voicemails || []) {
        if (v.listened) continue;
        items.push({ id: `vm:${v.id}`, kind: "ACTIVITY_VOICEMAIL", title: fmtTitle(v.callerName || v.callerId || "Voicemail"), body: "New voicemail", route: "/voicemail" });
      }
    }
    if (callsR.status === "fulfilled") {
      const dismissed = loadIdSet(MISSED_DISMISS_KEY);
      for (const c of callsR.value.items || []) {
        if (!((c.direction || "").toLowerCase().startsWith("in") && /miss|no.?answer|unanswer|fail/i.test(c.status || ""))) continue;
        const mid = String(c.callId || c.rowId || `${c.fromNumber || "x"}-${c.startedAt || ""}`);
        if (dismissed.has(mid)) continue;
        items.push({ id: `missed:${mid}`, kind: "ACTIVITY_MISSED", title: fmtTitle(c.fromName || c.fromNumber || "Missed call"), body: "Missed call", route: "/calls" });
      }
    }
    setActivity(items);
  }, []);

  const dismissActivity = useCallback(async (a: ActivityNotification) => {
    if (a.kind === "ACTIVITY_CHAT") {
      await apiPost(`/chat/threads/${a.id.slice(5)}/read`, {}).catch(() => undefined);
    } else if (a.kind === "ACTIVITY_VOICEMAIL") {
      await apiPatch(`/voice/voicemail/${encodeURIComponent(a.id.slice(3))}`, { listened: true }).catch(() => undefined);
    } else {
      const d = loadIdSet(MISSED_DISMISS_KEY);
      d.add(a.id.slice(7));
      saveIdSet(MISSED_DISMISS_KEY, d);
    }
    setActivity((prev) => prev.filter((x) => x.id !== a.id));
    window.dispatchEvent(new Event("cc:navbadges:refresh"));
  }, []);

  const markAllActivityRead = useCallback(async () => {
    const chats = activity.filter((a) => a.kind === "ACTIVITY_CHAT").map((a) => a.id.slice(5));
    const vms = activity.filter((a) => a.kind === "ACTIVITY_VOICEMAIL").map((a) => a.id.slice(3));
    const missed = activity.filter((a) => a.kind === "ACTIVITY_MISSED").map((a) => a.id.slice(7));
    if (missed.length > 0) {
      const d = loadIdSet(MISSED_DISMISS_KEY);
      for (const id of missed) d.add(id);
      saveIdSet(MISSED_DISMISS_KEY, d);
    }
    setActivity([]);
    await Promise.all([
      ...chats.map((id) => apiPost(`/chat/threads/${id}/read`, {}).catch(() => undefined)),
      ...vms.map((id) => apiPatch(`/voice/voicemail/${encodeURIComponent(id)}`, { listened: true }).catch(() => undefined)),
    ]);
    window.dispatchEvent(new Event("cc:navbadges:refresh"));
    void loadActivity();
  }, [activity, loadActivity]);

  useEffect(() => { if (open) { loadNotifications(); void loadActivity(); } }, [open, loadNotifications, loadActivity]);

  // Poll every 60s even when closed so the badge stays fresh.
  useEffect(() => {
    void loadNotifications();
    void loadActivity();
    const timer = setInterval(() => { void loadNotifications(); void loadActivity(); }, 60_000);
    return () => clearInterval(timer);
  }, [loadNotifications, loadActivity]);

  const dismiss = async (id: string) => {
    await apiPost(`/crm/notifications/${id}/dismiss`, {}).catch(() => undefined);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    setTotal((prev) => Math.max(0, prev - 1));
    seenIdsRef.current.delete(id);
  };

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const badgeCount = total + activity.length;
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
          <div className="panel-headline" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span>Notifications</span>
            {activity.length > 0 ? (
              <button
                type="button"
                onClick={() => { void markAllActivityRead(); }}
                style={{ border: "1px solid var(--border, rgba(125,125,125,.35))", background: "transparent", color: "var(--text-dim)", fontSize: 11, fontWeight: 600, borderRadius: 8, padding: "3px 8px", cursor: "pointer" }}
              >
                Mark all read
              </button>
            ) : null}
          </div>
          {activity.map((entry) => {
            const chip = kindChip(entry.kind);
            return (
              <div key={entry.id} className="notification-item" style={{ display: "grid", gap: 4 }}>
                <button type="button" onClick={() => { navigateToInternalRoute(entry.route); }} style={{ all: "unset", cursor: "pointer" }}>
                  <StatusChip tone={chip.tone} label={chip.label} />{" "}
                  <strong>{entry.title}</strong>
                  {entry.body ? (
                    <div style={{ marginTop: 4, fontSize: 12, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260 }}>{entry.body}</div>
                  ) : null}
                </button>
                <button type="button" onClick={() => { void dismissActivity(entry); }} style={{ justifySelf: "start", border: "none", background: "transparent", color: "var(--text-dim)", fontSize: 11, cursor: "pointer", padding: 0 }}>
                  Mark read
                </button>
              </div>
            );
          })}
          {notifications.length === 0 && activity.length === 0 ? (
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
                      navigateToInternalRoute(entry.route);
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
