import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Alert, Platform } from "react-native";
import { getPendingInvites, heartbeatVoiceDiagSession, postVoiceDiagEvent, registerMobileDevice, respondInvite, startVoiceDiagSession, unregisterMobileDevice } from "../api/client";
import { useAuth } from "./AuthContext";
import { useSip } from "./SipContext";
import { endNativeCall, setupNativeCalling, showIncomingNativeCall, subscribeNativeCallActions } from "../sip/callkeep";
import type { CallInvite, MobilePushPayload } from "../types";

type NotificationsState = {
  expoPushToken: string | null;
  incomingInvite: CallInvite | null;
  clearIncomingInvite: () => void;
};

const NotificationsCtx = createContext<NotificationsState | undefined>(undefined);

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false
  })
});

async function getExpoToken(): Promise<string | null> {
  if (!Device.isDevice) return null;
  const perm = await Notifications.getPermissionsAsync();
  if (perm.status !== "granted") {
    const req = await Notifications.requestPermissionsAsync();
    if (req.status !== "granted") return null;
  }

  const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID || Constants.expoConfig?.extra?.easProjectId;
  const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
  return token.data || null;
}

function payloadToInvite(data: Extract<MobilePushPayload, { type: "INCOMING_CALL" }>): CallInvite {
  return {
    id: data.inviteId,
    tenantId: data.tenantId,
    userId: "",
    extensionId: null,
    pbxCallId: data.pbxCallId || null,
    pbxSipUsername: data.pbxSipUsername || null,
    sipCallTarget: data.sipCallTarget || null,
    fromDisplay: data.fromDisplay || null,
    fromNumber: data.fromNumber,
    toExtension: data.toExtension,
    status: "PENDING",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 45_000).toISOString()
  };
}

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const sip = useSip();
  const [expoPushToken, setExpoPushToken] = useState<string | null>(null);
  const [incomingInvite, setIncomingInvite] = useState<CallInvite | null>(null);
  const deviceIdRef = React.useRef<string | null>(null);
  const diagSessionIdRef = React.useRef<string | null>(null);
  const lastRegStateRef = React.useRef<string>("idle");
  const lastCallStateRef = React.useRef<string>("idle");

  useEffect(() => {
    setupNativeCalling().catch(() => undefined);

    const unsubNative = subscribeNativeCallActions({
      onAnswer: async (callId) => {
        if (!token || !incomingInvite) return;
        const sid = diagSessionIdRef.current;
        if (sid) await postVoiceDiagEvent(token, { sessionId: sid, type: "ANSWER_TAPPED", payload: { action: "ACCEPT", inviteId: incomingInvite.id } }).catch(() => undefined);
        const resp = await respondInvite(token, incomingInvite.id, "ACCEPT", deviceIdRef.current || undefined).catch(() => null);
        if (!resp || resp.code !== "INVITE_CLAIMED_OK") {
          if (resp?.code === "TURN_REQUIRED_NOT_VERIFIED") {
            Alert.alert("TURN not verified", "TURN not verified. Ask admin to test TURN in the portal.");
            await respondInvite(token, incomingInvite.id, "DECLINE", deviceIdRef.current || undefined).catch(() => undefined);
          }
          setIncomingInvite(null);
          endNativeCall(callId);
          return;
        }

        await sip.register().catch(() => undefined);
        const answered = await sip.answerIncomingInvite({
          fromNumber: incomingInvite.fromNumber,
          toExtension: incomingInvite.toExtension,
          pbxCallId: incomingInvite.pbxCallId,
          sipCallTarget: incomingInvite.sipCallTarget
        }, 5000).catch(() => false);

        if (!answered) {
          setIncomingInvite(null);
          endNativeCall(callId);
          return;
        }

        setIncomingInvite(null);
      },
      onEnd: async (callId) => {
        if (!token || !incomingInvite) return;
        const sid = diagSessionIdRef.current;
        if (sid) await postVoiceDiagEvent(token, { sessionId: sid, type: "ANSWER_TAPPED", payload: { action: "DECLINE", inviteId: incomingInvite.id } }).catch(() => undefined);
        await respondInvite(token, incomingInvite.id, "DECLINE", deviceIdRef.current || undefined).catch(() => undefined);
        await sip.rejectIncomingInvite({
          fromNumber: incomingInvite.fromNumber,
          toExtension: incomingInvite.toExtension,
          pbxCallId: incomingInvite.pbxCallId,
          sipCallTarget: incomingInvite.sipCallTarget
        }).catch(() => false);
        setIncomingInvite(null);
        endNativeCall(callId);
      }
    });

    return () => {
      unsubNative();
    };
  }, [token, incomingInvite, sip]);

  useEffect(() => {
    if (!token) return;

    let mounted = true;
    let currentToken: string | null = null;

    (async () => {
      currentToken = await getExpoToken();
      if (!mounted) return;
      setExpoPushToken(currentToken);
      if (currentToken) {
        const reg = await registerMobileDevice(token, {
          platform: Platform.OS === "ios" ? "IOS" : "ANDROID",
          expoPushToken: currentToken,
          deviceName: Device.modelName || `${Platform.OS}-device`
        }).catch(() => null);
        if (reg?.id) deviceIdRef.current = String(reg.id);
      }

      const session = await startVoiceDiagSession(token, {
        sessionId: diagSessionIdRef.current || undefined,
        platform: Platform.OS === "ios" ? "IOS" : "ANDROID",
        deviceId: deviceIdRef.current || undefined,
        appVersion: String(Constants.expoConfig?.version || ""),
        lastRegState: sip.registrationState,
        lastCallState: sip.callState
      }).catch(() => null);
      if (session?.sessionId) diagSessionIdRef.current = String(session.sessionId);

      const pending = await getPendingInvites(token).catch(() => []);
      if (pending.length > 0) {
        const invite = pending[0] as CallInvite;
        setIncomingInvite(invite);
        showIncomingNativeCall(invite.id, invite.fromNumber);
        if (diagSessionIdRef.current) {
          await postVoiceDiagEvent(token, { sessionId: diagSessionIdRef.current, type: "INCOMING_INVITE", payload: { inviteId: invite.id, source: "pending" } }).catch(() => undefined);
        }
      }
    })();

    const pushSub = Notifications.addNotificationReceivedListener((evt) => {
      const data = evt.request.content.data as MobilePushPayload;
      if (data?.type === "INCOMING_CALL") {
        const invite = payloadToInvite(data);
        setIncomingInvite(invite);
        showIncomingNativeCall(invite.id, invite.fromDisplay || invite.fromNumber);
        const sid = diagSessionIdRef.current;
        if (sid) {
          postVoiceDiagEvent(token, { sessionId: sid, type: "INCOMING_INVITE", payload: { inviteId: invite.id, fromNumber: invite.fromNumber } }).catch(() => undefined);
        }
        return;
      }
      if (data?.type === "INVITE_CLAIMED") {
        setIncomingInvite((prev) => {
          if (!prev || prev.id !== data.inviteId) return prev;
          endNativeCall(prev.id);
          return null;
        });
      }
    });

    const responseSub = Notifications.addNotificationResponseReceivedListener((evt) => {
      const data = evt.notification.request.content.data as MobilePushPayload;
      if (data?.type !== "INCOMING_CALL") return;
      setIncomingInvite((prev) => prev || payloadToInvite(data));
    });

    return () => {
      mounted = false;
      pushSub.remove();
      responseSub.remove();
      if (token && currentToken) {
        unregisterMobileDevice(token, currentToken).catch(() => undefined);
      }
    };
  }, [token]);


  useEffect(() => {
    if (!token || !diagSessionIdRef.current) return;
    const sid = diagSessionIdRef.current;
    const prevReg = lastRegStateRef.current;
    const prevCall = lastCallStateRef.current;

    if (prevReg !== sip.registrationState) {
      if (sip.registrationState === "registered") {
        postVoiceDiagEvent(token, { sessionId: sid, type: "SIP_REGISTER", payload: { state: sip.registrationState } }).catch(() => undefined);
        postVoiceDiagEvent(token, { sessionId: sid, type: "WS_CONNECTED", payload: { state: sip.registrationState } }).catch(() => undefined);
      } else if (prevReg === "registered" && sip.registrationState !== "registered") {
        postVoiceDiagEvent(token, { sessionId: sid, type: "SIP_UNREGISTER", payload: { state: sip.registrationState } }).catch(() => undefined);
        postVoiceDiagEvent(token, { sessionId: sid, type: "WS_DISCONNECTED", payload: { state: sip.registrationState } }).catch(() => undefined);
      } else if (String(sip.registrationState).toLowerCase().includes("fail")) {
        postVoiceDiagEvent(token, { sessionId: sid, type: "ERROR", payload: { code: "SIP_REGISTER_FAILED", state: sip.registrationState } }).catch(() => undefined);
        postVoiceDiagEvent(token, { sessionId: sid, type: "WS_RECONNECT", payload: { state: sip.registrationState } }).catch(() => undefined);
      }
      lastRegStateRef.current = sip.registrationState;
    }

    if (prevCall !== sip.callState) {
      if (sip.callState === "connected") postVoiceDiagEvent(token, { sessionId: sid, type: "CALL_CONNECTED", payload: { callState: sip.callState } }).catch(() => undefined);
      if (sip.callState === "ended") postVoiceDiagEvent(token, { sessionId: sid, type: "CALL_ENDED", payload: { callState: sip.callState } }).catch(() => undefined);
      if (sip.callState === "ringing") postVoiceDiagEvent(token, { sessionId: sid, type: "INCOMING_INVITE", payload: { source: "sip_state" } }).catch(() => undefined);
      lastCallStateRef.current = sip.callState;
    }
  }, [token, sip.registrationState, sip.callState]);

  useEffect(() => {
    if (!token || !diagSessionIdRef.current) return;
    const sid = diagSessionIdRef.current;
    const t = setInterval(() => {
      heartbeatVoiceDiagSession(token, {
        sessionId: sid,
        lastRegState: sip.registrationState,
        lastCallState: sip.callState
      }).catch(() => undefined);
    }, 65_000);
    return () => clearInterval(t);
  }, [token, sip.registrationState, sip.callState]);

  const value = useMemo(
    () => ({
      expoPushToken,
      incomingInvite,
      clearIncomingInvite: () => setIncomingInvite(null)
    }),
    [expoPushToken, incomingInvite]
  );

  return <NotificationsCtx.Provider value={value}>{children}</NotificationsCtx.Provider>;
}

export function useIncomingNotifications() {
  const ctx = useContext(NotificationsCtx);
  if (!ctx) throw new Error("useIncomingNotifications must be used within NotificationsProvider");
  return ctx;
}
