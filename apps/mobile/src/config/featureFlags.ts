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
  /**
   * Force call media through the TURN relay (iceTransportPolicy "relay")
   * instead of the direct path. Per-device experiment lever for lossy
   * cellular networks: quality telemetry decides whether the relay path
   * beats direct for this device/carrier. Off = today's behavior ("all").
   */
  forceTurnRelay: boolean;
  /**
   * Server-observed keep-alive requirement. Set by the backend watchdog when
   * this user's PBX endpoint sat unregistered while the device was supposed
   * to be reachable (the DEVICE_REGISTRATION alert condition). Unlike the
   * on-device gate latch (AsyncStorage, lost on reinstall/re-enrollment),
   * this survives on the server and re-latches the gate on every register —
   * closing the gap where a re-enrolled device silently lost its keep-alive
   * protection (observed live 2026-07-30, Luxure T5_101_1 down 3h13m).
   */
  keepAliveRequired: boolean;
  keepAliveRequiredReason: string;
  /**
   * Whether this USER may download call recordings — server-computed from the
   * `can_download_recordings` portal permission (the same key the download
   * endpoint enforces), not a per-device toggle. Drives whether the Recents
   * long-press sheet offers "Download recording" at all (Izzy 2026-07-31).
   *
   * Deliberately follows the module's safety contract: absent = false = hidden.
   * So an APK that ships BEFORE the API change simply never shows the button,
   * and it appears by itself once the server starts sending the field — no
   * second app release needed.
   *
   * Note the server keeps an owner carve-out on the endpoint: you can always
   * download recordings for your own extension. This flag reflects the
   * permission only, so the button can be hidden for someone who would in fact
   * be allowed their own — accepted, because the alternative (showing a button
   * that 403s for other people's calls) is worse.
   */
  canDownloadRecordings: boolean;
  /**
   * Turn OFF the app's opus-preference SDP munging, so calls ride plain G.711
   * (PCMU) — the codec every call used before 2026-07-28 and the one the owner
   * remembers as flawless.
   *
   * WHY A SWITCH: opus is better on paper but is compressed and far more
   * sensitive to loss and jitter, and our TURN relay currently sits in France
   * while the PBX is in St. Louis. Whether opus actually sounds better on THIS
   * network is an empirical question, and until now it could only be answered
   * by shipping a new APK. Flip this per-device and compare by ear.
   *
   * Safety contract: absent = false = do NOT disable = today's exact behaviour
   * (opus-only offers, opus-preferred answers). Installing this build changes
   * nothing until the flag is set.
   */
  disableOpusSdp: boolean;
};

const DEFAULT_FLAGS: DeviceFeatureFlags = {
  standingRegistration: false,
  forceTurnRelay: false,
  keepAliveRequired: false,
  keepAliveRequiredReason: "",
  canDownloadRecordings: false,
  disableOpusSdp: false,
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
    forceTurnRelay: obj.forceTurnRelay === true,
    keepAliveRequired: obj.keepAliveRequired === true,
    keepAliveRequiredReason:
      typeof obj.keepAliveRequiredReason === "string" ? obj.keepAliveRequiredReason.slice(0, 160) : "",
    canDownloadRecordings: obj.canDownloadRecordings === true,
    disableOpusSdp: obj.disableOpusSdp === true,
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
    const changed =
      next.standingRegistration !== cachedFlags.standingRegistration ||
      next.forceTurnRelay !== cachedFlags.forceTurnRelay ||
      next.keepAliveRequired !== cachedFlags.keepAliveRequired ||
      next.canDownloadRecordings !== cachedFlags.canDownloadRecordings ||
      next.disableOpusSdp !== cachedFlags.disableOpusSdp;
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
      // Server-observed keep-alive requirement → latch the adaptive gate.
      // Lazy import keeps this module free of a hard sip/ dependency cycle.
      //
      // ⛔ ANDROID ONLY (owner directive, Izzy 2026-07-31). The keep-alive gate
      // exists to hold Android's standing SIP registration alive, because on
      // Android that socket IS how a call arrives. iOS receives calls through
      // APNs VoIP pushes and does not need to stay registered between calls, so
      // latching a keep-alive requirement there only drives needless reconnects.
      // The server sets this flag from the registration watchdog, which is an
      // Android-shaped signal; iPhone must ignore it.
      if (Platform.OS === "android" && next.keepAliveRequired) {
        void import("../sip/keepAliveGate")
          .then((gate) =>
            gate.forceKeepAliveNeeded(`server:${next.keepAliveRequiredReason || "device_registration_watchdog"}`),
          )
          .then((state) => {
            if (state.needed) console.log(`${LOG} keep-alive gate latched from server flag (${state.reason})`);
          })
          .catch((e) =>
            console.warn(`${LOG} keep-alive gate latch failed:`, e instanceof Error ? e.message : String(e)),
          );
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

/**
 * Sync read of the force-relay flag. Safe default: false (direct path,
 * today's behavior) until hydration completes.
 */
export function isForceTurnRelayEnabled(): boolean {
  return cachedFlags.forceTurnRelay;
}

/**
 * Sync read of the recording-download permission. Safe default: false, so the
 * Recents "Download recording" action stays hidden on any build/serverpair that
 * has not explicitly granted it.
 */
export function canDownloadRecordings(): boolean {
  return cachedFlags.canDownloadRecordings;
}

/**
 * Sync read of the opus kill-switch. Safe default: false — opus preference
 * stays ON, exactly as today, until the server says otherwise.
 */
export function isOpusSdpDisabled(): boolean {
  return cachedFlags.disableOpusSdp;
}
