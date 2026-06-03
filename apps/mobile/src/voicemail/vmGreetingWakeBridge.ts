import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "connect_vm_greeting_wake_v1";

export type VmGreetingWakeMeta = {
  pbxCallId: string;
  fromNumber: string;
  at: number;
};

export async function rememberVmGreetingWake(
  pbxCallId: string,
  fromNumber: string,
): Promise<void> {
  const meta: VmGreetingWakeMeta = {
    pbxCallId: String(pbxCallId || "").trim(),
    fromNumber: String(fromNumber || "").trim(),
    at: Date.now(),
  };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(meta));
}

export async function readRecentVmGreetingWake(
  maxAgeMs: number,
): Promise<VmGreetingWakeMeta | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as VmGreetingWakeMeta;
    if (!parsed?.pbxCallId || !Number.isFinite(parsed.at)) return null;
    if (Date.now() - parsed.at > maxAgeMs) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function clearVmGreetingWake(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}
