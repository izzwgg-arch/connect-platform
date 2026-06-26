import AsyncStorage from "@react-native-async-storage/async-storage";
import { NativeModules, Platform } from "react-native";

/**
 * Do-Not-Disturb state shared between the React presence UI and the (non-React)
 * SIP layer. The SIP `newRTCSession` handler reads {@link getDnd} synchronously
 * the instant an INVITE arrives so DND can silently handle the call (no UI) and
 * let it time out to voicemail. Keeping this outside React is deliberate: the
 * SIP client must not depend on a render.
 *
 * DND is ALSO mirrored into native SharedPreferences via the IncomingCallUi
 * bridge so the FCM ring path (IncomingCallFirebaseService) — which fires before
 * any JS, even when the app is killed — can suppress the native ringtone and the
 * full-screen incoming-call UI. Without this mirror the phone still rings on a
 * background/killed push regardless of the JS-side DND state.
 */
const STORAGE_KEY = "cc-dnd";

let dnd = false;
const listeners = new Set<(value: boolean) => void>();

/** Push the current DND value into the native FCM ring path (Android only). */
function syncDndToNative(value: boolean): void {
  if (Platform.OS !== "android") return;
  try {
    NativeModules.IncomingCallUi?.setDnd?.(value);
  } catch {
    /* native bridge is optional — never let it break call handling */
  }
}

/** Synchronous read for the SIP layer. */
export function getDnd(): boolean {
  return dnd;
}

export function setDnd(value: boolean): void {
  if (dnd === value) return;
  dnd = value;
  AsyncStorage.setItem(STORAGE_KEY, value ? "1" : "0").catch(() => {});
  syncDndToNative(value);
  for (const l of listeners) {
    try {
      l(value);
    } catch {
      /* listener errors must never break call handling */
    }
  }
}

export function subscribeDnd(listener: (value: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Load the persisted value on app start. Returns the hydrated value. */
export async function hydrateDnd(): Promise<boolean> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    dnd = stored === "1";
  } catch {
    dnd = false;
  }
  // Re-assert the persisted value into native on every boot so the SharedPreferences
  // copy the FCM ring path reads can never drift from the app's real DND state.
  syncDndToNative(dnd);
  for (const l of listeners) {
    try {
      l(dnd);
    } catch {
      /* ignore */
    }
  }
  return dnd;
}
