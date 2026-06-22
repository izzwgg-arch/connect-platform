import { NativeModules, Platform } from "react-native";
import RNCallKeep from "react-native-callkeep";
import { logCallFlow } from "../debug/callFlowDebug";
import { deterministicCallKitUuid } from "./callkitUuid";

// ── iOS CallKit identity mapping ─────────────────────────────────────────────
// CallKit (iOS) requires a valid RFC-4122 UUID for every call. The Connect
// backend identifies a call by `callId`/`inviteId` (a cuid like "clx…"), which
// is NOT a valid UUID — passing it straight to CallKit makes
// `[[NSUUID alloc] initWithUUIDString:]` return nil and the call report
// silently fails. We therefore keep a bidirectional, in-process map so:
//   • outgoing CallKit calls use a generated UUID, and
//   • the `answerCall` / `endCall` events (which carry the UUID) are translated
//     back to the original callId before reaching the shared answer/decline
//     pipeline.
//
// On Android these maps stay EMPTY (showIncomingNativeCall is only ever invoked
// on iOS), so every lookup falls through to the raw callId and Android behavior
// is byte-for-byte unchanged.
const callIdToCallKitUuid = new Map<string, string>();
const callKitUuidToCallId = new Map<string, string>();

// callIds already reported to CallKit — dedupe so a device that receives BOTH
// an Expo push and a VoIP push (or repeated VoIP retries) does not create two
// CallKit calls / two visible incoming UIs.
const reportedIncomingCallIds = new Set<string>();

/** Stable CallKit UUID for a backend callId.
 *
 *  DETERMINISTIC: derived from callId via deterministicCallKitUuid so the native
 *  PushKit handler (plugins/withIosVoipPush.js) and JS compute the SAME UUID for
 *  a fully cold-killed call — no shared runtime state required. We still cache
 *  both directions so callIdForCallKitUuid() can reverse a CallKit answer/end
 *  event (which only carries the UUID) back to the backend callId. */
export function callKitUuidForCallId(callId: string): string {
  let uuid = callIdToCallKitUuid.get(callId);
  if (!uuid) {
    uuid = deterministicCallKitUuid(callId);
    callIdToCallKitUuid.set(callId, uuid);
    callKitUuidToCallId.set(uuid, callId);
  }
  return uuid;
}

/** Translate a CallKit UUID back to the backend callId (null if unmapped, e.g.
 *  Android, where the raw callId is used directly). */
export function callIdForCallKitUuid(uuid: string): string | null {
  return callKitUuidToCallId.get(uuid) ?? null;
}

function forgetCallKitMapping(callIdOrUuid: string): void {
  const mappedUuid = callIdToCallKitUuid.get(callIdOrUuid);
  if (mappedUuid) {
    callIdToCallKitUuid.delete(callIdOrUuid);
    callKitUuidToCallId.delete(mappedUuid);
  }
  const mappedCallId = callKitUuidToCallId.get(callIdOrUuid);
  if (mappedCallId) {
    callKitUuidToCallId.delete(callIdOrUuid);
    callIdToCallKitUuid.delete(mappedCallId);
  }
}

/** Android: cancel native incoming notification + stop native ringtone immediately. */
export function dismissNativeIncomingUi(callId: string | null | undefined) {
  if (Platform.OS !== "android") {
    console.log("[NATIVE_DISMISS] skip not-android callId=" + callId);
    return;
  }
  if (!callId) {
    console.log("[NATIVE_DISMISS] skip empty callId");
    return;
  }
  const mod = NativeModules.IncomingCallUi;
  if (!mod || typeof mod.dismiss !== "function") {
    console.warn("[NATIVE_DISMISS] IncomingCallUi module missing, callId=" + callId);
    return;
  }
  try {
    console.log("[NATIVE_DISMISS] invoking IncomingCallUi.dismiss callId=" + callId);
    mod.dismiss(callId);
    console.log("[NATIVE_DISMISS] returned from IncomingCallUi.dismiss callId=" + callId);
  } catch (e) {
    console.warn("[NATIVE_DISMISS] IncomingCallUi.dismiss threw:", String(e));
  }
}

/** Android: clear show-when-locked / turn-screen-on after calls (avoids blank trap after hangup). */
export function clearAndroidLockScreenCallPresentation() {
  if (Platform.OS !== "android") return;
  try {
    NativeModules.IncomingCallUi?.clearLockScreenCallPresentation?.();
  } catch {
    // ignore
  }
}

/**
 * Android: move the app task to the background.
 * Used after a call ends that was answered from the lock screen — reveals
 * the lock screen instead of leaving the app's Quick page on top of it.
 */
export function moveAppToBackground() {
  if (Platform.OS !== "android") return;
  try {
    NativeModules.IncomingCallUi?.moveToBackground?.();
  } catch {
    // ignore
  }
}

let configured = false;

export async function setupNativeCalling() {
  if (configured) return;
  const options: any = {
    ios: {
      appName: "Connect Communications",
      supportsVideo: false
    },
    android: {
      alertTitle: "Phone account permission",
      alertDescription: "This app needs phone account access to show incoming call UI.",
      cancelButton: "Cancel",
      okButton: "ok"
    }
  };
  try {
    await RNCallKeep.setup(options);
    RNCallKeep.setAvailable(true);
    configured = true;
  } catch {
    configured = false;
  }
}

export function showIncomingNativeCall(callId: string, from: string) {
  // iOS ONLY: dedupe (an iPhone may receive both an Expo push and a VoIP push
  // for the same call → report to CallKit at most once per callId) and map the
  // callId to a real CallKit UUID. Android must run its original path untouched,
  // so none of this executes on Android — it falls straight through to the raw
  // callId, byte-for-byte identical to the pre-iOS behavior.
  if (Platform.OS === "ios") {
    if (reportedIncomingCallIds.has(callId)) {
      console.log("[CALL_INCOMING] showIncomingNativeCall: duplicate callId ignored callId=", callId);
      return;
    }
    reportedIncomingCallIds.add(callId);
  }
  const uuid = Platform.OS === "ios" ? callKitUuidForCallId(callId) : callId;
  console.log("[CALL_INCOMING] showIncomingNativeCall (foreground) callId=", callId, "uuid=", uuid, "from=", from);
  logCallFlow("CALLKEEP_DISPLAY_BEGIN", {
    inviteId: callId,
    extra: { from, source: "showIncomingNativeCall", uuid },
  });
  try {
    RNCallKeep.displayIncomingCall(uuid, from, from, "number", false);
    console.log("[CALL_INCOMING] showIncomingNativeCall: displayIncomingCall returned");
    logCallFlow("CALLKEEP_DISPLAY_DONE", {
      inviteId: callId,
      extra: { from, source: "showIncomingNativeCall" },
    });
  } catch (e) {
    console.error("[CALL_INCOMING] showIncomingNativeCall FAILED:", e);
    logCallFlow("CALLKEEP_DISPLAY_FAILED", {
      inviteId: callId,
      extra: { message: e instanceof Error ? e.message : String(e) },
    });
  }
}

export function endNativeCall(callId: string) {
  reportedIncomingCallIds.delete(callId);
  dismissNativeIncomingUi(callId);
  // iOS: ALWAYS resolve to the deterministic CallKit UUID so we end the exact
  // call the native PushKit handler reported — even on a cold-killed cancel
  // where JS never populated the map yet (callKitUuidForCallId recomputes the
  // same deterministic value the native side used).
  // Android: the map stays empty, so this is the raw callId — unchanged behavior.
  const uuid =
    Platform.OS === "ios"
      ? callIdToCallKitUuid.get(callId) ?? callKitUuidForCallId(callId)
      : callIdToCallKitUuid.get(callId) ?? callId;
  try {
    RNCallKeep.endCall(uuid);
  } catch {
    // ignore
  }
  forgetCallKitMapping(callId);
}

export function subscribeNativeCallActions(params: {
  onAnswer: (callId: string) => void;
  onEnd: (callId: string) => void;
}) {
  // Translate the CallKit UUID back to the backend callId before handing it to
  // the shared answer/decline pipeline. On Android the map is empty, so the raw
  // value (already the callId) passes straight through unchanged.
  const answerSub = RNCallKeep.addEventListener("answerCall", ({ callUUID }: any) => {
    params.onAnswer(callIdForCallKitUuid(callUUID) ?? callUUID);
  });
  const endSub = RNCallKeep.addEventListener("endCall", ({ callUUID }: any) => {
    params.onEnd(callIdForCallKitUuid(callUUID) ?? callUUID);
  });
  return () => {
    try { answerSub.remove(); } catch {}
    try { endSub.remove(); } catch {}
  };
}

/**
 * Returns any CallKeep events that fired before listeners were attached.
 *
 * NOTE: react-native-callkeep's native getInitialEvents() has a bug
 * (ObjectAlreadyConsumedException — WritableNativeArray consumed twice) that
 * causes a FATAL native crash on every cold start. We do NOT call that method.
 *
 * Instead, cold-start answer handling is done entirely through:
 *   1. AsyncStorage PENDING_CALL_STORAGE_KEY  (written by backgroundCallTask)
 *   2. getPendingInvites() API call
 * Both are performed in NotificationsContext immediately after setupNativeCalling().
 * The live subscribeNativeCallActions listeners pick up any answer/end events
 * that fire after React mounts, so no pre-mount buffering is needed.
 */
export async function consumeInitialCallKeepEvents(): Promise<
  Array<{ type: "answer" | "end"; callUUID: string }>
> {
  // Intentionally returns empty — see note above.
  // Do NOT call RNCallKeep.getInitialEvents() here.
  return [];
}

/**
 * Bring the app to the foreground — useful after the user taps Answer in
 * the native CallKeep screen while the app was in the background.
 */
export function bringAppToForeground() {
  try {
    (RNCallKeep as any).backToForeground?.();
  } catch {
    // ignore
  }
}
