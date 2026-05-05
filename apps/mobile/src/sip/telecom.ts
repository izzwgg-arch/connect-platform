import {
  DeviceEventEmitter,
  EmitterSubscription,
  NativeModules,
  Platform,
} from "react-native";

/**
 * JS-side bridge for the SELF_MANAGED Telecom layer (Android only).
 *
 * The native side (TelecomBridge / ConnectConnectionService /
 * ConnectIncomingConnection) owns the OS-level incoming-call UI. When the
 * user taps Answer or Decline in the system call screen, the Connection
 * forwards the action via TelecomBridge → IncomingCallUiModule →
 * RCTDeviceEventEmitter as one of:
 *
 *   Telecom.Answer       { inviteId, callerNumber, callerName, pbxCallId }
 *   Telecom.Reject       { inviteId, reason }
 *   Telecom.Disconnect   { inviteId, reason }
 *   Telecom.Failed       { inviteId, reason }
 *
 * NotificationsContext subscribes to these and drives the existing
 * handleAcceptInvite / handleDeclineInvite pipeline — exactly the same
 * flow as the in-app IncomingCallScreen Answer button — so we get a
 * single, well-tested code path for SIP answer + audio routing.
 *
 * The OS Connection state is also driven from JS via the helpers below
 * once the SIP layer reports success / failure (the system UI needs to
 * know "the call is now active" or "tear down — SIP failed").
 */

export type TelecomAnswerPayload = {
  inviteId: string;
  callerNumber?: string;
  callerName?: string;
  pbxCallId?: string;
};

export type TelecomTerminationPayload = {
  inviteId: string;
  reason: string;
};

type Subs = {
  onAnswer?: (payload: TelecomAnswerPayload) => void;
  onReject?: (payload: TelecomTerminationPayload) => void;
  onDisconnect?: (payload: TelecomTerminationPayload) => void;
  onFailed?: (payload: TelecomTerminationPayload) => void;
};

export function subscribeTelecomActions(handlers: Subs) {
  if (Platform.OS !== "android") return () => undefined;
  const subs: EmitterSubscription[] = [];
  if (handlers.onAnswer) {
    subs.push(
      DeviceEventEmitter.addListener("Telecom.Answer", (p: any) => {
        try {
          handlers.onAnswer?.({
            inviteId: String(p?.inviteId || ""),
            callerNumber: p?.callerNumber || "",
            callerName: p?.callerName || "",
            pbxCallId: p?.pbxCallId || "",
          });
        } catch (e) {
          console.warn("[TELECOM] onAnswer handler threw:", e instanceof Error ? e.message : String(e));
        }
      }),
    );
  }
  if (handlers.onReject) {
    subs.push(
      DeviceEventEmitter.addListener("Telecom.Reject", (p: any) => {
        try {
          handlers.onReject?.({
            inviteId: String(p?.inviteId || ""),
            reason: String(p?.reason || "user_rejected"),
          });
        } catch (e) {
          console.warn("[TELECOM] onReject handler threw:", e instanceof Error ? e.message : String(e));
        }
      }),
    );
  }
  if (handlers.onDisconnect) {
    subs.push(
      DeviceEventEmitter.addListener("Telecom.Disconnect", (p: any) => {
        try {
          handlers.onDisconnect?.({
            inviteId: String(p?.inviteId || ""),
            reason: String(p?.reason || "user_hangup"),
          });
        } catch (e) {
          console.warn("[TELECOM] onDisconnect handler threw:", e instanceof Error ? e.message : String(e));
        }
      }),
    );
  }
  if (handlers.onFailed) {
    subs.push(
      DeviceEventEmitter.addListener("Telecom.Failed", (p: any) => {
        try {
          handlers.onFailed?.({
            inviteId: String(p?.inviteId || ""),
            reason: String(p?.reason || "create_failed"),
          });
        } catch (e) {
          console.warn("[TELECOM] onFailed handler threw:", e instanceof Error ? e.message : String(e));
        }
      }),
    );
  }
  return () => {
    for (const s of subs) {
      try { s.remove(); } catch { /* ignore */ }
    }
  };
}

/**
 * Returns true iff Android Telecom currently owns a Connection for this
 * inviteId. Used by the answer pipeline to decide whether to call
 * markTelecomActive once SIP is up.
 */
export function telecomHasConnection(inviteId: string | null | undefined): boolean {
  if (Platform.OS !== "android") return false;
  if (!inviteId) return false;
  try {
    return Boolean(NativeModules.IncomingCallUi?.telecomHasConnection?.(inviteId));
  } catch {
    return false;
  }
}

/**
 * Flip the OS Telecom Connection to ACTIVE — call after the SIP layer
 * acknowledges the answer (200 OK → media path established) so the
 * system call UI shows the in-call timer and the lock-screen ringing
 * banner clears.
 */
export function markTelecomActive(inviteId: string | null | undefined) {
  if (Platform.OS !== "android") return;
  if (!inviteId) return;
  try {
    NativeModules.IncomingCallUi?.telecomMarkActive?.(inviteId);
  } catch (e) {
    console.warn("[TELECOM] markTelecomActive threw:", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Tear down the OS Telecom Connection cleanly when the SIP layer reports
 * the call ended. Reasons match android.telecom.DisconnectCause:
 *   remote_hangup | missed | canceled | rejected | other
 */
export function terminateTelecomCall(
  inviteId: string | null | undefined,
  reason: "remote_hangup" | "missed" | "canceled" | "rejected" | "other" = "other",
) {
  if (Platform.OS !== "android") return;
  if (!inviteId) return;
  try {
    NativeModules.IncomingCallUi?.telecomTerminate?.(inviteId, reason);
  } catch (e) {
    console.warn("[TELECOM] terminateTelecomCall threw:", e instanceof Error ? e.message : String(e));
  }
}
