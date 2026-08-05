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
import { Alert, AppState, Linking, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  getMediaTestStatus,
  getMobileInviteAnswerStatus,
  getPendingInvites,
  heartbeatVoiceDiagSession,
  postVoiceDiagEvent,
  registerMobileDevice,
  reportMediaTest,
  respondInvite,
  startMediaTest,
  startVoiceDiagSession,
} from "../api/client";
import { useAuth } from "./AuthContext";
import { useSip } from "./SipContext";
import {
  bringAppToForeground,
  consumeInitialCallKeepEvents,
  dismissNativeIncomingUi,
  endNativeCall,
  setupNativeCalling,
  showIncomingNativeCall,
  subscribeNativeCallActions,
} from "../sip/callkeep";
import * as FileSystem from "expo-file-system";
import type { CallInvite, MobilePushPayload } from "../types";
import {
  PENDING_CALL_STORAGE_KEY,
  BG_WAKE_EVENTS_KEY,
  NATIVE_CALL_CACHE_FILE,
} from "../notifications/backgroundCallTask";

// ─── Notification handler ─────────────────────────────────────────────────────
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification.request.content.data as any;
    // Don't show a system banner for incoming calls when the app is in the
    // foreground — the in-app IncomingCallScreen overlay already appears.
    // Showing both causes confusion ("message" appearance vs. call screen).
    if (data?.type === "INCOMING_CALL") {
      return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: false };
    }
    return { shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false };
  },
});

// ─── Types ────────────────────────────────────────────────────────────────────

export type CallReadiness = {
  notificationPermission: "granted" | "denied" | "undetermined";
  pushTokenRegistered: boolean;
  /** Non-null when push token registration failed — contains the error reason */
  pushTokenError: string | null;
  /** Android: whether we believe battery optimization may interfere */
  batteryOptimizationWarning: boolean;
  /** True only when all hard requirements are met */
  isFullyReady: boolean;
};

type NotificationsState = {
  expoPushToken: string | null;
  incomingInvite: CallInvite | null;
  incomingCallUiState: {
    phase: "idle" | "incoming" | "connecting" | "ended" | "failed";
    inviteId: string | null;
    error: string | null;
  };
  /**
   * Set synchronously when the user taps Answer so navigation can jump straight
   * to ActiveCall while SIP completes (incomingInvite is cleared immediately).
   */
  answerHandoffInviteIdRef: React.MutableRefObject<string | null>;
  /** Bumps when answerHandoffInviteIdRef changes so navigators can re-run effects. */
  answerHandoffTick: number;
  clearIncomingInvite: () => void;
  /**
   * Single, guarded path to answer an incoming call. Both the notification
   * deep-link handler and IncomingCallScreen should use this — it has the
   * in-flight dedup guard so the invite is claimed exactly once.
   */
  answerIncomingCall: (invite: CallInvite) => Promise<void>;
  declineIncomingCall: (invite: CallInvite | null) => Promise<void>;
  runMediaTest: () => Promise<void>;
  callReadiness: CallReadiness;
  openBatteryOptimizationSettings: () => Promise<void>;
  requestNotificationPermission: () => Promise<void>;
  /** Re-attempt push token registration (useful when the first attempt failed). */
  retryPushTokenRegistration: () => Promise<void>;
};

type AnswerFlowEventType =
  | "INCOMING_PUSH_RECEIVED"
  | "CALLKEEP_UI_SHOWN"
  | "CALLKEEP_ANSWER_TAPPED"
  | "APP_FOREGROUNDED_FROM_CALL"
  | "INCOMING_UI_DISMISSED"
  | "INVITE_RESTORED"
  | "INVITE_RESTORE_FAILED"
  | "SIP_ANSWER_REQUESTED"
  | "SIP_ANSWER_SENT"
  | "SIP_ANSWER_CONFIRMED"
  | "SIP_ANSWER_FAILED"
  | "PBX_CALL_ANSWERED"
  | "PBX_STILL_RINGING_AFTER_ANSWER"
  | "ANSWER_DESYNC_DETECTED"
  | "UI_SWITCHED_TO_CONNECTING"
  | "UI_SWITCHED_TO_ACTIVE"
  | "RINGTONE_STOPPED"
  | "CALL_ENDED_UI_SHOWN"
  | "RETURNED_TO_QUICK_ACTION";

const NotificationsCtx = createContext<NotificationsState | undefined>(
  undefined,
);

type IncomingCallAction = "open" | "answer" | "decline";

type ParsedIncomingCallAction = {
  action: IncomingCallAction;
  inviteId: string;
  invite: CallInvite | null;
  url: string;
};

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

function parseIncomingCallActionUrl(url: string | null): ParsedIncomingCallAction | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "com.connectcommunications.mobile:" ||
      parsed.hostname !== "incoming-call"
    ) {
      return null;
    }

    const rawAction = parsed.searchParams.get("action") || "open";
    if (rawAction !== "open" && rawAction !== "answer" && rawAction !== "decline") {
      return null;
    }

    const inviteId =
      parsed.searchParams.get("inviteId") ||
      parsed.searchParams.get("callId") ||
      "";
    if (!inviteId) return null;

    const fromNumber =
      parsed.searchParams.get("fromNumber") ||
      parsed.searchParams.get("from") ||
      "";
    const fromDisplay = parsed.searchParams.get("fromDisplay");
    const toExtension = parsed.searchParams.get("toExtension") || "";
    const tenantId = parsed.searchParams.get("tenantId") || "";
    const timestamp = parsed.searchParams.get("timestamp") || new Date().toISOString();

    const invite =
      fromNumber || fromDisplay || toExtension
        ? payloadToInvite({
            type: "INCOMING_CALL",
            inviteId,
            fromNumber,
            fromDisplay,
            toExtension,
            tenantId,
            pbxCallId: parsed.searchParams.get("pbxCallId"),
            pbxSipUsername: parsed.searchParams.get("pbxSipUsername"),
            sipCallTarget: parsed.searchParams.get("sipCallTarget"),
            timestamp,
            _pushReceivedAt: Date.now(),
          })
        : null;

    return {
      action: rawAction,
      inviteId,
      invite,
      url,
    };
  } catch {
    return null;
  }
}

async function readCachedInvite(matchInviteId?: string): Promise<CallInvite | null> {
  const cached = safeParse(
    await AsyncStorage.getItem(PENDING_CALL_STORAGE_KEY).catch(() => null),
  );
  if (!cached?.inviteId) return null;
  if (matchInviteId && cached.inviteId !== matchInviteId) return null;
  return payloadToInvite(cached);
}

/** Returns the Expo push token, or null with a reason string on failure. */
async function getExpoToken(): Promise<{ token: string | null; error: string | null }> {
  if (!Device.isDevice) {
    console.log("[PUSH_TOKEN] Skipped — not a physical device");
    return { token: null, error: "Not a physical device" };
  }
  const perm = await Notifications.getPermissionsAsync().catch(() => null);
  if (perm?.status !== "granted") {
    console.log("[PUSH_TOKEN] Skipped — permission not granted, status:", perm?.status);
    return { token: null, error: `Permission not granted (status: ${perm?.status ?? "unknown"})` };
  }
  const projectId =
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID ||
    Constants.expoConfig?.extra?.easProjectId ||
    Constants.expoConfig?.extra?.eas?.projectId ||
    (Constants as any).easConfig?.projectId;
  console.log("[PUSH_TOKEN] Requesting expo push token, projectId:", projectId ?? "(none — will try anyway)");

  try {
    const tokenObj = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    const tokenValue = tokenObj?.data ?? null;
    if (tokenValue) {
      console.log("[PUSH_TOKEN] Expo token received:", tokenValue.slice(0, 30) + "...");
      return { token: tokenValue, error: null };
    }
    console.warn("[PUSH_TOKEN] getExpoPushTokenAsync returned empty data");
    return { token: null, error: "getExpoPushTokenAsync returned empty token" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[PUSH_TOKEN] getExpoPushTokenAsync failed:", msg);

    // Diagnostic: also try the raw FCM device token to tell whether the issue
    // is at the Firebase level (no google-services config) vs Expo level
    try {
      const raw = await Notifications.getDevicePushTokenAsync();
      console.log("[PUSH_TOKEN] Raw FCM device token obtained:", raw?.data ? "YES" : "NO", raw?.type);
      // Raw FCM token works — the issue is at the Expo push layer (project ID / server)
      return { token: null, error: `Expo token failed (raw FCM available): ${msg}` };
    } catch (rawErr) {
      const rawMsg = rawErr instanceof Error ? rawErr.message : String(rawErr);
      console.warn("[PUSH_TOKEN] Raw FCM device token also failed:", rawMsg);
      // Firebase itself isn't working — likely missing google-services.json / FCM not configured
      return { token: null, error: `FCM unavailable: ${rawMsg}` };
    }
  }
}

async function ensureCallChannel() {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync("connect-calls", {
      name: "Incoming Calls",
      importance: Notifications.AndroidImportance.MAX,
      sound: "default",
      vibrationPattern: [0, 500, 200, 500],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
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
  const inviteId = String(data.inviteId || data.callId || "");
  const fromNumber = String(data.fromNumber || data.from || "");
  return {
    id: inviteId,
    tenantId: data.tenantId,
    userId: "",
    extensionId: null,
    pbxCallId: data.pbxCallId || null,
    pbxSipUsername: data.pbxSipUsername || null,
    sipCallTarget: data.sipCallTarget || null,
    fromDisplay: data.fromDisplay || null,
    fromNumber,
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
  console.log("[BATTERY_OPTIMIZATION_OPEN_REQUESTED]");

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let IL: typeof import("expo-intent-launcher") | null = null;
  try {
    IL = require("expo-intent-launcher");
  } catch (e) {
    console.warn("[BATTERY_OPTIMIZATION_SETTINGS_FAILED] expo-intent-launcher not available:", e instanceof Error ? e.message : String(e));
    return;
  }

  if (!IL) return;

  const pkg = "com.connectcommunications.mobile";

  // Step 1: Android standard Doze exemption dialog.
  // This shows "Allow Connect to always run in background?" — accepting is the action.
  // Do NOT return early on success; fall through to Samsung step.
  let androidDialogShown = false;
  try {
    await (IL as any).startActivityAsync(
      "android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
      { data: `package:${pkg}` },
    );
    androidDialogShown = true;
    console.log("[BATTERY_OPTIMIZATION_SETTINGS_OPENED] via REQUEST_IGNORE_BATTERY_OPTIMIZATIONS");
  } catch {
    console.log("[BATTERY_OPTIMIZATION_SETTINGS_FAILED] REQUEST_IGNORE_BATTERY_OPTIMIZATIONS not available");
  }

  // Step 2: Android 14+ full-screen intent permission (required for native call UI).
  // Without this, the incoming call screen cannot appear over the lock screen.
  try {
    await (IL as any).startActivityAsync(
      "android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT",
      { data: `package:${pkg}` },
    );
    console.log("[BATTERY_OPTIMIZATION_SETTINGS_OPENED] via MANAGE_APP_USE_FULL_SCREEN_INTENT");
    return;
  } catch {
    console.log("[BATTERY_OPTIMIZATION_SETTINGS_FAILED] MANAGE_APP_USE_FULL_SCREEN_INTENT not available");
  }

  // Step 3: Samsung Device Care — try to open the "Background usage limits" screen.
  // This covers Samsung's proprietary Freecess sleep layer which is separate from Android Doze.
  const samsungIntents = [
    // One UI 6+ (S24, etc.) Device Care battery detail
    {
      action: "android.intent.action.MAIN",
      componentName: "com.samsung.android.lool/com.samsung.android.lool.common.setting.main.AppSleepDetailActivity",
      extras: { "packageName": pkg },
    },
    // One UI 5 / older
    {
      action: "android.intent.action.MAIN",
      componentName: "com.samsung.android.lool/com.samsung.android.lool.common.setting.deepsleep.DeepSleepDetailActivity",
      extras: { "packageName": pkg },
    },
    // General Device Care battery page
    {
      action: "android.intent.action.MAIN",
      componentName: "com.samsung.android.lool/com.samsung.android.lool.common.setting.main.BatterySleepDetailActivity",
    },
  ];

  for (const intent of samsungIntents) {
    try {
      await (IL as any).startActivityAsync(intent.action, {
        ...(intent.componentName ? { componentName: intent.componentName } : {}),
        ...(intent.extras ? { extra: intent.extras } : {}),
      });
      console.log("[BATTERY_OPTIMIZATION_SETTINGS_OPENED] via Samsung Device Care");
      return;
    } catch {
      // try next Samsung intent
    }
  }

  // Step 4: Fallback — app-specific settings where battery can be set to "Unrestricted"
  if (!androidDialogShown) {
    try {
      await (IL as any).startActivityAsync(
        IL.ActivityAction.APPLICATION_DETAILS_SETTINGS,
        { data: `package:${pkg}` },
      );
      console.log("[BATTERY_OPTIMIZATION_SETTINGS_OPENED] via APPLICATION_DETAILS_SETTINGS");
      return;
    } catch (e) {
      console.warn("[BATTERY_OPTIMIZATION_SETTINGS_FAILED] All intents failed:", e instanceof Error ? e.message : String(e));
    }
  }

  // Final fallback: show manual instructions alert
  Alert.alert(
    "One More Step (Samsung)",
    "To ensure calls ring when the app is closed:\n\n" +
    "1. Open Settings → Battery → Background usage limits\n" +
    "2. Remove Connect from the \"Sleeping apps\" list\n\n" +
    "Also go to Settings → Apps → Connect → Battery → set to Unrestricted",
    [{ text: "OK" }],
  );
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
  const [incomingCallUiState, setIncomingCallUiState] = useState<NotificationsState["incomingCallUiState"]>({
    phase: "idle",
    inviteId: null,
    error: null,
  });
  const [callReadiness, setCallReadiness] = useState<CallReadiness>({
    notificationPermission: "undetermined",
    pushTokenRegistered: false,
    pushTokenError: null,
    batteryOptimizationWarning: Platform.OS === "android" && !!Device.isDevice,
    isFullyReady: false,
  });

  const deviceIdRef = useRef<string | null>(null);
  const diagSessionIdRef = useRef<string | null>(null);
  const lastRegStateRef = useRef<string>("idle");
  const lastCallStateRef = useRef<string>("idle");
  const handledIncomingActionKeysRef = useRef<Set<string>>(new Set());
  const processingIncomingActionRef = useRef<string | null>(null);
  const inviteActionInFlightRef = useRef<Set<string>>(new Set());
  const consumedInviteActionRef = useRef<Set<string>>(new Set());
  const [pendingIncomingAction, setPendingIncomingAction] =
    useState<ParsedIncomingCallAction | null>(null);

  // Tracks inviteId currently shown to prevent duplicates
  const shownInviteIdRef = useRef<string | null>(null);
  // Holds the 45-second stale-invite auto-expire timer
  const inviteExpireTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Auto-dismisses transient ended/failure UI after a short polished delay.
  const transientUiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timing anchors — filled from different sources, used to build latency chain
  const timingsRef = useRef<Record<string, number>>({});
  const answerHandoffInviteIdRef = useRef<string | null>(null);
  const [answerHandoffTick, setAnswerHandoffTick] = useState(0);

  // ── Helpers ────────────────────────────────────────────────────────────────

  const emitAnswerFlowEvent = useCallback(
    (
      type: AnswerFlowEventType,
      invite: Pick<CallInvite, "id" | "pbxCallId" | "toExtension"> | null,
      extra?: Record<string, unknown>,
    ) => {
      const payload = {
        inviteId: invite?.id || null,
        callId: invite?.pbxCallId || null,
        extension: invite?.toExtension || null,
        timestamp: new Date().toISOString(),
        ...extra,
      };
      console.log(`[ANSWER_FLOW] ${type}`, JSON.stringify(payload));
    },
    [],
  );

  const setIncomingUiPhase = useCallback(
    (
      phase: NotificationsState["incomingCallUiState"]["phase"],
      invite: Pick<CallInvite, "id" | "pbxCallId" | "toExtension"> | null,
      error: string | null = null,
    ) => {
      setIncomingCallUiState({
        phase,
        inviteId: invite?.id || null,
        error,
      });
    },
    [],
  );

  const clearTransientUiTimer = useCallback(() => {
    if (transientUiTimerRef.current !== null) {
      clearTimeout(transientUiTimerRef.current);
      transientUiTimerRef.current = null;
    }
  }, []);

  const scheduleIncomingUiReset = useCallback(
    (inviteId: string | null, delayMs = 1200) => {
      clearTransientUiTimer();
      transientUiTimerRef.current = setTimeout(() => {
        setIncomingInvite((prev) => {
          if (inviteId && prev?.id && prev.id !== inviteId) return prev;
          shownInviteIdRef.current = null;
          handledIncomingActionKeysRef.current.clear();
          setIncomingCallUiState({ phase: "idle", inviteId: null, error: null });
          return null;
        });
        transientUiTimerRef.current = null;
      }, delayMs);
    },
    [clearTransientUiTimer],
  );

  const showEndedState = useCallback(
    (
      invite: CallInvite | null,
      message: string,
      extra?: Record<string, unknown>,
      delayMs = 1400,
    ) => {
      emitAnswerFlowEvent("CALL_ENDED_UI_SHOWN", invite, {
        message,
        delayMs,
        ...extra,
      });
      setIncomingUiPhase("ended", invite, message);
      scheduleIncomingUiReset(invite?.id || null, delayMs);
    },
    [emitAnswerFlowEvent, scheduleIncomingUiReset, setIncomingUiPhase],
  );

  const waitForPbxAnswer = useCallback(
    async (invite: CallInvite, timeoutMs = 6_000) => {
      if (!token || !invite.id) {
        return { answered: false, answeredAt: null as string | null, state: null as string | null, activeChannels: [] as string[] };
      }

      const until = Date.now() + Math.max(2_000, timeoutMs);
      while (Date.now() < until) {
        const status = await getMobileInviteAnswerStatus(token, invite.id).catch(() => null);
        if (status?.pbxAnswered) {
          return {
            answered: true,
            answeredAt: status.answeredAt,
            state: status.telephonyState,
            activeChannels: status.activeChannels,
          };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }

      const finalStatus = await getMobileInviteAnswerStatus(token, invite.id).catch(() => null);
      return {
        answered: !!finalStatus?.pbxAnswered,
        answeredAt: finalStatus?.answeredAt ?? null,
        state: finalStatus?.telephonyState ?? null,
        activeChannels: finalStatus?.activeChannels ?? [],
      };
    },
    [token],
  );

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
      clearTransientUiTimer();
      if (invite === null) {
        shownInviteIdRef.current = null;
        handledIncomingActionKeysRef.current.clear();
        setIncomingInvite(null);
        setIncomingCallUiState({ phase: "idle", inviteId: null, error: null });
        return;
      }
      // Duplicate guard: don't replace an invite with itself
      if (shownInviteIdRef.current === invite.id) {
        console.log("[Notif] Duplicate invite ignored:", invite.id);
        return;
      }
      shownInviteIdRef.current = invite.id;
      setIncomingInvite(invite);
      setIncomingCallUiState((prev) =>
        prev.inviteId === invite.id && prev.phase === "connecting"
          ? prev
          : { phase: "incoming", inviteId: invite.id, error: null },
      );

      // Auto-expire: if the call is never answered by 47s (2s buffer beyond TTL),
      // clean up the invite so the UI doesn't get stuck.
      inviteExpireTimerRef.current = setTimeout(() => {
        setIncomingInvite((prev) => {
          if (prev?.id !== invite.id) return prev; // already changed
          endNativeCall(invite.id);
          AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
          shownInviteIdRef.current = null;
          setIncomingCallUiState({ phase: "idle", inviteId: null, error: null });
          return null;
        });
      }, 47_000);
    },
    [clearExpireTimer, clearTransientUiTimer],
  );

  useEffect(() => {
    if (!incomingInvite?.id) return;
    if (
      sip.registrationState === "registered" ||
      sip.registrationState === "registering"
    ) {
      return;
    }
    console.log("[CALL_INCOMING] prewarming SIP registration for invite", incomingInvite.id);
    sip.register().catch((e) => {
      console.warn(
        "[CALL_INCOMING] SIP prewarm failed:",
        e instanceof Error ? e.message : String(e),
      );
    });
  }, [incomingInvite?.id, sip.registrationState]);

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

  // ── Retry push token registration ────────────────────────────────────────

  const retryPushTokenRegistration = useCallback(async () => {
    if (!token) return;
    console.log("[PUSH_RETRY] Retrying push token registration...");

    // Re-check permission first
    const perm = await Notifications.getPermissionsAsync().catch(() => null);
    const granted = perm?.status === "granted";
    if (!granted) {
      console.log("[PUSH_RETRY] Permission not granted, requesting...");
      const req = await Notifications.requestPermissionsAsync().catch(() => null);
      if (req?.status !== "granted") {
        console.warn("[PUSH_RETRY] Permission denied — cannot register push token");
        setCallReadiness((prev) => ({
          ...prev,
          notificationPermission: (req?.status ?? "denied") as CallReadiness["notificationPermission"],
          pushTokenRegistered: false,
          isFullyReady: false,
        }));
        return;
      }
      setCallReadiness((prev) => ({
        ...prev,
        notificationPermission: "granted",
      }));
    }

    const { token: pushToken, error: pushErr } = await getExpoToken();
    console.log("[PUSH_RETRY] Token result:", pushToken ? "OK" : `FAILED (${pushErr})`);
    if (!pushToken) {
      console.warn("[PUSH_RETRY] Still no token after retry. Reason:", pushErr);
      setCallReadiness((prev) => ({ ...prev, pushTokenRegistered: false, pushTokenError: pushErr, isFullyReady: false }));
      return;
    }

    const reg = await registerMobileDevice(token, {
      platform: Platform.OS === "ios" ? "IOS" : "ANDROID",
      expoPushToken: pushToken,
      deviceName: Device.modelName || `${Platform.OS}-device`,
    }).catch((e) => {
      console.warn("[PUSH_RETRY] registerMobileDevice failed:", e instanceof Error ? e.message : String(e));
      return null;
    });

    if (reg?.id) deviceIdRef.current = String(reg.id);
    console.log("[PUSH_RETRY] Registration result — id:", reg?.id ?? "(none)");

    setExpoPushToken(pushToken);
    setCallReadiness((prev) => ({
      ...prev,
      pushTokenRegistered: true,
      pushTokenError: null,
      isFullyReady: prev.notificationPermission === "granted",
    }));
  }, [token]);

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
    async (
      invite: CallInvite,
      callId: string,
      options?: { skipBringToForeground?: boolean; deferForegroundUntilConnected?: boolean },
    ) => {
      if (!token) return;

      const acceptKey = `accept:${invite.id}`;
      if (
        inviteActionInFlightRef.current.has(acceptKey) ||
        consumedInviteActionRef.current.has(acceptKey)
      ) {
        return;
      }
      inviteActionInFlightRef.current.add(acceptKey);

      let answerFlowCommitted = false;
      try {
        dismissNativeIncomingUi(invite.id);

        // ── Expiry check ────────────────────────────────────────────────────
        if (isExpired(invite)) {
          console.log("[Notif] Invite expired, cannot answer:", invite.id);
          showEndedState(invite, "Call ended", { reason: "invite_expired" }, 1000);
          endNativeCall(callId);
          AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
          return;
        }

        // ── Timing: record answer-tap timestamp ─────────────────────────────
        const answerTappedAt = Date.now();
        const pushReceivedAt =
          (invite as any)._pushReceivedAt ||
          timingsRef.current[`push_${invite.id}`] ||
          answerTappedAt;
        const appWasBackgrounded = AppState.currentState !== "active";
        timingsRef.current[`answer_${invite.id}`] = answerTappedAt;
        emitAnswerFlowEvent("RINGTONE_STOPPED", invite, {
          reason: "answer_tapped",
          at: new Date(answerTappedAt).toISOString(),
        });
        emitAnswerFlowEvent("INCOMING_UI_DISMISSED", invite, {
          source: options?.deferForegroundUntilConnected ? "native_floating" : "incoming_screen",
          reason: "answer_tapped",
        });

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

        // Jump straight to ActiveCall UI — do not keep the incoming modal up
        // during SIP register / claim / answer.
        answerHandoffInviteIdRef.current = invite.id;
        setAnswerHandoffTick((n) => n + 1);
        safeSetInvite(null);

        // Retry SIP registration up to 4 times with 1.5 s gaps.  On cold start
        // the first attempt may fail with "Missing provisioning bundle" because
        // SipProvider hasn't loaded SecureStore yet — subsequent retries succeed.
        let registered = false;
        const shouldForceSipRefresh =
          appWasBackgrounded ||
          Boolean(options?.skipBringToForeground) ||
          Boolean(options?.deferForegroundUntilConnected);
        const wasAlreadyRegistered =
          sip.registrationState === "registered" && !shouldForceSipRefresh;
        const maxAttempts = wasAlreadyRegistered ? 1 : 4;
        for (let attempt = 1; attempt <= maxAttempts && !registered; attempt++) {
          if (attempt > 1) {
            console.log("[Notif] SIP register retry", attempt);
            await new Promise<void>((r) => setTimeout(r, 40));
          }
          registered = await sip.register({ forceRestart: shouldForceSipRefresh }).then(() => true).catch((e) => {
            console.warn("[Notif] SIP register attempt", attempt, "failed:", e?.message || e);
            return false;
          });
        }
        console.log("[Notif] SIP register result:", registered ? "OK" : "FAILED");

        if (!registered) {
          console.warn("[Notif] All SIP register attempts failed for invite:", invite.id);
          emitAnswerFlowEvent("SIP_ANSWER_FAILED", invite, {
            reason: "sip_register_failed",
          });
          showEndedState(invite, "Call ended", { reason: "sip_register_failed" });
          endNativeCall(callId);
          return;
        }

        const pbxReadinessDelayMs =
          wasAlreadyRegistered ? 0 : shouldForceSipRefresh ? 30 : 20;
        if (pbxReadinessDelayMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, pbxReadinessDelayMs));
        }

        console.log("[Notif] Claiming invite:", invite.id, "pbxCallId:", invite.pbxCallId, "sipCallTarget:", invite.sipCallTarget);
        const resp = await respondInvite(
          token,
          invite.id,
          "ACCEPT",
          deviceIdRef.current || undefined,
        ).catch(() => null);
        console.log("[Notif] respondInvite result:", resp?.code, resp?.status);

        if (!resp || resp.code !== "INVITE_CLAIMED_OK") {
          const reason = resp?.code || "unknown";

          // Another handler (e.g. IncomingCallScreen) already claimed this
          // invite — do NOT clear the invite state or the active screen.
          if (reason === "INVITE_ALREADY_HANDLED" && resp?.status === "ACCEPTED") {
            console.log("[Notif] Invite already claimed by another handler, leaving screen active");
            answerHandoffInviteIdRef.current = null;
            setAnswerHandoffTick((n) => n + 1);
            answerFlowCommitted = true;
            return;
          }

          if (reason === "TURN_REQUIRED_NOT_VERIFIED") {
            await respondInvite(token, invite.id, "DECLINE", deviceIdRef.current || undefined).catch(() => undefined);
          } else if (reason === "MEDIA_TEST_REQUIRED_NOT_PASSED") {
            await respondInvite(token, invite.id, "DECLINE", deviceIdRef.current || undefined).catch(() => undefined);
          }
          showEndedState(
            invite,
            "Call ended",
            { reason: `respond_invite_failed:${reason}` },
            1200,
          );
          endNativeCall(callId);
          AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
          return;
        }

        // Once the backend has claimed this invite, ignore any repeated answer
        // events from deep links or native callbacks for the same call.
        consumedInviteActionRef.current.add(acceptKey);

        // Deep-link notification actions already launched MainActivity. Calling
        // backToForeground again from that path causes a second launcher-style
        // restart on Samsung, which looks like a flicker loop.
        if (
          !options?.skipBringToForeground &&
          !options?.deferForegroundUntilConnected &&
          AppState.currentState !== "active"
        ) {
          emitAnswerFlowEvent("APP_FOREGROUNDED_FROM_CALL", invite, { source: "callkeep_bridge" });
          bringAppToForeground();
        }

        emitAnswerFlowEvent("SIP_ANSWER_REQUESTED", invite);
        const pbxAnswerPromise = waitForPbxAnswer(invite, 6_000);
        const answered = await sip
          .answerIncomingInvite(
            {
              inviteId: invite.id,
              fromNumber: invite.fromNumber,
              toExtension: invite.toExtension,
              pbxCallId: invite.pbxCallId,
              sipCallTarget: invite.sipCallTarget,
            },
            8000,
            (event) => {
              if (event.phase === "sent") {
                emitAnswerFlowEvent("SIP_ANSWER_SENT", invite, {
                  traceAt: new Date(event.timestamp).toISOString(),
                });
                return;
              }
              if (event.phase === "confirmed") {
                emitAnswerFlowEvent("SIP_ANSWER_CONFIRMED", invite, {
                  traceAt: new Date(event.timestamp).toISOString(),
                });
                return;
              }
              emitAnswerFlowEvent("SIP_ANSWER_FAILED", invite, {
                traceAt: new Date(event.timestamp).toISOString(),
                code: event.code ?? null,
                reason: event.reason ?? null,
                message: event.message ?? null,
              });
            },
          )
          .catch(() => false);

        if (!answered) {
          showEndedState(invite, "Call ended", {
            reason: "sip_answer_not_confirmed",
          });
          endNativeCall(callId);
          return;
        }

        if (
          !options?.skipBringToForeground &&
          options?.deferForegroundUntilConnected &&
          AppState.currentState !== "active"
        ) {
          emitAnswerFlowEvent("APP_FOREGROUNDED_FROM_CALL", invite, { source: "callkeep_after_connect" });
          bringAppToForeground();
        }
        emitAnswerFlowEvent("UI_SWITCHED_TO_ACTIVE", invite, {
          answeredAt: new Date().toISOString(),
        });

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
        setIncomingUiPhase("idle", null, null);
        pbxAnswerPromise
          .then((pbxAnswer) => {
            if (!pbxAnswer.answered) {
              emitAnswerFlowEvent("PBX_STILL_RINGING_AFTER_ANSWER", invite, {
                telephonyState: pbxAnswer.state,
                activeChannels: pbxAnswer.activeChannels,
              });
              emitAnswerFlowEvent("ANSWER_DESYNC_DETECTED", invite, {
                telephonyState: pbxAnswer.state,
                activeChannels: pbxAnswer.activeChannels,
              });
              return;
            }
            emitAnswerFlowEvent("PBX_CALL_ANSWERED", invite, {
              answeredAt: pbxAnswer.answeredAt,
              telephonyState: pbxAnswer.state,
              activeChannels: pbxAnswer.activeChannels,
            });
          })
          .catch(() => undefined);

        // SIP answered successfully — keep answerHandoff set until SipContext
        // reports connected so navigators do not pop home between invite=null
        // and callState=connected.
        answerFlowCommitted = true;
      } finally {
        inviteActionInFlightRef.current.delete(acceptKey);
        if (!answerFlowCommitted && answerHandoffInviteIdRef.current) {
          answerHandoffInviteIdRef.current = null;
          setAnswerHandoffTick((n) => n + 1);
        }
      }
    },
    [
      token,
      sip,
      safeSetInvite,
      emitAnswerFlowEvent,
      setIncomingUiPhase,
      showEndedState,
      waitForPbxAnswer,
    ],
  );

  useEffect(() => {
    if (sip.callState !== "connected") return;
    if (!answerHandoffInviteIdRef.current) return;
    answerHandoffInviteIdRef.current = null;
    setAnswerHandoffTick((n) => n + 1);
  }, [sip.callState]);

  const resolveInviteForAction = useCallback(
    async (callId: string, fallbackInvite?: CallInvite | null) => {
      let invite =
        incomingInvite && (!callId || incomingInvite.id === callId)
          ? incomingInvite
          : null;

      if (!invite && fallbackInvite) {
        invite = fallbackInvite;
        safeSetInvite(fallbackInvite);
      }

      if (!invite && token) {
        const pending = await getPendingInvites(token).catch(() => []);
        const matched =
          pending.find((item) => !callId || item.id === callId) ||
          pending[0] ||
          null;
        if (matched) {
          invite = matched as CallInvite;
          safeSetInvite(invite);
        }
      }

      if (!invite) {
        const cached = await readCachedInvite(callId || undefined);
        if (cached) {
          invite = cached;
          safeSetInvite(invite);
        }
      }

      if (invite) {
        emitAnswerFlowEvent("INVITE_RESTORED", invite, {
          source:
            incomingInvite && (!callId || incomingInvite.id === callId)
              ? "memory"
              : fallbackInvite?.id === invite.id
              ? "fallback"
              : "cache_or_api",
        });
      } else {
        emitAnswerFlowEvent("INVITE_RESTORE_FAILED", fallbackInvite || null, {
          requestedInviteId: callId || null,
        });
      }

      return invite;
    },
    [emitAnswerFlowEvent, incomingInvite, safeSetInvite, token],
  );

  const handleDeclineInvite = useCallback(
    async (invite: CallInvite | null, callId: string) => {
      const declineKey = `decline:${callId || invite?.id || ""}`;
      if (
        declineKey !== "decline:" &&
        (inviteActionInFlightRef.current.has(declineKey) ||
          consumedInviteActionRef.current.has(declineKey))
      ) {
        return;
      }
      if (declineKey !== "decline:") {
        inviteActionInFlightRef.current.add(declineKey);
      }

      try {
        dismissNativeIncomingUi(callId || invite?.id);

        if (!token) {
          endNativeCall(callId);
          return;
        }

        const activeInvite =
          invite ||
          (incomingInvite && (!callId || incomingInvite.id === callId)
            ? incomingInvite
            : null) ||
          (await readCachedInvite(callId || undefined));

        if (!activeInvite) {
          const fallbackInviteId = callId || (await readCachedInvite())?.id;
          if (fallbackInviteId) {
            await respondInvite(
              token,
              fallbackInviteId,
              "DECLINE",
              deviceIdRef.current || undefined,
            ).catch(() => undefined);
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
            payload: { action: "DECLINE", inviteId: activeInvite.id },
          }).catch(() => undefined);
        }
        emitAnswerFlowEvent("RINGTONE_STOPPED", activeInvite, {
          reason: "decline_tapped",
          at: new Date().toISOString(),
        });
        emitAnswerFlowEvent("INCOMING_UI_DISMISSED", activeInvite, {
          source: "decline",
          reason: "decline_tapped",
        });

        await respondInvite(
          token,
          activeInvite.id,
          "DECLINE",
          deviceIdRef.current || undefined,
        ).catch(() => undefined);
        await sip.rejectIncomingInvite({
          fromNumber: activeInvite.fromNumber,
          toExtension: activeInvite.toExtension,
          pbxCallId: activeInvite.pbxCallId,
          sipCallTarget: activeInvite.sipCallTarget,
        }).catch(() => false);

        AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
        safeSetInvite(null);
        endNativeCall(callId || activeInvite.id);
        if (declineKey !== "decline:") {
          consumedInviteActionRef.current.add(declineKey);
        }
      } finally {
        if (declineKey !== "decline:") {
          inviteActionInFlightRef.current.delete(declineKey);
        }
      }
    },
    [incomingInvite, safeSetInvite, sip, token],
  );

  // ── CallKeep native action subscriptions ─────────────────────────────────

  useEffect(() => {
    setupNativeCalling().then(async () => {
      // Drain any events that fired before React mounted (cold-start answer)
      const initialEvents = await consumeInitialCallKeepEvents();

      for (const evt of initialEvents) {
        if (evt.type === "answer") {
          const invite = await resolveInviteForAction(evt.callUUID);
          if (invite) {
            safeSetInvite(invite);
            await handleAcceptInvite(invite, evt.callUUID);
          } else {
            endNativeCall(evt.callUUID);
          }
        } else if (evt.type === "end") {
          await handleDeclineInvite(null, evt.callUUID);
        }
      }
    }).catch(() => undefined);

    const unsubNative = subscribeNativeCallActions({
      onAnswer: async (callId) => {
        let invite = await resolveInviteForAction(callId);

        if (!invite && token) {
          await new Promise<void>((r) => setTimeout(r, 400));
          invite = await resolveInviteForAction(callId);
        }

        if (!invite) {
          endNativeCall(callId);
          return;
        }

        emitAnswerFlowEvent("CALLKEEP_ANSWER_TAPPED", invite, { source: "native_callkeep" });
        await handleAcceptInvite(invite, callId, {
          deferForegroundUntilConnected: true,
        });
      },

      onEnd: async (callId) => {
        const invite = await resolveInviteForAction(callId);
        await handleDeclineInvite(invite, callId);
      },
    });

    return () => { unsubNative(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, emitAnswerFlowEvent, handleAcceptInvite, handleDeclineInvite, resolveInviteForAction, safeSetInvite]);

  // ── Native notification deep-link actions ──────────────────────────────────

  useEffect(() => {
    const queueIncomingActionUrl = (url: string | null) => {
      const action = parseIncomingCallActionUrl(url);
      if (!action) return;
      const actionKey = `${action.action}:${action.inviteId}`;
      console.log("[Notif] Incoming action URL queued:", action.action, action.inviteId);
      if (handledIncomingActionKeysRef.current.has(actionKey)) {
        console.log("[Notif] Incoming action already handled:", action.action, action.inviteId);
        return;
      }
      handledIncomingActionKeysRef.current.add(actionKey);
      setPendingIncomingAction(action);
    };

    Linking.getInitialURL()
      .then((url) => {
        queueIncomingActionUrl(url);
      })
      .catch(() => undefined);

    const sub = Linking.addEventListener("url", ({ url }) => {
      queueIncomingActionUrl(url);
    });

    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!pendingIncomingAction) return;
    if (pendingIncomingAction.action !== "open" && !token) {
      console.log("[Notif] Waiting for auth before processing action:", pendingIncomingAction.action, pendingIncomingAction.inviteId);
      return;
    }

    const actionKey = `${pendingIncomingAction.action}:${pendingIncomingAction.inviteId}`;
    if (processingIncomingActionRef.current === actionKey) return;
    processingIncomingActionRef.current = actionKey;

    const currentAction = pendingIncomingAction;
    setPendingIncomingAction(null);

    let cancelled = false;

    (async () => {
      const { action, inviteId, invite: fallbackInvite } = currentAction;
      console.log("[Notif] Processing incoming action:", action, inviteId);

      if (fallbackInvite) {
        safeSetInvite(fallbackInvite);
      }

      if (action === "open") {
        await resolveInviteForAction(inviteId, fallbackInvite).catch(() => fallbackInvite);
        if (!cancelled) processingIncomingActionRef.current = null;
        return;
      }

      const invite = await resolveInviteForAction(inviteId, fallbackInvite);

      if (action === "answer") {
        if (invite) {
          emitAnswerFlowEvent("CALLKEEP_ANSWER_TAPPED", invite, { source: "deep_link" });
          emitAnswerFlowEvent("APP_FOREGROUNDED_FROM_CALL", invite, { source: "deep_link" });
          await handleAcceptInvite(invite, inviteId, {
            skipBringToForeground: true,
          });
        } else {
          endNativeCall(inviteId);
        }
      } else {
        await handleDeclineInvite(invite, inviteId);
      }

      if (!cancelled) processingIncomingActionRef.current = null;
    })().catch(() => {
      if (!cancelled) processingIncomingActionRef.current = null;
    });

    return () => {
      cancelled = true;
    };
  }, [
    handleAcceptInvite,
    handleDeclineInvite,
    pendingIncomingAction,
    resolveInviteForAction,
    safeSetInvite,
    token,
  ]);

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
      console.log("[PUSH_INIT] Notification permission status:", permStatus);

      if (permStatus !== "granted") {
        // Request immediately — do not defer. Users need this for call alerts.
        const req = await Notifications.requestPermissionsAsync().catch(() => null);
        const granted = req?.status === "granted";
        console.log("[PUSH_INIT] Permission request result:", req?.status);
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
      // getExpoToken() never throws — it returns { token, error }.
      const { token: pushToken, error: pushErr } = await getExpoToken();
      currentToken = pushToken;
      console.log("[PUSH_INIT] Push token result:", pushToken ? "OK" : `FAILED (${pushErr})`);
      if (!mounted) return;
      setExpoPushToken(currentToken);

      if (currentToken) {
        console.log("[PUSH_INIT] Registering device with backend...");
        const reg = await registerMobileDevice(token, {
          platform: Platform.OS === "ios" ? "IOS" : "ANDROID",
          expoPushToken: currentToken,
          deviceName: Device.modelName || `${Platform.OS}-device`,
        }).catch((e) => {
          console.warn("[PUSH_INIT] registerMobileDevice failed:", e instanceof Error ? e.message : String(e));
          return null;
        });
        if (reg?.id) {
          deviceIdRef.current = String(reg.id);
          console.log("[PUSH_INIT] Device registered, id:", reg.id);
        } else {
          console.warn("[PUSH_INIT] registerMobileDevice returned no id — response:", JSON.stringify(reg));
        }

        if (mounted) {
          setCallReadiness((prev) => ({
            ...prev,
            pushTokenRegistered: true,
            pushTokenError: null,
            isFullyReady: prev.notificationPermission === "granted",
          }));
        }
      } else {
        console.warn("[PUSH_INIT] No push token — device will NOT receive push notifications. Reason:", pushErr);
        if (mounted) {
          setCallReadiness((prev) => ({
            ...prev,
            pushTokenRegistered: false,
            pushTokenError: pushErr,
            isFullyReady: false,
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
          const inviteMeta = evt?.inviteId
            ? {
                id: String(evt.inviteId),
                pbxCallId: evt?.pbxCallId ? String(evt.pbxCallId) : null,
                toExtension: evt?.toExtension ? String(evt.toExtension) : "",
              }
            : null;
          if (evt?.type === "CALLKEEP_UI_SHOWN") {
            emitAnswerFlowEvent("CALLKEEP_UI_SHOWN", inviteMeta, {
              source: evt?.source || "background_task",
              bgWakeAt: evt.at,
            });
          } else {
            emitAnswerFlowEvent("INCOMING_PUSH_RECEIVED", inviteMeta, {
              source: "background_task_wake",
              bgWakeAt: evt.at,
            });
          }
          // Stash timing for latency computation
          if (evt.inviteId) {
            timingsRef.current[`push_${evt.inviteId}`] = evt.at;
          }
        }
        AsyncStorage.removeItem(BG_WAKE_EVENTS_KEY).catch(() => {});
      }

      runMediaTest().catch(() => undefined);

      // ── Check native call cache (written by IncomingCallFirebaseService.java) ─
      // This file is written by the Java FCM handler before JS starts. It is the
      // primary source for invite details when the app was closed and a call came
      // in — the background task may not have had time to run yet.
      let nativeCacheClaimed = false;
      if (Platform.OS === "android") {
        try {
          const nativeCacheUri = FileSystem.cacheDirectory + NATIVE_CALL_CACHE_FILE;
          const nativeCacheInfo = await FileSystem.getInfoAsync(nativeCacheUri);
          if (nativeCacheInfo.exists) {
            const nativeCacheRaw = await FileSystem.readAsStringAsync(nativeCacheUri);
            const nativeCached = safeParse(nativeCacheRaw);
            const nativeAge = nativeCached?._storedAt ? Date.now() - nativeCached._storedAt : Infinity;
            if (nativeCached?._nativeCallAdded === true && nativeAge < 120_000) {
              console.log("[Notif] native call cache found age=", nativeAge, "inviteId=", nativeCached.inviteId);
              const invite = payloadToInvite(nativeCached);
              if (invite.id && mounted) {
                safeSetInvite(invite);
                // Android now wakes directly into the branded Connect screen
                // instead of CallKeep's telecom UI.
                if (Platform.OS !== "android") {
                  showIncomingNativeCall(invite.id, invite.fromDisplay || invite.fromNumber);
                }
                nativeCacheClaimed = true;
                if (diagSessionIdRef.current) {
                  postVoiceDiagEvent(token, {
                    sessionId: diagSessionIdRef.current,
                    type: "INCOMING_INVITE",
                    payload: {
                      inviteId: invite.id,
                      source: "native_cache",
                      nativeAge,
                    },
                  }).catch(() => undefined);
                }
              }
            }
            // Always delete the file so stale data doesn't linger.
            FileSystem.deleteAsync(nativeCacheUri, { idempotent: true }).catch(() => {});
          }
        } catch (nativeCacheErr) {
          console.warn("[Notif] native cache read failed:", nativeCacheErr);
        }
      }

      // ── Check AsyncStorage invite cache (written by background task) ──────
      const cachedRaw = await AsyncStorage.getItem(PENDING_CALL_STORAGE_KEY).catch(() => null);
      if (cachedRaw && mounted) {
        const cached = safeParse(cachedRaw);
        const age = cached?._storedAt ? Date.now() - cached._storedAt : Infinity;

        if (cached?.type === "INCOMING_CALL" && age < 45_000) {
          if (!nativeCacheClaimed) {
            const invite = payloadToInvite(cached);
            safeSetInvite(invite);
            if (Platform.OS !== "android") {
              showIncomingNativeCall(invite.id, invite.fromDisplay || invite.fromNumber);
            }
          }

          if (diagSessionIdRef.current) {
            postVoiceDiagEvent(token, {
              sessionId: diagSessionIdRef.current,
              type: "INCOMING_INVITE",
              payload: {
                inviteId: payloadToInvite(cached).id,
                source: nativeCacheClaimed ? "async_storage_after_native" : "cold_start_cache",
                pushReceivedAt: cached._pushReceivedAt,
                cacheAgeMs: age,
              },
            }).catch(() => undefined);
          }
        } else if (age >= 45_000) {
          console.log("[Notif] Stale cached invite removed, age:", age);
          AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
        }
      }

      // ── Authoritative pending invite check from server ────────────────────
      const pending = await getPendingInvites(token).catch(() => []);
      if (pending.length > 0 && mounted) {
        const invite = pending[0] as CallInvite;
        safeSetInvite(invite);
        if (Platform.OS !== "android") {
          showIncomingNativeCall(invite.id, invite.fromDisplay || invite.fromNumber);
        }

        if (diagSessionIdRef.current) {
          postVoiceDiagEvent(token, {
            sessionId: diagSessionIdRef.current,
            type: "INCOMING_INVITE",
            payload: { inviteId: invite.id, source: "pending_api" },
          }).catch(() => undefined);
        }
      }
    })().catch((e) => {
      // Catch-all so a single failure in the init pipeline doesn't leave the
      // entire notification system in a broken state silently.
      console.error("[PUSH_INIT] Unhandled error in notification init:", e instanceof Error ? e.message : String(e));
    });

    // ── Foreground push listener ──────────────────────────────────────────

    const pushSub = Notifications.addNotificationReceivedListener((evt) => {
      const data = evt.request.content.data as MobilePushPayload;
      const now = Date.now();

      if (data?.type === "INCOMING_CALL") {
        console.log("[CALL_INCOMING] foreground push listener: INCOMING_CALL inviteId=", (data as any).inviteId || (data as any).callId);
        const invite = payloadToInvite({ ...data, _pushReceivedAt: now } as any);
        timingsRef.current[`push_${invite.id}`] = now;
        emitAnswerFlowEvent("INCOMING_PUSH_RECEIVED", invite, {
          source: "foreground_listener",
          pushReceivedAt: now,
        });

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
        if (Platform.OS !== "android") {
          showIncomingNativeCall(invite.id, invite.fromDisplay || invite.fromNumber);
        }

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
            showEndedState(prev, "Call ended", { reason: "remote_hangup" });
            return prev;
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
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, emitAnswerFlowEvent]);

  // ── Re-check permissions + push token when app comes back to foreground ───

  useEffect(() => {
    const sub = AppState.addEventListener("change", async (state) => {
      if (state !== "active") return;
      const perm = await Notifications.getPermissionsAsync().catch(() => null);
      if (!perm) return;
      const granted = perm.status === "granted";

      setCallReadiness((prev) => {
        const wasNotGranted = prev.notificationPermission !== "granted";
        const nowGranted = granted;
        const tokenMissing = !prev.pushTokenRegistered;

        // If permission was just newly granted AND push token is missing,
        // trigger token registration automatically (e.g. after user came back
        // from enabling notifications in Android settings).
        if (wasNotGranted && nowGranted && tokenMissing && token) {
          // Fire-and-forget — errors are logged inside retryPushTokenRegistration
          retryPushTokenRegistration().catch(() => undefined);
        }

        return {
          ...prev,
          notificationPermission: perm.status as CallReadiness["notificationPermission"],
          isFullyReady: granted && prev.pushTokenRegistered,
        };
      });
    });
    return () => sub.remove();
  // retryPushTokenRegistration is stable (useCallback with [token] dep)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, retryPushTokenRegistration]);

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
      incomingCallUiState,
      answerHandoffInviteIdRef,
      answerHandoffTick,
      clearIncomingInvite: () => safeSetInvite(null),
      answerIncomingCall: (invite: CallInvite) =>
        handleAcceptInvite(invite, invite.id, { skipBringToForeground: false }),
      declineIncomingCall: (invite: CallInvite | null) =>
        handleDeclineInvite(invite, invite?.id || ""),
      runMediaTest,
      callReadiness,
      openBatteryOptimizationSettings,
      requestNotificationPermission,
      retryPushTokenRegistration,
    }),
    [
      expoPushToken,
      incomingInvite,
      incomingCallUiState,
      answerHandoffTick,
      runMediaTest,
      callReadiness,
      safeSetInvite,
      handleAcceptInvite,
      handleDeclineInvite,
      requestNotificationPermission,
      retryPushTokenRegistration,
    ],
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
