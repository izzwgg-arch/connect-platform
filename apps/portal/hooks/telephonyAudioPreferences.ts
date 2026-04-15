export const WEB_RINGTONE_STORAGE_KEY = "connect_web_incoming_ringtone";

export const WEB_RINGTONE_OPTIONS = [
  { id: "connect-default", label: "Connect Default" },
  { id: "classic", label: "Classic Ring" },
] as const;

export type WebRingtoneId = (typeof WEB_RINGTONE_OPTIONS)[number]["id"];

export const DEFAULT_WEB_RINGTONE_ID: WebRingtoneId = "connect-default";

function isValidRingtoneId(value: string | null | undefined): value is WebRingtoneId {
  return WEB_RINGTONE_OPTIONS.some((option) => option.id === value);
}

export function getWebIncomingRingtone(): WebRingtoneId {
  if (typeof window === "undefined") return DEFAULT_WEB_RINGTONE_ID;
  const stored = window.localStorage.getItem(WEB_RINGTONE_STORAGE_KEY);
  return isValidRingtoneId(stored) ? stored : DEFAULT_WEB_RINGTONE_ID;
}

export function setWebIncomingRingtone(next: WebRingtoneId): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(WEB_RINGTONE_STORAGE_KEY, next);
}

export function getWebIncomingRingtoneLabel(id: WebRingtoneId): string {
  return WEB_RINGTONE_OPTIONS.find((option) => option.id === id)?.label ?? "Connect Default";
}
