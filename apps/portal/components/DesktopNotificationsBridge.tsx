"use client";

import { useEffect, useRef } from "react";
import { useAppContext } from "../hooks/useAppContext";
import { useSipPhone } from "../hooks/useSipPhone";
import { ApiError, apiGet, hasBrowserAuthToken } from "../services/apiClient";
import { fetchTenantSmsInboxThreads, type SmsThread } from "../services/platformData";
import {
  buildDesktopVoicemailInboxProbePath,
  NotificationProbeBackoff,
} from "../lib/desktopNotificationPoll";

type VoicemailProbe = {
  voicemails?: Array<{
    id: string;
    callerId?: string;
    callerName?: string | null;
    listened?: boolean;
    receivedAt?: string;
  }>;
};

const SEEN_STORE_KEY = "cc:notif:seen:v1";
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEEN_MAX = 800;

/** Durable, cross-window fire-once guard. Returns true if this key already fired
 *  (caller should skip); otherwise records it and returns false. Backed by
 *  localStorage, shared by every desktop window, so a given notification fires
 *  exactly once across reloads, relaunches, and multiple windows. */
function alreadyNotified(key: string): boolean {
  try {
    const now = Date.now();
    const raw = JSON.parse(window.localStorage.getItem(SEEN_STORE_KEY) || "{}") as Record<string, number>;
    for (const k of Object.keys(raw)) {
      if (now - raw[k] > SEEN_TTL_MS) delete raw[k];
    }
    if (raw[key]) {
      window.localStorage.setItem(SEEN_STORE_KEY, JSON.stringify(raw));
      return true;
    }
    raw[key] = now;
    const keys = Object.keys(raw);
    if (keys.length > SEEN_MAX) {
      keys.sort((a, b) => raw[a] - raw[b]).slice(0, keys.length - SEEN_MAX).forEach((k) => delete raw[k]);
    }
    window.localStorage.setItem(SEEN_STORE_KEY, JSON.stringify(raw));
    return false;
  } catch {
    return false;
  }
}

export function DesktopNotificationsBridge() {
  const phone = useSipPhone();
  const { backendJwtRole, tenantId, can } = useAppContext();
  const previousCall = useRef({ state: phone.callState, direction: phone.callDirection, remoteParty: phone.remoteParty });
  const knownThreadIds = useRef<Set<string> | null>(null);
  const knownVoicemailIds = useRef<Set<string> | null>(null);
  const backoffRef = useRef(new NotificationProbeBackoff());

  useEffect(() => {
    backoffRef.current = new NotificationProbeBackoff();
  }, [tenantId, backendJwtRole]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.connectDesktop?.isDesktop || window.connectDesktop.windowKind !== "full") return;
    const prev = previousCall.current;
    if (prev.state === "ringing" && prev.direction === "inbound" && phone.callState === "ended") {
      const key = `missed:${(prev.remoteParty || "call").trim()}:${Math.floor(Date.now() / 60000)}`;
      if (!alreadyNotified(key)) {
        void window.connectDesktop.notifications?.show({
          kind: "missed-call",
          title: "Missed call",
          body: prev.remoteParty || "Connect call",
          route: "/calls",
        });
      }
    }
    previousCall.current = { state: phone.callState, direction: phone.callDirection, remoteParty: phone.remoteParty };
  }, [phone.callDirection, phone.callState, phone.remoteParty]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.connectDesktop?.isDesktop || window.connectDesktop.windowKind !== "full") return;

    let cancelled = false;
    const backoff = backoffRef.current;

    const applySmsNotifications = (threads: SmsThread[]) => {
      const ids = new Set(threads.map((thread) => thread.id));
      const previous = knownThreadIds.current;
      if (previous) {
        const newest = threads.find((thread) => !previous.has(thread.id));
        if (newest && !alreadyNotified(`sms:${newest.id}`)) {
          void window.connectDesktop?.notifications?.show({
            kind: "message",
            title: "New message",
            body: `${newest.phone}: ${newest.preview}`,
            route: `/sms?phone=${encodeURIComponent(newest.phone)}`,
          });
        }
      }
      knownThreadIds.current = ids;
    };

    const poll = async () => {
      if (cancelled) return;
      // Mounted globally, so this also ticks on /login and after the api has
      // refused our session and the token was cleared. Signed out = nothing to
      // notify about and every probe would be a guaranteed 401 — the shape that
      // trips the nginx auto-ban on the customer's office IP.
      if (!hasBrowserAuthToken()) return;

      let smsThreads: SmsThread[] | null = null;
      if (!backoff.shouldSkip("sms")) {
        try {
          smsThreads = await fetchTenantSmsInboxThreads();
          backoff.recordSuccess("sms");
        } catch (e) {
          const st = e instanceof ApiError ? e.status : 599;
          backoff.recordFailure("sms", st);
        }
      }

      if (smsThreads && !cancelled) {
        applySmsNotifications(smsThreads);
      }

      const vmPath =
        can("can_view_workspace_voicemail") &&
        buildDesktopVoicemailInboxProbePath({
          folder: "inbox",
          page: 1,
          tenantId,
          backendJwtRole,
        });

      if (vmPath && !backoff.shouldSkip("voicemail") && !cancelled) {
        try {
          const voicemail = await apiGet<VoicemailProbe>(vmPath);
          backoff.recordSuccess("voicemail");
          const unread = (voicemail.voicemails || []).filter((item) => !item.listened);
          const ids = new Set(unread.map((item) => item.id));
          const previous = knownVoicemailIds.current;
          if (previous) {
            const newest = unread.find((item) => !previous.has(item.id));
            if (newest && !alreadyNotified(`voicemail:${newest.id}`)) {
              void window.connectDesktop?.notifications?.show({
                kind: "voicemail",
                title: "New voicemail",
                body: newest.callerName || newest.callerId || "Voicemail",
                route: "/voicemail",
              });
            }
          }
          knownVoicemailIds.current = ids;
        } catch (e) {
          const st = e instanceof ApiError ? e.status : 599;
          backoff.recordFailure("voicemail", st);
        }
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [backendJwtRole, can, tenantId]);

  return null;
}
