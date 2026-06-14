import AsyncStorage from "@react-native-async-storage/async-storage";
import { NativeModules, Platform } from "react-native";

export const MOBILE_RINGTONE_STORAGE_KEY = "connect_mobile_incoming_ringtone";

/**
 * Push the ringtone choice down to the native Android service so the FCM ring
 * path (which fires before any JS runs) plays the correct ringtone:
 *   • "connect-default" → bundled Connect ringtone
 *   • "classic"         → the phone's own default ringtone
 * No-op on iOS / when the bridge is unavailable.
 */
function syncRingtoneToNative(id: MobileRingtoneId): void {
  if (Platform.OS !== "android") return;
  try {
    const mod: any = (NativeModules as any)?.IncomingCallUi;
    if (mod && typeof mod.setIncomingRingtone === "function") {
      mod.setIncomingRingtone(id);
    }
  } catch {
    // non-critical — native falls back to connect-default
  }
}

/** Read the stored preference and mirror it to native (call once on startup). */
export async function syncMobileIncomingRingtoneToNative(): Promise<void> {
  const id = await getMobileIncomingRingtone();
  syncRingtoneToNative(id);
}

export const MOBILE_RINGTONE_OPTIONS = [
  { id: "connect-default", label: "Connect Default" },
  { id: "classic", label: "Classic Ring" },
] as const;

export type MobileRingtoneId = (typeof MOBILE_RINGTONE_OPTIONS)[number]["id"];

export const DEFAULT_MOBILE_RINGTONE_ID: MobileRingtoneId = "connect-default";

let cachedRingtoneId: MobileRingtoneId | null = null;

function isValidRingtoneId(value: string | null | undefined): value is MobileRingtoneId {
  return MOBILE_RINGTONE_OPTIONS.some((option) => option.id === value);
}

export async function getMobileIncomingRingtone(): Promise<MobileRingtoneId> {
  if (cachedRingtoneId) return cachedRingtoneId;
  const stored = await AsyncStorage.getItem(MOBILE_RINGTONE_STORAGE_KEY).catch(() => null);
  cachedRingtoneId = isValidRingtoneId(stored) ? stored : DEFAULT_MOBILE_RINGTONE_ID;
  return cachedRingtoneId;
}

export async function setMobileIncomingRingtone(next: MobileRingtoneId): Promise<void> {
  cachedRingtoneId = next;
  syncRingtoneToNative(next);
  await AsyncStorage.setItem(MOBILE_RINGTONE_STORAGE_KEY, next).catch(() => undefined);
}

export function getMobileIncomingRingtoneLabel(id: MobileRingtoneId): string {
  return MOBILE_RINGTONE_OPTIONS.find((option) => option.id === id)?.label ?? "Connect Default";
}
