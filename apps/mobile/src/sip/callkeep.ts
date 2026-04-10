import RNCallKeep from "react-native-callkeep";

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
      okButton: "ok",
      foregroundService: {
        channelId: "connect-calls",
        channelName: "Incoming calls",
        notificationTitle: "Connect call service"
      }
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
  try {
    RNCallKeep.displayIncomingCall(callId, from, from, "number", false);
  } catch {
    // fallback UI handles non-native case
  }
}

export function endNativeCall(callId: string) {
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
