"use client";

import { useEffect, useRef } from "react";
import { useAppContext } from "../hooks/useAppContext";
import { useSipPhone } from "../hooks/useSipPhone";
import { ApiError, apiGet } from "../services/apiClient";
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
    if (typeof window === "undefined" || !window.connectDesktop?.isDesktop || window.connectDesktop.windowKind === "phone-engine") return;
    const prev = previousCall.current;
    if (prev.state === "ringing" && prev.direction === "inbound" && phone.callState === "ended") {
      void window.connectDesktop.notifications?.show({
        kind: "missed-call",
        title: "Missed call",
        body: prev.remoteParty || "Connect call",
        route: "/calls",
      });
    }
    previousCall.current = { state: phone.callState, direction: phone.callDirection, remoteParty: phone.remoteParty };
  }, [phone.callDirection, phone.callState, phone.remoteParty]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.connectDesktop?.isDesktop || window.connectDesktop.windowKind === "phone-engine") return;

    let cancelled = false;
    const backoff = backoffRef.current;

    const applySmsNotifications = (threads: SmsThread[]) => {
      const ids = new Set(threads.map((thread) => thread.id));
      const previous = knownThreadIds.current;
      if (previous) {
        const newest = threads.find((thread) => !previous.has(thread.id));
        if (newest) {
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
            if (newest) {
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
