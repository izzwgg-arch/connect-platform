// Per-device remote feature flags, delivered by /mobile/devices/register.
//
// This is the client half of the standing-SIP-registration kill-switch:
// the server returns `featureFlags: { standingRegistration?: boolean }` on
// every device register, we persist it, mirror it into the native
// SipKeepAliveService pref (so the FGS heartbeat can headlessly refresh the
// registration even when the JS runtime is dead), and expose it to JS-side
// consumers (stable instance_id, ICE restart, answer-pipeline fast path).
//
// SAFETY CONTRACT: every consumer must treat "no flag / never applied /
// storage empty" as FALSE and fall back to today's exact behavior. Flipping
// the flag off in the DB reverts the device on its next register — no APK.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { NativeModules, Platform } from "react-native";

const LOG = "[FEATURE_FLAGS]";
const STORAGE_KEY = "connect.device_feature_flags.v1";

export type DeviceFeatureFlags = {
  standingRegistration: boolean;
};

const DEFAULT_FLAGS: DeviceFeatureFlags = {
  standingRegistration: false,
};

let cachedFlags: DeviceFeatureFlags = { ...DEFAULT_FLAGS };

// Hydration kicks off at module import so sync reads are correct by the time
// SIP provisioning completes (registration always loads async state first).
// Consumers that must be certain can await getFeatureFlags().
const hydration: Promise<void> = (async () => {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      cachedFlags = sanitize(JSON.parse(raw));
      console.log(`${LOG} hydrated from storage:`, JSON.stringify(cachedFlags));
    }
  } catch (e) {
    console.warn(`${LOG} hydrate failed (defaults stay off):`, e instanceof Error ? e.message : String(e));
  }
})();

function sanitize(raw: unknown): DeviceFeatureFlags {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    standingRegistration: obj.standingRegistration === true,
  };
}

/**
 * Apply the `featureFlags` object from a /mobile/devices/register response.
 * Never throws. Persists to AsyncStorage and mirrors the standing-registration
 * bit into the native SipKeepAliveService pref (Android only).
 */
export async function applyServerFeatureFlags(raw: unknown): Promise<void> {
  try {
    // Older API builds don't return featureFlags at all — leave the cached
    // value alone rather than clobbering a previously-applied flag with the
    // default during a server rollback window.
    if (raw === undefined) return;
    const next = sanitize(raw);
    const changed = next.standingRegistration !== cachedFlags.standingRegistration;
    cachedFlags = next;
    if (changed) {
      console.log(`${LOG} flags changed:`, JSON.stringify(next));
    }
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);

    if (Platform.OS === "android") {
      const mod: any = (NativeModules as any)?.IncomingCallUi;
      if (mod && typeof mod.setStandingRegistrationEnabled === "function") {
        mod.setStandingRegistrationEnabled(next.standingRegistration);
        console.log(`${LOG} native standingRegistration mirrored: ${next.standingRegistration}`);
      } else {
        console.warn(`${LOG} setStandingRegistrationEnabled bridge missing — native mirror skipped`);
      }
    }
  } catch (e) {
    console.warn(`${LOG} apply failed:`, e instanceof Error ? e.message : String(e));
  }
}

/** Await hydration, then return the current flags. */
export async function getFeatureFlags(): Promise<DeviceFeatureFlags> {
  await hydration;
  return cachedFlags;
}

/**
 * Sync read of the standing-registration flag. Safe default: false until
 * hydration completes (falls back to legacy behavior, never the new mode).
 */
export function isStandingRegistrationEnabled(): boolean {
  return cachedFlags.standingRegistration;
}
