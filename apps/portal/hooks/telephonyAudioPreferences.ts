export const WEB_RINGTONE_STORAGE_KEY = "connect_web_incoming_ringtone";
export const WEB_RINGER_ENABLED_STORAGE_KEY = "connect_web_ringer_enabled";
export const WEB_RINGER_ENABLED_EVENT = "connect:web-ringer-enabled";

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

export function getWebRingerEnabled(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(WEB_RINGER_ENABLED_STORAGE_KEY) !== "0";
}

export function setWebRingerEnabled(next: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(WEB_RINGER_ENABLED_STORAGE_KEY, next ? "1" : "0");
  window.dispatchEvent(new CustomEvent(WEB_RINGER_ENABLED_EVENT, { detail: { enabled: next } }));
}

// Ringer routing (desktop): the incoming ring can play on its OWN output device
// and volume, independent of the call audio - so a headset user still hears the
// ring on their speakers. Stored client-side; the ringtone engine reads these.
export const WEB_RINGER_OUTPUT_STORAGE_KEY = "connect_web_ringer_output";
export const WEB_RINGER_VOLUME_STORAGE_KEY = "connect_web_ringer_volume";
export const WEB_RINGER_AUDIO_EVENT = "connect:web-ringer-audio";

export function getWebRingerOutputDeviceId(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(WEB_RINGER_OUTPUT_STORAGE_KEY) || "";
}

export function setWebRingerOutputDeviceId(deviceId: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(WEB_RINGER_OUTPUT_STORAGE_KEY, deviceId || "");
  window.dispatchEvent(new CustomEvent(WEB_RINGER_AUDIO_EVENT));
}

export function getWebRingerVolume(): number {
  if (typeof window === "undefined") return 0.8;
  const raw = Number(window.localStorage.getItem(WEB_RINGER_VOLUME_STORAGE_KEY));
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.8;
}

export function setWebRingerVolume(next: number): void {
  if (typeof window === "undefined") return;
  const clamped = Math.max(0, Math.min(1, next));
  window.localStorage.setItem(WEB_RINGER_VOLUME_STORAGE_KEY, String(clamped));
  window.dispatchEvent(new CustomEvent(WEB_RINGER_AUDIO_EVENT));
}
