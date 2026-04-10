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
 * Critical for the cold-start scenario where the user taps "Answer" in the
 * native CallKeep UI (shown by the background task), then Android brings the
 * app to the foreground. By the time React has mounted the provider and wired
 * subscribeNativeCallActions, the "answerCall" event has already fired.
 *
 * Call this once after setupNativeCalling() in NotificationsContext.
 */
export async function consumeInitialCallKeepEvents(): Promise<
  Array<{ type: "answer" | "end"; callUUID: string }>
> {
  try {
    // react-native-callkeep buffers events fired before any JS listener was
    // attached and exposes them via getInitialEvents().
    const raw: any[] = await (RNCallKeep as any).getInitialEvents?.() ?? [];
    // Drain the buffer so events don't re-fire on the next mount
    (RNCallKeep as any).clearInitialEvents?.();
    return raw.flatMap((e) => {
      const uuid: string = e?.callUUID ?? e?.data?.callUUID ?? "";
      if (!uuid) return [];
      if (e.name === "answerCall") return [{ type: "answer" as const, callUUID: uuid }];
      if (e.name === "endCall") return [{ type: "end" as const, callUUID: uuid }];
      return [];
    });
  } catch {
    return [];
  }
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
