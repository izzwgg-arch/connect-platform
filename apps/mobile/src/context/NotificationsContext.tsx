import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Alert, AppState, Platform } from "react-native";
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
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// ─── Types ────────────────────────────────────────────────────────────────────

export type CallReadiness = {
  notificationPermission: "granted" | "denied" | "undetermined";
  pushTokenRegistered: boolean;
  /** Android: whether we believe battery optimization may interfere */
  batteryOptimizationWarning: boolean;
  /** True only when all hard requirements are met */
  isFullyReady: boolean;
};

type NotificationsState = {
  expoPushToken: string | null;
  incomingInvite: CallInvite | null;
  clearIncomingInvite: () => void;
  runMediaTest: () => Promise<void>;
  callReadiness: CallReadiness;
  openBatteryOptimizationSettings: () => Promise<void>;
  requestNotificationPermission: () => Promise<void>;
};

const NotificationsCtx = createContext<NotificationsState | undefined>(
  undefined,
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Safe JSON.parse — returns null on any error. */
function safeParse(raw: string | null): any {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function getExpoToken(): Promise<string | null> {
  if (!Device.isDevice) return null;
  const perm = await Notifications.getPermissionsAsync();
  if (perm.status !== "granted") return null;
  const projectId =
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID ||
    Constants.expoConfig?.extra?.easProjectId;
  const token = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  );
  return token.data || null;
}

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
    });
  } catch {
    // Non-fatal — plugin-configured channel is the primary path
  }
}

function payloadToInvite(
  data: Extract<MobilePushPayload, { type: "INCOMING_CALL" }> & {
    _pushReceivedAt?: number;
    _storedAt?: number;
  },
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
    // Carry timing data so latency can be computed at answer time
    _pushReceivedAt: data._pushReceivedAt || data._storedAt || Date.now(),
  } as CallInvite & { _pushReceivedAt: number };
}

/** Returns true if the invite is already past its expiry. */
function isExpired(invite: CallInvite): boolean {
  if (!invite.expiresAt) return false;
  return Date.now() > new Date(invite.expiresAt).getTime();
}

async function openBatteryOptimizationSettings(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const IL = require("expo-intent-launcher");
    await IL.startActivityAsync(
      "android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
      { data: "package:com.connectcommunications.mobile" },
    ).catch(() =>
      IL.startActivityAsync(IL.ActivityAction.IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
    );
  } catch {
    // ignore
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
  const [callReadiness, setCallReadiness] = useState<CallReadiness>({
    notificationPermission: "undetermined",
    pushTokenRegistered: false,
    batteryOptimizationWarning: Platform.OS === "android" && !!Device.isDevice,
    isFullyReady: false,
  });

  const deviceIdRef = useRef<string | null>(null);
  const diagSessionIdRef = useRef<string | null>(null);
  const lastRegStateRef = useRef<string>("idle");
  const lastCallStateRef = useRef<string>("idle");

  // Tracks inviteId currently shown to prevent duplicates
  const shownInviteIdRef = useRef<string | null>(null);
  // Holds the 45-second stale-invite auto-expire timer
  const inviteExpireTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timing anchors — filled from different sources, used to build latency chain
  const timingsRef = useRef<Record<string, number>>({});

  // ── Helpers ────────────────────────────────────────────────────────────────

  const clearExpireTimer = useCallback(() => {
    if (inviteExpireTimerRef.current !== null) {
      clearTimeout(inviteExpireTimerRef.current);
      inviteExpireTimerRef.current = null;
    }
  }, []);

  /** Set the active invite with duplicate guard and restart the 45s expire timer. */
  const safeSetInvite = useCallback(
    (invite: CallInvite | null) => {
      clearExpireTimer();
      if (invite === null) {
        shownInviteIdRef.current = null;
        setIncomingInvite(null);
        return;
      }
      // Duplicate guard: don't replace an invite with itself
      if (shownInviteIdRef.current === invite.id) {
        console.log("[Notif] Duplicate invite ignored:", invite.id);
        return;
      }
      shownInviteIdRef.current = invite.id;
      setIncomingInvite(invite);

      // Auto-expire: if the call is never answered by 47s (2s buffer beyond TTL),
      // clean up the invite so the UI doesn't get stuck.
      inviteExpireTimerRef.current = setTimeout(() => {
        setIncomingInvite((prev) => {
          if (prev?.id !== invite.id) return prev; // already changed
          endNativeCall(invite.id);
          AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
          shownInviteIdRef.current = null;
          return null;
        });
      }, 47_000);
    },
    [clearExpireTimer],
  );

  // ── Notification permission request ───────────────────────────────────────

  const requestNotificationPermission = useCallback(async () => {
    const result = await Notifications.requestPermissionsAsync();
    const granted = result.status === "granted";
    setCallReadiness((prev) => ({
      ...prev,
      notificationPermission: result.status as CallReadiness["notificationPermission"],
      isFullyReady: granted && prev.pushTokenRegistered,
    }));
    if (!granted) {
      Alert.alert(
        "Notifications required",
        "Connect needs notification permission to show incoming call alerts.\n\nPlease enable it in Android Settings → Apps → Connect → Notifications.",
        [{ text: "OK" }],
      );
    }
  }, []);

  // ── runMediaTest ──────────────────────────────────────────────────────────

  const runMediaTest = useCallback(async () => {
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

  // ── Answer invite (shared path for native CallKeep + in-app button) ───────

  const handleAcceptInvite = useCallback(
    async (invite: CallInvite, callId: string) => {
      if (!token) return;

      // ── Expiry check ──────────────────────────────────────────────────────
      if (isExpired(invite)) {
        console.log("[Notif] Invite expired, cannot answer:", invite.id);
        Alert.alert(
          "Call ended",
          "This call is no longer available — the caller may have hung up.",
        );
        safeSetInvite(null);
        endNativeCall(callId);
        AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
        return;
      }

      // ── Timing: record answer-tap timestamp ───────────────────────────────
      const answerTappedAt = Date.now();
      const pushReceivedAt =
        (invite as any)._pushReceivedAt ||
        timingsRef.current[`push_${invite.id}`] ||
        answerTappedAt;
      timingsRef.current[`answer_${invite.id}`] = answerTappedAt;

      const sid = diagSessionIdRef.current;
      if (sid) {
        postVoiceDiagEvent(token, {
          sessionId: sid,
          type: "ANSWER_TAPPED",
          payload: {
            action: "ACCEPT",
            inviteId: invite.id,
            pushReceivedAt,
            answerTappedAt,
            pushToAnswerMs: answerTappedAt - pushReceivedAt,
          },
        }).catch(() => undefined);
      }

      const resp = await respondInvite(
        token,
        invite.id,
        "ACCEPT",
        deviceIdRef.current || undefined,
      ).catch(() => null);

      if (!resp || resp.code !== "INVITE_CLAIMED_OK") {
        const reason = resp?.code || "unknown";
        if (reason === "TURN_REQUIRED_NOT_VERIFIED") {
          Alert.alert(
            "TURN not verified",
            "TURN not verified. Ask admin to test TURN in the portal.",
          );
          await respondInvite(token, invite.id, "DECLINE", deviceIdRef.current || undefined).catch(() => undefined);
        } else if (reason === "MEDIA_TEST_REQUIRED_NOT_PASSED") {
          Alert.alert(
            "Media test required",
            "Media reliability gate requires a recent passing media test.",
          );
          await respondInvite(token, invite.id, "DECLINE", deviceIdRef.current || undefined).catch(() => undefined);
        } else if (reason === "INVITE_EXPIRED" || reason === "INVITE_NOT_FOUND") {
          Alert.alert("Call ended", "This call is no longer available.");
        }
        safeSetInvite(null);
        endNativeCall(callId);
        AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
        return;
      }

      // Bring app to foreground if answering via native CallKeep screen
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
        Alert.alert(
          "Answer failed",
          "Could not connect the call. The call may have already ended.",
        );
        safeSetInvite(null);
        endNativeCall(callId);
        return;
      }

      // Log SIP-join timing
      const sipJoinedAt = Date.now();
      if (sid) {
        postVoiceDiagEvent(token, {
          sessionId: sid,
          type: "CALL_CONNECTED",
          payload: {
            inviteId: invite.id,
            sipJoinedAt,
            pushReceivedAt,
            answerTappedAt,
            pushToJoinMs: sipJoinedAt - pushReceivedAt,
            answerToJoinMs: sipJoinedAt - answerTappedAt,
          },
        }).catch(() => undefined);
      }

      AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
      safeSetInvite(null);
    },
    [token, sip, safeSetInvite],
  );

  // ── CallKeep native action subscriptions ─────────────────────────────────

  useEffect(() => {
    setupNativeCalling().then(async () => {
      // Drain any events that fired before React mounted (cold-start answer)
      const initialEvents = await consumeInitialCallKeepEvents();

      for (const evt of initialEvents) {
        if (evt.type === "answer") {
          const pending = token ? await getPendingInvites(token).catch(() => []) : [];
          const cached = safeParse(
            await AsyncStorage.getItem(PENDING_CALL_STORAGE_KEY).catch(() => null),
          );
          let invite: CallInvite | null =
            pending.length > 0 ? (pending[0] as CallInvite) : null;
          if (!invite && cached?.inviteId === evt.callUUID) {
            invite = payloadToInvite(cached);
          }
          if (invite) {
            safeSetInvite(invite);
            await handleAcceptInvite(invite, evt.callUUID);
          } else {
            endNativeCall(evt.callUUID);
          }
        } else if (evt.type === "end") {
          const cached = safeParse(
            await AsyncStorage.getItem(PENDING_CALL_STORAGE_KEY).catch(() => null),
          );
          if (cached?.inviteId && token) {
            await respondInvite(token, cached.inviteId, "DECLINE").catch(() => undefined);
          }
          AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
          endNativeCall(evt.callUUID);
          safeSetInvite(null);
        }
      }
    }).catch(() => undefined);

    const unsubNative = subscribeNativeCallActions({
      onAnswer: async (callId) => {
        let invite = incomingInvite;

        // If invite not yet in state (app just foregrounded), wait briefly then try
        if (!invite && token) {
          await new Promise<void>((r) => setTimeout(r, 400));
          invite = incomingInvite;
        }

        // Still no invite — fetch from API or AsyncStorage cache
        if (!invite && token) {
          const pending = await getPendingInvites(token).catch(() => []);
          if (pending.length > 0) {
            invite = pending[0] as CallInvite;
            safeSetInvite(invite);
          } else {
            const cached = safeParse(
              await AsyncStorage.getItem(PENDING_CALL_STORAGE_KEY).catch(() => null),
            );
            if (cached?.inviteId === callId || cached?.inviteId) {
              invite = payloadToInvite(cached);
              safeSetInvite(invite);
            }
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

        if (!token) {
          endNativeCall(callId);
          return;
        }

        if (!invite) {
          // No invite in state — try cache (background task set it)
          const cached = safeParse(
            await AsyncStorage.getItem(PENDING_CALL_STORAGE_KEY).catch(() => null),
          );
          if (cached?.inviteId) {
            await respondInvite(token, cached.inviteId, "DECLINE").catch(() => undefined);
          }
          AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
          endNativeCall(callId);
          safeSetInvite(null);
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

        await respondInvite(token, invite.id, "DECLINE", deviceIdRef.current || undefined).catch(() => undefined);
        await sip.rejectIncomingInvite({
          fromNumber: invite.fromNumber,
          toExtension: invite.toExtension,
          pbxCallId: invite.pbxCallId,
          sipCallTarget: invite.sipCallTarget,
        }).catch(() => false);

        AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
        safeSetInvite(null);
        endNativeCall(callId);
      },
    });

    return () => { unsubNative(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, incomingInvite, sip, handleAcceptInvite, safeSetInvite]);

  // ── Main init: permissions, push token, diag session, pending invites ─────

  useEffect(() => {
    if (!token) return;
    let mounted = true;
    let currentToken: string | null = null;

    (async () => {
      await ensureCallChannel();

      // ── Check & request notification permission ─────────────────────────
      const permResult = await Notifications.getPermissionsAsync().catch(() => null);
      const permStatus = permResult?.status ?? "undetermined";

      if (permStatus !== "granted") {
        // Request immediately — do not defer. Users need this for call alerts.
        const req = await Notifications.requestPermissionsAsync().catch(() => null);
        const granted = req?.status === "granted";
        if (!granted && mounted) {
          // Show guidance on first denial
          const alreadyPrompted = await AsyncStorage.getItem(
            "connect_notif_permission_prompted",
          ).catch(() => null);
          if (!alreadyPrompted) {
            await AsyncStorage.setItem(
              "connect_notif_permission_prompted",
              "1",
            ).catch(() => {});
            Alert.alert(
              "Allow notifications for incoming calls",
              'Connect needs notification permission to ring when you receive a call.\n\nGo to Settings → Apps → Connect → Notifications and enable them.',
              [{ text: "OK" }],
            );
          }
        }
        if (mounted) {
          setCallReadiness((prev) => ({
            ...prev,
            notificationPermission: (req?.status ?? "undetermined") as CallReadiness["notificationPermission"],
          }));
        }
      } else {
        if (mounted) {
          setCallReadiness((prev) => ({
            ...prev,
            notificationPermission: "granted",
          }));
        }
      }

      // ── Get push token ────────────────────────────────────────────────────
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

        if (mounted) {
          setCallReadiness((prev) => ({
            ...prev,
            pushTokenRegistered: true,
            isFullyReady: prev.notificationPermission === "granted",
          }));
        }
      }

      // ── Start diag session ────────────────────────────────────────────────
      const session = await startVoiceDiagSession(token, {
        sessionId: diagSessionIdRef.current || undefined,
        platform: Platform.OS === "ios" ? "IOS" : "ANDROID",
        deviceId: deviceIdRef.current || undefined,
        appVersion: String(Constants.expoConfig?.version || ""),
        lastRegState: sip.registrationState,
        lastCallState: sip.callState,
      }).catch(() => null);

      if (session?.sessionId && mounted) {
        diagSessionIdRef.current = String(session.sessionId);
        AsyncStorage.setItem("connect_diag_session_id", diagSessionIdRef.current).catch(() => {});
      }

      // ── Flush deferred APP_WAKE events from background task ───────────────
      const wakeRaw = await AsyncStorage.getItem(BG_WAKE_EVENTS_KEY).catch(() => null);
      if (wakeRaw && diagSessionIdRef.current) {
        const wakeEvents: any[] = safeParse(wakeRaw) ?? [];
        for (const evt of wakeEvents) {
          await postVoiceDiagEvent(token, {
            sessionId: diagSessionIdRef.current!,
            type: "PUSH_RECEIVED",
            payload: {
              source: "background_task_wake",
              inviteId: evt.inviteId,
              bgWakeAt: evt.at,
            },
          }).catch(() => undefined);
          // Stash timing for latency computation
          if (evt.inviteId) {
            timingsRef.current[`push_${evt.inviteId}`] = evt.at;
          }
        }
        AsyncStorage.removeItem(BG_WAKE_EVENTS_KEY).catch(() => {});
      }

      runMediaTest().catch(() => undefined);

      // ── Check AsyncStorage invite cache (written by background task) ──────
      const cachedRaw = await AsyncStorage.getItem(PENDING_CALL_STORAGE_KEY).catch(() => null);
      if (cachedRaw && mounted) {
        const cached = safeParse(cachedRaw);
        const age = cached?._storedAt ? Date.now() - cached._storedAt : Infinity;

        if (cached?.type === "INCOMING_CALL" && age < 45_000) {
          const invite = payloadToInvite(cached);
          safeSetInvite(invite);
          showIncomingNativeCall(invite.id, invite.fromDisplay || invite.fromNumber);

          if (diagSessionIdRef.current) {
            postVoiceDiagEvent(token, {
              sessionId: diagSessionIdRef.current,
              type: "INCOMING_INVITE",
              payload: {
                inviteId: invite.id,
                source: "cold_start_cache",
                pushReceivedAt: cached._pushReceivedAt,
                cacheAgeMs: age,
              },
            }).catch(() => undefined);
          }
        } else if (age >= 45_000) {
          // Stale — remove so the screen doesn't show a dead call
          console.log("[Notif] Stale cached invite removed, age:", age);
          AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
        }
      }

      // ── Authoritative pending invite check from server ────────────────────
      const pending = await getPendingInvites(token).catch(() => []);
      if (pending.length > 0 && mounted) {
        const invite = pending[0] as CallInvite;
        safeSetInvite(invite);
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

    // ── Foreground push listener ──────────────────────────────────────────

    const pushSub = Notifications.addNotificationReceivedListener((evt) => {
      const data = evt.request.content.data as MobilePushPayload;
      const now = Date.now();

      if (data?.type === "INCOMING_CALL") {
        const invite = payloadToInvite({ ...data, _pushReceivedAt: now } as any);
        timingsRef.current[`push_${invite.id}`] = now;

        // Sequential call cleanup: if there's already a different invite showing,
        // dismiss the old one first before replacing with the new one.
        setIncomingInvite((prev) => {
          if (prev && prev.id !== invite.id) {
            endNativeCall(prev.id);
            AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
          }
          return prev; // safeSetInvite handles the actual set
        });

        safeSetInvite(invite);
        showIncomingNativeCall(invite.id, invite.fromDisplay || invite.fromNumber);

        const sid = diagSessionIdRef.current;
        if (sid && token) {
          postVoiceDiagEvent(token, {
            sessionId: sid,
            type: "PUSH_RECEIVED",
            payload: { inviteId: invite.id, fromNumber: invite.fromNumber, source: "foreground_listener", pushReceivedAt: now },
          }).catch(() => undefined);
          postVoiceDiagEvent(token, {
            sessionId: sid,
            type: "INCOMING_INVITE",
            payload: { inviteId: invite.id, fromNumber: invite.fromNumber, pushReceivedAt: now },
          }).catch(() => undefined);
        }
        return;
      }

      if (data?.type === "INVITE_CLAIMED" || data?.type === "INVITE_CANCELED") {
        setIncomingInvite((prev) => {
          if (!prev || prev.id !== data.inviteId) return prev;
          endNativeCall(prev.id);
          AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
          if (data.type === "INVITE_CANCELED") {
            Alert.alert("Call ended", "The caller hung up.");
          }
          clearExpireTimer();
          shownInviteIdRef.current = null;
          return null;
        });
      }
    });

    // ── Notification response listener (system tray tap) ─────────────────

    const responseSub = Notifications.addNotificationResponseReceivedListener(
      (evt) => {
        const data = evt.notification.request.content.data as MobilePushPayload;
        if (data?.type !== "INCOMING_CALL") return;
        const now = Date.now();
        const invite = payloadToInvite({ ...data, _pushReceivedAt: now } as any);
        safeSetInvite(invite);
        const sid = diagSessionIdRef.current;
        if (sid && token) {
          postVoiceDiagEvent(token, {
            sessionId: sid,
            type: "PUSH_RECEIVED",
            payload: { inviteId: data.inviteId, source: "notification_tap", pushReceivedAt: now },
          }).catch(() => undefined);
        }
      },
    );

    return () => {
      mounted = false;
      clearExpireTimer();
      pushSub.remove();
      responseSub.remove();
      if (token && currentToken) {
        unregisterMobileDevice(token, currentToken).catch(() => undefined);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // ── Re-check permissions when app comes back to foreground ────────────────

  useEffect(() => {
    const sub = AppState.addEventListener("change", async (state) => {
      if (state !== "active") return;
      const perm = await Notifications.getPermissionsAsync().catch(() => null);
      if (!perm) return;
      const granted = perm.status === "granted";
      setCallReadiness((prev) => ({
        ...prev,
        notificationPermission: perm.status as CallReadiness["notificationPermission"],
        isFullyReady: granted && prev.pushTokenRegistered,
      }));
    });
    return () => sub.remove();
  }, []);

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
        postVoiceDiagEvent(token, { sessionId: sid, type: "ERROR", payload: { code: "SIP_REGISTER_FAILED" } }).catch(() => undefined);
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

  // ─────────────────────────────────────────────────────────────────────────

  const value = useMemo(
    () => ({
      expoPushToken,
      incomingInvite,
      clearIncomingInvite: () => safeSetInvite(null),
      runMediaTest,
      callReadiness,
      openBatteryOptimizationSettings,
      requestNotificationPermission,
    }),
    [expoPushToken, incomingInvite, runMediaTest, callReadiness, safeSetInvite, requestNotificationPermission],
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
