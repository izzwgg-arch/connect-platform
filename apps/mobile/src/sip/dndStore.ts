import AsyncStorage from "@react-native-async-storage/async-storage";
import { NativeModules, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { reportDndStatus } from "../api/client";
import { reportDndWithBoundedRetry } from "./dndReportPolicy";

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
 *
 * DND is ALSO best-effort reported to the Connect API (POST /mobile/dnd-status)
 * whenever it changes, and once on hydrate. This is what lets PBX-side
 * [connect-wake-core] (scripts/pbx/install-connect-wake-dialplan.sh) skip the
 * ConnectWake/grace/ringback cycle for a SWIPED-AWAY app that has DND on — the
 * native SharedPreferences mirror above only suppresses the ring on THIS
 * device; it is invisible to the PBX. The server report is fire-and-forget and
 * bounded-retried (see dndReportPolicy.ts) — it can never throw into, block, or
 * otherwise affect local DND behavior (486 decline / native ring suppression
 * both continue to work identically whether or not the report succeeds).
 */
const STORAGE_KEY = "cc-dnd";
// Same SecureStore key AuthContext.tsx uses for the session JWT. Read
// directly (not imported) to avoid a dependency from this non-React module
// back onto the AuthContext/api-client React wiring — dndStore must remain
// usable with zero React dependency, per the file's existing design.
const AUTH_TOKEN_KEY = "cc_mobile_token";

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

/**
 * Best-effort, fire-and-forget report of the current DND value to the Connect
 * API so the PBX-side wake engine can see it. Never awaited by callers, never
 * throws, never touches local DND state. Silently no-ops when the user isn't
 * logged in yet (no token) — there is nothing meaningful to report against.
 */
function reportDndToServer(value: boolean): void {
  (async () => {
    let token: string | null = null;
    try {
      token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
    } catch {
      return;
    }
    if (!token) return;
    await reportDndWithBoundedRetry(() => reportDndStatus(token as string, value));
  })().catch(() => {
    /* belt-and-suspenders — reportDndWithBoundedRetry already never throws */
  });
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
  // Fire-and-forget — never awaited, never throws, never blocks call handling.
  reportDndToServer(value);
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
  // Report once on boot too (fire-and-forget) so the server-side flag catches
  // up after e.g. a fresh install/relogin, or a period the app was fully
  // killed and unable to report a change made just before being killed.
  reportDndToServer(dnd);
  for (const l of listeners) {
    try {
      l(dnd);
    } catch {
      /* ignore */
    }
  }
  return dnd;
}
