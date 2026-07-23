"use client";

import { useEffect, useState } from "react";
import { apiGet } from "../services/apiClient";

export type NavBadges = {
  chat: number;
  voicemail: number;
};

/**
 * Polls /chat/unread-count and /voice/voicemail/unread-count every 60s.
 * Errors are silently swallowed — a failed poll leaves the badge at its last
 * known value (0 on first load). Each count is strictly scoped to the calling
 * user by the API layer (ConnectChatParticipant.userId / voicemail owned scope).
 */
export function useNavBadges(): NavBadges {
  const [chatUnread, setChatUnread] = useState(0);
  const [voicemailUnread, setVoicemailUnread] = useState(0);

  useEffect(() => {
    const load = async () => {
      const [c, v] = await Promise.allSettled([
        apiGet<{ count: number }>("/chat/unread-count"),
        apiGet<{ count: number }>("/voice/voicemail/unread-count"),
      ]);
      if (c.status === "fulfilled") setChatUnread(c.value.count ?? 0);
      if (v.status === "fulfilled") setVoicemailUnread(v.value.count ?? 0);
    };
    void load();
    const t = setInterval(load, 20_000);
    const refresh = () => void load();
    const onVis = () => { if (!document.hidden) void load(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("cc:navbadges:refresh", refresh);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("cc:navbadges:refresh", refresh);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return { chat: chatUnread, voicemail: voicemailUnread };
}
