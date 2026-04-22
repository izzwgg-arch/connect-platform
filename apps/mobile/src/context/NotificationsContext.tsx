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
import { Alert, AppState, Linking, NativeEventEmitter, NativeModules, Platform } from "react-native";
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
import { useCallSessions } from "./CallSessionManager";
import {
  bringAppToForeground,
  consumeInitialCallKeepEvents,
  dismissNativeIncomingUi,
  endNativeCall,
  moveAppToBackground,
  setupNativeCalling,
  showIncomingNativeCall,
  subscribeNativeCallActions,
} from "../sip/callkeep";
// NOTE: stopAllTelephonyAudio is imported statically here rather than via
// `void import("../audio/telephonyAudio").then(...)`. The dynamic-import
// pattern was throwing `Object is not a function` inside teardown paths
// (seen in the `killAll telephonyAudio import threw` log), which short-
// circuited every subsequent teardown step — most notably the
// moveAppToBackground call that returns the user to the lock screen on
// remote cancel. Static import guarantees the function exists before we
// call it and keeps teardown fully synchronous.
import { stopAllTelephonyAudio } from "../audio/telephonyAudio";
import * as FileSystem from "expo-file-system";
import type { CallInvite, MobilePushPayload } from "../types";
import {
  PENDING_CALL_STORAGE_KEY,
  BG_WAKE_EVENTS_KEY,
  NATIVE_CALL_CACHE_FILE,
} from "../notifications/backgroundCallTask";
import {
  logCallFlow,
  logCallFlowFromAnswerFlow,
  setCallFlowLastError,
  setCallFlowInviteId,
} from "../debug/callFlowDebug";
import {
  markCallLatency,
  summarizeCallLatency,
  resetCallLatency,
  setCallLatencyContext,
} from "../debug/callLatency";
import {
  configureFlightRecorder,
  flightBeginCall,
  flightDrainQueue,
  flightEndCall,
  flightRecord,
} from "../diagnostics/CallFlightRecorder";
/**
 * Reads native ringtone timing data from the Android bridge and records
 * RINGTONE_START / RINGTONE_STOP events in the flight recorder.
 * Safe to call multiple times — only records if startedAtMs > 0.
 */
function flightRecordNativeRingtone(inviteId?: string | null) {
  if (Platform.OS !== "android") return;
  try {
    const t = NativeModules.IncomingCallUi?.getRingtoneTimings?.() as
      | { startedAtMs: number; stoppedAtMs: number; source: string; stopReason: string }
      | undefined;
    if (!t || !t.startedAtMs) return;
    flightRecord("AUDIO", "RINGTONE_START", {
      ts: t.startedAtMs,
      inviteId: inviteId ?? undefined,
      payload: { source: t.source, native: true },
    });
    if (t.stoppedAtMs > 0) {
      flightRecord("AUDIO", "RINGTONE_STOP", {
        ts: t.stoppedAtMs,
        inviteId: inviteId ?? undefined,
        payload: {
          durationMs: t.stoppedAtMs - t.startedAtMs,
          reason: t.stopReason,
          native: true,
        },
      });
    }
    NativeModules.IncomingCallUi?.resetRingtoneTimings?.();
  } catch {
    // ignore — bridge not available in tests / iOS
  }
}

// ─── Notification handler ─────────────────────────────────────────────────────
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification.request.content.data as any;
    const type = typeof data?.type === "string" ? data.type : "";
    // Call-related FCMs are handled entirely by our native service +
    // in-app IncomingCallScreen. Never show an Expo system banner for them.
    const CALL_TYPES = new Set([
      "INCOMING_CALL",
      "INVITE_CLAIMED",
      "INVITE_CANCELED",
      "MISSED_CALL",
    ]);
    if (CALL_TYPES.has(type)) {
      return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: false };
    }
    // When IncomingCallFirebaseService consumes the FCM payload before expo-
    // notifications sees it, the JS notification arrives with empty data.type.
    // Detect this by looking for telltale call-invite keys on the raw payload
    // and suppress the empty "Connect" banner that otherwise renders on top
    // of the IncomingCallScreen when the app is foreground.
    const hasCallShapedKeys =
      !!(data?.inviteId || data?.callId || data?.pbxCallId || data?.sipCallTarget);
    if (!type && hasCallShapedKeys) {
      return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: false };
    }
    // Also suppress entirely empty / unknown notifications — our app never
    // intentionally sends a display-only push, so an empty banner is always
    // a side effect of the native call path above.
    const hasRenderableContent =
      !!(notification.request.content.title || notification.request.content.body);
    if (!type && !hasRenderableContent) {
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
  /** True when the most recent call was answered while the app was backgrounded (e.g. lock screen). */
  answeredFromBackgroundRef: React.MutableRefObject<boolean>;
  /**
   * True when the most recent inbound call interaction (answer OR incoming
   * presentation) originated from the OS lock screen. This is the
   * authoritative "should we return to the keyguard after the call ends?"
   * signal — distinct from `answeredFromBackgroundRef`, which also fires for
   * answers from a backgrounded-but-unlocked app. We use the answer-time
   * `deviceLockedAtAnswer` / `launchedFromIncomingCall` flags rather than a
   * live `isDeviceLocked()` check at hangup because Samsung One UI flips
   * KeyguardManager to "unlocked" the moment MainActivity surfaces over the
   * keyguard via `showWhenLocked=true`, even though the device is still
   * actually locked.
   */
  answeredFromLockScreenRef: React.MutableRefObject<boolean>;
  /** The invite that is currently being answered — use as fallback caller info before SIP remoteParty is set. */
  answerInviteRef: React.MutableRefObject<CallInvite | null>;
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
  // Anchor createdAt / expiresAt to when the push was first received (or
  // the cached row was stored), NOT to "now". Before this fix, recovery
  // paths (AsyncStorage cache, native cache file, foreground re-injection)
  // minted fresh timestamps every call, which tricked the downstream
  // freshness guard into accepting zombie invites from prior test runs.
  const anchorMs =
    (typeof data._pushReceivedAt === "number" && data._pushReceivedAt > 0
      ? data._pushReceivedAt
      : undefined) ??
    (typeof data._storedAt === "number" && data._storedAt > 0
      ? data._storedAt
      : undefined) ??
    Date.now();
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
    createdAt: new Date(anchorMs).toISOString(),
    expiresAt: new Date(anchorMs + 45_000).toISOString(),
    _pushReceivedAt: anchorMs,
  } as CallInvite & { _pushReceivedAt: number };
}

/** Returns true if the invite is already past its expiry. */
function isExpired(invite: CallInvite): boolean {
  if (!invite.expiresAt) return false;
  return Date.now() > new Date(invite.expiresAt).getTime();
}

/**
 * Invite-freshness filter. Guards against the backend returning old
 * PENDING invites (from prior tests that never hit a terminal state)
 * on pending-list / hydrate polls. An invite is considered live iff:
 *   - its expiresAt is in the future (or missing), AND
 *   - its createdAt is within INVITE_FRESHNESS_MS (default 60 s, a bit
 *     beyond the backend's 45 s ring TTL).
 * Anything else is a zombie that would otherwise permanently ghost the
 * multi-call drawer as a fake "INCOMING" row.
 */
const INVITE_FRESHNESS_MS = 60_000;
function filterFreshInvites(invites: CallInvite[]): CallInvite[] {
  const now = Date.now();
  return (invites ?? []).filter((inv) => {
    if (!inv) return false;
    const expiresMs = inv.expiresAt ? Date.parse(String(inv.expiresAt)) : NaN;
    if (Number.isFinite(expiresMs) && expiresMs <= now) return false;
    const createdMs = inv.createdAt ? Date.parse(String(inv.createdAt)) : NaN;
    if (Number.isFinite(createdMs) && now - createdMs > INVITE_FRESHNESS_MS) {
      return false;
    }
    return true;
  });
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
  const callSessions = useCallSessions();
  // Mirror the latest token into a ref so async wait loops (e.g. the cold-start
  // answer path) can observe fresh token values instead of stale closure values.
  const tokenRef = useRef<string | null>(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  // Mirror the current "is there an active call?" into a ref so safeSetInvite
  // can make the call-waiting vs idle-incoming decision synchronously without
  // re-rendering every time the multi-call state updates.
  const activeCallIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeCallIdRef.current = callSessions.activeCall?.id ?? null;
  }, [callSessions.activeCall?.id]);

  // Also mirror the broader "any ongoing call" flag — this is what gates
  // the full-screen IncomingCallScreen for SECONDARY invites. Covers the
  // answer→connecting transition window where activeCallId is briefly null
  // but the user is definitely mid-call.
  const hasOngoingCallRef = useRef<boolean>(false);
  useEffect(() => {
    hasOngoingCallRef.current = callSessions.hasAnyOngoingCall;
  }, [callSessions.hasAnyOngoingCall]);

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
  // The invite id that the currently-scheduled reset timer belongs to.
  // Used so repeat calls to `scheduleIncomingUiReset(sameId, ...)` become
  // no-ops instead of clobbering the pending timer. Without this guard a
  // teardown path that fires multiple times for the same invite (e.g.
  // the status poll seeing a CANCELED on every tick) keeps resetting the
  // delay and the incoming UI never actually clears.
  const pendingResetInviteIdRef = useRef<string | null>(null);
  // Timing anchors — filled from different sources, used to build latency chain
  const timingsRef = useRef<Record<string, number>>({});
  const answerHandoffInviteIdRef = useRef<string | null>(null);
  const [answerHandoffTick, setAnswerHandoffTick] = useState(0);
  // True when the current/most-recent call was answered while the app was in the
  // background (e.g. from the lock screen). Used to move back to the lock screen
  // after hangup instead of leaving the Quick page visible on top.
  const answeredFromBackgroundRef = useRef(false);
  const answeredFromLockScreenRef = useRef(false);
  // The invite that is currently being answered. Cleared when the call ends.
  // Used by ActiveCallScreen to show caller info before SIP remoteParty is set.
  const answerInviteRef = useRef<CallInvite | null>(null);
  // Once an invite enters the answer path, never show it again as an "incoming"
  // call. This prevents stale AsyncStorage/native-cache recovery from remounting
  // the incoming screen after the call has already connected.
  const suppressedIncomingInviteIdsRef = useRef<Set<string>>(new Set());

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
      logCallFlowFromAnswerFlow(type, invite, extra);
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
    pendingResetInviteIdRef.current = null;
  }, []);

  const scheduleIncomingUiReset = useCallback(
    (inviteId: string | null, delayMs = 1200) => {
      // Idempotent for repeat calls with the same id: if a reset is
      // already scheduled for this invite, leave it alone. Previous
      // behaviour was to clear the prior timer and reschedule on every
      // call, which caused a loop where a repeating teardown source
      // (status poll re-firing on every tick, FCM duplicate delivery,
      // etc.) kept pushing the reset out indefinitely and the incoming
      // UI never cleared. If the caller is targeting a DIFFERENT invite
      // we still clear and reschedule — that's a genuine context switch.
      if (
        transientUiTimerRef.current !== null &&
        inviteId &&
        pendingResetInviteIdRef.current === inviteId
      ) {
        return;
      }
      clearTransientUiTimer();
      pendingResetInviteIdRef.current = inviteId;
      transientUiTimerRef.current = setTimeout(() => {
        setIncomingInvite((prev) => {
          if (inviteId && prev?.id && prev.id !== inviteId) return prev;
          shownInviteIdRef.current = null;
          handledIncomingActionKeysRef.current.clear();
          setIncomingCallUiState({ phase: "idle", inviteId: null, error: null });
          return null;
        });
        transientUiTimerRef.current = null;
        pendingResetInviteIdRef.current = null;
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
        // Also drop it from the multi-call ringing stack — the push-layer
        // registerInboundInvite() added it there, and if the SIP session
        // never materialised we need to clean it up here too.
        const prevShownId = shownInviteIdRef.current;
        if (prevShownId) {
          try {
            callSessions.removeInboundInvite(prevShownId, "safe_set_invite_null");
          } catch { /* ignore */ }
        }
        shownInviteIdRef.current = null;
        handledIncomingActionKeysRef.current.clear();
        setIncomingInvite(null);
        setIncomingCallUiState({ phase: "idle", inviteId: null, error: null });
        return;
      }
      if (suppressedIncomingInviteIdsRef.current.has(invite.id)) {
        console.log("[Notif] Ignoring suppressed invite:", invite.id);
        return;
      }
      // Duplicate guard: don't replace an invite with itself
      if (shownInviteIdRef.current === invite.id) {
        console.log("[Notif] Duplicate invite ignored:", invite.id);
        return;
      }
      // Freshness guard — drop invites that are clearly stale before they
      // can ghost the multi-call drawer. The backend (or a stuck
      // getPendingInvites poll on app resume) sometimes hands us an
      // invite that has been sitting in PENDING for minutes/hours because
      // the phone never got a SIP INVITE for it. Registering those
      // invites produces a permanent "INCOMING" row in the drawer that
      // the user sees on every subsequent call.
      //
      // A live inbound ring has:
      //   - expiresAt in the future (or no expiresAt)
      //   - createdAt within the last ~45 s (matches server TTL)
      // Anything outside that window is treated as a zombie and
      // suppressed locally. We also poison the id so a push listener
      // racing with us can't re-open it immediately.
      try {
        const nowMs = Date.now();
        const expiresAtRaw = (invite as any).expiresAt;
        const createdAtRaw = (invite as any).createdAt;
        const expiresAtMs = expiresAtRaw ? Date.parse(String(expiresAtRaw)) : NaN;
        const createdAtMs = createdAtRaw ? Date.parse(String(createdAtRaw)) : NaN;
        const isExpired = Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
        const ageMs = Number.isFinite(createdAtMs) ? nowMs - createdAtMs : 0;
        const TOO_OLD_MS = 60_000; // a little beyond the 45 s invite TTL
        if (isExpired || ageMs > TOO_OLD_MS) {
          console.log(
            '[Notif] Ignoring stale invite id=' + invite.id +
            ' ageMs=' + ageMs +
            ' expired=' + isExpired,
          );
          suppressedIncomingInviteIdsRef.current.add(invite.id);
          // Scrub anything the push / multi-call layer may already have
          // stashed for this id so the drawer doesn't keep it around.
          try {
            callSessions.removeInboundInvite(invite.id, 'stale_on_register');
          } catch { /* ignore */ }
          return;
        }
      } catch {
        // If we can't parse the timestamps, fall through and let the
        // normal flow handle it — we'd rather accept a suspicious invite
        // than drop a real call.
      }
      shownInviteIdRef.current = invite.id;
      console.log('[LOCK_CALL] incoming_received inviteId=' + invite.id + ' from=' + (invite.fromNumber || 'unknown'));

      // ══════════════════════════════════════════════════════════════════
      // EAGER SIP PRE-REGISTER (Optim #3 — measured impact ≈ 1.6 s)
      //
      // The measurement campaign proved that on a cold-cache answer the
      // JS thread spends ~571 ms doing a SIP REGISTER round-trip AND
      // ~1105 ms busy-waiting for the PBX to deliver the INVITE to the
      // freshly-registered socket. Both of those happen AFTER the user
      // taps Answer on today's code path.
      //
      // Kicking `sip.register()` off here — synchronously, in the same
      // JS turn as the push delivery — means by the time the user taps
      // Answer (typically hundreds of ms to seconds later while the phone
      // rings) the REGISTER is already complete AND the PBX has already
      // forwarded the SIP INVITE to our socket. `findIncoming()` then
      // returns on its first poll iteration and `session.answer()`
      // completes in ~10 ms.
      //
      // Safety:
      //   • sip.register() is idempotent when already registered /
      //     registering — the internal state machine skips.
      //   • Fire-and-forget: never blocks the UI thread.
      //   • Skipped if we already have an active call — in that case
      //     the UA is registered and the INVITE for the waiting call
      //     is delivered over the existing socket with no REGISTER round
      //     trip needed.
      //   • The existing post-render `useEffect` prewarm below stays in
      //     place as a belt-and-suspenders fallback (it's a no-op if
      //     this call already flipped state to "registering").
      // ══════════════════════════════════════════════════════════════════
      try {
        const hasActiveUaSession = hasOngoingCallRef.current || activeCallIdRef.current !== null;
        if (!hasActiveUaSession) {
          const regState = sip.registrationState;
          if (regState !== "registered" && regState !== "registering") {
            console.log(
              '[ANSWER_PIPELINE] eager_preregister inviteId=' + invite.id +
              ' regState=' + regState,
            );
            sip.register().catch((e) => {
              console.warn(
                "[ANSWER_PIPELINE] eager_preregister failed:",
                e instanceof Error ? e.message : String(e),
              );
            });
          } else {
            console.log(
              '[ANSWER_PIPELINE] eager_preregister_skipped_already_registered inviteId=' + invite.id +
              ' regState=' + regState,
            );
          }
        }
      } catch (e) {
        // Never let instrumentation / pre-register crash the notification path.
        console.warn("[ANSWER_PIPELINE] eager_preregister threw:", e);
      }

      // Register with the multi-call manager regardless of whether this is the
      // idle (full-screen) path or the call-waiting (banner) path. This gives
      // ActiveCallScreen a CallSession it can render for the waiting UI.
      try {
        callSessions.registerInboundInvite({
          callId: invite.id,
          remoteNumber: invite.fromNumber || "Unknown",
          remoteName: (invite as any).fromDisplay ?? null,
          pbxCallId: (invite as any).pbxCallId ?? null,
        });
      } catch (err) {
        console.warn("[MULTICALL] registerInboundInvite threw:", err);
      }

      // Call-waiting path — another call is already live (active, held,
      // still connecting, or dialing). Do NOT push the full-screen
      // IncomingCallScreen; the CallsDrawer on the ActiveCallScreen will
      // render the waiting call + per-call actions (answer / decline /
      // transfer / hold / hangup). We check hasOngoingCallRef (which spans
      // active + held + connecting + dialing_outbound + ringing with SIP
      // session) rather than just activeCallIdRef so the guard still
      // catches the brief window between tapping Answer on call-1 and
      // SIP completing the 200 OK → `active` transition.
      const hasActiveCall = activeCallIdRef.current !== null;
      const hasOngoing = hasOngoingCallRef.current;
      if (hasActiveCall || hasOngoing) {
        console.log(
          "[MULTICALL] call_waiting_inbound — suppressing full-screen IncomingCall, drawer will render",
          JSON.stringify({
            newInviteId: invite.id,
            active: activeCallIdRef.current,
            hasOngoing,
          }),
        );
        return;
      }

      setIncomingInvite(invite);
      setIncomingCallUiState((prev) =>
        prev.inviteId === invite.id && prev.phase === "connecting"
          ? prev
          : { phase: "incoming", inviteId: invite.id, error: null },
      );

      // Flight recorder: begin a call session (or continue the background one for the same invite).
      // flightBeginCall is now synchronous for session creation so subsequent flightRecord()
      // calls are guaranteed to land in the correct session.
      void flightBeginCall({
        inviteId: invite.id,
        pbxCallId: invite.pbxCallId ?? null,
        fromNumber: invite.fromNumber,
        extension: invite.toExtension,
      });

      // Latency pipeline — open the timeline as soon as the JS layer
      // acknowledges a fresh invite. Anchor it to the original native
      // push-receipt timestamp when available so we can measure the
      // true "push → UI" gap, not just "JS-observed-invite → UI".
      const pushReceivedAt =
        (invite as any)._pushReceivedAt ??
        (invite as any)._storedAt ??
        null;
      markCallLatency(invite.id, "INCOMING_RECEIVED", {
        appState: AppState.currentState,
        fromNumber: invite.fromNumber,
        pbxCallId: invite.pbxCallId ?? null,
        pushToReceivedMs:
          typeof pushReceivedAt === "number"
            ? Math.max(0, Date.now() - pushReceivedAt)
            : null,
      });
      // Only record PUSH_RECEIVED_FG if the session doesn't already have a BG push event
      // (i.e. app was foregrounded — background task would have recorded PUSH_RECEIVED_BG).
      flightRecord('PUSH', 'PUSH_RECEIVED_FG', {
        inviteId: invite.id,
        pbxCallId: invite.pbxCallId ?? null,
        payload: { source: 'safeSetInvite', fromNumber: invite.fromNumber },
      });
      flightRecord('UI', 'INCOMING_SCREEN_SHOWN', {
        inviteId: invite.id,
        pbxCallId: invite.pbxCallId ?? null,
        payload: { fromNumber: invite.fromNumber },
      });

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
    [clearExpireTimer, clearTransientUiTimer, callSessions],
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

  useEffect(() => {
    setCallFlowInviteId(incomingInvite?.id ?? null);
  }, [incomingInvite?.id]);

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
      // Cold-start lock-screen race: user can tap Answer in the in-app UI
      // before the auth token has finished loading from SecureStore. Previously
      // we just returned silently, which manifested as "first tap does nothing,
      // second tap works" — the user perceives this as "cannot answer". Instead,
      // wait briefly (up to 4s) for the token to arrive and continue so the tap
      // is never lost on cold start.
      //
      // This useCallback closed over `token` at render time. We shadow the
      // outer closure value by declaring a local `token` below so every
      // downstream API call observes the freshly resolved value rather than
      // the potentially stale null closure.
      let resolved: string | null = token ?? tokenRef.current;
      if (!resolved) {
        console.warn('[ACCEPT_GUARD] token not ready, waiting inviteId=' + invite?.id);
        const waitStart = Date.now();
        while (!tokenRef.current && Date.now() - waitStart < 4000) {
          await new Promise<void>((r) => setTimeout(r, 100));
        }
        resolved = tokenRef.current;
        if (!resolved) {
          console.warn('[ACCEPT_GUARD] gave_up_waiting_for_token after ' + (Date.now() - waitStart) + 'ms inviteId=' + invite?.id);
          return;
        }
        console.log('[ACCEPT_GUARD] token ready after ' + (Date.now() - waitStart) + 'ms, proceeding inviteId=' + invite?.id);
      }
      // eslint-disable-next-line @typescript-eslint/no-shadow, no-shadow
      const token: string = resolved;

    const acceptKey = `accept:${invite.id}`;
    if (inviteActionInFlightRef.current.has(acceptKey)) {
      console.warn('[ACCEPT_GUARD] early_return reason=in_flight inviteId=' + invite.id + ' acceptKey=' + acceptKey);
      return;
    }
    if (consumedInviteActionRef.current.has(acceptKey)) {
      console.warn('[ACCEPT_GUARD] early_return reason=already_consumed inviteId=' + invite.id + ' acceptKey=' + acceptKey);
      return;
    }
    inviteActionInFlightRef.current.add(acceptKey);
    console.log('[ACCEPT_GUARD] passed inviteId=' + invite.id + ' acceptKey=' + acceptKey);
    console.log('[LOCK_CALL] answer_pressed inviteId=' + invite.id + ' callId=' + callId);

      let answerFlowCommitted = false;
      try {
        setCallFlowLastError(null);
        // ─── Latency: "ANSWER_TAPPED" is logged here (the authoritative
        // JS entry point for any answer trigger — inline tap, CallKeep
        // action, lock-screen button, background task). The UI-level tap
        // marker in IncomingCallScreen records the UI thread's stamp;
        // this one is the moment the business logic actually begins.
        markCallLatency(invite.id, "ANSWER_TAPPED", {
          appState: AppState.currentState,
        });
        // Seed the context with fields we have right now; lock-state
        // fields are appended further below once the native bridge
        // reports them. NetInfo is fetched async — `setCallLatencyContext`
        // merges, so whichever value settles first wins without races.
        setCallLatencyContext(invite.id, {
          appState: AppState.currentState,
          sipRegistered: sip.registrationState === "registered",
          sipRegState: sip.registrationState,
          platform: Platform.OS,
        });

        // ── Expiry check (cheap sync, must happen before launching SIP) ─────
        if (isExpired(invite)) {
          console.log("[Notif] Invite expired, cannot answer:", invite.id);
          setCallFlowLastError("invite_expired");
          showEndedState(invite, "Call ended", { reason: "invite_expired" }, 1000);
          endNativeCall(callId);
          AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
          return;
        }

        // ── Timing: record answer-tap timestamp (needed by register/answer
        //    promises below) ──────────────────────────────────────────────────
        const answerTappedAt = Date.now();
        const pushReceivedAt =
          (invite as any)._pushReceivedAt ||
          timingsRef.current[`push_${invite.id}`] ||
          answerTappedAt;
        timingsRef.current[`answer_${invite.id}`] = answerTappedAt;

        // ══════════════════════════════════════════════════════════════════
        // CRITICAL PATH — launch SIP register→answer chain IMMEDIATELY.
        //
        // Previously ~336 ms of JS work (native-bridge dismiss + lock flag
        // probes, state re-renders, logging, flight records, bringAppToFore-
        // ground, and an awaited sip.register()) ran BEFORE this point. The
        // measured gap from ANSWER_TAPPED → SESSION_ACCEPT_START on a warm
        // foreground call was 336 ms — all of it wasted time before the SIP
        // 200 OK could be sent.
        //
        // Fix: compute the minimal flags needed to decide forceRestart,
        // launch `sip.register()` as a promise without awaiting, chain
        // `sip.answerIncomingInvite()` onto it, and let the rest of the
        // pre-answer work run on the main JS thread in parallel with the
        // SIP 200 OK going out.
        // ══════════════════════════════════════════════════════════════════

        /** Only force a full UA restart when registration is missing or failed — not on every background answer. */
        const sipLooksUnready =
          sip.registrationState !== "registered" &&
          sip.registrationState !== "registering";
        // If SIP says "registered" but no INVITE has arrived (callState still
        // "idle" when the user taps answer), the WebSocket binding is stale —
        // common after the OS suspends/resumes the WS connection or after a
        // long idle period. A SIP registration ALONE on the dead socket shows
        // ok locally but the PBX can no longer route INVITEs to us, so Kamailio
        // silently retransmits into the void and the user sees the incoming
        // screen with no underlying session. Force-restart the UA in that
        // case: register() has a guard that skips restart if an incoming
        // session is already present, so this is safe. After restart, the PBX
        // re-routes the INVITE within Timer B (~32s) to the fresh Contact.
        const sipSocketLooksStale =
          sip.registrationState === "registered" && sip.callState === "idle";
        const shouldForceSipRefresh = sipLooksUnready || sipSocketLooksStale;
        const wasAlreadyRegistered = sip.registrationState === "registered";
        // When the socket looks stale we MUST retry register() a few times —
        // the first ua.stop()/new UA() cycle can race with the WebSocket being
        // in a half-closed state and the fresh REGISTER may need a retry.
        const maxAttempts = wasAlreadyRegistered && !sipSocketLooksStale ? 1 : 4;
        if (sipSocketLooksStale) {
          console.warn(
            "[ANSWER_PIPELINE] socket_looks_stale — forcing SIP restart (registered but callState=idle)",
          );
        }

        // Retry SIP registration up to 4 times with 40 ms gaps. On cold start
        // the first attempt may fail with "Missing provisioning bundle" because
        // SipProvider hasn't loaded SecureStore yet — subsequent retries succeed.
        //
        // PERF: previously we ALWAYS forceRestart=true on the deep-link path
        // (skipBringToForeground), which tore down any in-flight register
        // that SipContext had started on mount, re-queued the UA, and added
        // roughly 200–700 ms of unnecessary work to cold-start answers.
        // We now only forceRestart when the UA is genuinely unhealthy
        // (state ≠ "registered" ∧ ≠ "registering"). This mirrors the
        // SipContext AppState handler.
        const t0_sipReg = Date.now();
        const sipRegisterPromise: Promise<boolean> = (async () => {
          let registered = false;
          for (let attempt = 1; attempt <= maxAttempts && !registered; attempt++) {
            if (attempt > 1) {
              console.log("[Notif] SIP register retry", attempt);
              await new Promise<void>((r) => setTimeout(r, 40));
            }
            registered = await sip
              .register({ forceRestart: shouldForceSipRefresh })
              .then(() => true)
              .catch((e) => {
                console.warn("[Notif] SIP register attempt", attempt, "failed:", e?.message || e);
                return false;
              });
          }
          const t1_sipRegDone = Date.now();
          console.log('[ANSWER_PIPELINE] SIP_REG', JSON.stringify({
            result: registered ? "OK" : "FAILED",
            wasAlreadyRegistered,
            forceRestart: shouldForceSipRefresh,
            tookMs: t1_sipRegDone - t0_sipReg,
            sinceAnswerMs: t1_sipRegDone - answerTappedAt,
          }));
          flightRecord('SIP', registered ? 'SIP_REGISTERED' : 'SIP_REGISTER_FAILED', {
            inviteId: invite.id,
            pbxCallId: invite.pbxCallId ?? null,
            severity: registered ? 'info' : 'error',
            payload: { wasAlreadyRegistered, tookMs: t1_sipRegDone - t0_sipReg },
          });
          return registered;
        })();

        // Launch SIP answer as soon as register resolves. This is the
        // moment the SIP 200 OK begins travelling — constructing this
        // promise synchronously (without `await`) means JsSIP is queued on
        // the JS microtask queue BEFORE any of the non-critical
        // pre-answer work below has a chance to run. The result: all of
        // dismiss/log/render/native-bridge work now runs in parallel with
        // the SIP answer rather than gating it.
        const sipAnswerPromise: Promise<boolean> = sipRegisterPromise.then(async (registered) => {
          if (!registered) return false;
          const t4_sipAnswerStart = Date.now();
          console.log('[ANSWER_PIPELINE] SIP_ANSWER_START (parallel with claim)', JSON.stringify({
            inviteId: invite.id, sinceAnswerMs: t4_sipAnswerStart - answerTappedAt,
            sipReg: sip.registrationState, callState: sip.callState,
          }));
          emitAnswerFlowEvent("SIP_ANSWER_REQUESTED", invite);
          flightRecord('SIP', 'SIP_ANSWER_START', { inviteId: invite.id, pbxCallId: invite.pbxCallId ?? null, payload: { sinceAnswerMs: t4_sipAnswerStart - answerTappedAt } });
          // Latency: this is the moment the JS SIP layer is asked to send
          // the SIP 200 OK. Gap from ANSWER_TAPPED→here now only includes
          // register() cost (near-zero when already registered) — the
          // dismiss, logging, state updates, and foreground bring-up all
          // run in parallel instead of blocking this step.
          markCallLatency(invite.id, "SESSION_ACCEPT_START", {
            sipRegState: sip.registrationState,
            sinceAnswerMs: t4_sipAnswerStart - answerTappedAt,
          });
          return sip
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
                  const sentMs = event.timestamp - answerTappedAt;
                  console.log('[ANSWER_PIPELINE] SIP_200OK_SENT +' + sentMs + 'ms');
                  emitAnswerFlowEvent("SIP_ANSWER_SENT", invite, {
                    traceAt: new Date(event.timestamp).toISOString(),
                    sinceAnswerMs: sentMs,
                  });
                  flightRecord('SIP', 'SIP_ANSWER_SENT', { inviteId: invite.id, payload: { sinceAnswerMs: sentMs } });
                  // Latency: 200 OK has been handed to the transport —
                  // this captures the JsSIP internal "accept → send" cost.
                  markCallLatency(invite.id, "SESSION_ACCEPT_SIGNAL_SENT", {
                    sinceAnswerMs: sentMs,
                  });
                  return;
                }
                if (event.phase === "confirmed") {
                  const confirmedMs = event.timestamp - answerTappedAt;
                  console.log('[ANSWER_PIPELINE] SIP_CONFIRMED +' + confirmedMs + 'ms');
                  emitAnswerFlowEvent("SIP_ANSWER_CONFIRMED", invite, {
                    traceAt: new Date(event.timestamp).toISOString(),
                    sinceAnswerMs: confirmedMs,
                  });
                  flightRecord('SIP', 'SIP_CONNECTED', { inviteId: invite.id, pbxCallId: invite.pbxCallId ?? null, payload: { traceAt: new Date(event.timestamp).toISOString(), sinceAnswerMs: confirmedMs } });
                  // Latency: ACK received. This is the dialog-confirmed
                  // signaling milestone; gap to ICE_CONNECTED is almost
                  // always network-bound.
                  markCallLatency(invite.id, "SESSION_ESTABLISHED_SIGNAL", {
                    sinceAnswerMs: confirmedMs,
                  });
                  return;
                }
                const failedMs = event.timestamp - answerTappedAt;
                console.warn('[ANSWER_PIPELINE] SIP_FAILED +' + failedMs + 'ms reason=' + event.reason + ' code=' + event.code);
                emitAnswerFlowEvent("SIP_ANSWER_FAILED", invite, {
                  traceAt: new Date(event.timestamp).toISOString(),
                  code: event.code ?? null,
                  reason: event.reason ?? null,
                  message: event.message ?? null,
                  sinceAnswerMs: failedMs,
                });
                flightRecord('SIP', 'SIP_ANSWER_FAILED', { inviteId: invite.id, severity: 'error', payload: { code: event.code, reason: event.reason, sinceAnswerMs: failedMs } });
              },
            )
            .catch(() => false);
        });

        // ══════════════════════════════════════════════════════════════════
        // PARALLEL PATH — everything below now runs in parallel with SIP
        // 200 OK transmission. None of this gates the answer. Order is
        // preserved where observable (e.g. UI re-renders still fire after
        // native dismiss so the handoff feels smooth), but nothing here
        // blocks JsSIP.
        // ══════════════════════════════════════════════════════════════════

        // NetInfo context was previously gathered here, but the package
        // (`@react-native-community/netinfo`) is not installed in this app.
        // A `require("@react-native-community/netinfo")` baked an undefined
        // module id into the Hermes bundle and threw
        // "Requiring unknown module 'undefined'" on every answer tap,
        // which the RN error reporter forwarded as a fatal to the native
        // modules thread and crashed the app. Removed; NetInfo data was
        // informational-only for latency instrumentation.

        // Native incoming-call UI dismissal. JS→native bridge call; the
        // native side stops the ringtone and closes the notification
        // asynchronously. No longer gates SIP answer.
        dismissNativeIncomingUi(invite.id);
        // The JS→native bridge hop for dismiss + native UI teardown is
        // the first non-trivial cost after the tap. Mark the boundary
        // so any delay between ANSWER_TAPPED and NATIVE_ANSWER_TRIGGERED
        // is attributable to that bridge.
        markCallLatency(invite.id, "NATIVE_ANSWER_TRIGGERED", {
          source: "handle_accept_invite",
        });
        logCallFlow("ANSWER_TAPPED", {
          inviteId: invite.id,
          pbxCallId: invite.pbxCallId ?? null,
          extension: invite.toExtension ?? null,
          extra: { source: "handle_accept_invite" },
        });
        flightRecord('USER', 'ANSWER_TAPPED', {
          inviteId: invite.id,
          pbxCallId: invite.pbxCallId ?? null,
        });

        const appWasBackgrounded = AppState.currentState !== "active";
        // Authoritative lock-screen / notification-launch signal: did the
        // user reach this activity via the incoming-call PendingIntent
        // (lock-screen full-screen surface or notification action)? If yes
        // we want to moveTaskToBack on hangup so the keyguard / launcher
        // re-emerges instead of QuickAction. KeyguardManager is unreliable
        // here — Samsung One UI flips it to "unlocked" the moment
        // MainActivity surfaces over the keyguard via showWhenLocked=true,
        // even though the device is still actually locked. The native
        // module sets a flag in MainActivity at the precise moment the
        // PendingIntent fires; we consume it here and remember the result
        // for the call's lifetime so the hangup effect can act on it.
        let launchedFromIncomingCall = false;
        let deviceLockedAtAnswer = false;
        if (Platform.OS === "android") {
          try {
            const mod = (NativeModules as any)?.IncomingCallUi;
            if (mod && typeof mod.consumeLaunchedFromIncomingCall === "function") {
              launchedFromIncomingCall = !!mod.consumeLaunchedFromIncomingCall();
            }
            if (mod && typeof mod.isDeviceLocked === "function") {
              deviceLockedAtAnswer = !!mod.isDeviceLocked();
            }
          } catch {
            launchedFromIncomingCall = false;
            deviceLockedAtAnswer = false;
          }
        }
        if (appWasBackgrounded || deviceLockedAtAnswer || launchedFromIncomingCall) {
          answeredFromBackgroundRef.current = true;
        }
        // Narrower, lock-screen-specific flag. This drives the "return to
        // keyguard after hangup" decision in RootNavigator without
        // depending on a live isDeviceLocked() check (which Samsung lies
        // about). launchedFromIncomingCall is authoritative because it's
        // only set by the native PendingIntent path — i.e. MainActivity
        // was surfaced specifically for this call, which only happens on
        // lock-screen / heads-up / notification-action entry paths.
        if (deviceLockedAtAnswer || launchedFromIncomingCall) {
          answeredFromLockScreenRef.current = true;
        }
        // Latency context — now that the native bridge has reported
        // lock / launch flags, fold them into the timeline so the
        // summary line can tell cold-from-locked from warm-foreground.
        setCallLatencyContext(invite.id, {
          appWasBackgrounded,
          deviceLockedAtAnswer,
          launchedFromIncomingCall,
        });
        console.log(
          '[LOCK_CALL] answer_context appWasBackgrounded=' + appWasBackgrounded +
          ' deviceLocked=' + deviceLockedAtAnswer +
          ' launchedFromIncomingCall=' + launchedFromIncomingCall +
          ' answeredFromBackgroundRef=' + answeredFromBackgroundRef.current +
          ' inviteId=' + invite.id,
        );
        const answerPath = options?.skipBringToForeground
          ? "deep_link"
          : options?.deferForegroundUntilConnected
          ? "floating_notification_deferred"
          : appWasBackgrounded
          ? "background_app"
          : "in_app";
        console.log('[ANSWER_PIPELINE] START', JSON.stringify({
          inviteId: invite.id,
          pbxCallId: invite.pbxCallId,
          answerPath,
          appState: AppState.currentState,
          sipReg: sip.registrationState,
          sipLooksUnready,
          appWasBackgrounded,
          pushToAnswerMs: answerTappedAt - pushReceivedAt,
          ts: answerTappedAt,
        }));
        flightRecordNativeRingtone(invite.id);
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
        // during SIP register / claim / answer. These React state updates
        // used to run BEFORE the SIP answer and were a major contributor to
        // the 336 ms stall via re-render cost.
        answerHandoffInviteIdRef.current = invite.id;
        suppressedIncomingInviteIdsRef.current.add(invite.id);
        answerInviteRef.current = invite;   // caller info fallback for ActiveCallScreen
        setAnswerHandoffTick((n) => n + 1);
        safeSetInvite(null);

        // Bring app to foreground (if needed) — does NOT gate SIP answer.
        if (
          !options?.skipBringToForeground &&
          !options?.deferForegroundUntilConnected &&
          AppState.currentState !== "active"
        ) {
          emitAnswerFlowEvent("APP_FOREGROUNDED_FROM_CALL", invite, { source: "callkeep_bridge" });
          bringAppToForeground();
        }

        // Now await register — if it failed, SIP answer never fired and
        // we must surface that as a user-visible error. On success, SIP
        // 200 OK is already in flight via sipAnswerPromise.
        const registered = await sipRegisterPromise;
        if (!registered) {
          console.warn("[Notif] All SIP register attempts failed for invite:", invite.id);
          setCallFlowLastError("sip_register_failed");
          emitAnswerFlowEvent("SIP_ANSWER_FAILED", invite, {
            reason: "sip_register_failed",
          });
          showEndedState(invite, "Call ended", { reason: "sip_register_failed" });
          void flightEndCall('failed');
          endNativeCall(callId);
          // Latency: capture the "couldn't even register" case so the
          // timeline still produces a summary (useful if the bottleneck
          // is the SIP register loop itself).
          markCallLatency(invite.id, "CALL_FAILED", { reason: "sip_register_failed" });
          summarizeCallLatency(invite.id, "failed");
          resetCallLatency(invite.id);
          return;
        }

        // pbxAnswerPromise runs concurrently with the backend claim below.
        const pbxAnswerPromise = waitForPbxAnswer(invite, 6_000);

        // === BACKEND CLAIM (parallel with SIP answer) ===========================
        // SIP 200 OK is already in flight. Now claim the invite on the backend.
        const t2_claimStart = Date.now();
        console.log('[ANSWER_PIPELINE] CLAIM_START (parallel)', JSON.stringify({
          inviteId: invite.id, pbxCallId: invite.pbxCallId, sinceAnswerMs: t2_claimStart - answerTappedAt,
        }));
        const resp = await respondInvite(
          token,
          invite.id,
          "ACCEPT",
          deviceIdRef.current || undefined,
        ).catch(() => null);
        const t3_claimDone = Date.now();
        console.log('[ANSWER_PIPELINE] CLAIM_DONE', JSON.stringify({
          code: resp?.code, status: resp?.status,
          tookMs: t3_claimDone - t2_claimStart, sinceAnswerMs: t3_claimDone - answerTappedAt,
        }));

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

          // Backend rejected — hang up the SIP call we already sent 200 OK for.
          sip.hangup().catch(() => {});
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

        // === AWAIT SIP CONFIRMATION =============================================
        const answered = await sipAnswerPromise;

        if (!answered) {
          setCallFlowLastError("sip_answer_not_confirmed");
          showEndedState(invite, "Call ended", {
            reason: "sip_answer_not_confirmed",
          });
          void flightEndCall('failed');
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
        flightRecord('UI', 'ACTIVE_CALL_SCREEN_SHOWN', {
          inviteId: invite.id,
          pbxCallId: invite.pbxCallId ?? null,
          payload: { answeredAt: new Date().toISOString() },
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
              flightRecord('BACKEND', 'PBX_ANSWER_DESYNC', {
                inviteId: invite.id,
                severity: 'warn',
                payload: { telephonyState: pbxAnswer.state },
              });
              return;
            }
            emitAnswerFlowEvent("PBX_CALL_ANSWERED", invite, {
              answeredAt: pbxAnswer.answeredAt,
              telephonyState: pbxAnswer.state,
              activeChannels: pbxAnswer.activeChannels,
            });
            flightRecord('BACKEND', 'PBX_CALL_ANSWERED', {
              inviteId: invite.id,
              payload: { answeredAt: pbxAnswer.answeredAt, state: pbxAnswer.state },
            });
          })
          .catch(() => undefined);

        // SIP answered successfully — keep answerHandoff set until SipContext
        // reports connected so navigators do not pop home between invite=null
        // and callState=connected.
        answerFlowCommitted = true;
      } catch (err: any) {
        // Surface the real reason for any silent failure. This used to
        // be swallowed by the outer deep-link catch, leaving the UI
        // stuck on "Connecting…" with no diagnostic trail.
        console.error(
          '[ANSWER_PIPELINE] handleAcceptInvite threw inviteId=' + invite?.id + ':',
          err?.message || String(err),
          err?.stack || '',
        );
        setCallFlowLastError('answer_pipeline_error: ' + (err?.message || String(err)));
        // Best-effort recovery: terminate any half-answered SIP session,
        // dismiss native UI, and bail out of the fake "ActiveCall" state
        // so the user sees a real ended/failed state instead of being
        // stranded.
        try {
          sip.hangup?.();
        } catch {
          /* best-effort */
        }
        try {
          endNativeCall(invite?.id);
        } catch {
          /* best-effort */
        }
        try {
          stopAllTelephonyAudio().catch(() => undefined);
        } catch {
          /* best-effort */
        }
        showEndedState(
          invite,
          'Answer failed',
          { reason: 'answer_error', error: err?.message || String(err) },
          1500,
        );
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
    // Keep answerInviteRef alive through the connected state so ActiveCallScreen
    // always has caller info. Clear it when the call fully ends.
  }, [sip.callState]);

  useEffect(() => {
    if (sip.callState === "idle") {
      console.log('[CALL_CLEANUP] sip_idle clearing answerInviteRef, deferring suppressed id clear');
      console.log('[LOCK_CALL_CLEANUP] sip_idle — clearing per-call refs so next incoming call starts fresh');
      answerInviteRef.current = null;
      // Defensive: ensure shownInviteIdRef and the in-flight action sets are
      // empty so the NEXT incoming call (especially from the lock screen) can
      // always re-populate them. Earlier builds saw repeated-call drops when a
      // stale shownInviteIdRef from an answered-but-not-reset path blocked the
      // next call's UI. Clearing on SIP idle is the canonical boundary.
      shownInviteIdRef.current = null;
      inviteActionInFlightRef.current.clear();
      consumedInviteActionRef.current.clear();
      handledIncomingActionKeysRef.current.clear();
      answerHandoffInviteIdRef.current = null;
      // Keep suppressed ids for a short window so stale late-arriving push/cache
      // data cannot re-open an incoming screen for a call that already ended.
      const snapshot = new Set(suppressedIncomingInviteIdsRef.current);
      const t = setTimeout(() => {
        for (const id of snapshot) {
          suppressedIncomingInviteIdsRef.current.delete(id);
        }
        console.log('[CALL_CLEANUP] suppressed_ids_cleared count=' + snapshot.size);
        console.log('[LOCK_CALL_CLEANUP] reset_complete ready_for_next_call=true');
      }, 30_000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [sip.callState]);

  // ── Reconcile call UI on app resume ─────────────────────────────────────────
  // When the app becomes active, if SIP has no active/ringing call, any
  // lingering incoming-call UI is orphaned and must be cleared immediately.
  // This prevents the "open app and see a stale incoming call screen" bug.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      const sipBusy = sip.callState === "ringing" || sip.callState === "dialing" || sip.callState === "connected";
      const uiShowing = incomingInvite !== null || incomingCallUiState.phase === "incoming" || incomingCallUiState.phase === "connecting";
      if (!sipBusy && uiShowing) {
        console.warn('[CALL_RECONCILE] orphan_ui_detected sipState=' + sip.callState + ' phase=' + incomingCallUiState.phase + ' inviteId=' + (incomingInvite?.id || 'n/a') + ' — clearing stale incoming UI');
        // Poison the id so a race with a push listener cannot immediately re-open.
        if (incomingInvite?.id) suppressedIncomingInviteIdsRef.current.add(incomingInvite.id);
        safeSetInvite(null);
      } else {
        console.log('[CALL_RECONCILE] app_active sipState=' + sip.callState + ' uiPhase=' + incomingCallUiState.phase + ' — no action');
      }
    });
    return () => sub.remove();
  }, [sip.callState, incomingInvite, incomingCallUiState.phase, safeSetInvite]);

  // ── Incoming invite status poll (cancellation safety net) ──────────────────
  // Hard-watchdog for incoming-call UI/audio: the moment an invite appears in
  // JS state, start polling /mobile/call-invites/:id/answer-status every
  // 800 ms. If the backend reports any terminal state (remote hung up →
  // CANCELED / EXPIRED / MISSED; another device accepted → ACCEPTED; declined
  // → DECLINED; failed), tear down the incoming UI and all ringtones — JS
  // AND native — immediately.
  //
  // Why this has to exist: INVITE_CANCELED FCMs are unreliable in practice
  // (Doze, OEM throttling, app killed while the service tries to start).
  // Without this poll, when the remote caller hangs up an unanswered call
  // the user sits watching the incoming-call screen ringing indefinitely
  // and has to force-quit the app. With the poll the UI clears within
  // ~1 s of the backend update.
  //
  // We intentionally do NOT gate on incomingCallUiState.phase. We want the
  // poll running regardless of whether the UI is `incoming`, `connecting`,
  // or anything else as long as the invite is still present — on "Answered
  // elsewhere" the user needs that UI dismissed even if we already tapped
  // Answer locally. `answerHandoffInviteIdRef` and the poll terminating
  // itself on accept/decline prevents races with the local answer flow.
  useEffect(() => {
    if (!token) return undefined;
    if (!incomingInvite) return undefined;

    const inviteId = incomingInvite.id;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const TERMINAL_STATUSES = new Set([
      "CANCELED",
      "CANCELLED",
      "EXPIRED",
      "DECLINED",
      "ACCEPTED",
      "MISSED",
      "FAILED",
    ]);

    const killAll = (reason: string, friendly: string, delayMs: number) => {
      console.log('[INVITE_POLL] terminal_state inviteId=' + inviteId + ' reason=' + reason);
      // Only push the Android task back to the lock screen when the
      // device is ACTUALLY locked. If we did this for every background
      // presentation (home-screen heads-up, etc.), we'd leave
      // MainActivity paused after the call ended, which in turn forces
      // the next incoming call down the native heads-up-only path and
      // blocks the JS IncomingCallScreen from rendering (Android 14+
      // BAL policy quietly drops background full-screen activity starts
      // on unlocked devices). Consuming the `launchedFromIncomingCall`
      // flag is still useful — it clears state used elsewhere — but we
      // only ACT on isDeviceLocked() for the back-to-lock behaviour.
      let presentedOnLockScreen = false;
      if (Platform.OS === "android") {
        try {
          const mod = (NativeModules as any)?.IncomingCallUi;
          const launchedFlag =
            mod && typeof mod.consumeLaunchedFromIncomingCall === "function"
              ? !!mod.consumeLaunchedFromIncomingCall()
              : false;
          const locked =
            mod && typeof mod.isDeviceLocked === "function"
              ? !!mod.isDeviceLocked()
              : false;
          presentedOnLockScreen = locked;
          console.log(
            '[LOCK_RETURN] killAll context inviteId=' + inviteId +
            ' launchedFlag=' + launchedFlag +
            ' locked=' + locked +
            ' appState=' + AppState.currentState +
            ' willReturnToLockScreen=' + presentedOnLockScreen,
          );
        } catch {
          presentedOnLockScreen = false;
        }
      }
      // Each teardown step is wrapped individually: earlier versions
      // chained them without local guards, so a single throw (e.g.
      // "Object is not a function" from a stale native bridge method)
      // short-circuited the rest of the cleanup AND was caught by the
      // poll's outer try/catch, which then re-armed the tick. That led
      // to killAll firing every ~1 s forever, each iteration clobbering
      // `scheduleIncomingUiReset`'s timer so the invite was never
      // cleared and the incoming UI stayed on screen. Now every step
      // can fail independently without preventing `showEndedState` (the
      // only thing that actually hides the IncomingCallScreen) from
      // running.
      try {
        const mod = (NativeModules as any)?.IncomingCallUi;
        if (mod && typeof mod.stopRingtone === "function") {
          mod.stopRingtone(inviteId);
        }
        if (mod && typeof mod.dismiss === "function") {
          mod.dismiss(inviteId);
        }
      } catch (e: any) {
        console.warn('[INVITE_POLL] killAll stopRingtone/dismiss threw: ' + (e?.message || String(e)));
      }
      try {
        stopAllTelephonyAudio().catch(() => undefined);
      } catch (e: any) {
        console.warn('[INVITE_POLL] killAll telephonyAudio stop threw: ' + (e?.message || String(e)));
      }
      try {
        suppressedIncomingInviteIdsRef.current.add(inviteId);
      } catch (e: any) {
        console.warn('[INVITE_POLL] killAll suppressedIds.add threw: ' + (e?.message || String(e)));
      }
      try {
        endNativeCall(inviteId);
      } catch (e: any) {
        console.warn('[INVITE_POLL] killAll endNativeCall threw: ' + (e?.message || String(e)));
      }
      try {
        AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
      } catch (e: any) {
        console.warn('[INVITE_POLL] killAll AsyncStorage.removeItem threw: ' + (e?.message || String(e)));
      }
      // Remove the invite from the multi-call ringing stack too — otherwise
      // a ghost ringing entry stays in CallSessionManager and lights up the
      // CallWaitingBanner once the user answers the next real call.
      try {
        callSessions.removeInboundInvite(inviteId, "poll_" + reason);
      } catch (e: any) {
        console.warn('[INVITE_POLL] killAll removeInboundInvite threw: ' + (e?.message || String(e)));
      }
      try {
        showEndedState(incomingInvite, friendly, { reason }, delayMs);
      } catch (e: any) {
        console.warn('[INVITE_POLL] killAll showEndedState threw: ' + (e?.message || String(e)));
      }
      if (presentedOnLockScreen) {
        // Fire AFTER the "Call ended" splash has been visible long enough
        // to be seen. The UI reset timer is scheduled for the same
        // delayMs so we land immediately on idle/QuickAction and then
        // moveTaskToBack hides that behind the keyguard. Using a tiny
        // +80ms cushion ensures the reset has fired before we push the
        // activity back, so we don't re-render QuickAction over the
        // keyguard for a frame.
        setTimeout(() => {
          try {
            moveAppToBackground();
            console.log(
              '[LOCK_RETURN] moveAppToBackground after remote end inviteId=' + inviteId +
              ' reason=' + reason,
            );
          } catch {
            /* ignore */
          }
        }, delayMs + 80);
      }
    };

    let tickCount = 0;
    const tickStartedAt = Date.now();
    const tick = async () => {
      if (cancelled) return;
      tickCount++;
      // If the local user has just tapped Answer, stop polling so we don't
      // race the answer pipeline. The answer flow owns the invite from
      // this point forward.
      if (answerHandoffInviteIdRef.current === inviteId) {
        console.log('[INVITE_POLL] stopped_for_answer_handoff inviteId=' + inviteId);
        return;
      }
      const tickStart = Date.now();
      try {
        const status = await getMobileInviteAnswerStatus(token, inviteId);
        if (cancelled) return;
        const inviteStatus = (status?.inviteStatus || "").toUpperCase();
        const elapsed = Date.now() - tickStartedAt;
        const httpMs = Date.now() - tickStart;
        console.log(
          '[INVITE_POLL] tick=' + tickCount +
          ' inviteId=' + inviteId +
          ' inviteStatus=' + (inviteStatus || 'none') +
          ' telephonyState=' + (status?.telephonyState || 'none') +
          ' pbxAnswered=' + !!status?.pbxAnswered +
          ' httpMs=' + httpMs +
          ' elapsedMs=' + elapsed,
        );
        if (inviteStatus && inviteStatus !== "PENDING" && TERMINAL_STATUSES.has(inviteStatus)) {
          const ended = inviteStatus === "ACCEPTED";
          // Terminal signal is authoritative: kill the poll BEFORE invoking
          // killAll. Previously if killAll threw mid-teardown the catch
          // below would swallow the error AND fall through to
          // setTimeout(tick, 800), re-firing killAll every second forever.
          // Every re-fire clobbered `scheduleIncomingUiReset`'s timer so
          // the incoming UI never actually cleared. Setting `cancelled`
          // here guarantees exactly one terminal teardown pass per invite.
          cancelled = true;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          killAll(
            ended ? "accepted_elsewhere" : `remote_${inviteStatus.toLowerCase()}`,
            ended ? "Answered elsewhere" : "Call ended",
            ended ? 600 : 900,
          );
          return;
        }
        // Secondary signal: the PBX may flip the telephony channel to
        // HUNGUP/ENDED before our DB writer updates invite.status. In
        // some Asterisk configs (internal-extension → mobile invite) the
        // AMI state webhook never fires on a caller-hangup-before-answer
        // so invite.status stays PENDING forever. The telephony lookup
        // still reports the channel state accurately, so use it as the
        // authoritative hangup signal.
        //
        // NOTE: Asterisk's state strings include "hungup" (the PJSIP
        //   endpoint state verb, with an extra 'u') — do NOT "correct"
        //   this to "hangup". We also accept `none` / empty, which is
        //   what the telephony query returns once the channel is fully
        //   gone; that happens shortly after HUNGUP for an unanswered
        //   call.
        const telephonyState = (status?.telephonyState || '').toUpperCase();
        const telephonyTerminal =
          telephonyState === 'HUNGUP' ||
          telephonyState === 'HANGUP' ||
          telephonyState === 'CANCELED' ||
          telephonyState === 'CANCELLED' ||
          telephonyState === 'ENDED' ||
          telephonyState === 'TERMINATED';
        if (telephonyTerminal) {
          // Same rationale as the inviteStatus branch above: stop the
          // poll BEFORE killAll so an exception inside teardown cannot
          // restart the loop.
          cancelled = true;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          killAll(
            'remote_telephony_' + telephonyState.toLowerCase(),
            'Call ended',
            900,
          );
          return;
        }
      } catch (e: any) {
        console.warn('[INVITE_POLL] error tick=' + tickCount + ' inviteId=' + inviteId + ' msg=' + (e?.message || String(e)));
      }
      if (cancelled) return;
      timer = setTimeout(tick, 800);
    };

    console.log('[INVITE_POLL] started inviteId=' + inviteId);
    // Kick off immediately so we catch fast cancels (e.g. caller hangs up
    // within the first second of ringing).
    tick();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      console.log('[INVITE_POLL] stopped inviteId=' + inviteId);
    };
  }, [
    token,
    incomingInvite,
    showEndedState,
    endNativeCall,
  ]);

  // ── SIP → incoming-UI cancel bridge ────────────────────────────────────────
  // When the remote caller hangs up while we are still ringing (the user has
  // NOT tapped Answer), JsSIP surfaces the CANCEL as a session `ended`/`failed`
  // event. That translates to `sip.callState === "ended"` in SipContext. The
  // /mobile/call-invites/:id/answer-status poll will also eventually catch
  // this via a terminal telephonyState, but the poll runs at 800 ms intervals
  // plus an HTTP round-trip, so on a fast same-LAN cancel it can lag ~1.5 s.
  // Meanwhile the IncomingCallScreen keeps showing the "incoming" UI and the
  // native ringtone keeps playing — that's the bug the user reported.
  //
  // This effect fires the same teardown as the poll's killAll, immediately,
  // the moment JsSIP reports the inbound call has ended while we are still
  // in the "incoming" phase (i.e. the user never tapped Answer). The two
  // paths are idempotent: if the poll happens to win the race it's a no-op
  // that just updates the visible "Call ended" message.
  useEffect(() => {
    if (!incomingInvite) return;
    if (sip.callDirection !== "inbound") return;
    // Only fire when the SIP state has terminated and the user has NOT
    // handed the invite off to the answer pipeline. "connecting" is the
    // phase during answer handoff; during that window the normal answer
    // flow (or its failure branch) owns the UI and we must not preempt it.
    if (incomingCallUiState.phase !== "incoming") return;
    if (answerHandoffInviteIdRef.current === incomingInvite.id) return;
    if (sip.callState !== "ended" && sip.callState !== "idle") return;

    const invite = incomingInvite;
    const inviteId = invite.id;
    const reason = "sip_cancel_while_ringing";
    const friendly = "Call ended";
    const delayMs = 900;

    console.log(
      '[SIP_CANCEL_BRIDGE] teardown inviteId=' + inviteId +
      ' sipCallState=' + sip.callState +
      ' uiPhase=' + incomingCallUiState.phase,
    );

    // Remember whether this invite was presented on the lock screen so the
    // post-teardown moveAppToBackground uses the authoritative signal —
    // same rationale as `answeredFromLockScreenRef` for the answered path.
    let presentedOnLockScreen = answeredFromLockScreenRef.current;
    if (Platform.OS === "android") {
      try {
        const mod = (NativeModules as any)?.IncomingCallUi;
        // consumeLaunchedFromIncomingCall is a one-shot: if the invite was
        // surfaced via the PendingIntent and the user never tapped Answer,
        // the flag is still set here. Consuming it also prevents a stale
        // true leaking into the next, unrelated call.
        const launchedFlag =
          mod && typeof mod.consumeLaunchedFromIncomingCall === "function"
            ? !!mod.consumeLaunchedFromIncomingCall()
            : false;
        const liveLocked =
          mod && typeof mod.isDeviceLocked === "function"
            ? !!mod.isDeviceLocked()
            : false;
        presentedOnLockScreen = presentedOnLockScreen || launchedFlag || liveLocked;
        console.log(
          '[LOCK_RETURN] sip_cancel_bridge inviteId=' + inviteId +
          ' launchedFlag=' + launchedFlag +
          ' liveLocked=' + liveLocked +
          ' answeredFromLockRef=' + answeredFromLockScreenRef.current +
          ' willReturnToLockScreen=' + presentedOnLockScreen,
        );
      } catch {
        /* ignore — fall back to false */
      }
    }

    try {
      const mod = (NativeModules as any)?.IncomingCallUi;
      if (mod && typeof mod.stopRingtone === "function") mod.stopRingtone(inviteId);
      if (mod && typeof mod.dismiss === "function") mod.dismiss(inviteId);
    } catch {
      /* ignore */
    }
    try {
      stopAllTelephonyAudio().catch(() => undefined);
    } catch {
      /* ignore */
    }
    suppressedIncomingInviteIdsRef.current.add(inviteId);
    endNativeCall(inviteId);
    AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
    try {
      callSessions.removeInboundInvite(inviteId, "sip_cancel_bridge");
    } catch {
      /* ignore */
    }
    showEndedState(invite, friendly, { reason }, delayMs);
    if (presentedOnLockScreen) {
      setTimeout(() => {
        try {
          moveAppToBackground();
          console.log(
            '[LOCK_RETURN] moveAppToBackground after sip_cancel_bridge inviteId=' + inviteId,
          );
        } catch {
          /* ignore */
        }
      }, delayMs + 80);
    }
  }, [
    sip.callState,
    sip.callDirection,
    incomingInvite,
    incomingCallUiState.phase,
    answerHandoffInviteIdRef,
    callSessions,
    endNativeCall,
    showEndedState,
  ]);

  // ── SIP ringing safety net ──────────────────────────────────────────────────
  // When SIP reports "ringing" but we have no invite in UI state (i.e. the push
  // data path failed silently), recover the invite from AsyncStorage or from
  // the native cache file written synchronously by IncomingCallFirebaseService.
  //
  // CRITICAL RACE CONDITION: when the app is foregrounded, Android fires this
  // order of events on an inbound call:
  //   (1) JsSIP emits newRTCSession → setCallState("ringing") → this effect runs
  //   (2) native IncomingCallFirebaseService writes pending_call_native.json
  //   (3) expo-task-manager runs the background task → writes to AsyncStorage
  //
  // Step (1) can fire ~300-800ms BEFORE (2) or (3). Previously this effect
  // read AsyncStorage once and returned empty, so the IncomingCallScreen
  // never mounted — the user saw a black screen with only the heads-up
  // notification. Now we retry for up to ~3s, checking BOTH the native
  // cache file (populated in step 2, ~instant) and AsyncStorage (step 3),
  // so the incoming UI appears within a single render tick of the native
  // write.
  useEffect(() => {
    if (sip.callState !== "ringing") return;
    if (incomingInvite !== null) return;
    // CRITICAL: JsSIP reports "ringing" for BOTH an inbound INVITE AND an
    // outbound 180 Ringing response. Before this guard, an outbound call
    // would trip this effect, read whatever stale push payload was still
    // in AsyncStorage from a previous test, and inject it as a phantom
    // "INCOMING TEMP 110" row into the multi-call drawer next to the
    // user's own outbound call. Only run the inbound safety-net when
    // telephony signals inbound direction.
    if (sip.callDirection !== "inbound") return;
    let cancelled = false;

    const tryRecoverFromStorage = async (): Promise<boolean> => {
      const stored = await AsyncStorage.getItem(PENDING_CALL_STORAGE_KEY).catch(() => null);
      if (!stored) return false;
      const data = safeParse(stored);
      if (!data?.inviteId) return false;
      if (suppressedIncomingInviteIdsRef.current.has(String(data.inviteId))) {
        console.log('[Notif] SIP ringing but invite is suppressed — skipping stale invite recovery', data.inviteId);
        return true;
      }
      const invite = payloadToInvite(data);
      if (!invite?.id) return false;
      console.log('[Notif] SIP ringing recovered invite via AsyncStorage inviteId=', invite.id);
      safeSetInvite(invite);
      return true;
    };

    const tryRecoverFromNativeCache = async (): Promise<boolean> => {
      try {
        const uri = FileSystem.cacheDirectory + 'pending_call_native.json';
        const info = await FileSystem.getInfoAsync(uri);
        if (!info.exists) return false;
        const raw = await FileSystem.readAsStringAsync(uri).catch(() => '');
        const data = safeParse(raw);
        if (!data?.inviteId || data.type !== 'INCOMING_CALL') return false;
        if (suppressedIncomingInviteIdsRef.current.has(String(data.inviteId))) {
          console.log('[Notif] SIP ringing but native-cached invite is suppressed — skipping', data.inviteId);
          return true;
        }
        const invite = payloadToInvite(data);
        if (!invite?.id) return false;
        console.log('[Notif] SIP ringing recovered invite via native cache file inviteId=', invite.id);
        safeSetInvite(invite);
        return true;
      } catch {
        return false;
      }
    };

    // Retry schedule in ms. Covers the native-write (~50-200ms after SIP
    // INVITE) and BG-task (~500-1500ms) windows. Caps at ~3s total — by
    // then SIP's own dialog timeout will surface a call-failed state.
    const delays = [0, 100, 250, 500, 800, 1200, 1800, 2600];
    (async () => {
      for (const delay of delays) {
        if (cancelled) return;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        if (cancelled) return;
        const recoveredFromNative = await tryRecoverFromNativeCache();
        if (recoveredFromNative) return;
        if (cancelled) return;
        const recoveredFromStorage = await tryRecoverFromStorage();
        if (recoveredFromStorage) return;
      }
      console.warn('[Notif] SIP ringing safety net gave up — neither native cache nor AsyncStorage produced an invite');
    })();

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sip.callState, sip.callDirection]);

  // ── Native foreground-invite event listener ──────────────────────────────
  // IncomingCallFirebaseService emits `IncomingCall.ForegroundInvite` via the
  // IncomingCallUiModule bridge whenever it receives an FCM INCOMING_CALL
  // while the React host is foregrounded. This is the authoritative signal
  // that mounts IncomingCallScreen — it does NOT depend on JsSIP's INVITE
  // arriving (the WSS socket can be stale after the app returned from the
  // background; the push still reaches us reliably).
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const emitter = new NativeEventEmitter(NativeModules.IncomingCallUi as any);
    const sub = emitter.addListener('IncomingCall.ForegroundInvite', (payload: any) => {
      try {
        const inviteId = String(payload?.inviteId || payload?.callId || '');
        if (!inviteId) {
          console.warn('[Notif] ForegroundInvite event missing inviteId — ignoring');
          return;
        }
        if (suppressedIncomingInviteIdsRef.current.has(inviteId)) {
          console.log('[Notif] ForegroundInvite event for suppressed invite — ignoring', inviteId);
          return;
        }
        const data = {
          type: 'INCOMING_CALL',
          inviteId,
          callId: payload?.callId || inviteId,
          fromNumber: payload?.fromNumber || null,
          fromDisplay: payload?.fromDisplay || null,
          toExtension: payload?.toExtension || null,
          pbxCallId: payload?.pbxCallId || null,
          tenantId: payload?.tenantId || null,
          sipCallTarget: payload?.sipCallTarget || null,
          pbxSipUsername: payload?.pbxSipUsername || null,
          timestamp: payload?.timestamp || new Date().toISOString(),
          _pushReceivedAt: typeof payload?.pushReceivedAt === 'number' ? payload.pushReceivedAt : Date.now(),
        };
        const invite = payloadToInvite(data as any);
        if (!invite?.id) {
          console.warn('[Notif] ForegroundInvite event: payloadToInvite returned empty, ignoring', payload);
          return;
        }
        console.log('[Notif] ForegroundInvite event → mounting IncomingCallScreen inviteId=', invite.id);
        safeSetInvite(invite);
      } catch (e) {
        console.warn('[Notif] ForegroundInvite listener failed:', e instanceof Error ? e.message : String(e));
      }
    });
    return () => {
      try {
        sub.remove();
      } catch {
        /* ignore */
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        const fresh = filterFreshInvites(pending as CallInvite[]);
        const matched =
          fresh.find((item) => !callId || item.id === callId) ||
          fresh[0] ||
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
        flightRecord('USER', 'DECLINE_TAPPED', { inviteId: activeInvite.id });
        flightRecordNativeRingtone(activeInvite.id);
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
        void flightEndCall('declined');
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
        const t0 = Date.now();
        console.log('[CALLKEEP_ANSWER] native onAnswer fired callId=' + callId + ' appState=' + AppState.currentState + ' sipReg=' + sip.registrationState);
        let invite = await resolveInviteForAction(callId);

        if (!invite && token) {
          // Give JS state a very short settle time (invite may arrive just after the
          // native answer event). 100 ms is enough — 400 ms felt like a noticeable lag.
          console.log('[CALLKEEP_ANSWER] invite not in state, waiting 100ms... callId=' + callId);
          await new Promise<void>((r) => setTimeout(r, 100));
          invite = await resolveInviteForAction(callId);
        }

        if (!invite) {
          console.warn('[CALLKEEP_ANSWER] no invite found for callId=' + callId + ', ending native call');
          endNativeCall(callId);
          return;
        }

        console.log('[CALLKEEP_ANSWER] invite resolved +' + (Date.now() - t0) + 'ms inviteId=' + invite.id + ' from=' + invite.fromNumber);
        emitAnswerFlowEvent("CALLKEEP_ANSWER_TAPPED", invite, { source: "native_callkeep", resolveMs: Date.now() - t0 });
        // No deferForegroundUntilConnected — bring app to foreground immediately after
        // respondInvite succeeds so the active call screen appears right away (same
        // timing as answering from the in-app incoming call screen).
        await handleAcceptInvite(invite, callId);
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

  // ── Flight recorder: configure auth token + drain queue on foreground ────────
  useEffect(() => {
    const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL || "https://app.connectcomunications.com/api";
    configureFlightRecorder({
      apiBaseUrl: API_BASE,
      getAuthToken: () => token,
    });
    if (token) {
      flightDrainQueue();
    }
  }, [token]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') flightDrainQueue();
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

      // For the "answer" deep-link path (user tapped Answer on the
      // heads-up / full-screen intent), promote directly to ActiveCallScreen
      // so the IncomingCallScreen never even mounts. Previously we set
      // `incomingInvite` first → RootNavigator rendered IncomingCallScreen
      // → handleAcceptInvite then cleared it a few frames later, which
      // produced a ~100-300ms ghost flash of the incoming UI before the
      // call screen appeared.
      //
      // For the "open" path (user tapped the notification body, not a
      // button), we do still want IncomingCallScreen so they can choose
      // Answer / Decline in-app.
      if (action === "answer") {
        if (answerHandoffInviteIdRef.current !== inviteId) {
          answerHandoffInviteIdRef.current = inviteId;
          setAnswerHandoffTick((n) => n + 1);
        }
        if (fallbackInvite) {
          answerInviteRef.current = fallbackInvite;
        }
      } else if (fallbackInvite) {
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
          // Roll back the preemptive handoff so we don't leave the UI
          // stuck on a fake ActiveCall if the invite couldn't be resolved.
          if (answerHandoffInviteIdRef.current === inviteId) {
            answerHandoffInviteIdRef.current = null;
            setAnswerHandoffTick((n) => n + 1);
          }
          endNativeCall(inviteId);
        }
      } else {
        await handleDeclineInvite(invite, inviteId);
      }

      if (!cancelled) processingIncomingActionRef.current = null;
    })().catch((e: any) => {
      // Surface real error (was previously silently swallowed).
      console.error('[Notif] Incoming action IIFE failed:', e?.message || String(e), e?.stack || '');
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
      // Filter out expired / long-stale invites before we touch any UI —
      // see filterFreshInvites for the freshness window. The backend has
      // been known to keep old PENDING invites around, which used to
      // surface as a permanent "INCOMING" row in the call drawer.
      const pendingRaw = await getPendingInvites(token).catch(() => []);
      const pending = filterFreshInvites(pendingRaw as CallInvite[]);
      if (pendingRaw.length !== pending.length) {
        console.log('[Notif] dropped stale pending invites count=' + (pendingRaw.length - pending.length));
      }
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

    const pushSub = Notifications.addNotificationReceivedListener(async (evt) => {
      const data = evt.request.content.data as MobilePushPayload;
      const now = Date.now();

      // If notification data is null/empty (common when IncomingCallFirebaseService.java
      // handles the FCM message first), try to recover from the native cache file.
      if (!data?.type) {
        const stored = await AsyncStorage.getItem(PENDING_CALL_STORAGE_KEY).catch(() => null);
        const cached = safeParse(stored);
        if (cached?.inviteId && cached?.type === 'INCOMING_CALL') {
          if (suppressedIncomingInviteIdsRef.current.has(String(cached.inviteId))) {
            console.log('[CALL_INCOMING] foreground listener: recovered invite is suppressed, ignoring', cached.inviteId);
            return;
          }
          console.log('[CALL_INCOMING] foreground listener: data null, recovered from AsyncStorage inviteId=', cached.inviteId);
          const invite = payloadToInvite({ ...cached, _pushReceivedAt: now });
          if (invite?.id) {
            safeSetInvite(invite);
          }
        }
        return;
      }

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
        // Belt-and-braces silence: stop the native Android ringtone + dismiss
        // the native full-screen UI regardless of JS state. The native service
        // ALSO receives this FCM (handleCallTerminationNative) and does the
        // same, but we can't rely on delivery order and on some OEMs the
        // service is killed while JS is foregrounded. Calling dismiss twice
        // is a no-op.
        try {
          const mod = (NativeModules as any)?.IncomingCallUi;
          if (mod && typeof mod.stopRingtone === "function") {
            mod.stopRingtone(String(data.inviteId || ""));
          }
          if (mod && typeof mod.dismiss === "function") {
            mod.dismiss(String(data.inviteId || ""));
          }
        } catch {
          /* ignore */
        }
        try {
          stopAllTelephonyAudio().catch(() => undefined);
        } catch {
          /* ignore */
        }
        // Permanently suppress this inviteId so late recovery paths
        // (AsyncStorage, background task, native cache) can't bring the
        // incoming UI back for a call that's already terminated.
        if (data.inviteId) {
          suppressedIncomingInviteIdsRef.current.add(String(data.inviteId));
        }
        setIncomingInvite((prev) => {
          if (!prev || prev.id !== data.inviteId) return prev;
          endNativeCall(prev.id);
          AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
          if (data.type === "INVITE_CANCELED") {
            showEndedState(
              prev,
              "Call ended",
              { reason: "remote_hangup" },
              900,
            );
            return prev;
          }
          // INVITE_CLAIMED (answered on another device): dismiss immediately.
          clearExpireTimer();
          shownInviteIdRef.current = null;
          setIncomingCallUiState({ phase: "idle", inviteId: null, error: null });
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
      // Mirror into flight recorder
      if (sip.callState === "ended") {
        flightRecord('SIP', 'CALL_ENDED', { severity: 'info', payload: { sipCallState: 'ended' } });
        flightRecordNativeRingtone();
        void flightEndCall('ended');
        // Latency summary: the call-state transition to `ended` is the
        // single authoritative terminal for every inbound call (normal
        // hangup, remote BYE, failure after answer, abandoned ring). We
        // summarize and reset the timeline here so each call produces
        // exactly one `--- TIMELINE --- … --- END ---` block, regardless
        // of which failure / success branch took us here.
        const endedInviteId =
          answerInviteRef.current?.id ??
          answerHandoffInviteIdRef.current ??
          shownInviteIdRef.current ??
          null;
        if (endedInviteId) {
          markCallLatency(endedInviteId, "CALL_ENDED");
          summarizeCallLatency(endedInviteId, "ended");
          resetCallLatency(endedInviteId);
        }
      }
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
      answeredFromBackgroundRef,
      answeredFromLockScreenRef,
      answerInviteRef,
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
