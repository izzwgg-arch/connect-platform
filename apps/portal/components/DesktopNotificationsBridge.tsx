"use client";

import { useEffect, useRef } from "react";
import { useAppContext } from "../hooks/useAppContext";
import { useSipPhone } from "../hooks/useSipPhone";
import { apiGet } from "../services/apiClient";
import { loadSmsThreads } from "../services/platformData";

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
  const { adminScope } = useAppContext();
  const previousCall = useRef({ state: phone.callState, direction: phone.callDirection, remoteParty: phone.remoteParty });
  const knownThreadIds = useRef<Set<string> | null>(null);
  const knownVoicemailIds = useRef<Set<string> | null>(null);

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
    const poll = async () => {
      const [sms, voicemail] = await Promise.allSettled([
        loadSmsThreads(adminScope),
        apiGet<VoicemailProbe>("/voice/voicemail?folder=inbox&page=1&pageSize=10"),
      ]);

      if (cancelled) return;

      if (sms.status === "fulfilled") {
        const ids = new Set(sms.value.threads.map((thread) => thread.id));
        const previous = knownThreadIds.current;
        if (previous) {
          const newest = sms.value.threads.find((thread) => !previous.has(thread.id));
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
      }

      if (voicemail.status === "fulfilled") {
        const unread = (voicemail.value.voicemails || []).filter((item) => !item.listened);
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
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [adminScope]);

  return null;
}
