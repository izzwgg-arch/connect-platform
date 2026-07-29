/**
 * Tab-bar unread badges (Izzy 2026-07-28): shared keys + helpers so the tab
 * bar, RecentTab, and VoicemailTab stay in sync. Rules:
 *  - Chat badge = number of conversations with unread messages (clears the
 *    moment a thread is opened — thread list cache updates drive it).
 *  - Voicemail badge = new (inbox+urgent) voicemail count; refreshes on read.
 *  - Recent badge = missed calls newer than the last time Recents was viewed;
 *    opening Recents clears it instantly.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { QueryClient } from '@tanstack/react-query';

export const RECENTS_SEEN_STORAGE_KEY = 'cc_recents_seen_at_v1';
export const recentsSeenQueryKey = ['recentsSeenAt'] as const;
export const vmBadgeQueryKey = (token: string | null | undefined) =>
  ['vmBadgeTotals', token ?? ''] as const;

/** Recents viewed now — clears the missed-call tab badge immediately. */
export function markRecentsSeen(queryClient: QueryClient): void {
  const now = Date.now();
  queryClient.setQueryData(recentsSeenQueryKey, now);
  AsyncStorage.setItem(RECENTS_SEEN_STORAGE_KEY, String(now)).catch(() => undefined);
}

/** Seed the seen-marker from disk (call once from the badge hook). */
export async function loadRecentsSeen(queryClient: QueryClient): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(RECENTS_SEEN_STORAGE_KEY);
    const ts = raw ? Number(raw) : 0;
    const existing = queryClient.getQueryData(recentsSeenQueryKey);
    if (existing === undefined) {
      queryClient.setQueryData(recentsSeenQueryKey, Number.isFinite(ts) ? ts : 0);
    }
  } catch {
    /* badge simply starts at "everything unseen" */
  }
}
