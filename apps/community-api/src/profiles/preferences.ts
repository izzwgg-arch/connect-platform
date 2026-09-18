/**
 * Discovery/communication switches stored in `Person.preferences` (JSON).
 * Defaults favour being findable and reachable — the opposite of the privacy
 * *sections* (which default to sensible hiding for phone/email) — because a
 * professional network is useless if nobody can find you. `showOnline`
 * defaults off since a live presence dot is the one switch people expect to
 * opt into, not out of.
 */
export const PREFERENCE_KEYS = ["searchEngineVisible", "findableByPhone", "readReceipts", "showOnline", "messageRequests", "analytics"] as const;
export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];
export type Preferences = Record<PreferenceKey, boolean>;

export const DEFAULT_PREFERENCES: Preferences = {
  searchEngineVisible: true,
  findableByPhone: true,
  readReceipts: true,
  showOnline: false,
  messageRequests: true,
  analytics: true,
};

/** Merges stored JSON (possibly null/partial/stale-keyed) onto the defaults. */
export function mergePreferences(raw: unknown): Preferences {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Preferences = { ...DEFAULT_PREFERENCES };
  for (const k of PREFERENCE_KEYS) {
    if (typeof obj[k] === "boolean") out[k] = obj[k] as boolean;
  }
  return out;
}
