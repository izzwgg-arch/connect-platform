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
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  return { chat: chatUnread, voicemail: voicemailUnread };
}
