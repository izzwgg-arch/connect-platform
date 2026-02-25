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
