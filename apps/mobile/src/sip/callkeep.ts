import { NativeModules, Platform } from "react-native";
import RNCallKeep from "react-native-callkeep";
import { logCallFlow } from "../debug/callFlowDebug";

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
  console.log("[CALL_INCOMING] showIncomingNativeCall (foreground) callId=", callId, "from=", from);
  logCallFlow("CALLKEEP_DISPLAY_BEGIN", {
    inviteId: callId,
    extra: { from, source: "showIncomingNativeCall" },
  });
  try {
    RNCallKeep.displayIncomingCall(callId, from, from, "number", false);
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
  dismissNativeIncomingUi(callId);
  try {
    RNCallKeep.endCall(callId);
  } catch {
    // ignore
  }
}

export function subscribeNativeCallActions(params: {
  onAnswer: (callId: string) => void;
  onEnd: (callId: string) => void;
}) {
  const answerSub = RNCallKeep.addEventListener("answerCall", ({ callUUID }: any) => {
    params.onAnswer(callUUID);
  });
  const endSub = RNCallKeep.addEventListener("endCall", ({ callUUID }: any) => {
    params.onEnd(callUUID);
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
