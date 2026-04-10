import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Alert, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  getMediaTestStatus,
  getPendingInvites,
  heartbeatVoiceDiagSession,
  postVoiceDiagEvent,
  registerMobileDevice,
  reportMediaTest,
  respondInvite,
  startMediaTest,
  startVoiceDiagSession,
  unregisterMobileDevice,
} from "../api/client";
import { useAuth } from "./AuthContext";
import { useSip } from "./SipContext";
import {
  bringAppToForeground,
  consumeInitialCallKeepEvents,
  endNativeCall,
  setupNativeCalling,
  showIncomingNativeCall,
  subscribeNativeCallActions,
} from "../sip/callkeep";
import type { CallInvite, MobilePushPayload } from "../types";
import {
  PENDING_CALL_STORAGE_KEY,
  BG_WAKE_EVENTS_KEY,
} from "../notifications/backgroundCallTask";

// ─── Notification handler ─────────────────────────────────────────────────────
// Allows the system to display the notification even when the app is open so
// the user still sees the heads-up banner if they're in a different screen.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

type NotificationsState = {
  expoPushToken: string | null;
  incomingInvite: CallInvite | null;
  clearIncomingInvite: () => void;
  runMediaTest: () => Promise<void>;
  /** Whether the device has battery optimization enabled (Android only) */
  batteryOptimizationEnabled: boolean;
  /** Opens Android battery optimization settings for this app */
  openBatteryOptimizationSettings: () => Promise<void>;
};

const NotificationsCtx = createContext<NotificationsState | undefined>(undefined);

async function getExpoToken(): Promise<string | null> {
  if (!Device.isDevice) return null;
  const perm = await Notifications.getPermissionsAsync();
  if (perm.status !== "granted") {
    const req = await Notifications.requestPermissionsAsync();
    if (req.status !== "granted") return null;
  }
  const projectId =
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID ||
    Constants.expoConfig?.extra?.easProjectId;
  const token = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  );
  return token.data || null;
}

// ─── Android high-importance notification channel ────────────────────────────
// Created programmatically to guarantee it exists on the first run, even
// before the plugin-config channel is applied.
async function ensureCallChannel() {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync("connect-calls", {
      name: "Incoming Calls",
      importance: Notifications.AndroidImportance.MAX,
      sound: "default",
      vibrationPattern: [0, 500, 200, 500],
      lockScreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      enableVibrate: true,
      enableLights: true,
      lightColor: "#22c55e",
      showBadge: false,
      // bypassDnd is not supported in expo-notifications JS API; the plugin
      // manifest config handles the channel-level flags instead.
    });
  } catch {
    // Non-fatal — the plugin-configured channel is the primary path
  }
}

function payloadToInvite(
  data: Extract<MobilePushPayload, { type: "INCOMING_CALL" }>,
): CallInvite {
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
    expiresAt: new Date(Date.now() + 45_000).toISOString(),
  };
}

async function dismissIncomingInvite(
  sip: ReturnType<typeof useSip>,
  invite: CallInvite,
) {
  endNativeCall(invite.id);
  await sip
    .rejectIncomingInvite({
      fromNumber: invite.fromNumber,
      toExtension: invite.toExtension,
      pbxCallId: invite.pbxCallId,
      sipCallTarget: invite.sipCallTarget,
    })
    .catch(() => false);
}

// ─── Battery optimization helpers ────────────────────────────────────────────

async function checkBatteryOptimizationEnabled(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    // expo-intent-launcher doesn't expose a direct check, but we can infer it
    // from the absence of the IGNORE_BATTERY_OPTIMIZATIONS permission being
    // granted. On Android 6+ the OS tracks this per-app.
    // We use a best-effort check: if the device is real and Android,
    // we conservatively assume optimization may be on unless the user has
    // explicitly whitelisted the app.
    // A more precise check would require a native module.
    return Device.isDevice && Platform.OS === "android";
  } catch {
    return false;
  }
}

async function openBatteryOptimizationSettings(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const IntentLauncher = require("expo-intent-launcher");
    // Try to open the specific app's battery optimization page first
    await IntentLauncher.startActivityAsync(
      "android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
      { data: "package:com.connectcommunications.mobile" },
    ).catch(() =>
      // Fallback: open general battery optimization list
      IntentLauncher.startActivityAsync(
        IntentLauncher.ActivityAction.IGNORE_BATTERY_OPTIMIZATION_SETTINGS,
      ),
    );
  } catch {
    // IntentLauncher not available / activity not found
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function NotificationsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { token } = useAuth();
  const sip = useSip();
  const [expoPushToken, setExpoPushToken] = useState<string | null>(null);
  const [incomingInvite, setIncomingInvite] = useState<CallInvite | null>(null);
  const [batteryOptimizationEnabled, setBatteryOptimizationEnabled] =
    useState(false);
  const deviceIdRef = useRef<string | null>(null);
  const diagSessionIdRef = useRef<string | null>(null);
  const lastRegStateRef = useRef<string>("idle");
  const lastCallStateRef = useRef<string>("idle");

  // ── runMediaTest ──────────────────────────────────────────────────────────
  const runMediaTest = React.useCallback(async () => {
    if (!token) return;
    const status = await getMediaTestStatus(token).catch(() => null);
    if (!status?.mediaReliabilityGateEnabled) return;

    const started = await startMediaTest(token, {
      platform: Platform.OS === "ios" ? "IOS" : "ANDROID",
    }).catch(() => null);
    if (!started?.token) return;

    const wsOk =
      String(sip.registrationState || "").toLowerCase() === "registered";
    await reportMediaTest(token, {
      token: started.token,
      hasRelay: false,
      iceSelectedPairType: "unknown",
      wsOk,
      sipRegisterOk: wsOk,
      rtpCandidatePresent: false,
      durationMs: 120,
      platform: Platform.OS === "ios" ? "IOS" : "ANDROID",
      ...(wsOk ? {} : { errorCode: "MOBILE_DIAG_NOT_REGISTERED" }),
    }).catch(() => undefined);

    if (diagSessionIdRef.current) {
      await postVoiceDiagEvent(token, {
        sessionId: diagSessionIdRef.current,
        type: "MEDIA_TEST_RUN",
        payload: { wsOk, source: "mobile_optional_action" },
      }).catch(() => undefined);
    }
  }, [token, sip.registrationState]);

  // ── Answer flow helper ────────────────────────────────────────────────────
  // Shared logic for answering via CallKeep native UI (answer button tap) or
  // in-app button. Also handles cold-start where incomingInvite may be null.
  const handleAcceptInvite = React.useCallback(
    async (invite: CallInvite, callId: string) => {
      if (!token) return;

      const sid = diagSessionIdRef.current;
      if (sid) {
        postVoiceDiagEvent(token, {
          sessionId: sid,
          type: "ANSWER_TAPPED",
          payload: { action: "ACCEPT", inviteId: invite.id },
        }).catch(() => undefined);
      }

      const resp = await respondInvite(
        token,
        invite.id,
        "ACCEPT",
        deviceIdRef.current || undefined,
      ).catch(() => null);

      if (!resp || resp.code !== "INVITE_CLAIMED_OK") {
        if (resp?.code === "TURN_REQUIRED_NOT_VERIFIED") {
          Alert.alert(
            "TURN not verified",
            "TURN not verified. Ask admin to test TURN in the portal.",
          );
          await respondInvite(
            token,
            invite.id,
            "DECLINE",
            deviceIdRef.current || undefined,
          ).catch(() => undefined);
        }
        if (resp?.code === "MEDIA_TEST_REQUIRED_NOT_PASSED") {
          Alert.alert(
            "Media test required",
            "Media reliability gate requires a recent passing media test.",
          );
          await respondInvite(
            token,
            invite.id,
            "DECLINE",
            deviceIdRef.current || undefined,
          ).catch(() => undefined);
        }
        setIncomingInvite(null);
        endNativeCall(callId);
        return;
      }

      // Bring app to foreground if answering from native CallKeep screen
      bringAppToForeground();

      await sip.register().catch(() => undefined);
      const answered = await sip
        .answerIncomingInvite(
          {
            fromNumber: invite.fromNumber,
            toExtension: invite.toExtension,
            pbxCallId: invite.pbxCallId,
            sipCallTarget: invite.sipCallTarget,
          },
          5000,
        )
        .catch(() => false);

      if (!answered) {
        setIncomingInvite(null);
        endNativeCall(callId);
        return;
      }

      // Clear the stored pending invite from the background task cache
      AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
      setIncomingInvite(null);
    },
    [token, sip],
  );

  // ── CallKeep native actions ───────────────────────────────────────────────
  useEffect(() => {
    setupNativeCalling().then(async () => {
      // ── Consume initial events (fired before listeners attached) ────────
      // This is the critical path for: background task showed CallKeep UI
      // → user tapped Answer → Android launched app cold → events fired
      // before React mounted. We drain the buffer here and handle them.
      const initialEvents = await consumeInitialCallKeepEvents();

      for (const evt of initialEvents) {
        if (evt.type === "answer") {
          // Fetch invite from API since incomingInvite state isn't loaded yet
          const pending = token
            ? await getPendingInvites(token).catch(() => [])
            : [];
          // Also check AsyncStorage cache from background task
          const cachedRaw = await AsyncStorage.getItem(PENDING_CALL_STORAGE_KEY).catch(() => null);
          const cached = cachedRaw ? (() => { try { return JSON.parse(cachedRaw); } catch { return null; } })() : null;

          let invite: CallInvite | null =
            pending.length > 0 ? (pending[0] as CallInvite) : null;

          if (!invite && cached && cached.inviteId === evt.callUUID) {
            invite = payloadToInvite(cached as any);
          }

          if (invite) {
            setIncomingInvite(invite);
            await handleAcceptInvite(invite, evt.callUUID);
          } else {
            endNativeCall(evt.callUUID);
          }
        } else if (evt.type === "end") {
          // User declined from native UI before app was open
          const cachedRaw = await AsyncStorage.getItem(PENDING_CALL_STORAGE_KEY).catch(() => null);
          const cached = cachedRaw ? (() => { try { return JSON.parse(cachedRaw); } catch { return null; } })() : null;
          if (cached && token) {
            await respondInvite(token, cached.inviteId, "DECLINE").catch(() => undefined);
          }
          AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
          endNativeCall(evt.callUUID);
        }
      }
    }).catch(() => undefined);

    const unsubNative = subscribeNativeCallActions({
      onAnswer: async (callId) => {
        // Live (post-mount) answer — use state if available, otherwise fetch
        let invite = incomingInvite;

        if (!invite && token) {
          // App may have just foregrounded; give state a moment to populate
          await new Promise((r) => setTimeout(r, 300));
          invite = incomingInvite;
        }

        if (!invite && token) {
          const pending = await getPendingInvites(token).catch(() => []);
          if (pending.length > 0) {
            invite = pending[0] as CallInvite;
            setIncomingInvite(invite);
          }
        }

        if (!invite) {
          endNativeCall(callId);
          return;
        }

        await handleAcceptInvite(invite, callId);
      },

      onEnd: async (callId) => {
        const invite = incomingInvite;
        if (!token || !invite) {
          // No invite in state — try cached invite from background task
          const cachedRaw = await AsyncStorage.getItem(PENDING_CALL_STORAGE_KEY).catch(() => null);
          const cached = cachedRaw ? (() => { try { return JSON.parse(cachedRaw); } catch { return null; } })() : null;
          if (cached && token) {
            await respondInvite(token, cached.inviteId, "DECLINE").catch(() => undefined);
          }
          AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
          endNativeCall(callId);
          return;
        }

        const sid = diagSessionIdRef.current;
        if (sid) {
          postVoiceDiagEvent(token, {
            sessionId: sid,
            type: "ANSWER_TAPPED",
            payload: { action: "DECLINE", inviteId: invite.id },
          }).catch(() => undefined);
        }

        await respondInvite(
          token,
          invite.id,
          "DECLINE",
          deviceIdRef.current || undefined,
        ).catch(() => undefined);
        await sip
          .rejectIncomingInvite({
            fromNumber: invite.fromNumber,
            toExtension: invite.toExtension,
            pbxCallId: invite.pbxCallId,
            sipCallTarget: invite.sipCallTarget,
          })
          .catch(() => false);
        setIncomingInvite(null);
        endNativeCall(callId);
      },
    });

    return () => {
      unsubNative();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, incomingInvite, sip, handleAcceptInvite]);

  // ── Main init: token, push, diag session, pending invites ─────────────────
  useEffect(() => {
    if (!token) return;

    let mounted = true;
    let currentToken: string | null = null;

    // Battery optimization warning (Android only, shown once per session)
    checkBatteryOptimizationEnabled().then((enabled) => {
      if (mounted) setBatteryOptimizationEnabled(enabled);
    });

    (async () => {
      // Ensure high-importance call channel exists before any push arrives
      await ensureCallChannel();

      currentToken = await getExpoToken();
      if (!mounted) return;
      setExpoPushToken(currentToken);

      if (currentToken) {
        const reg = await registerMobileDevice(token, {
          platform: Platform.OS === "ios" ? "IOS" : "ANDROID",
          expoPushToken: currentToken,
          deviceName: Device.modelName || `${Platform.OS}-device`,
        }).catch(() => null);
        if (reg?.id) deviceIdRef.current = String(reg.id);
      }

      const session = await startVoiceDiagSession(token, {
        sessionId: diagSessionIdRef.current || undefined,
        platform: Platform.OS === "ios" ? "IOS" : "ANDROID",
        deviceId: deviceIdRef.current || undefined,
        appVersion: String(Constants.expoConfig?.version || ""),
        lastRegState: sip.registrationState,
        lastCallState: sip.callState,
      }).catch(() => null);
      if (session?.sessionId) {
        diagSessionIdRef.current = String(session.sessionId);
        // Persist for screens that need it outside the provider (e.g. IncomingCallScreen)
        AsyncStorage.setItem("connect_diag_session_id", diagSessionIdRef.current).catch(() => {});
      }

      // ── Submit deferred APP_WAKE events from background task ─────────────
      // The background task can't post to the API (no auth token), so it
      // stores events in AsyncStorage. We flush them here.
      const wakeRaw = await AsyncStorage.getItem(BG_WAKE_EVENTS_KEY).catch(() => null);
      if (wakeRaw && diagSessionIdRef.current) {
        const wakeEvents: any[] = (() => { try { return JSON.parse(wakeRaw); } catch { return []; } })();
        for (const evt of wakeEvents) {
          await postVoiceDiagEvent(token, {
            sessionId: diagSessionIdRef.current!,
            type: "PUSH_RECEIVED",
            payload: { source: "background_task_wake", inviteId: evt.inviteId, at: evt.at },
          }).catch(() => undefined);
        }
        AsyncStorage.removeItem(BG_WAKE_EVENTS_KEY).catch(() => {});
      }

      runMediaTest().catch(() => undefined);

      // ── Check for invite cached by background task ────────────────────────
      // When the background task ran while app was killed, it stored the
      // invite in AsyncStorage. Read it here for instant cold-start display
      // without waiting for the API round-trip.
      const cachedRaw = await AsyncStorage.getItem(PENDING_CALL_STORAGE_KEY).catch(() => null);
      if (cachedRaw && mounted) {
        const cached = (() => { try { return JSON.parse(cachedRaw); } catch { return null; } })();
        const age = cached?._storedAt ? Date.now() - cached._storedAt : Infinity;
        // Only use cached invite if it's less than 45 seconds old (invite TTL)
        if (cached?.type === "INCOMING_CALL" && age < 45_000) {
          const invite = payloadToInvite(cached);
          setIncomingInvite(invite);
          showIncomingNativeCall(invite.id, invite.fromDisplay || invite.fromNumber);
          if (diagSessionIdRef.current) {
            postVoiceDiagEvent(token, {
              sessionId: diagSessionIdRef.current,
              type: "INCOMING_INVITE",
              payload: { inviteId: invite.id, source: "cold_start_cache" },
            }).catch(() => undefined);
          }
        } else {
          // Stale — clean up
          AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
        }
      }

      // ── Fetch server-side pending invites as authoritative source ─────────
      const pending = await getPendingInvites(token).catch(() => []);
      if (pending.length > 0 && mounted) {
        const invite = pending[0] as CallInvite;
        setIncomingInvite(invite);
        showIncomingNativeCall(invite.id, invite.fromDisplay || invite.fromNumber);
        if (diagSessionIdRef.current) {
          postVoiceDiagEvent(token, {
            sessionId: diagSessionIdRef.current,
            type: "INCOMING_INVITE",
            payload: { inviteId: invite.id, source: "pending_api" },
          }).catch(() => undefined);
        }
      }
    })();

    // ── Foreground notification listener ────────────────────────────────────
    const pushSub = Notifications.addNotificationReceivedListener((evt) => {
      const data = evt.request.content.data as MobilePushPayload;

      if (data?.type === "INCOMING_CALL") {
        const invite = payloadToInvite(data);
        setIncomingInvite(invite);
        showIncomingNativeCall(invite.id, invite.fromDisplay || invite.fromNumber);

        const sid = diagSessionIdRef.current;
        if (sid && token) {
          // Telemetry: push received in foreground/background
          postVoiceDiagEvent(token, {
            sessionId: sid,
            type: "PUSH_RECEIVED",
            payload: {
              inviteId: invite.id,
              fromNumber: invite.fromNumber,
              source: "foreground_listener",
            },
          }).catch(() => undefined);

          postVoiceDiagEvent(token, {
            sessionId: sid,
            type: "INCOMING_INVITE",
            payload: { inviteId: invite.id, fromNumber: invite.fromNumber },
          }).catch(() => undefined);
        }
        return;
      }

      if (data?.type === "INVITE_CLAIMED" || data?.type === "INVITE_CANCELED") {
        setIncomingInvite((prev) => {
          if (!prev || prev.id !== data.inviteId) return prev;
          dismissIncomingInvite(sip, prev).catch(() => undefined);
          if (data.type === "INVITE_CANCELED") {
            Alert.alert("Call ended", "The caller hung up.");
          }
          return null;
        });
        AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
      }
    });

    // ── Notification response listener (user tapped system tray notification) ─
    const responseSub = Notifications.addNotificationResponseReceivedListener(
      (evt) => {
        const data = evt.notification.request.content.data as MobilePushPayload;
        if (data?.type !== "INCOMING_CALL") return;
        // Restore invite if not already set (cold-start tap)
        setIncomingInvite((prev) => prev || payloadToInvite(data));
        const sid = diagSessionIdRef.current;
        if (sid && token) {
          postVoiceDiagEvent(token, {
            sessionId: sid,
            type: "PUSH_RECEIVED",
            payload: { inviteId: data.inviteId, source: "notification_tap" },
          }).catch(() => undefined);
        }
      },
    );

    return () => {
      mounted = false;
      pushSub.remove();
      responseSub.remove();
      if (token && currentToken) {
        unregisterMobileDevice(token, currentToken).catch(() => undefined);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // ── Registration / call state telemetry ───────────────────────────────────
  useEffect(() => {
    if (!token || !diagSessionIdRef.current) return;
    const sid = diagSessionIdRef.current;
    const prevReg = lastRegStateRef.current;
    const prevCall = lastCallStateRef.current;

    if (prevReg !== sip.registrationState) {
      if (sip.registrationState === "registered") {
        postVoiceDiagEvent(token, { sessionId: sid, type: "SIP_REGISTER", payload: { state: sip.registrationState } }).catch(() => undefined);
        postVoiceDiagEvent(token, { sessionId: sid, type: "WS_CONNECTED", payload: { state: sip.registrationState } }).catch(() => undefined);
      } else if (String(prevReg) === "registered") {
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

  // ── Session heartbeat ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!token || !diagSessionIdRef.current) return;
    const sid = diagSessionIdRef.current;
    const t = setInterval(() => {
      heartbeatVoiceDiagSession(token, {
        sessionId: sid,
        lastRegState: sip.registrationState,
        lastCallState: sip.callState,
      }).catch(() => undefined);
    }, 65_000);
    return () => clearInterval(t);
  }, [token, sip.registrationState, sip.callState]);

  const value = useMemo(
    () => ({
      expoPushToken,
      incomingInvite,
      clearIncomingInvite: () => setIncomingInvite(null),
      runMediaTest,
      batteryOptimizationEnabled,
      openBatteryOptimizationSettings,
    }),
    [expoPushToken, incomingInvite, runMediaTest, batteryOptimizationEnabled],
  );

  return (
    <NotificationsCtx.Provider value={value}>
      {children}
    </NotificationsCtx.Provider>
  );
}

export function useIncomingNotifications() {
  const ctx = useContext(NotificationsCtx);
  if (!ctx)
    throw new Error(
      "useIncomingNotifications must be used within NotificationsProvider",
    );
  return ctx;
}
