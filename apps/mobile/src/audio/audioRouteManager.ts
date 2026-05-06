/**
 * Durable audio route manager for in-call audio (mobile).
 *
 * Why this exists
 * ───────────────
 * Before this module, audio routing was scattered across:
 *   • `JsSipClient.bindSession` (force route to earpiece 150 ms after
 *     `confirmed`, **even when Bluetooth was connected**)
 *   • `JsSipClient.answer()` (same force-to-earpiece on incoming answer)
 *   • `SipContext.cycleAudioRoute` (drives speaker button)
 *   • `react-native-incall-manager` defaults (Android sometimes auto-routes
 *     to speakerphone when MODE_IN_COMMUNICATION starts)
 *
 * Result: when Bluetooth was connected, ringback played on Bluetooth, but
 * `confirmed` fired and we routed to earpiece — so users perceived the
 * call as "switched away from BT on connect". Speaker would then sometimes
 * grab the route as well.
 *
 * The fix is to centralise every routing decision into one place that
 * knows the current device list AND any user-explicit override.
 *
 * Priority during an active call
 * ──────────────────────────────
 *   1. user explicit override for THIS call (speaker / earpiece / bluetooth / wired)
 *   2. Bluetooth (if connected)
 *   3. Wired headset (if connected)
 *   4. Earpiece
 *   5. Speaker is NEVER selected automatically — only when explicitly chosen
 *      by the user via the speaker button.
 *
 * The user override is per-call and cleared by `noteCallEnded()`.
 *
 * Logs
 * ────
 * Every state change emits a `console.log` with one of these tags so the
 * call-flow debug overlay / adb logcat / Sentry can trace what happened:
 *   [audio_route] available_devices
 *   [audio_route] selected
 *   [audio_route] applied
 *   [audio_route] user_override
 *   [audio_route] call_connected_reapply
 *   [audio_route] bluetooth_available
 *   [audio_route] fallback
 */
import { NativeModules, Platform } from 'react-native';

export type AudioRoute = 'earpiece' | 'speaker' | 'bluetooth' | 'wired';

export type AudioDeviceSnapshot = {
  bluetoothConnected: boolean;
  wiredHeadsetConnected: boolean;
  speakerphoneOn: boolean;
};

type RouteListener = (snapshot: { current: AudioRoute; available: AudioDeviceSnapshot; userOverride: AudioRoute | null }) => void;

const log = (tag: string, payload?: unknown) => {
  // Single-line, prefixed so `adb logcat | grep audio_route` works.
  if (payload === undefined) {
    console.log(`[audio_route] ${tag}`);
  } else {
    try {
      console.log(`[audio_route] ${tag}`, payload);
    } catch {
      console.log(`[audio_route] ${tag}`);
    }
  }
};

function getNativeRouter(): any | null {
  if (Platform.OS !== 'android') return null;
  const mod = (NativeModules as any)?.IncomingCallUi;
  if (!mod) return null;
  if (
    typeof mod.routeAudioToBluetooth === 'function' &&
    typeof mod.routeAudioToEarpiece === 'function' &&
    typeof mod.routeAudioToSpeaker === 'function'
  ) {
    return mod;
  }
  return null;
}

function getInCallManager(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('react-native-incall-manager').default;
  } catch {
    return null;
  }
}

export function getAudioDevicesSnapshot(): AudioDeviceSnapshot {
  const fallback: AudioDeviceSnapshot = {
    bluetoothConnected: false,
    wiredHeadsetConnected: false,
    speakerphoneOn: false,
  };
  if (Platform.OS !== 'android') return fallback;
  const mod = (NativeModules as any)?.IncomingCallUi;
  if (!mod || typeof mod.getAudioDevices !== 'function') return fallback;
  try {
    const result = mod.getAudioDevices();
    return {
      bluetoothConnected: !!result?.bluetoothConnected,
      wiredHeadsetConnected: !!result?.wiredHeadsetConnected,
      speakerphoneOn: !!result?.speakerphoneOn,
    };
  } catch {
    return fallback;
  }
}

class AudioRouteManager {
  private currentRoute: AudioRoute = 'earpiece';
  private userOverride: AudioRoute | null = null;
  private callActive = false;
  private listeners: Set<RouteListener> = new Set();
  private lastSnapshot: AudioDeviceSnapshot = {
    bluetoothConnected: false,
    wiredHeadsetConnected: false,
    speakerphoneOn: false,
  };

  // Public API ────────────────────────────────────────────────────────────

  /** Mark a call as starting (dialed / answered). Resets per-call state. */
  noteCallStarted(direction: 'inbound' | 'outbound'): void {
    this.callActive = true;
    this.userOverride = null;
    log('call_started', { direction });
  }

  /**
   * Call this when the SIP session reaches "confirmed" (connected). This is
   * where the previous code unconditionally jumped to earpiece. Now we
   * recompute the correct sink and apply it.
   */
  noteCallConnected(): void {
    if (!this.callActive) {
      this.callActive = true;
    }
    log('call_connected_reapply');
    this.applyRoute('call_connected');
  }

  /** Mark a call as ended; clear per-call user override. */
  noteCallEnded(): void {
    this.callActive = false;
    this.userOverride = null;
    log('call_ended');
  }

  /**
   * Refresh the device list (Bluetooth/wired connect/disconnect).
   * Returns true if anything changed.
   *
   * Should be called from the BT availability poll / WiredHeadset event
   * inside SipContext. When the route differs from what's selected, this
   * automatically re-applies (so unplugging BT during a call routes to
   * earpiece, plugging it back in returns to BT — unless the user
   * explicitly chose speaker).
   */
  refreshDevices(snapshot: AudioDeviceSnapshot): boolean {
    const prev = this.lastSnapshot;
    const changed =
      prev.bluetoothConnected !== snapshot.bluetoothConnected ||
      prev.wiredHeadsetConnected !== snapshot.wiredHeadsetConnected ||
      prev.speakerphoneOn !== snapshot.speakerphoneOn;
    this.lastSnapshot = snapshot;
    if (changed) {
      log('available_devices', snapshot);
      if (snapshot.bluetoothConnected !== prev.bluetoothConnected) {
        log('bluetooth_available', { available: snapshot.bluetoothConnected });
      }
      if (this.callActive) {
        this.applyRoute('device_change');
      }
      this.notify();
    }
    return changed;
  }

  /**
   * User explicitly tapped the speaker button (or some other route picker).
   * Saves the override for the duration of the current call.
   *
   * Special case: if the user toggles speaker OFF, we don't store an override
   * — instead we clear it so we fall back to "best available" (BT > wired >
   * earpiece). That implements: "press Speaker once → speaker; press Speaker
   * again → returns to Bluetooth if still connected".
   */
  setUserOverride(route: AudioRoute | null): void {
    log('user_override', { route });
    this.userOverride = route;
    this.applyRoute('user_override');
    this.notify();
  }

  /** Toggle between speaker and the best non-speaker route. */
  toggleSpeaker(): AudioRoute {
    const next: AudioRoute = this.currentRoute === 'speaker' ? this.preferredNonSpeakerRoute() : 'speaker';
    if (next === 'speaker') {
      this.setUserOverride('speaker');
    } else {
      // Going off speaker = clear override so BT / earpiece is auto-picked.
      this.setUserOverride(null);
    }
    return this.currentRoute;
  }

  /** Cycle: speaker ⇄ best non-speaker (BT if available, else earpiece). */
  cycleSpeakerRoute(): AudioRoute {
    return this.toggleSpeaker();
  }

  getCurrentRoute(): AudioRoute {
    return this.currentRoute;
  }

  getUserOverride(): AudioRoute | null {
    return this.userOverride;
  }

  getDevicesSnapshot(): AudioDeviceSnapshot {
    return { ...this.lastSnapshot };
  }

  isBluetoothAvailable(): boolean {
    return this.lastSnapshot.bluetoothConnected;
  }

  /** Subscribe to route changes (returns unsubscribe). */
  subscribe(listener: RouteListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Internals ─────────────────────────────────────────────────────────────

  /**
   * Compute the desired route from current state and apply it via native
   * AudioManager (Android) / InCallManager (iOS fallback).
   */
  private applyRoute(reason: string): void {
    const desired = this.computeDesiredRoute();
    log('selected', { route: desired, reason });
    this.applyRouteToNative(desired);
    if (this.currentRoute !== desired) {
      this.currentRoute = desired;
    }
    log('applied', { route: this.currentRoute });
    this.notify();
  }

  private computeDesiredRoute(): AudioRoute {
    if (this.userOverride) {
      return this.userOverride;
    }
    if (this.lastSnapshot.bluetoothConnected) {
      return 'bluetooth';
    }
    if (this.lastSnapshot.wiredHeadsetConnected) {
      return 'wired';
    }
    return 'earpiece';
  }

  private preferredNonSpeakerRoute(): AudioRoute {
    if (this.lastSnapshot.bluetoothConnected) return 'bluetooth';
    if (this.lastSnapshot.wiredHeadsetConnected) return 'wired';
    return 'earpiece';
  }

  private applyRouteToNative(route: AudioRoute): void {
    const native = getNativeRouter();
    if (native) {
      try {
        if (route === 'bluetooth') {
          native.routeAudioToBluetooth();
        } else if (route === 'speaker') {
          native.routeAudioToSpeaker();
        } else {
          // earpiece / wired — wired routing is handled by the OS automatically
          // when SCO is stopped and speaker is off.
          native.routeAudioToEarpiece();
        }
        return;
      } catch (err) {
        log('fallback', { reason: 'native_router_throw', err: String((err as any)?.message ?? err) });
      }
    }
    // iOS / native router unavailable: fall back to InCallManager.
    const icm = getInCallManager();
    if (!icm) {
      log('fallback', { reason: 'no_native_no_icm' });
      return;
    }
    try {
      if (route === 'speaker') {
        icm.setSpeakerphoneOn?.(true);
      } else if (route === 'bluetooth' && typeof icm.chooseAudioRoute === 'function') {
        icm.chooseAudioRoute('BLUETOOTH');
      } else if (typeof icm.chooseAudioRoute === 'function') {
        icm.chooseAudioRoute('EARPIECE');
      } else {
        icm.setSpeakerphoneOn?.(false);
      }
    } catch (err) {
      log('fallback', { reason: 'icm_throw', err: String((err as any)?.message ?? err) });
    }
  }

  private notify(): void {
    const snap = {
      current: this.currentRoute,
      available: this.getDevicesSnapshot(),
      userOverride: this.userOverride,
    };
    for (const l of this.listeners) {
      try { l(snap); } catch { /* listener error is non-fatal */ }
    }
  }
}

export const audioRouteManager = new AudioRouteManager();
