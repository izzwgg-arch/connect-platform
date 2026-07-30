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
import * as SecureStore from "expo-secure-store";
import { AppState, Linking, NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from "react-native";
import { showAppAlert } from "../components/ui/appAlert";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  getMediaTestStatus,
  getMobileInviteAnswerStatus,
  getPendingInvites,
  heartbeatVoiceDiagSession,
  postVoiceDiagEvent,
  postWakeEvent,
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
  associateCallIds,
  endAllNativeCalls,
  endNativeCall,
  moveAppToBackground,
  setupNativeCalling,
  showIncomingNativeCall,
  subscribeNativeCallActions,
} from "../sip/callkeep";
import { startIosForegroundActiveHeartbeat } from "../sip/iosForegroundActiveHeartbeat";
import {
  subscribeTelecomActions,
  terminateTelecomCall,
  markTelecomActive,
  TELECOM_ANCHOR_PREFIX,
} from "../sip/telecom";
import { initVoipPushListener, getCachedVoipPushToken } from "../sip/voipPush";
import { isStandingRegistrationEnabled } from "../config/featureFlags";
// NOTE: stopAllTelephonyAudio is imported statically here rather than via
// `void import("../audio/telephonyAudio").then(...)`. The dynamic-import
// pattern was throwing `Object is not a function` inside teardown paths
// (seen in the `killAll telephonyAudio import threw` log), which short-
// circuited every subsequent teardown step — most notably the
// moveAppToBackground call that returns the user to the lock screen on
// remote cancel. Static import guarantees the function exists before we
// call it and keeps teardown fully synchronous.
import { stopAllTelephonyAudio } from "../audio/telephonyAudio";
import { syncMobileIncomingRingtoneToNative } from "../audio/ringtonePreferences";
import { appendCallRecord } from "../storage/callHistory";
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
import { uploadAndClearIosRingLog } from "../diagnostics/iosRingLog";
import {
  MOBILE_SIP_ANSWER_INITIAL_WAIT_MS,
  MOBILE_SIP_ANSWER_PRECLAIM_WAIT_MS,
  MOBILE_SIP_ANSWER_POST_ACCEPT_EXTRA_MS,
  MOBILE_SIP_ANSWER_MAX_WAIT_MS,
  createSipAnswerDeadline,
} from "../sip/mobileAnswerTiming";
import type { SipAnswerTraceEvent } from "../sip/types";
import { loadKeepAliveGate } from "../sip/keepAliveGate";
import {
  shouldSuppressForegroundPush,
  shouldPresentForegroundUserAlert,
  userAlertChannelId,
  isNotificationForCurrentUser,
  setCurrentNotificationIdentity,
} from "../notifications/notificationRouting";
import { decodeJwtPayloadLoose } from "../voicemail/vmGreetingInviteUtils";
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
      // Push-wake (Option 2): silent, no UI. Always suppress the system banner.
      "INCOMING_CALL_WAKE",
      "INVITE_CLAIMED",
      "INVITE_CANCELED",
      "MISSED_CALL",
    ]);
    if (CALL_TYPES.has(type)) {
      return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: false };
    }
    const USER_ALERT_TYPES = new Set(["voicemail", "missed_call", "dm_message", "sms_message"]);
    if (USER_ALERT_TYPES.has(type)) {
      // Per-user isolation: never display an alert addressed to a different
      // signed-in user (defends against stale/rotated push tokens).
      if (!isNotificationForCurrentUser(data)) {
        return { shouldShowAlert: false, shouldPlaySound: false, shouldSetBadge: false };
      }
      if (data?.alertTitle) {
        return { shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false };
      }
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
    if (shouldSuppressForegroundPush(data)) {
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
  /**
   * True when the auto-retry loop has a backoff timer pending for the next
   * registration attempt. Used by the Settings UI to render "Retrying…" rather
   * than a flat "Missing" so users on devices where Google Play Services is
   * temporarily unavailable (common on Moto G / Lenovo / older Android 14
   * builds returning SERVICE_NOT_AVAILABLE) understand the app is recovering
   * on its own and they don't need to keep tapping the row.
   */
  pushTokenRetrying: boolean;
  /** Android: whether we believe battery optimization may interfere */
  batteryOptimizationWarning: boolean;
  /**
   * Android: the REAL OS battery-optimization exemption state, read live from
   * the native module (`isBatteryOptimizationIgnored`).
   *   true  = app is exempt from Doze/optimization (good)
   *   false = still being optimized (calls may not ring in background)
   *   null  = unknown / not yet checked / non-Android
   * This is the source of truth for the Settings row — never a guess.
   */
  batteryOptimizationIgnored: boolean | null;
  /**
   * Microphone (RECORD_AUDIO) runtime-permission state, read live from
   * `PermissionsAndroid.check`. Surfaced in Settings so a user who dismissed
   * the first-run mic prompt can re-grant it. "unknown" until first checked.
   */
  microphonePermission: "granted" | "denied" | "unknown";
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
  /**
   * Android: fire the system Doze-exemption "Allow" dialog directly (single-tap
   * on most OEMs), then re-check the live status. Falls back to the settings
   * deep-link when the native request module is unavailable.
   */
  requestBatteryOptimizationExclusion: () => Promise<void>;
  requestNotificationPermission: () => Promise<void>;
  /** Android: request the microphone (RECORD_AUDIO) runtime permission, then re-check. */
  requestMicrophonePermission: () => Promise<void>;
  /** Re-query the live OS state for battery optimization + microphone permission. */
  refreshDeviceReadiness: () => Promise<void>;
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
  | "RETURNED_TO_QUICK_ACTION"
  // Phase 7c — cold-start answer-deferral lifecycle
  | "ANSWER_DEFERRED_AWAITING_SIP"
  | "ANSWER_DEFERRED_EXECUTED"
  | "ANSWER_DEFERRED_TIMEOUT"
  | "ANSWER_DEFERRED_STALE_CALL";

const NotificationsCtx = createContext<NotificationsState | undefined>(
  undefined,
);

const EXPO_PUSH_TOKEN_KEY = "cc_mobile_expo_push_token";
const INSTALLATION_DEVICE_ID_KEY = "cc_mobile_device_id";

const IOS_DECLINE_GRACE_MS = 1500;
type IncomingCallAction = "open" | "answer" | "decline" | "reply";

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

/**
 * Mirror of the telephony service's `looksDivertedToVoicemail` channel check
 * (apps/telephony/.../MobilePushNotifier.ts). The mobile answer-status poll
 * only receives the active channel name strings, so we inspect those for the
 * voicemail markers Asterisk leaves on the channel once a call rolls into the
 * VoiceMail() app. Used purely to pick the right "call ended" wording when a
 * still-ringing invite is answered away from this device.
 */
function channelsLookLikeVoicemail(channels: unknown): boolean {
  if (!Array.isArray(channels)) return false;
  const joined = channels.map((c) => String(c || "")).join(" ").toLowerCase();
  return (
    joined.includes("voicemail") ||
    joined.includes("vmail") ||
    joined.includes("@vm") ||
    joined.includes("app-voicemail")
  );
}

// Telephony channel states that mean the call is truly over. Anything else
// (UP, RINGING, EARLY, …) means a ring group is still alerting.
const TERMINAL_TELEPHONY_STATES = new Set([
  "HUNGUP", "HANGUP", "CANCELED", "CANCELLED", "ENDED", "TERMINATED", "NONE", "",
]);

type PollStatusSnapshot = {
  telephonyState: string;
  pbxAnswered: boolean;
  extensionAnswered: boolean;
  inviteStatus: string;
  reachedVoicemail: boolean;
  at: number;
};

// True when the most recent backend INVITE_POLL still reports the call as a
// live, ringing inbound call. This is the AUTHORITATIVE "is the call still
// alive" signal — it stays PENDING + telephonyState=up the whole time a ring
// group rings and only flips to voicemail / extensionAnswered / a terminal
// telephony state when the call genuinely ends. Local SIP leg state is NOT
// reliable here because ring groups fork + CANCEL + re-INVITE rapidly.
function pollSnapshotSaysLive(
  poll: PollStatusSnapshot | null,
  maxAgeMs = 3_500,
): boolean {
  if (!poll) return false;
  if (Date.now() - poll.at >= maxAgeMs) return false;
  return (
    poll.inviteStatus === "PENDING" &&
    !poll.reachedVoicemail &&
    !poll.extensionAnswered &&
    !TERMINAL_TELEPHONY_STATES.has(poll.telephonyState)
  );
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
    if (rawAction !== "open" && rawAction !== "answer" && rawAction !== "decline" && rawAction !== "reply") {
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

async function getStableInstallationDeviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(INSTALLATION_DEVICE_ID_KEY).catch(() => null);
  if (existing) return existing;
  const next = `mobile-${Platform.OS}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await SecureStore.setItemAsync(INSTALLATION_DEVICE_ID_KEY, next).catch(() => undefined);
  return next;
}

function mobileAppVersion(): string {
  const nativeVersion = Constants.nativeApplicationVersion || Constants.expoConfig?.version || "unknown";
  const nativeBuild = Constants.nativeBuildVersion || "";
  return nativeBuild ? `${nativeVersion}+${nativeBuild}` : nativeVersion;
}

/**
 * Returns the metadata sent to /mobile/devices/register on every app start.
 *
 * Manufacturer / model / osVersion power the backend's call-wake diagnostics
 * surface so we can correlate "Samsung SM-S921 / S24" vs "Samsung SM-S931 /
 * S25" without guessing — this is what lets us prove an S25-specific wake
 * regression once and for all.
 *
 * Native module values win over expo-device because the Android bridge
 * returns the OEM Build.* strings exactly as Android sees them, which the
 * backend can match against known device-class regressions.
 */
async function mobileDeviceRegistrationMetadata() {
  let manufacturer: string | undefined;
  let model: string | undefined;
  let osVersion: string | undefined;
  if (Platform.OS === "android") {
    try {
      const native = (NativeModules as any).IncomingCallUi?.getDeviceInfo?.();
      if (native && typeof native === "object") {
        manufacturer = String(native.manufacturer || "") || undefined;
        model = String(native.model || "") || undefined;
        osVersion = String(native.osVersion || "") || undefined;
      }
    } catch {
      // fall through to expo-device fallback below
    }
  }
  if (!manufacturer) manufacturer = (Device.manufacturer || undefined) ?? undefined;
  if (!model) model = (Device.modelName || undefined) ?? undefined;
  if (!osVersion) osVersion = (Device.osVersion || undefined) ?? undefined;

  // Snapshot the runtime permissions that affect call delivery / answer.
  // Sent to the backend on every register so /admin/call-wake-diagnostics
  // can render a per-device permission badge and the auto-triage can flag
  // "missing RECORD_AUDIO" as a likely cause of answer-then-disconnect.
  let permRecordAudio: boolean | undefined;
  let permNotifications: boolean | undefined;
  if (Platform.OS === "android") {
    try {
      permRecordAudio = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      );
    } catch {
      permRecordAudio = undefined;
    }
  } else {
    // iOS records the mic permission inside react-native-webrtc; we don't
    // have a reliable sync probe here, so we leave it undefined and rely
    // on the in-call answer pipeline to surface failures. This still
    // populates the Android-side badge which is the actual S25 path we're
    // debugging.
    permRecordAudio = undefined;
  }
  try {
    const perm = await Notifications.getPermissionsAsync().catch(() => null);
    if (perm) permNotifications = perm.status === "granted";
  } catch {
    permNotifications = undefined;
  }
  const permissions =
    permRecordAudio !== undefined || permNotifications !== undefined
      ? {
          ...(permRecordAudio !== undefined ? { recordAudio: permRecordAudio } : {}),
          ...(permNotifications !== undefined ? { notifications: permNotifications } : {}),
        }
      : undefined;

  // Snapshot the SipKeepAliveService FGS state at register time. This is
  // the single most important signal for triaging "calls don't ring on
  // backgrounded S25 / Android 15" — if isRunning=false +
  // lastForegroundResult="threw" + lastForegroundErrorClass="ForegroundService
  // TypeNotAllowedException", we know Android killed our PHONE_CALL FGS and
  // the WSS socket is unprotected. Surfaced on /admin/call-wake-diagnostics
  // so an operator can spot it without asking the user to open Diagnostics.
  let keepAlive:
    | {
        isRunning?: boolean;
        serviceCreatedAtMs?: number;
        serviceDestroyedAtMs?: number;
        lastStartResult?: string;
        lastStartErrorClass?: string;
        lastForegroundResult?: string;
        lastForegroundTypeUsed?: string;
        lastForegroundErrorClass?: string;
        // 2026-06-17 hardening additions.
        foregroundLandedAtMs?: number;
        process?: string;
        rearmCount?: number;
        batteryOptimizationIgnored?: boolean;
        // Adaptive activation gate (keepAliveGate.ts). `gateNeeded=false` means
        // the FGS is intentionally dormant on this device because it has not yet
        // observed a background-delivery failure — NOT a fault.
        gateNeeded?: boolean;
        gateReason?: string;
        gateLatchedAtMs?: number;
        gateDropCount?: number;
      }
    | undefined;
  if (Platform.OS === "android") {
    try {
      const mod = (NativeModules as any).IncomingCallUi;
      const diag = mod?.getCallWakeDiagnostics?.();
      if (diag && typeof diag === "object") {
        let batteryIgnored: boolean | undefined;
        try {
          if (typeof mod?.isBatteryOptimizationIgnored === "function") {
            batteryIgnored = Boolean(await mod.isBatteryOptimizationIgnored());
          }
        } catch {
          batteryIgnored = undefined;
        }
        keepAlive = {
          isRunning: Boolean(diag.keepAliveIsRunning),
          serviceCreatedAtMs: Number(diag.keepAliveServiceCreatedAtMs) || 0,
          serviceDestroyedAtMs: Number(diag.keepAliveServiceDestroyedAtMs) || 0,
          lastStartResult: String(diag.keepAliveLastStartResult ?? ""),
          lastStartErrorClass: String(diag.keepAliveLastStartErrorClass ?? ""),
          lastForegroundResult: String(diag.keepAliveLastForegroundResult ?? ""),
          lastForegroundTypeUsed: String(diag.keepAliveLastForegroundTypeUsed ?? ""),
          lastForegroundErrorClass: String(diag.keepAliveLastForegroundErrorClass ?? ""),
          foregroundLandedAtMs: Number(diag.keepAliveForegroundLandedAtMs) || 0,
          process: String(diag.keepAliveProcess ?? ""),
          rearmCount: Number(diag.keepAliveRearmCount) || 0,
          ...(batteryIgnored !== undefined ? { batteryOptimizationIgnored: batteryIgnored } : {}),
        };
      }
    } catch {
      // Native module not available (older builds, iOS, etc.) — leave undefined.
    }
    // Adaptive activation gate — report regardless of the native diag so the
    // dashboard can distinguish "FGS dormant because not needed" from "FGS
    // failed to start". Independent of `diag` availability.
    try {
      const gate = await loadKeepAliveGate();
      keepAlive = {
        ...(keepAlive ?? {}),
        gateNeeded: gate.needed,
        gateReason: gate.reason,
        gateLatchedAtMs: gate.latchedAtMs,
        gateDropCount: gate.dropCount,
      };
    } catch {
      /* gate optional */
    }
  }

  return {
    deviceId: await getStableInstallationDeviceId(),
    appVersion: mobileAppVersion(),
    deviceName: Device.modelName || `${Platform.OS}-device`,
    ...(manufacturer ? { manufacturer } : {}),
    ...(model ? { model } : {}),
    ...(osVersion ? { osVersion } : {}),
    ...(permissions ? { permissions } : {}),
    ...(keepAlive ? { keepAlive } : {}),
  };
}

async function readCachedInvite(matchInviteId?: string): Promise<CallInvite | null> {
  const cached = safeParse(
    await AsyncStorage.getItem(PENDING_CALL_STORAGE_KEY).catch(() => null),
  );
  if (!cached?.inviteId) return null;
  if (matchInviteId && cached.inviteId !== matchInviteId) return null;
  return payloadToInvite(cached);
}

/**
 * Classifies a push-token error string as worth retrying automatically.
 *
 * The most common one we see in the wild is Google Play Services' transient
 * `SERVICE_NOT_AVAILABLE` (Moto G / Lenovo / some Samsung Android 14 builds
 * after a Play Services update or after the user clears Play Services data —
 * Play Services takes 30s to several minutes to mint a fresh FCM registration
 * token, and during that window every getToken() call throws). These errors
 * self-heal as soon as Play Services is ready, so retrying with backoff turns
 * a permanent-looking "Push Token Missing" into a "registers within 1–10
 * minutes without the user touching anything".
 *
 * Non-retryable cases include misconfigured `google-services.json`, missing
 * EAS project ID, or notification permission denied — those will never fix
 * themselves and we should let the user act on the error message.
 */
function isRetryablePushTokenError(error: string | null | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes("service_not_available") ||
    lower.includes("io.ioexception") ||
    lower.includes("ioexception") ||
    lower.includes("network") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("unavailable") ||
    lower.includes("temporarily") ||
    // Expo's getDevicePushTokenAsync wraps the underlying FCM exception in
    // strings like "FCM unavailable: …" — match that prefix too.
    lower.includes("fcm unavailable") ||
    lower.includes("execution") // ExecutionException from FCM getToken()
  );
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
    await Notifications.setNotificationChannelAsync("connect-messages", {
      name: "Messages",
      importance: Notifications.AndroidImportance.HIGH,
      sound: "default",
      vibrationPattern: [0, 160],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      enableVibrate: true,
      showBadge: true,
    });
    await Notifications.setNotificationChannelAsync("connect-voicemail", {
      name: "Voicemail",
      importance: Notifications.AndroidImportance.HIGH,
      sound: "default",
      vibrationPattern: [0, 220, 120, 220],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      enableVibrate: true,
      showBadge: true,
    });
    await Notifications.setNotificationChannelAsync("connect-missed-calls", {
      name: "Missed Calls",
      importance: Notifications.AndroidImportance.HIGH,
      sound: "default",
      vibrationPattern: [0, 300, 120, 300],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      enableVibrate: true,
      showBadge: true,
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
    fromPrefix: data.fromPrefix || null,
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
  showAppAlert(
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

  // Keep the module-level notification identity in sync with the signed-in user
  // so the (import-time) notification handler can enforce per-user isolation:
  // a notification addressed to a different userId/tenantId is never shown.
  useEffect(() => {
    if (!token) {
      setCurrentNotificationIdentity(null);
      return;
    }
    const claims = decodeJwtPayloadLoose(token) as { sub?: unknown; tenantId?: unknown } | null;
    setCurrentNotificationIdentity({
      userId: claims?.sub != null ? String(claims.sub) : null,
      tenantId: claims?.tenantId != null ? String(claims.tenantId) : null,
    });
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

  // Mirror whether a live inbound SIP INVITE is currently ringing. The invite
  // poll uses this to tell a genuine "answered on another device" (our SIP leg
  // was CANCELed → no live session) from ring-group early media (our INVITE is
  // still ringing, so the call is answerable here regardless of the PBX
  // inbound-leg "up"/pbxAnswered signal). Read synchronously inside the poll
  // tick so it never gates on a stale closure value.
  //
  // We must consult the multi-call store's ringing sessions, NOT just the
  // legacy `sip.callState`. Ring groups fork into multiple simultaneous INVITE
  // legs; JsSIP only drives the legacy `sip.callState` for the FIRST leg, so
  // after the first leg is CANCELed and replaced by re-INVITE legs the legacy
  // state can read "ended" while live `ringing_inbound` sessions (each with a
  // real sipSessionId) still exist in the store. Keying only on sip.callState
  // made the gate read false and let the false "answered_on_another_device"
  // teardown through (observed: store had ringing:[6eefbb6a…] at teardown).
  const liveInboundRingingRef = useRef<boolean>(false);
  // True once a live inbound SIP leg has appeared for the CURRENT invite, and
  // stays true after it disappears — the cancel bridge uses this to distinguish
  // "the call's SIP leg ended (stop ringing)" from "the SIP INVITE hasn't
  // arrived yet (keep waiting)". Reset per invite id.
  const hadLiveInboundSipRef = useRef<boolean>(false);
  const trackedInviteIdRef = useRef<string | null>(null);
  const multiCallInboundRinging = callSessions.ringingCalls.some(
    (cs) => !!cs.sipSessionId,
  );
  // NOTE: the effect that maintains these refs lives just after the
  // `incomingInvite` state declaration below, because it reads `incomingInvite`
  // to reset the per-call latch.

  // Latest authoritative disposition observed by the invite poll for the
  // in-flight inbound call. The SIP cancel bridge reads this so that, if the
  // PBX CANCEL beats the next poll tick, it still renders the correct end-state
  // label ("Answered on another device" vs the neutral "Call ended") instead of
  // always falling back to "Call ended". Reset to 'unknown' per call.
  const lastPollDispositionRef = useRef<
    'unknown' | 'answered_elsewhere' | 'voicemail'
  >('unknown');

  // Snapshot of the most recent poll's telephony signals, so the SIP cancel
  // bridge can classify WHY the leg ended (voicemail vs answered-elsewhere vs
  // caller-hangup) even when the leg dies between poll ticks.
  const lastPollStatusRef = useRef<PollStatusSnapshot | null>(null);

  // Wall-clock time the current incoming-call UI was first shown in JS. Used by
  // the app-resume orphan reconcile to avoid clearing a brand-new call whose
  // SIP INVITE simply hasn't landed yet (FCM-first race). Robust regardless of
  // whether the invite payload carried a push timestamp.
  const incomingInviteShownAtRef = useRef<number>(0);
  // Timestamp the inbound SIP leg FIRST went away (0 = currently live / no call).
  // The cancel-bridge teardown fires at this + the fork-abandon window so that
  // legacy sip.callState micro-transitions (ringing→ended→idle) re-running the
  // effect cannot keep pushing the teardown later — it stays anchored to when
  // the PBX actually stopped offering us the call.
  const inboundLegGoneAtRef = useRef<number>(0);

  const [expoPushToken, setExpoPushToken] = useState<string | null>(null);
  // iOS VoIP push token (hex, delivered by PushKit). Null on Android and on
  // iOS until the device registers with Apple — the register event can take
  // a few seconds on first launch. See src/sip/voipPush.ts for lifecycle.
  const [voipPushToken, setVoipPushToken] = useState<string | null>(() => getCachedVoipPushToken());
  // Remember which VoIP token we've already pushed to the backend so we
  // don't spam registerMobileDevice on every re-render. A change (rotation
  // or late first-arrival) triggers exactly one re-register.
  const lastSentVoipTokenRef = useRef<string | null>(null);
  const [incomingInvite, setIncomingInvite] = useState<CallInvite | null>(null);
  const [incomingCallUiState, setIncomingCallUiState] = useState<NotificationsState["incomingCallUiState"]>({
    phase: "idle",
    inviteId: null,
    error: null,
  });

  // Maintain the live-inbound-SIP latch (declared above) for the current invite.
  // Kept here, after `incomingInvite`, so it can reset the latch per invite id.
  useEffect(() => {
    const currentId = incomingInvite?.id ?? null;
    if (currentId !== trackedInviteIdRef.current) {
      trackedInviteIdRef.current = currentId;
      hadLiveInboundSipRef.current = false;
    }
    const sipRinging =
      sip.callState === "ringing" && sip.callDirection === "inbound";
    const live = sipRinging || multiCallInboundRinging;
    liveInboundRingingRef.current = live;
    if (live) hadLiveInboundSipRef.current = true;
  }, [sip.callState, sip.callDirection, multiCallInboundRinging, incomingInvite]);
  const [callReadiness, setCallReadiness] = useState<CallReadiness>({
    notificationPermission: "undetermined",
    pushTokenRegistered: false,
    pushTokenError: null,
    pushTokenRetrying: false,
    batteryOptimizationWarning: Platform.OS === "android" && !!Device.isDevice,
    batteryOptimizationIgnored: null,
    microphonePermission: "unknown",
    isFullyReady: false,
  });

  const deviceIdRef = useRef<string | null>(null);
  // iOS foreground-active heartbeat reads the current token via this ref
  // (see src/sip/iosForegroundActiveHeartbeat.ts). iOS-only; no-op on Android.
  const fgHeartbeatTokenRef = useRef<string | null>(null);
  const diagSessionIdRef = useRef<string | null>(null);
  const lastRegStateRef = useRef<string>("idle");
  const lastCallStateRef = useRef<string>("idle");
  const handledIncomingActionKeysRef = useRef<Set<string>>(new Set());
  const processingIncomingActionRef = useRef<string | null>(null);
  const inviteActionInFlightRef = useRef<Set<string>>(new Set());
  const consumedInviteActionRef = useRef<Set<string>>(new Set());
  const pendingDeclineTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [pendingIncomingAction, setPendingIncomingAction] =
    useState<ParsedIncomingCallAction | null>(null);

  // iOS-only: run the foreground-active heartbeat so the server skips the VoIP
  // push while the app is open — preventing the native CallKit screen / ring /
  // no-audio conflict on top of the in-app Connect incoming screen. Android:
  // startIosForegroundActiveHeartbeat is a hard no-op (Platform.OS gate).
  useEffect(() => {
    fgHeartbeatTokenRef.current = token ?? null;
  }, [token]);
  useEffect(() => {
    return startIosForegroundActiveHeartbeat({
      getToken: () => fgHeartbeatTokenRef.current,
      getDeviceId: () => deviceIdRef.current,
    });
  }, []);

  // Tracks inviteId currently shown to prevent duplicates
  const shownInviteIdRef = useRef<string | null>(null);
  // Invites we have already asked the backend to pre-deliver (ring-time
  // INVITE requeue). Prevents firing the requeue more than once per call.
  const preDeliverRequeuedRef = useRef<Set<string>>(new Set());
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
  // Set when the user tapped "Reply" on the incoming-call notification: the
  // IncomingCallScreen auto-opens the quick-reply sheet for this invite and
  // then calls clearQuickReplyRequest().
  const [quickReplyInviteId, setQuickReplyInviteId] = useState<string | null>(null);
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
  // Phase 7c — cold-start answer-deferral queue. When CallKit's `answerCall`
  // fires before the invite metadata is resolvable (cold-killed launch: in-memory
  // state empty, auth token not yet hydrated, AsyncStorage/native-cache not yet
  // written by the VoIP listener), we MUST NOT drop the tap (the pre-7c bug:
  // `endNativeCall` + return). Instead we record the accepted callId here and a
  // background loop replays the real answer (`handleAcceptInvite`) the instant the
  // invite resolves and SIP is (being) registered. Keyed by callId; `running`
  // guards against launching two loops for the same tap (iOS can redeliver
  // `answerCall`).
  const pendingNativeAcceptRef = useRef<
    Map<string, { tappedAt: number; running: boolean }>
  >(new Map());

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
      // The ring resolved to a non-answer terminal state (expired, missed,
      // caller hung up, answered-elsewhere, register/INVITE failure). Release
      // any prewarmed inbound mic. Idempotent: a no-op if an answered call
      // already consumed/released it (released by the JsSIP terminal handlers).
      sip.releasePrewarmedMedia("ring_ended");
      emitAnswerFlowEvent("CALL_ENDED_UI_SHOWN", invite, {
        message,
        delayMs,
        ...extra,
      });
      setIncomingUiPhase("ended", invite, message);
      scheduleIncomingUiReset(invite?.id || null, delayMs);
    },
    [emitAnswerFlowEvent, scheduleIncomingUiReset, setIncomingUiPhase, sip],
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

      // ── Self-loop guard ────────────────────────────────────────────────
      // A push-layer invite where the caller (`fromNumber`) and the
      // recipient (`toExtension`) are the same extension is always
      // nonsense — there is no legitimate way for an extension to ring
      // itself. In practice this happens when the user dials an external
      // DID that loops back through the PBX (IVR option, follow-me, or
      // a trunk-routed callback) and Asterisk re-injects the call as an
      // "inbound" leg with caller-id preserved from the original outbound
      // dial. The PBX-level "is this a loopback?" check isn't reachable
      // from the push notifier (different pbxCallId / linkedId on the
      // loop-back leg), so we filter at the device using the data the
      // invite already carries. Without this the user sees a phantom
      // "Call Waiting" banner from their own extension on top of an
      // active outbound call.
      const fromExtRaw = (invite.fromNumber ?? "").trim();
      const toExtRaw = (invite.toExtension ?? "").trim();
      if (fromExtRaw && toExtRaw && fromExtRaw === toExtRaw) {
        console.log(
          '[Notif] Suppressing self-loop invite id=' + invite.id +
          ' fromNumber=' + fromExtRaw +
          ' toExtension=' + toExtRaw,
        );
        suppressedIncomingInviteIdsRef.current.add(invite.id);
        try {
          callSessions.removeInboundInvite(invite.id, 'self_loop');
        } catch { /* ignore */ }
        return;
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

      // ══════════════════════════════════════════════════════════════════
      // RING-TIME INVITE PRE-DELIVERY (eliminates the answer-time claim)
      //
      // On this PBX the SIP INVITE is NOT pushed to the registered endpoint
      // on its own — it is only (re)queued to the device after the backend
      // is told the device is ready (DEVICE_REGISTER_COMPLETE → server-side
      // `register_complete` requeue, server.ts) or after the answer-time
      // ACCEPT/claim. The FCM wake handler in SipContext posts
      // DEVICE_REGISTER_COMPLETE, but on a cold call that native event is
      // DROPPED ("no ReactApplicationContext cached — JS not booted"), so the
      // requeue never fires during the ring and EVERY answer pays the
      // ~800 ms claim round-trip (the dominant remaining answer latency).
      //
      // Fire the requeue HERE — the moment the invite is observed in JS (ring
      // start) — once registration is complete (the requeue needs a live
      // Contact to deliver to). The INVITE then arrives over the live socket
      // DURING the ring; CallSessionManager.onSipSessionAdded correlates it to
      // this ringing invite by caller number (no double-ring), and at answer
      // findIncoming() returns it immediately so the claim is SKIPPED and the
      // connect is effectively instant. If the user answers before the INVITE
      // lands (very fast tap / short ring), the answer pipeline still falls
      // back to the claim path, so this is strictly an optimisation.
      // ══════════════════════════════════════════════════════════════════
      try {
        const pbxCallId = (invite.pbxCallId ?? "").trim();
        const tok = tokenRef.current;
        if (pbxCallId && tok && !preDeliverRequeuedRef.current.has(invite.id)) {
          preDeliverRequeuedRef.current.add(invite.id);
          // register() is idempotent and resolves once REGISTERED.
          void sip
            .register()
            .then(() => {
              console.log(
                "[ANSWER_PIPELINE] ring_predeliver_requeue inviteId=" +
                  invite.id + " pbxCallId=" + pbxCallId,
              );
              return postWakeEvent(tok, {
                pbxCallId,
                stage: "DEVICE_REGISTER_COMPLETE",
                deviceId: deviceIdRef.current,
                details: { source: "ring_predeliver", inviteId: invite.id },
              });
            })
            .catch((e) => {
              console.warn(
                "[ANSWER_PIPELINE] ring_predeliver_requeue failed:",
                e instanceof Error ? e.message : String(e),
              );
            });
        }
      } catch (e) {
        console.warn("[ANSWER_PIPELINE] ring_predeliver threw:", e);
      }

      // Register with the multi-call manager regardless of whether this is the
      // idle (full-screen) path or the call-waiting (banner) path. This gives
      // ActiveCallScreen a CallSession it can render for the waiting UI.
      try {
        callSessions.registerInboundInvite({
          callId: invite.id,
          remoteNumber: invite.fromNumber || "Unknown",
          remoteName: (invite as any).fromDisplay ?? null,
          fromPrefix: (invite as any).fromPrefix ?? null,
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

      // Reaching here means a fresh invite is being shown (the duplicate guard
      // above already returned for repeats). Stamp the show time so the
      // app-resume orphan reconcile can tell a brand-new call (SIP INVITE still
      // in transit) from a genuinely stale leftover UI.
      incomingInviteShownAtRef.current = Date.now();
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

  // Phase 1 / Option 2A — Android-only inbound-answer mic prewarm.
  // Pre-acquire the mic as soon as a ring is shown so JsSIP `answer()` can skip
  // its internal getUserMedia (cuts the 200-OK → ICE-gathering delay). No-op off
  // Android (guarded inside the SIP client) and best-effort. We deliberately do
  // NOT release in this effect's cleanup: the cleanup also fires on the answer
  // transition (incomingInvite clears), and stopping the tracks there would cut
  // the live call's mic. Release is funneled through showEndedState /
  // handleDeclineInvite and the JsSIP session terminal handlers instead.
  useEffect(() => {
    if (!incomingInvite?.id) return;
    // Pair the invite id with the PBX call-id so ending the call tears down
    // EVERY CallKit call the wake/invite pushes created (no stuck lock-screen
    // ring after voicemail, no orphaned green "active call" pill).
    associateCallIds(incomingInvite.id, incomingInvite.pbxCallId ?? null);
    sip.prewarmInboundMedia();
    // iOS cold-answer: warm the WebRTC engine (PeerConnection factory only - no
    // mic, no audio session) during the ring so the first answer completes fast
    // enough that CallKit's audio session activates before it times out.
    if (Platform.OS === "ios") {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { RTCPeerConnection } = require("react-native-webrtc");
        const warmPc = new RTCPeerConnection({ iceServers: [] });
        setTimeout(() => {
          try {
            warmPc.close();
          } catch {
            // ignore
          }
        }, 0);
      } catch {
        // best-effort warm - ignore
      }
    }
  }, [incomingInvite?.id, sip]);

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
      showAppAlert(
        "Notifications required",
        "Connect needs notification permission to show incoming call alerts.\n\nPlease enable it in Android Settings → Apps → Connect → Notifications.",
        [{ text: "OK" }],
      );
    }
  }, []);

  // ── Live device-readiness refresh (battery optimization + microphone) ──────
  //
  // Queries the ACTUAL OS state rather than a guess/"settings were opened"
  // flag. Runs on mount and every foreground so the Settings rows always
  // reflect reality (e.g. the user just toggled "Don't optimize" and came
  // back). No-op / benign on iOS.
  const refreshDeviceReadiness = useCallback(async () => {
    if (Platform.OS !== "android") return;

    // Battery optimization — real exemption state from the native module.
    let batteryIgnored: boolean | null = null;
    try {
      const mod: any = (NativeModules as any)?.IncomingCallUi;
      if (typeof mod?.isBatteryOptimizationIgnored === "function") {
        batteryIgnored = Boolean(await mod.isBatteryOptimizationIgnored());
      }
    } catch {
      batteryIgnored = null;
    }

    // Microphone — real RECORD_AUDIO grant state.
    let micPermission: CallReadiness["microphonePermission"] = "unknown";
    try {
      const granted = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      );
      micPermission = granted ? "granted" : "denied";
    } catch {
      micPermission = "unknown";
    }

    setCallReadiness((prev) => ({
      ...prev,
      batteryOptimizationIgnored: batteryIgnored,
      microphonePermission: micPermission,
    }));
  }, []);

  // ── Request the Doze-exemption dialog directly, then re-check ──────────────
  //
  // Prefers the native `requestBatteryOptimizationExclusion()` which pops the
  // one-tap "Allow" system dialog. Falls back to the multi-OEM settings
  // deep-link (`openBatteryOptimizationSettings`) when that native method
  // isn't present. Either way we re-read the real status afterward.
  const requestBatteryOptimizationExclusion = useCallback(async () => {
    if (Platform.OS !== "android") return;
    try {
      const mod: any = (NativeModules as any)?.IncomingCallUi;
      if (typeof mod?.requestBatteryOptimizationExclusion === "function") {
        await mod.requestBatteryOptimizationExclusion();
      } else {
        await openBatteryOptimizationSettings();
      }
    } catch {
      await openBatteryOptimizationSettings().catch(() => undefined);
    }
    // The dialog result lands asynchronously; give it a beat, then re-check.
    await new Promise((r) => setTimeout(r, 600));
    await refreshDeviceReadiness();
  }, [refreshDeviceReadiness]);

  // ── Request the microphone runtime permission, then re-check ───────────────
  const requestMicrophonePermission = useCallback(async () => {
    if (Platform.OS !== "android") return;
    try {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        {
          title: "Microphone access",
          message:
            "Connect needs microphone access so you can be heard on calls.",
          buttonPositive: "Allow",
        },
      );
      if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
        // User previously chose "Don't ask again" — the runtime prompt can no
        // longer appear, so send them to the app's settings page instead.
        showAppAlert(
          "Microphone access needed",
          "Microphone permission is blocked. Enable it in Android Settings → Apps → Connect → Permissions → Microphone.",
          [{ text: "OK" }],
        );
      }
    } catch {
      /* best-effort — re-check below reflects whatever the user chose */
    }
    await refreshDeviceReadiness();
  }, [refreshDeviceReadiness]);

  // ── Retry push token registration ────────────────────────────────────────
  //
  // `pushRetryAttemptRef` is consumed by the auto-retry useEffect lower in this
  // provider to drive exponential backoff on transient FCM errors (the most
  // common one being Google Play Services' SERVICE_NOT_AVAILABLE on Moto G /
  // Lenovo / older Android 14 devices, which self-heals as soon as Play
  // Services finishes minting a fresh registration token). Manual retries
  // reset the counter so the user always gets a fast first attempt; automatic
  // retries preserve it so backoff actually grows.

  const pushRetryAttemptRef = useRef(0);
  const pushRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const retryPushTokenRegistration = useCallback(async (source: "manual" | "auto" = "manual") => {
    if (!token) return;
    const tag = source === "auto" ? "PUSH_RETRY_AUTO" : "PUSH_RETRY";
    console.log(`[${tag}] Retrying push token registration...`);

    if (source === "manual") {
      // User pressed Settings → Push Token → reset backoff so the next failure
      // restarts the auto-retry ladder from the shortest delay.
      pushRetryAttemptRef.current = 0;
      if (pushRetryTimerRef.current) {
        clearTimeout(pushRetryTimerRef.current);
        pushRetryTimerRef.current = null;
      }
    }

    // Re-check permission first
    const perm = await Notifications.getPermissionsAsync().catch(() => null);
    const granted = perm?.status === "granted";
    if (!granted) {
      console.log(`[${tag}] Permission not granted, requesting...`);
      const req = await Notifications.requestPermissionsAsync().catch(() => null);
      if (req?.status !== "granted") {
        console.warn(`[${tag}] Permission denied — cannot register push token`);
        setCallReadiness((prev) => ({
          ...prev,
          notificationPermission: (req?.status ?? "denied") as CallReadiness["notificationPermission"],
          pushTokenRegistered: false,
          pushTokenRetrying: false,
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
    console.log(`[${tag}] Token result:`, pushToken ? "OK" : `FAILED (${pushErr})`);
    if (!pushToken) {
      console.warn(`[${tag}] Still no token after retry. Reason:`, pushErr);
      setCallReadiness((prev) => ({
        ...prev,
        pushTokenRegistered: false,
        pushTokenError: pushErr,
        // The auto-retry effect will set `pushTokenRetrying: true` again when
        // it schedules the next backoff; flip it off here so the UI reflects
        // "this attempt completed (and failed)" before the next timer fires.
        pushTokenRetrying: false,
        isFullyReady: false,
      }));
      return;
    }

    // Attach the iOS VoIP push token (if PushKit has issued one). Android
    // always omits this. The backend accepts `voipPushToken` optionally and
    // stores it on the MobileDevice row; the worker's future APNs VoIP
    // delivery path will read it from there.
    const voipToken = Platform.OS === "ios" ? (getCachedVoipPushToken() ?? undefined) : undefined;
    const metadata = await mobileDeviceRegistrationMetadata();
    const reg = await registerMobileDevice(token, {
      platform: Platform.OS === "ios" ? "IOS" : "ANDROID",
      expoPushToken: pushToken,
      ...(voipToken ? { voipPushToken: voipToken } : {}),
      ...metadata,
    }).catch((e) => {
      console.warn(`[${tag}] registerMobileDevice failed:`, e instanceof Error ? e.message : String(e));
      return null;
    });

    if (reg?.id) deviceIdRef.current = String(reg.id);
    await SecureStore.setItemAsync(EXPO_PUSH_TOKEN_KEY, pushToken).catch(() => undefined);
    console.log(`[${tag}] Registration result — id:`, reg?.id ?? "(none)", "voip:", voipToken ? "yes" : "no");

    pushRetryAttemptRef.current = 0;
    if (pushRetryTimerRef.current) {
      clearTimeout(pushRetryTimerRef.current);
      pushRetryTimerRef.current = null;
    }

    setExpoPushToken(pushToken);
    setCallReadiness((prev) => ({
      ...prev,
      pushTokenRegistered: true,
      pushTokenError: null,
      pushTokenRetrying: false,
      isFullyReady: prev.notificationPermission === "granted",
    }));
  }, [token]);

  // The Settings screen and the AppState foreground listener still call
  // `retryPushTokenRegistration()` with no args (treat as "manual"). Surface
  // an explicit auto-only entrypoint for the backoff effect below so its
  // intent is unambiguous in the call site.
  const autoRetryPushTokenRegistration = useCallback(() => {
    return retryPushTokenRegistration("auto");
  }, [retryPushTokenRegistration]);

  // ── Auto-retry push token registration on transient FCM errors ───────────
  //
  // Goal: turn the user-facing "Push Token: Missing — Error: SERVICE_NOT_AVAILABLE"
  // into a self-healing recovery without the user needing to keep tapping the
  // Settings row. Google Play Services on Moto / Lenovo / older Samsung
  // Android 14 builds frequently throws SERVICE_NOT_AVAILABLE for 30s to a
  // few minutes after Play Services is updated, the device is rebooted, the
  // user clears Play Services data, or comes off airplane mode — and then
  // succeeds without any other change.
  //
  // Strategy:
  //   • Attempt counter (`pushRetryAttemptRef`) tracks how many auto-retries
  //     we've already burned. Reset to 0 on success or on any manual retry.
  //   • Backoff schedule: 8s, 20s, 45s, 90s, 180s, 300s. After the 6th attempt
  //     (~10.8 minutes total) we stop. The user can still tap the Settings
  //     row to manually retry, which resets the ladder.
  //   • Only retry if pushTokenError is classified as retryable
  //     (isRetryablePushTokenError) — non-retryable causes like missing
  //     google-services.json or denied permission stop the loop immediately.
  //   • Do NOT retry if notification permission isn't granted — the OS won't
  //     even let getExpoPushTokenAsync run, and we'd just re-fail forever.
  const PUSH_RETRY_BACKOFFS_MS = [8_000, 20_000, 45_000, 90_000, 180_000, 300_000];
  useEffect(() => {
    if (pushRetryTimerRef.current) {
      clearTimeout(pushRetryTimerRef.current);
      pushRetryTimerRef.current = null;
    }

    if (callReadiness.pushTokenRegistered) {
      // Recovery completed — leave the counter reset done by retry helper.
      return;
    }
    if (!token) return;
    if (callReadiness.notificationPermission !== "granted") return;
    if (!isRetryablePushTokenError(callReadiness.pushTokenError)) return;

    const attempt = pushRetryAttemptRef.current;
    if (attempt >= PUSH_RETRY_BACKOFFS_MS.length) {
      console.warn(
        `[PUSH_RETRY_AUTO] Giving up after ${attempt} attempts. ` +
          `User can still tap the Push Token row in Settings to manually retry. ` +
          `Last error: ${callReadiness.pushTokenError}`,
      );
      // Surface to Settings UI: stop showing "Retrying…" so user knows they
      // need to act.
      setCallReadiness((prev) => (prev.pushTokenRetrying ? { ...prev, pushTokenRetrying: false } : prev));
      return;
    }

    const delay = PUSH_RETRY_BACKOFFS_MS[attempt];
    console.log(
      `[PUSH_RETRY_AUTO] Scheduling retry #${attempt + 1}/${PUSH_RETRY_BACKOFFS_MS.length} ` +
        `in ${Math.round(delay / 1000)}s (last error: ${callReadiness.pushTokenError})`,
    );

    // Mark retrying = true so SettingsScreen can render "Retrying…" instead
    // of just "Missing" while the timer is pending.
    setCallReadiness((prev) => (prev.pushTokenRetrying ? prev : { ...prev, pushTokenRetrying: true }));

    pushRetryTimerRef.current = setTimeout(() => {
      pushRetryAttemptRef.current = attempt + 1;
      autoRetryPushTokenRegistration().catch((e) => {
        console.warn(
          `[PUSH_RETRY_AUTO] Retry attempt #${attempt + 1} threw:`,
          e instanceof Error ? e.message : String(e),
        );
      });
    }, delay);

    return () => {
      if (pushRetryTimerRef.current) {
        clearTimeout(pushRetryTimerRef.current);
        pushRetryTimerRef.current = null;
      }
    };
  }, [
    callReadiness.pushTokenRegistered,
    callReadiness.pushTokenError,
    callReadiness.notificationPermission,
    token,
    autoRetryPushTokenRegistration,
  ]);

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
      // This useCallback closed over `token` at render time. Use a local
      // authToken below so every
      // downstream API call observes the freshly resolved value rather than
      // the potentially stale null closure.
      let resolved: string | null = token ?? tokenRef.current;
      if (!resolved) {
        console.warn('[ACCEPT_GUARD] token not ready, waiting inviteId=' + invite?.id);
        const waitStart = Date.now();
        // 25 ms poll (was 100 ms): on a cold lock-screen answer this loop sits
        // between the user's tap and the entire answer pipeline — keep the
        // post-hydration dead time negligible.
        while (!tokenRef.current && Date.now() - waitStart < 4000) {
          await new Promise<void>((r) => setTimeout(r, 25));
        }
        resolved = tokenRef.current;
        if (!resolved) {
          console.warn('[ACCEPT_GUARD] gave_up_waiting_for_token after ' + (Date.now() - waitStart) + 'ms inviteId=' + invite?.id);
          return;
        }
        console.log('[ACCEPT_GUARD] token ready after ' + (Date.now() - waitStart) + 'ms, proceeding inviteId=' + invite?.id);
      }
      const authToken: string = resolved;

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

        // ── Mic permission preflight (Android only) ─────────────────────────
        // Without RECORD_AUDIO, JsSIP's internal `getUserMedia({ audio: true })`
        // inside `session.answer()` either throws or yields a no-track stream,
        // which causes the call to briefly "answer" then immediately drop —
        // exactly the Samsung Galaxy S25 symptom users were reporting. We
        // also proactively request the permission in SipContext when SIP is
        // ready, so this should be a hot, granted-already check; we still
        // gate here defensively because permissions can be revoked at any
        // time from Android Settings, and proactive request can be denied.
        if (Platform.OS === "android") {
          let micGranted = false;
          try {
            micGranted = await PermissionsAndroid.check(
              PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
            );
          } catch {
            micGranted = false;
          }
          if (!micGranted) {
            console.warn('[ANSWER_GUARD] mic_permission_missing — requesting before answer');
            try {
              const result = await PermissionsAndroid.request(
                PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
                {
                  title: 'Microphone access required',
                  message: 'Allow microphone access to answer this call.',
                  buttonPositive: 'Allow',
                  buttonNegative: 'Cancel',
                },
              );
              micGranted = result === PermissionsAndroid.RESULTS.GRANTED;
            } catch {
              micGranted = false;
            }
          }
          if (!micGranted) {
            console.warn('[ANSWER_GUARD] mic_permission_denied — aborting answer for invite ' + invite.id);
            setCallFlowLastError('mic_permission_denied');
            // Decline the invite on the backend so the caller hears voicemail
            // instead of silent hold-then-drop.
            void respondInvite(authToken, invite.id, 'DECLINE', deviceIdRef.current || undefined).catch(() => undefined);
            showEndedState(
              invite,
              'Microphone access required',
              { reason: 'mic_permission_denied' },
              2000,
            );
            endNativeCall(callId);
            AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
            return;
          }
        }

        // ── Timing: record answer-tap timestamp (needed by register/answer
        //    promises below) ──────────────────────────────────────────────────
        const answerTappedAt = Date.now();
        const pushReceivedAt =
          (invite as any)._pushReceivedAt ||
          timingsRef.current[`push_${invite.id}`] ||
          answerTappedAt;
        timingsRef.current[`answer_${invite.id}`] = answerTappedAt;

        // COWORK cold-answer fix - iOS killed/background ONLY. Android + warm
        // iOS are byte-for-byte unchanged: earlyColdAcceptSent stays false for
        // them and every branch that uses it is gated on it. On a swipe-killed
        // iOS launch the original INVITE went to the now-dead, JsSIP-rotated
        // contact, so no local session arrives and the extension leg dies (~5s)
        // BEFORE the normal accept (which only fires after the invite-wait grace)
        // can trigger the server Mode-B re-delivery. We fire the backend ACCEPT
        // now so Mode-B re-INVITEs our FRESH contact immediately and the re-INVITE
        // lands during the invite-wait below. The claim is idempotent server-side
        // and Mode-B is one-shot, so the accept(s) further down safely no-op.
        let earlyColdAcceptSent = false;
        if (Platform.OS === "ios" && AppState.currentState !== "active") {
          earlyColdAcceptSent = true;
          void respondInvite(
            authToken,
            invite.id,
            "ACCEPT",
            deviceIdRef.current || undefined,
          ).catch(() => undefined);
        }

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
        //
        // STANDING REGISTRATION (server flag, Android): "registered but idle at
        // answer-tap" is the NORMAL healthy state — the PBX only dials the
        // contact after the backend claim, so no INVITE is expected yet, and
        // the socket is actively maintained (FGS + native maintenance
        // re-register). Blind force-restarting here tore down a good UA,
        // rotated the Contact, and added 200-700 ms to every answer. In
        // standing mode only treat the socket as stale when the WebSocket
        // transport is provably DOWN (isConnected() false).
        const standingMode = Platform.OS === "android" && isStandingRegistrationEnabled();
        const sipTransportDown = (() => {
          if (!standingMode) return false;
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const singleton = require("../sip/sipClientSingleton") as typeof import("../sip/sipClientSingleton");
            const client = singleton.peekSipClient() as any;
            if (!client || typeof client.isConnected !== "function") return true;
            return !client.isConnected();
          } catch {
            return true;
          }
        })();
        const sipSocketLooksStale =
          sip.registrationState === "registered" &&
          sip.callState === "idle" &&
          (!standingMode || sipTransportDown);
        if (standingMode && sip.registrationState === "registered" && sip.callState === "idle") {
          console.log(
            "[ANSWER_PIPELINE] standing_mode socket check — transportDown=" + sipTransportDown +
            (sipTransportDown ? " (forcing restart)" : " (healthy, fast path — no UA teardown)"),
          );
        }
        // COWORK cold-answer fix (2026-07-13): on iOS cold answer HOLD the fresh wake registration - never force-restart on the stale-socket heuristic, which mints a new rotated Contact and makes the server Mode-B re-delivery target a dead contact (voicemail). Proven live 1783981096.246385. Warm iOS + Android unchanged (earlyColdAcceptSent=false for them).
        const shouldForceSipRefresh = earlyColdAcceptSent ? sipLooksUnready : (sipLooksUnready || sipSocketLooksStale);
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
        // Regression fix (2026-06-19): use a SHORT pre-claim grace, not the 8 s
        // MOBILE_SIP_ANSWER_INITIAL_WAIT_MS. On this PBX the INVITE only arrives
        // after the backend ACCEPT (claim), so a long pre-claim wait was wasted
        // on every answer. The post-accept extension below still gives the
        // requeued leg the full window to land. See MOBILE_SIP_ANSWER_PRECLAIM_WAIT_MS.
        const answerDeadline = createSipAnswerDeadline(
          answerTappedAt,
          MOBILE_SIP_ANSWER_PRECLAIM_WAIT_MS,
        );
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

        const inviteMatch = {
          inviteId: invite.id,
          fromNumber: invite.fromNumber,
          toExtension: invite.toExtension,
          pbxCallId: invite.pbxCallId,
          sipCallTarget: invite.sipCallTarget,
        };

        const recordSipAnswerTrace = (event: SipAnswerTraceEvent) => {
          if (event.phase === "sent") {
            const sentMs = event.timestamp - answerTappedAt;
            console.log('[ANSWER_PIPELINE] SIP_200OK_SENT +' + sentMs + 'ms');
            emitAnswerFlowEvent("SIP_ANSWER_SENT", invite, {
              traceAt: new Date(event.timestamp).toISOString(),
              sinceAnswerMs: sentMs,
            });
            flightRecord('SIP', 'SIP_ANSWER_SENT', { inviteId: invite.id, payload: { sinceAnswerMs: sentMs } });
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
            flightRecord('SIP', 'SIP_CONNECTED', {
              inviteId: invite.id,
              pbxCallId: invite.pbxCallId ?? null,
              payload: { traceAt: new Date(event.timestamp).toISOString(), sinceAnswerMs: confirmedMs },
            });
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
          flightRecord('SIP', 'SIP_ANSWER_FAILED', {
            inviteId: invite.id,
            severity: 'error',
            payload: {
              code: event.code,
              reason: event.reason,
              message: event.message,
              sinceAnswerMs: failedMs,
            },
          });
        };

        // ══════════════════════════════════════════════════════════════════
        // PARALLEL PATH — UI dismiss / logging runs while register proceeds.
        // Backend ACCEPT is deferred until findIncoming() finds a session, or
        // until the initial invite-wait window expires (AMI requeue path).
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
        // Stamp answer-flow start on the raw client and expose an abort probe.
        // A user hangup (End tap on the "Answering…" screen) after this point
        // must abandon the pipeline immediately — before this, an End tap
        // killed the requeued INVITE and the pipeline still sat out its full
        // 16 s invite wait on a dead screen (live failure 2026-07-27).
        const peekRawSipClient = (): any => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const singleton = require("../sip/sipClientSingleton") as typeof import("../sip/sipClientSingleton");
            return singleton.peekSipClient();
          } catch {
            return null;
          }
        };
        try { peekRawSipClient()?.markAnswerFlowStart?.(); } catch { /* diagnostics only */ }
        const answerFlowAborted = (): boolean => {
          try {
            return !!peekRawSipClient()?.isAnswerFlowAborted?.();
          } catch {
            return false;
          }
        };
        sip.beginInboundBlackbox(invite.id, {
          push_received: {
            pushReceivedAt,
            answerTappedAt,
            pushToAnswerMs: answerTappedAt - pushReceivedAt,
            wakeReceived: pushReceivedAt > 0,
          },
          incoming_screen_shown: { appWasBackgrounded, answerPath },
          answer_tapped: { answerTappedAt, answerPath },
          uiState: {
            appState: AppState.currentState,
            sipRegState: sip.registrationState,
            callState: sip.callState,
          },
        });
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
          postVoiceDiagEvent(authToken, {
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
        flightRecord('UI', 'ANSWER_HANDOFF_STARTED', {
          inviteId: invite.id,
          pbxCallId: invite.pbxCallId ?? null,
          payload: { sinceAnswerMs: Date.now() - answerTappedAt },
        });
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

        // WARM FAST-PATH: if the matching INVITE is ALREADY live on the UA
        // (standing registration held in the background, Asterisk dialed us
        // directly during the ring), do NOT gate the answer on the register
        // round-trip — the INVITE's presence is stronger proof of a working
        // socket than any REGISTER (~140 ms saved on every warm answer). The
        // register promise keeps running in the background for bookkeeping;
        // cold paths below still await nothing here because waitForIncomingInvite
        // finds the session on its first poll.
        let warmInvitePresent = false;
        try {
          warmInvitePresent = sip.hasMatchingIncomingInvite(inviteMatch);
        } catch { /* fall back to the register gate */ }

        if (warmInvitePresent) {
          console.log('[ANSWER_PIPELINE] REG_GATE_SKIPPED (invite already live)', JSON.stringify({
            inviteId: invite.id,
            sinceAnswerMs: Date.now() - answerTappedAt,
          }));
          void sipRegisterPromise.catch(() => undefined);
        } else {
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
            markCallLatency(invite.id, "CALL_FAILED", { reason: "sip_register_failed" });
            summarizeCallLatency(invite.id, "failed");
            resetCallLatency(invite.id);
            return;
          }
        }

        const pbxAnswerPromise = waitForPbxAnswer(invite, 6_000);

        const t4_waitStart = Date.now();
        console.log('[ANSWER_PIPELINE] SIP_INVITE_WAIT_START', JSON.stringify({
          inviteId: invite.id,
          sinceAnswerMs: t4_waitStart - answerTappedAt,
          sipReg: sip.registrationState,
          callState: sip.callState,
        }));
        flightRecord('SIP', 'SIP_ANSWER_START', {
          inviteId: invite.id,
          pbxCallId: invite.pbxCallId ?? null,
          payload: { sinceAnswerMs: t4_waitStart - answerTappedAt, phase: 'invite_wait' },
        });
        markCallLatency(invite.id, "SESSION_ACCEPT_START", {
          sipRegState: sip.registrationState,
          sinceAnswerMs: t4_waitStart - answerTappedAt,
        });

        // Trust the warm probe from above: the INVITE was live on the UA a
        // few ms ago, so skip the wait loop entirely (its deadline is anchored
        // at answer-tap time and can already be expired by the time we get
        // here on slower paths — lock screen preamble ≈ 200 ms).
        let inviteReady = warmInvitePresent
          ? true
          : await sip
              .waitForIncomingInvite(inviteMatch, answerDeadline.handle)
              .catch(() => false);

        let backendClaimed = false;
        if (!inviteReady && earlyColdAcceptSent) {
          // Cold iOS: the backend ACCEPT (Mode-B trigger) already went out at
          // tap time above. Don't re-claim - just wait for the re-delivered
          // INVITE to our fresh contact. Only reachable on iOS killed/background.
          backendClaimed = true;
          answerDeadline.handle.extend(MOBILE_SIP_ANSWER_POST_ACCEPT_EXTRA_MS);
          consumedInviteActionRef.current.add(acceptKey);
          inviteReady = await sip
            .waitForIncomingInvite(inviteMatch, answerDeadline.handle)
            .catch(() => false);
        } else if (!inviteReady && answerFlowAborted()) {
          // User hung up while we were still waiting for the INVITE — do NOT
          // claim/requeue a call they already gave up on. Clean up and exit.
          console.warn('[ANSWER_PIPELINE] aborted_by_user_before_claim', JSON.stringify({
            inviteId: invite.id,
            sinceAnswerMs: Date.now() - answerTappedAt,
          }));
          setCallFlowLastError("answer_aborted_by_user");
          respondInvite(authToken, invite.id, "DECLINE", deviceIdRef.current || undefined).catch(() => undefined);
          showEndedState(invite, "Call ended", { reason: "answer_aborted_by_user" });
          void flightEndCall('failed');
          endNativeCall(callId);
          markCallLatency(invite.id, "CALL_FAILED", { reason: "answer_aborted_by_user" });
          summarizeCallLatency(invite.id, "failed");
          resetCallLatency(invite.id);
          return;
        } else if (!inviteReady) {
          const t2_claimStart = Date.now();
          console.log('[ANSWER_PIPELINE] CLAIM_START (requeue path)', JSON.stringify({
            inviteId: invite.id,
            pbxCallId: invite.pbxCallId,
            sinceAnswerMs: t2_claimStart - answerTappedAt,
            reason: 'no_invite_before_initial_wait',
          }));
          // No SIP INVITE arrived on the live socket before the initial wait —
          // i.e. this device did not hold its registration in the background and
          // had to be rescued via the backend claim path (the dominant cause of
          // the "sat on answering for ages" cold-call symptom). This is the
          // definitive proof the adaptive keep-alive gate is watching for, but
          // the gate previously only latched on slow *registration*, never on a
          // slow *answer* when registration itself was fast — so this failure
          // mode slipped through and every killed-state call stayed slow. Latch
          // now so the persistent FGS arms and the next killed call keeps the
          // process resident → instant connect.
          try {
            sip.markBackgroundDeliveryFailure(
              'cold_answer_no_sip_invite:' + (t2_claimStart - answerTappedAt) + 'ms',
            );
          } catch {
            /* diagnostics latch must never break the answer path */
          }
          const resp = await respondInvite(
            authToken,
            invite.id,
            "ACCEPT",
            deviceIdRef.current || undefined,
          ).catch(() => null);
          const t3_claimDone = Date.now();
          console.log('[ANSWER_PIPELINE] CLAIM_DONE', JSON.stringify({
            code: resp?.code,
            status: resp?.status,
            tookMs: t3_claimDone - t2_claimStart,
            sinceAnswerMs: t3_claimDone - answerTappedAt,
          }));

          if (!resp || resp.code !== "INVITE_CLAIMED_OK") {
            const reason = resp?.code || "unknown";
            if (reason === "INVITE_ALREADY_HANDLED" && resp?.status === "ACCEPTED") {
              console.log("[Notif] Invite already claimed by another handler, leaving screen active");
              answerHandoffInviteIdRef.current = null;
              setAnswerHandoffTick((n) => n + 1);
              answerFlowCommitted = true;
              return;
            }
            if (reason === "TURN_REQUIRED_NOT_VERIFIED" || reason === "MEDIA_TEST_REQUIRED_NOT_PASSED") {
              await respondInvite(authToken, invite.id, "DECLINE", deviceIdRef.current || undefined).catch(() => undefined);
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

          backendClaimed = true;
          answerDeadline.handle.extend(MOBILE_SIP_ANSWER_POST_ACCEPT_EXTRA_MS);
          flightRecord('BACKEND', 'INVITE_CLAIMED', {
            inviteId: invite.id,
            pbxCallId: invite.pbxCallId ?? null,
            payload: {
              sinceAnswerMs: t3_claimDone - answerTappedAt,
              answerWaitExtendedMs: MOBILE_SIP_ANSWER_POST_ACCEPT_EXTRA_MS,
              answerWaitUntilMs: answerDeadline.handle.getUntilMs(),
              path: 'requeue_after_initial_wait',
            },
          });
          consumedInviteActionRef.current.add(acceptKey);

          inviteReady = await sip
            .waitForIncomingInvite(inviteMatch, answerDeadline.handle)
            .catch(() => false);
        }

        if (!inviteReady) {
          const inviteWaitFailureReason = answerFlowAborted()
            ? "answer_aborted_by_user"
            : "sip_invite_not_received";
          setCallFlowLastError(inviteWaitFailureReason);
          emitAnswerFlowEvent("SIP_ANSWER_FAILED", invite, {
            reason: inviteWaitFailureReason,
          });
          flightRecord('SIP', 'SIP_INVITE_WAIT_TIMEOUT', {
            inviteId: invite.id,
            severity: 'error',
            payload: { sinceAnswerMs: Date.now() - answerTappedAt, reason: inviteWaitFailureReason },
          });
          sip.finalizeInboundBlackboxFailure({
            inviteId: invite.id,
            pbxCallId: invite.pbxCallId ?? null,
            callerNumber: invite.fromNumber ?? null,
            calleeExtension: invite.toExtension ?? null,
            failureReason: inviteWaitFailureReason,
            pushMeta: {
              pushReceivedAt,
              answerTappedAt,
              pushToAnswerMs: answerTappedAt - pushReceivedAt,
            },
            backendAccept: backendClaimed
              ? { requested: true, responseCode: "INVITE_CLAIMED_OK" }
              : { requested: false },
            uiState: {
              appState: AppState.currentState,
              sipRegState: sip.registrationState,
              sinceAnswerMs: Date.now() - answerTappedAt,
            },
          });
          if (backendClaimed) {
            sip.rejectIncomingInvite({
              inviteId: invite.id,
              fromNumber: invite.fromNumber,
              toExtension: invite.toExtension,
              pbxCallId: invite.pbxCallId,
              sipCallTarget: invite.sipCallTarget,
            }).catch(() => undefined);
          }
          showEndedState(invite, "Call ended", { reason: inviteWaitFailureReason });
          void flightEndCall('failed');
          endNativeCall(callId);
          markCallLatency(invite.id, "CALL_FAILED", { reason: inviteWaitFailureReason });
          summarizeCallLatency(invite.id, "failed");
          resetCallLatency(invite.id);
          return;
        }

        // ══════════════════════════════════════════════════════════════════
        // WARM ANSWER (INVITE already on the live socket) — instant connect.
        //
        // When the device held its registration in the background, Asterisk
        // dialed it directly and the INVITE arrived during the ring
        // (`waitForIncomingInvite` returned true on the first wait, so
        // `backendClaimed` is still false here). Bridging is PURE SIP — the
        // backend ACCEPT is only bookkeeping (atomic DB claim + INVITE_CLAIMED
        // stop-ring for sibling devices) and, on the cold path, an AMI requeue.
        //
        // Historically we awaited the full ACCEPT round-trip (~1.2s — it awaits
        // a server-side AMI requeue) BEFORE sending the SIP 200 OK, so every
        // app-open/registered call paid that latency for nothing. Now we send
        // the 200 OK FIRST and fire ACCEPT async. By the time the server would
        // run the requeue, Asterisk has observed our 200 OK and set
        // `extensionAnsweredAt`, so `requeueLiveCallToDialplan` skips the
        // (here-redundant, potentially disruptive) AMI Redirect via its guard.
        // Verified safe against telephony code; the cold/requeue path below is
        // unchanged.
        // ══════════════════════════════════════════════════════════════════
        let answered: boolean;
        if (!backendClaimed) {
          const t2_warm = Date.now();
          console.log('[ANSWER_PIPELINE] WARM_ANSWER (invite present, accept async)', JSON.stringify({
            inviteId: invite.id,
            pbxCallId: invite.pbxCallId,
            sinceAnswerMs: t2_warm - answerTappedAt,
          }));
          answerDeadline.handle.extend(MOBILE_SIP_ANSWER_POST_ACCEPT_EXTRA_MS);
          consumedInviteActionRef.current.add(acceptKey);
          emitAnswerFlowEvent("SIP_ANSWER_REQUESTED", invite, {
            sinceAnswerMs: t2_warm - answerTappedAt,
          });

          // SIP 200 OK first — this is what actually bridges the call.
          answered = await sip
            .answerIncomingInvite(
              inviteMatch,
              MOBILE_SIP_ANSWER_INITIAL_WAIT_MS,
              recordSipAnswerTrace,
              answerDeadline.handle,
            )
            .catch(() => false);

          // Fire-and-forget backend bookkeeping: atomic DB claim + INVITE_CLAIMED
          // push so sibling devices stop ringing. Never blocks the connect. The
          // server-side requeue is skipped because our 200 OK already set
          // `extensionAnsweredAt`. Asterisk arbitrates multi-device races by
          // first-200-OK-wins, so INVITE_ALREADY_HANDLED needs no teardown here.
          void respondInvite(
            authToken,
            invite.id,
            "ACCEPT",
            deviceIdRef.current || undefined,
          )
            .then((resp) => {
              console.log('[ANSWER_PIPELINE] WARM_ACCEPT_DONE', JSON.stringify({
                code: resp?.code,
                status: resp?.status,
                sinceAnswerMs: Date.now() - answerTappedAt,
              }));
              const reason = resp?.code;
              // Gated tenants can reject the accept after we answered. Honour the
              // policy by tearing the call down (rare; ungated tenants always OK).
              if (
                reason === "TURN_REQUIRED_NOT_VERIFIED" ||
                reason === "MEDIA_TEST_REQUIRED_NOT_PASSED"
              ) {
                sip.hangup().catch(() => undefined);
                respondInvite(authToken, invite.id, "DECLINE", deviceIdRef.current || undefined).catch(() => undefined);
              }
            })
            .catch(() => undefined);

          if (answered) {
            backendClaimed = true;
            flightRecord('BACKEND', 'INVITE_CLAIMED', {
              inviteId: invite.id,
              pbxCallId: invite.pbxCallId ?? null,
              payload: {
                sinceAnswerMs: Date.now() - answerTappedAt,
                path: 'warm_answer_first',
              },
            });
          }
        } else {
          // Cold / requeue path: ACCEPT was already awaited above; answer now.
          emitAnswerFlowEvent("SIP_ANSWER_REQUESTED", invite, {
            sinceAnswerMs: Date.now() - answerTappedAt,
          });
          answered = await sip
            .answerIncomingInvite(
              inviteMatch,
              MOBILE_SIP_ANSWER_INITIAL_WAIT_MS,
              recordSipAnswerTrace,
              answerDeadline.handle,
            )
            .catch(() => false);
        }

        if (!answered) {
          setCallFlowLastError("sip_answer_not_confirmed");
          sip.rejectIncomingInvite({
            inviteId: invite.id,
            fromNumber: invite.fromNumber,
            toExtension: invite.toExtension,
            pbxCallId: invite.pbxCallId,
            sipCallTarget: invite.sipCallTarget,
          }).catch(() => undefined);
          sip.hangup().catch(() => undefined);
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
          postVoiceDiagEvent(authToken, {
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
    // ── Telecom: flip the OS Connection to ACTIVE on SIP connect ────────────
    // Fires the moment the SIP UA reports the call is up so the system
    // call UI shows the in-call timer + clears the lock-screen ringer
    // banner. Idempotent on the native side — safe to call even when the
    // call did not originate via Telecom (no-op if no Connection exists).
    try {
      const inviteId = answerInviteRef.current?.id || incomingInvite?.id || null;
      if (inviteId) markTelecomActive(inviteId);
    } catch (e) {
      console.warn("[TELECOM] markTelecomActive on connect threw:", e instanceof Error ? e.message : String(e));
    }
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
      // ── Telecom: tear down any OS Connection still up for this call ──────
      // Fires on every SIP idle transition (remote hangup, local hangup,
      // missed). Idempotent — no-op if no Connection exists. Without this
      // the OS lock-screen call UI would linger until its 60s no-answer
      // timeout when the remote party hangs up first.
      try {
        const lingerId = answerInviteRef.current?.id || incomingInvite?.id || null;
        if (lingerId) terminateTelecomCall(lingerId, "remote_hangup");
        // iOS: terminateTelecomCall is Android-only, so end the matching CallKit
        // call here when SIP goes idle (remote/local hangup, voicemail rollover)
        // so the iPhone doesn't keep showing a dead call. No-op on a call that
        // CallKit already ended. Android is unaffected (handled by Telecom above).
        if (Platform.OS === "ios" && lingerId) endNativeCall(lingerId);
      } catch (e) {
        console.warn("[TELECOM] terminateTelecomCall on idle threw:", e instanceof Error ? e.message : String(e));
      }
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
        // Do NOT treat a FRESH incoming call as orphaned. In the FCM-first
        // architecture the native ForegroundInvite mounts IncomingCallScreen
        // BEFORE the SIP INVITE arrives, and tapping the lock-screen call to
        // open it flips AppState→active in that same window — so sipState is
        // legitimately "idle" for the first ~1-3s of a real, live call. Ring
        // groups also drop sipState to idle transiently during fork CANCEL+re-
        // INVITE storms. Clearing here races the SIP INVITE and flashes the
        // screen away on a live call (observed: orphan clear 27ms after mount).
        // Only clear once the invite is old enough that no SIP leg is plausibly
        // still in transit AND the backend poll is not actively reporting the
        // call as live. The INVITE_POLL + 45s expire timer remain the real
        // teardown authorities.
        const shownAt = incomingInviteShownAtRef.current;
        const inviteAgeMs = shownAt ? Date.now() - shownAt : Number.MAX_SAFE_INTEGER;
        const ORPHAN_MIN_AGE_MS = 12_000;
        // Never clear before the answer-status poll has returned even once: until
        // it has, we cannot know the call is dead, and the SIP INVITE is often
        // still in transit (the FCM/native UI mounts before SIP arrives). Field
        // logs showed this firing 72 ms after the poll started — clearing a
        // perfectly live call — because the snapshot was still null. The poll +
        // 45 s expiry + SIP cancel-bridge are the real teardown authorities.
        const pollHasNotResolvedYet = lastPollStatusRef.current === null;
        if (
          inviteAgeMs < ORPHAN_MIN_AGE_MS ||
          pollHasNotResolvedYet ||
          pollSnapshotSaysLive(lastPollStatusRef.current)
        ) {
          console.log(
            '[CALL_RECONCILE] orphan_ui_kept_fresh_or_live sipState=' + sip.callState +
              ' phase=' + incomingCallUiState.phase +
              ' inviteAgeMs=' + (inviteAgeMs === Number.MAX_SAFE_INTEGER ? 'unknown' : inviteAgeMs) +
              ' inviteId=' + (incomingInvite?.id || 'n/a'),
          );
          return;
        }
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
        lastPollStatusRef.current = {
          telephonyState: (status?.telephonyState || "").toUpperCase(),
          pbxAnswered: !!status?.pbxAnswered,
          extensionAnswered: status?.extensionAnswered === true,
          inviteStatus,
          reachedVoicemail:
            status?.reachedVoicemail === true ||
            channelsLookLikeVoicemail(status?.activeChannels),
          at: Date.now(),
        };
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
        // Tertiary signal: the call ended somewhere OTHER than this device.
        // (If WE had answered, the answerHandoff guard at the top of tick would
        // have stopped this poll already.) We classify using the telephony
        // service's AUTHORITATIVE signals rather than the ambiguous pbxAnswered:
        //
        //  - reachedVoicemail: the PBX diverted to the VoiceMail app. Stop
        //    ringing immediately and label as ended — no human picked up here.
        //  - extensionAnswered: a real PJSIP extension leg actually answered.
        //    The telephony store sets this ONLY for genuine extension pickups,
        //    NEVER for inbound-trunk IVR `Answer()` / ring-back early media. So
        //    a true value means another device / desk phone in the ring group
        //    genuinely answered → "Answered on another device".
        //
        // pbxAnswered alone is deliberately NOT a teardown trigger anymore: it
        // is true for early-media ringback the ENTIRE time a ring group rings
        // (observed pbxAnswered=true from ~1.5 s through 17 s while the call was
        // never answered), which caused repeated false teardowns.
        const backendKnowsAnswered =
          typeof status?.extensionAnswered === "boolean";
        const reachedVoicemail =
          status?.reachedVoicemail === true ||
          channelsLookLikeVoicemail(status?.activeChannels);
        const extensionAnsweredElsewhere = status?.extensionAnswered === true;

        // Cache the latest disposition for the SIP cancel bridge's label.
        if (reachedVoicemail) {
          lastPollDispositionRef.current = 'voicemail';
        } else if (extensionAnsweredElsewhere) {
          lastPollDispositionRef.current = 'answered_elsewhere';
        }

        let teardownReason:
          | 'reached_voicemail'
          | 'answered_on_another_device'
          | null = null;
        if (reachedVoicemail) {
          teardownReason = 'reached_voicemail';
        } else if (backendKnowsAnswered) {
          // New telephony build: trust extensionAnswered exclusively. No live
          // SIP guard needed — extensionAnswered is never set by ringback.
          if (extensionAnsweredElsewhere) {
            teardownReason = 'answered_on_another_device';
          }
        } else if (status?.pbxAnswered) {
          // Legacy fallback for telephony builds that predate extensionAnswered:
          // retain the previous live-INVITE guard so old servers don't regress.
          if (!liveInboundRingingRef.current) {
            teardownReason = 'answered_on_another_device';
          }
        }

        if (teardownReason) {
          cancelled = true;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          const answeredElsewhere =
            teardownReason === 'answered_on_another_device';
          if (answeredElsewhere && incomingInvite) {
            // Stamp a local call-history entry so Recent shows "Answered on
            // another device" for this call. mergeCallRecords lets this
            // device-only signal override the server record's disposition.
            appendCallRecord({
              id: 'invite:' + inviteId,
              linkedId: incomingInvite.pbxCallId || null,
              direction: 'inbound',
              fromNumber: incomingInvite.fromNumber || '',
              fromName: incomingInvite.fromDisplay || null,
              toNumber: incomingInvite.toExtension || '',
              startedAt: new Date((incomingInvite as any)?._pushReceivedAt || Date.now()).toISOString(),
              durationSec: 0,
              disposition: 'answered_elsewhere',
            }).catch(() => undefined);
          }
          killAll(
            teardownReason,
            answeredElsewhere ? 'Answered on another device' : 'Call ended',
            700,
          );
          return;
        }
        if (status?.pbxAnswered) {
          console.log(
            '[INVITE_POLL] pbxAnswered=true but no extension answered yet' +
              ' (backendKnowsAnswered=' + backendKnowsAnswered +
              ', extensionAnswered=' + extensionAnsweredElsewhere +
              ', reachedVoicemail=' + reachedVoicemail +
              ', elapsedMs=' + elapsed +
              ') — ring-group early media, keep ringing',
          );
        }
      } catch (e: any) {
        console.warn('[INVITE_POLL] error tick=' + tickCount + ' inviteId=' + inviteId + ' msg=' + (e?.message || String(e)));
      }
      if (cancelled) return;
      timer = setTimeout(tick, 800);
    };

    // Reset the cached disposition for this fresh call so a previous call's
    // "answered_elsewhere"/"voicemail" can never leak into this one's label.
    lastPollDispositionRef.current = 'unknown';
    lastPollStatusRef.current = null;
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
  // When our inbound SIP leg goes away while we are still ringing (caller hung
  // up, the call rolled to voicemail, or another device answered and the PBX
  // CANCELed our fork), there is nothing left to answer here, so the incoming
  // UI + ringtone must stop immediately.
  //
  // CRITICAL: this is keyed on the MULTI-CALL store (`multiCallInboundRinging`),
  // NOT the legacy single-call `sip.callState`/`sip.callDirection`. Ring groups
  // are driven through the multi-call store and the legacy fields are unreliable
  // for forked re-INVITE legs. Keying on the legacy state previously made this
  // bridge silently never fire for a ring group: the SIP leg was CANCELed at
  // ~29 s (multi-call sessions → 0) but the UI kept ringing 16 s more until the
  // invite EXPIRED at ~45 s — the "it didn't stop at voicemail" bug.
  //
  // The poll's killAll and this teardown are idempotent; whichever wins, the
  // other is a no-op that just refreshes the visible end-state message.
  useEffect(() => {
    if (!incomingInvite) {
      // No active incoming call — clear the abandon clock so a stale timestamp
      // from a previous call cannot trip an immediate teardown on the next one.
      inboundLegGoneAtRef.current = 0;
      return;
    }
    // Only while the user is still being presented the incoming call and has
    // NOT handed off to the answer pipeline ("connecting" is the answer phase).
    if (incomingCallUiState.phase !== "incoming") return;
    if (answerHandoffInviteIdRef.current === incomingInvite.id) return;
    // Don't tear down before the SIP INVITE has even arrived: only fire once a
    // live inbound SIP leg existed for this invite and is now gone.
    if (!hadLiveInboundSipRef.current) return;
    const hasLiveInboundSip =
      multiCallInboundRinging ||
      (sip.callState === "ringing" && sip.callDirection === "inbound");
    if (hasLiveInboundSip) {
      // A live inbound leg exists (initial INVITE or a ring-group re-INVITE that
      // landed inside the abandon window) — reset the abandon clock so the next
      // gap is measured fresh.
      inboundLegGoneAtRef.current = 0;
      return;
    }

    const invite = incomingInvite;
    const inviteId = invite.id;
    const delayMs = 900;

    // Anchor the teardown to when the leg FIRST went away, not to this effect
    // run. Legacy sip.callState flaps ringing→ended→idle as the forks reap,
    // re-running this effect several times; without anchoring, each re-run
    // pushed the timer out another full window (observed +4.5 s instead of the
    // intended window after the fork died).
    if (inboundLegGoneAtRef.current === 0) {
      inboundLegGoneAtRef.current = Date.now();
    }

    // ── Fork-abandon window (THE authoritative "stop ringing this device"
    //    signal) ──────────────────────────────────────────────────────────────
    // A live inbound SIP INVITE is the PBX actively offering THIS device the
    // call. While a ring group rings us, that INVITE dialog stays up
    // continuously; at fork handoff it is CANCELed and re-INVITEd within
    // ~500 ms (measured in the field). When the call leaves us for good —
    // rolled to voicemail, answered on another device, or the caller hung up —
    // the PBX CANCELs our fork and never re-offers it.
    //
    // So the single robust rule is: if NO live inbound SIP leg has existed for
    // longer than this window, the call is no longer being offered here and the
    // incoming UI + ringtone must stop. The window is sized far above the
    // ~500 ms fork-handoff gap so legitimate ring-group flapping never trips it
    // (a re-INVITE inside the window re-runs this effect and the cleanup clears
    // the pending teardown), while voicemail/answered-elsewhere stop within
    // ~3 s instead of hanging until the 45 s invite EXPIRED (the "it didn't
    // stop at voicemail" bug: field logs showed the fork dying at +32 s but the
    // screen ringing until +45 s because teardown was skipped while the backend
    // poll still reported telephonyState=up).
    const GHOST_CANCEL_WAIT_MS = 1500;
    const remainingMs = Math.max(
      0,
      inboundLegGoneAtRef.current + GHOST_CANCEL_WAIT_MS - Date.now(),
    );
    console.log(
      '[SIP_CANCEL_BRIDGE] inbound_sip_leg_gone — debouncing ' +
        GHOST_CANCEL_WAIT_MS + 'ms (remaining ' + remainingMs + 'ms) for re-INVITE inviteId=' + inviteId +
        ' sipCallState=' + sip.callState +
        ' multiCallRinging=' + multiCallInboundRinging,
    );

    const teardownTimer = setTimeout(() => {
      // The full fork-abandon window elapsed with NO live inbound SIP leg and
      // no replacement re-INVITE (a re-INVITE would have re-run this effect and
      // cleared this timer via the cleanup below). The PBX is no longer offering
      // this call to this device, so there is nothing left to answer here —
      // tear down regardless of what the backend poll reports. The poll keeps
      // saying telephonyState=up while the call sits in voicemail, so deferring
      // to it (the old behaviour) left the screen ringing until the 45 s invite
      // EXPIRED. The poll snapshot is still read below, but only to LABEL the
      // end state (voicemail vs answered-elsewhere vs caller-hangup), never to
      // veto the teardown.
      inboundLegGoneAtRef.current = 0;
      console.log(
        '[SIP_CANCEL_BRIDGE] teardown inviteId=' + inviteId +
          ' forkAbandonedMs=' + GHOST_CANCEL_WAIT_MS +
          ' sipCallState=' + sip.callState +
          ' uiPhase=' + incomingCallUiState.phase +
          ' lastPoll=' + JSON.stringify(lastPollStatusRef.current),
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
      // Resolve the end-state label from the latest authoritative disposition
      // the poll observed (read NOW, after the debounce, so a disposition that
      // resolved during the wait is reflected). A SIP CANCEL alone is ambiguous
      // — it fires for answered-elsewhere, voicemail, AND caller-hangup — so we
      // only upgrade past the neutral "Call ended" when the telephony signals
      // tell us why. Classify from the last poll snapshot when the poll didn't
      // already tag it: a real extension answered ⇒ answered-elsewhere; the
      // trunk still up + answered by a non-extension ⇒ voicemail; otherwise the
      // caller hung up / missed.
      let disposition = lastPollDispositionRef.current;
      if (disposition === 'unknown') {
        const ls = lastPollStatusRef.current;
        if (ls?.extensionAnswered) {
          disposition = 'answered_elsewhere';
        } else if (ls?.pbxAnswered && (ls.telephonyState === 'UP' || ls.telephonyState === '')) {
          disposition = 'voicemail';
        }
      }
      console.log(
        '[SIP_CANCEL_BRIDGE] teardown_classified inviteId=' + inviteId +
          ' disposition=' + disposition +
          ' lastPoll=' + JSON.stringify(lastPollStatusRef.current),
      );
      const reason =
        disposition === 'answered_elsewhere'
          ? 'sip_cancel_answered_elsewhere'
          : disposition === 'voicemail'
            ? 'sip_cancel_voicemail'
            : 'sip_cancel_while_ringing';
      const friendly =
        disposition === 'answered_elsewhere'
          ? 'Answered on another device'
          : 'Call ended';
      if (disposition === 'answered_elsewhere') {
        appendCallRecord({
          id: 'invite:' + inviteId,
          linkedId: invite.pbxCallId || null,
          direction: 'inbound',
          fromNumber: invite.fromNumber || '',
          fromName: invite.fromDisplay || null,
          toNumber: invite.toExtension || '',
          startedAt: new Date((invite as any)?._pushReceivedAt || Date.now()).toISOString(),
          durationSec: 0,
          disposition: 'answered_elsewhere',
        }).catch(() => undefined);
      } else if (disposition !== 'voicemail') {
        // HARDENING (Izzy 2026-07-29): the classified answered_elsewhere stamp
        // above depends on the status poll having SEEN the answer before the
        // CANCEL — a race it loses whenever the cancel is fast (live repro:
        // other device answered, this device showed plain "Incoming call").
        // Leave a race-free local trace that this device's ring ended WITHOUT
        // this device answering; mergeCallRecords promotes the server's
        // "answered" verdict for the same call into "Answered on another
        // device" using this trace. Caller-hangup/missed calls are unaffected
        // (server says missed → no promotion), voicemail likewise.
        appendCallRecord({
          id: 'invite:' + inviteId,
          linkedId: invite.pbxCallId || null,
          direction: 'inbound',
          fromNumber: invite.fromNumber || '',
          fromName: invite.fromDisplay || null,
          toNumber: invite.toExtension || '',
          startedAt: new Date((invite as any)?._pushReceivedAt || Date.now()).toISOString(),
          durationSec: 0,
          disposition: 'ring_ended_unanswered',
        }).catch(() => undefined);
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
    }, remainingMs);

    return () => {
      clearTimeout(teardownTimer);
    };
  }, [
    multiCallInboundRinging,
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

    // iOS-only backend fallback. When the app is foreground and the server gate
    // intentionally SKIPPED the VoIP push (see the foreground-active heartbeat),
    // the two push-cache recoveries above find nothing — the invite only ever
    // arrived over SIP. Fetch the authoritative pending invite from the backend
    // so the Connect incoming screen shows and the normal answer flow works.
    // We deliberately do NOT call showIncomingNativeCall here: foreground stays
    // Connect-screen-only (no native CallKit). Android is unaffected — its native
    // cache path already populates the recoveries above.
    const tryRecoverFromBackend = async (): Promise<boolean> => {
      if (Platform.OS !== "ios") return false;
      const tkn = tokenRef.current;
      if (!tkn) return false;
      try {
        const pendingRaw = await getPendingInvites(tkn).catch(() => []);
        const pending = filterFreshInvites(pendingRaw as CallInvite[]);
        const invite = pending.find(
          (inv) => inv?.id && !suppressedIncomingInviteIdsRef.current.has(String(inv.id)),
        );
        if (!invite?.id) return false;
        console.log("[Notif] SIP ringing recovered invite via backend getPendingInvites inviteId=", invite.id);
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
        if (cancelled) return;
        const recoveredFromBackend = await tryRecoverFromBackend();
        if (recoveredFromBackend) return;
      }
      console.warn('[Notif] SIP ringing safety net gave up — neither native cache, AsyncStorage, nor backend produced an invite');
    })();

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sip.callState, sip.callDirection]);

  // ── Telecom (SELF_MANAGED ConnectionService) event listener ──────────────
  // ConnectIncomingConnection forwards user actions in the OS-level call UI
  // (Answer / Decline / Hangup) into JS via TelecomBridge. We pipe each
  // event into the same handleAcceptInvite / handleDeclineInvite functions
  // the in-app IncomingCallScreen uses, so there is exactly one SIP-answer
  // pipeline regardless of where the answer originated. This is the
  // primary path for "app killed → call wakes phone → user taps Answer
  // on lock screen" on every Android 14/15+ device.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const unsub = subscribeTelecomActions({
      onAnswer: async (payload) => {
        const inviteId = payload.inviteId;
        if (!inviteId) {
          console.warn("[TELECOM] onAnswer with empty inviteId — ignoring");
          return;
        }
        console.log("[TELECOM] onAnswer inviteId=" + inviteId + " — resolving invite + driving handleAcceptInvite");
        let invite = await resolveInviteForAction(inviteId);
        if (!invite && tokenRef.current) {
          // Telecom can fire onAnswer faster than the JS process boots
          // from a killed state — give the cache / pending-invites API a
          // brief window to populate before giving up.
          await new Promise<void>((r) => setTimeout(r, 250));
          invite = await resolveInviteForAction(inviteId);
        }
        if (!invite) {
          console.warn("[TELECOM] onAnswer: no invite found for inviteId=" + inviteId + " — terminating Connection");
          terminateTelecomCall(inviteId, "other");
          return;
        }
        try {
          await handleAcceptInvite(invite, inviteId);
        } catch (e) {
          console.warn("[TELECOM] handleAcceptInvite threw, terminating Connection:", e instanceof Error ? e.message : String(e));
          terminateTelecomCall(inviteId, "other");
        }
      },
      onReject: async (payload) => {
        const inviteId = payload.inviteId;
        // Samsung's SamsungAutoAnswerCallsManagerListener can auto-reject our
        // SELF_MANAGED Telecom call within <1 second of creation when a managed
        // cellular/IMS call is concurrently active. If we forward that system
        // rejection into handleDeclineInvite we send a SIP BYE → the caller
        // reaches voicemail before the user sees any UI.
        //
        // We intentionally do NOT call handleDeclineInvite here. The SIP INVITE
        // stays alive and the user can answer/decline via our CallStyle
        // notification (which is now always posted in parallel with the Telecom
        // dispatch — see IncomingCallFirebaseService). The call will reach
        // voicemail only if the user ignores the notification until PBX timeout.
        console.log("[TELECOM] onReject inviteId=" + (inviteId || "(empty)") + " reason=" + payload.reason + " — Telecom layer dismissed; notification UI remains for user action (SIP NOT cancelled)");
      },
      onDisconnect: async (payload) => {
        const inviteId = payload.inviteId;
        if (!inviteId) return;
        // Answer-time anchors (standing-registration feature) are owned by
        // SipContext, which hangs up the live SIP session itself. Running
        // handleDeclineInvite against an anchor id would fire a bogus decline.
        if (inviteId.startsWith(TELECOM_ANCHOR_PREFIX)) {
          console.log("[TELECOM] onDisconnect for anchor " + inviteId + " — SipContext owns it, skipping");
          return;
        }
        console.log("[TELECOM] onDisconnect inviteId=" + inviteId + " reason=" + payload.reason);
        // Same as reject for our SIP layer: hang up the live session.
        const invite = await resolveInviteForAction(inviteId);
        try {
          await handleDeclineInvite(invite, inviteId);
        } catch (e) {
          console.warn("[TELECOM] handleDeclineInvite (disconnect) threw:", e instanceof Error ? e.message : String(e));
        }
      },
      onFailed: (payload) => {
        console.warn("[TELECOM] onFailed inviteId=" + payload.inviteId + " reason=" + payload.reason + " — Telecom rejected the call; legacy CallStyle path will fire next time");
      },
    });
    return () => {
      try { unsub(); } catch { /* ignore */ }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

      // User declined the ring — release any prewarmed inbound mic. Idempotent.
      sip.releasePrewarmedMedia("declined");

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

  // Phase 7c — cold-start answer deferral.
  //
  // Invoked when a native CallKit answer fires but the invite metadata cannot yet
  // be resolved (cold-killed launch). Rather than dropping the tap, we keep the
  // CallKit call up and poll until either (a) the invite resolves — then we run
  // the full `handleAcceptInvite` pipeline (which itself awaits SIP registration
  // and performs the backend claim/PBX-requeue), (b) the call goes stale
  // (canceled / answered elsewhere → suppressed), or (c) a hard timeout elapses.
  // Foreground/warm answers never reach here because the caller only defers when
  // `resolveInviteForAction` already returned null twice — so this adds zero
  // latency to the proven fast path.
  const deferNativeAcceptUntilReady = useCallback(
    async (callId: string) => {
      if (!callId) {
        endNativeCall(callId);
        return;
      }
      const existing = pendingNativeAcceptRef.current.get(callId);
      if (existing?.running) {
        // A defer loop is already running for this exact CallKit tap — never
        // start a second (would risk a double-accept). iOS can redeliver the
        // answerCall event.
        return;
      }
      pendingNativeAcceptRef.current.set(callId, {
        tappedAt: Date.now(),
        running: true,
      });

      const postDiag = (
        type:
          | "ANSWER_DEFERRED_AWAITING_SIP"
          | "ANSWER_DEFERRED_EXECUTED"
          | "ANSWER_DEFERRED_TIMEOUT"
          | "ANSWER_DEFERRED_STALE_CALL",
        payload: Record<string, unknown>,
      ) => {
        const sid = diagSessionIdRef.current;
        if (token && sid) {
          postVoiceDiagEvent(token, {
            sessionId: sid,
            type,
            payload: { callId, ...payload },
          }).catch(() => undefined);
        }
      };

      const startedAt = Date.now();
      const deadline = startedAt + MOBILE_SIP_ANSWER_MAX_WAIT_MS;
      const POLL_MS = 300;

      emitAnswerFlowEvent("ANSWER_DEFERRED_AWAITING_SIP", { id: callId } as any, {
        reason: "invite_unresolved_on_native_answer",
        sipReg: sip.registrationState,
      });
      postDiag("ANSWER_DEFERRED_AWAITING_SIP", {
        reason: "invite_unresolved_on_native_answer",
        sipReg: sip.registrationState,
      });

      // Kick SIP registration immediately so it is (or is becoming) ready by the
      // time the invite resolves. `handleAcceptInvite` also awaits registration,
      // but starting now shaves cold-start latency. Fire-and-forget.
      try {
        void sip.register?.();
      } catch {
        /* non-fatal — handleAcceptInvite re-attempts registration */
      }

      try {
        let resolved: CallInvite | null = null;
        while (Date.now() < deadline) {
          // Stale: the call was canceled or answered on another device while we
          // were waiting → tear down CallKit and stop.
          if (suppressedIncomingInviteIdsRef.current.has(callId)) {
            emitAnswerFlowEvent("ANSWER_DEFERRED_STALE_CALL", { id: callId } as any, {
              reason: "suppressed_while_deferred",
              waitedMs: Date.now() - startedAt,
            });
            postDiag("ANSWER_DEFERRED_STALE_CALL", {
              reason: "suppressed_while_deferred",
              waitedMs: Date.now() - startedAt,
            });
            endNativeCall(callId);
            return;
          }
          resolved = await resolveInviteForAction(callId).catch(() => null);
          if (resolved) break;
          await new Promise<void>((r) => setTimeout(r, POLL_MS));
        }

        if (!resolved) {
          // Timed out waiting for the invite/PBX. Clear CallKit and log the exact
          // failure so the cold-start path is debuggable server-side.
          emitAnswerFlowEvent("ANSWER_DEFERRED_TIMEOUT", { id: callId } as any, {
            waitedMs: Date.now() - startedAt,
            sipReg: sip.registrationState,
          });
          postDiag("ANSWER_DEFERRED_TIMEOUT", {
            waitedMs: Date.now() - startedAt,
            sipReg: sip.registrationState,
          });
          endNativeCall(callId);
          return;
        }

        emitAnswerFlowEvent("ANSWER_DEFERRED_EXECUTED", resolved, {
          waitedMs: Date.now() - startedAt,
          sipReg: sip.registrationState,
        });
        postDiag("ANSWER_DEFERRED_EXECUTED", {
          inviteId: resolved.id,
          waitedMs: Date.now() - startedAt,
          sipReg: sip.registrationState,
        });
        safeSetInvite(resolved);
        // `handleAcceptInvite` carries its own `accept:<id>` in-flight dedupe plus
        // its own register-await + backend claim/requeue, so this is safe against
        // a concurrent foreground answer and completes the real connect.
        await handleAcceptInvite(resolved, callId);
      } finally {
        pendingNativeAcceptRef.current.delete(callId);
      }
    },
    [
      emitAnswerFlowEvent,
      handleAcceptInvite,
      resolveInviteForAction,
      safeSetInvite,
      sip,
      token,
    ],
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
          } else if (Platform.OS === "ios") {
            // iOS ONLY: same cold-start deferral as the live onAnswer path.
            await deferNativeAcceptUntilReady(evt.callUUID);
          } else {
            // Android: original behavior, untouched.
            endNativeCall(evt.callUUID);
          }
        } else if (evt.type === "end") {
          await handleDeclineInvite(null, evt.callUUID);
        }
      }
    }).catch(() => undefined);

    // iOS VoIP push listener — no-op on Android. Installed alongside the
    // CallKeep subscription so an incoming VoIP push can drive
    // showIncomingNativeCall without racing the CallKit bridge. The token
    // is cached in src/sip/voipPush.ts so registerMobileDevice can pick it
    // up on next register/refresh; see the voipPushToken useEffect below
    // for the late-arrival re-register path.
    const unsubscribeVoip = initVoipPushListener({
      onToken: (hexToken) => {
        console.log("[VOIP_PUSH] token received:", hexToken.slice(0, 12) + "...");
        setVoipPushToken(hexToken);
      },
      onIncoming: (payload) => {
        // iOS-only (this listener is installed only on iOS). When an APNs VoIP
        // push arrives we MUST report the call to CallKit promptly, then persist
        // the invite so the EXISTING answer/decline pipeline (CallKeep
        // answerCall/endCall → handleAcceptInvite/handleDeclineInvite) can act
        // on it. We deliberately DO NOT connect SIP/WebRTC here — that only
        // happens after the user taps Answer.
        try {
          const callId = String(payload?.inviteId || (payload as any)?.callId || "");
          console.log("[VOIP_PUSH] incoming notification, callId:", callId || "(none)");
          if (!callId) {
            console.warn("[VOIP_PUSH] onIncoming missing callId — cannot report to CallKit");
            return;
          }
          // COWORK build 20 (2026-07-16): server-driven CANCEL VoIP push
          // (cancel="1"). The NATIVE handler has already ended the CallKit
          // call(s); here we only clean JS invite state so no recovery path
          // resurrects the call. Must NEVER fall through to payloadToInvite
          // below — that would fabricate a fresh incoming call out of a
          // cancellation.
          const cancelFlag = String((payload as any)?.cancel ?? "");
          if (cancelFlag === "1" || cancelFlag === "true" || (payload as any)?.type === "INVITE_CANCELED") {
            const altId = String((payload as any)?.altCallId || "");
            console.log("[VOIP_PUSH] cancel push — clearing invite state callId=", callId, "altCallId=", altId || "(none)");
            suppressedIncomingInviteIdsRef.current.add(callId);
            if (altId) suppressedIncomingInviteIdsRef.current.add(altId);
            endNativeCall(callId);
            if (altId && altId !== callId) endNativeCall(altId);
            setIncomingInvite((prev) => {
              if (!prev || (prev.id !== callId && prev.id !== altId)) return prev;
              clearExpireTimer();
              shownInviteIdRef.current = null;
              setIncomingCallUiState({ phase: "idle", inviteId: null, error: null });
              AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
              return null;
            });
            return;
          }
          // If this call was already canceled/answered-elsewhere, don't resurrect
          // it; make sure CallKit clears any stale report instead.
          if (suppressedIncomingInviteIdsRef.current.has(callId)) {
            console.log("[VOIP_PUSH] callId already suppressed — ending CallKit:", callId);
            endNativeCall(callId);
            return;
          }
          // Map the minimal VoIP payload (callId/callerNumber/callerName/…) onto
          // the same CallInvite shape the Expo/FCM path produces, so downstream
          // dedupe + answer logic is identical across both push transports.
          const invite = payloadToInvite({
            type: "INCOMING_CALL",
            ...(payload as any),
            inviteId: callId,
            callId,
            fromNumber:
              (payload as any)?.callerNumber ??
              (payload as any)?.fromNumber ??
              (payload as any)?.from ??
              "",
            fromDisplay: (payload as any)?.callerName ?? (payload as any)?.fromDisplay ?? null,
            _pushReceivedAt: Date.now(),
          } as any);

          timingsRef.current[`push_${invite.id}`] = Date.now();
          emitAnswerFlowEvent("INCOMING_PUSH_RECEIVED", invite, { source: "ios_voip_push" });

          // 1) Report to CallKit FIRST (idempotent — deduped in callkeep.ts).
          showIncomingNativeCall(invite.id, invite.fromNumber || invite.fromDisplay || "", invite.fromDisplay);
          // 2) Persist invite state so resolveInviteForAction can answer/decline
          //    without a race (safeSetInvite also dedupes via shownInviteIdRef).
          safeSetInvite(invite);
        } catch (e) {
          console.warn(
            "[VOIP_PUSH] onIncoming handler error:",
            e instanceof Error ? e.message : String(e),
          );
        }
      },
    });

    const unsubNative = subscribeNativeCallActions({
      onAnswer: async (callId) => {
        {
          const pd = pendingDeclineTimersRef.current.get(callId);
          if (pd) { clearTimeout(pd); pendingDeclineTimersRef.current.delete(callId); }
        }
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
          // iOS ONLY (cold-killed launch): the invite metadata isn't resolvable
          // yet (memory empty, token not hydrated, AsyncStorage/native-cache not
          // yet written). Don't drop the tap — defer and replay once the invite
          // resolves and SIP registers.
          if (Platform.OS === "ios") {
            console.warn('[CALLKEEP_ANSWER] no invite yet for callId=' + callId + ', deferring accept until SIP/invite ready');
            await deferNativeAcceptUntilReady(callId);
            return;
          }
          // Android: original behavior, untouched — end the native call.
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
        const acceptKey = invite ? ("accept:" + invite.id) : null;
        // "Already answered" = the app recorded an accept for this invite (only
        // added AFTER the answer succeeds, so it is false during the vulnerable
        // answer-race window) OR the SIP call is currently connected. The
        // connected fallback matters for a cold lock-screen answer where the
        // invite is no longer resolvable, so a later CallKit endCall is still
        // recognised as a real hangup rather than a ring decline.
        const alreadyAnswered =
          (!!acceptKey && consumedInviteActionRef.current.has(acceptKey)) ||
          sip.callState === "connected";
        // COWORK fix (2026-07-13): a real hangup of an ESTABLISHED call must BYE
        // the active SIP session. handleDeclineInvite only sends a ring DECLINE
        // (respondInvite DECLINE + rejectIncomingInvite -> 486), which does NOT
        // tear down a confirmed dialog — so the call stayed up (lock-screen
        // "hang up doesn't hang up") and the ongoing-call banner stayed stuck.
        // Terminate the live session instead. Same end-immediately gating as
        // before (this branch previously ran handleDeclineInvite); only the
        // teardown mechanism changed, so the answer race is unaffected.
        if (alreadyAnswered) {
          endNativeCall(callId);
          await sip.hangup().catch(() => undefined);
          return;
        }
        // iOS cold-answer race guard: a stray CallKit endCall can fire around
        // the answer tap and beat it, declining our own still-ringing invite so
        // the caller lands in voicemail. For a not-yet-answered call, defer the
        // decline; onAnswer cancels it when the user is answering. Android is
        // unchanged.
        if (Platform.OS === "ios") {
          if (!pendingDeclineTimersRef.current.has(callId)) {
            const timer = setTimeout(() => {
              pendingDeclineTimersRef.current.delete(callId);
              void handleDeclineInvite(invite, callId);
            }, IOS_DECLINE_GRACE_MS);
            pendingDeclineTimersRef.current.set(callId, timer);
          }
          return;
        }
        await handleDeclineInvite(invite, callId);
      },
    });

    return () => {
      unsubNative();
      try { unsubscribeVoip(); } catch { /* ignore — unmount racing teardown */ }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, emitAnswerFlowEvent, handleAcceptInvite, handleDeclineInvite, resolveInviteForAction, safeSetInvite, deferNativeAcceptUntilReady]);

  // Re-register the backend MobileDevice when the VoIP push token arrives
  // late (normal on a fresh iOS install — PushKit issues the token async,
  // often after our initial registerMobileDevice already fired with just
  // the expoPushToken). We dedupe via lastSentVoipTokenRef so the effect
  // body is a no-op on every subsequent render. Android is early-returned.
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    if (!voipPushToken || !token || !expoPushToken) return;
    if (lastSentVoipTokenRef.current === voipPushToken) return;
    lastSentVoipTokenRef.current = voipPushToken;
    (async () => {
      try {
        const metadata = await mobileDeviceRegistrationMetadata();
        const reg = await registerMobileDevice(token, {
          platform: "IOS",
          expoPushToken,
          voipPushToken,
          ...metadata,
        });
        if (reg?.id) deviceIdRef.current = String(reg.id);
        await SecureStore.setItemAsync(EXPO_PUSH_TOKEN_KEY, expoPushToken).catch(() => undefined);
        console.log("[VOIP_PUSH] re-registered device with VoIP token, id:", reg?.id ?? "(none)");
      } catch (e) {
        console.warn("[VOIP_PUSH] re-register with VoIP token failed:", e instanceof Error ? e.message : String(e));
        // Clear so we retry on the next token delivery if it fails.
        lastSentVoipTokenRef.current = null;
      }
    })();
  }, [voipPushToken, token, expoPushToken]);

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
    if (token) {
      void uploadAndClearIosRingLog({ apiBaseUrl: API_BASE, token });
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

      if (action === "open" || action === "reply") {
        // "reply" = "open" + auto-open the quick-reply sheet on the
        // IncomingCallScreen (the screen clears the flag after consuming it).
        if (action === "reply") setQuickReplyInviteId(inviteId);
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

      // Mirror the saved incoming-ringtone choice to the native ring path so
      // it honours "Classic Ring" (phone ringtone) vs "Connect Default" even
      // on the very first FCM ring after launch.
      void syncMobileIncomingRingtoneToNative();

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
            showAppAlert(
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
        // Same VoIP-token attach as the retry path — see the PUSH_RETRY
        // block above for why this is iOS-only and optional.
        const voipToken = Platform.OS === "ios" ? (getCachedVoipPushToken() ?? undefined) : undefined;
        const metadata = await mobileDeviceRegistrationMetadata();
        const reg = await registerMobileDevice(token, {
          platform: Platform.OS === "ios" ? "IOS" : "ANDROID",
          expoPushToken: currentToken,
          ...(voipToken ? { voipPushToken: voipToken } : {}),
          ...metadata,
        }).catch((e) => {
          console.warn("[PUSH_INIT] registerMobileDevice failed:", e instanceof Error ? e.message : String(e));
          return null;
        });
        if (reg?.id) {
          deviceIdRef.current = String(reg.id);
          await SecureStore.setItemAsync(EXPO_PUSH_TOKEN_KEY, currentToken).catch(() => undefined);
          console.log("[PUSH_INIT] Device registered, id:", reg.id, "voip:", voipToken ? "yes" : "no");
        } else {
          console.warn("[PUSH_INIT] registerMobileDevice returned no id — response:", JSON.stringify(reg));
        }

        if (mounted) {
          setCallReadiness((prev) => ({
            ...prev,
            pushTokenRegistered: true,
            pushTokenError: null,
            pushTokenRetrying: false,
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
            // The auto-retry effect will look at pushTokenError and schedule
            // the next attempt with backoff; we just record the failure here.
            pushTokenRetrying: false,
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
                  showIncomingNativeCall(invite.id, invite.fromNumber || invite.fromDisplay || "", invite.fromDisplay);
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
              showIncomingNativeCall(invite.id, invite.fromNumber || invite.fromDisplay || "", invite.fromDisplay);
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
          showIncomingNativeCall(invite.id, invite.fromNumber || invite.fromDisplay || "", invite.fromDisplay);
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
      const t = typeof (data as any)?.type === "string" ? String((data as any).type) : "";
      if (t === "voicemail" || t === "missed_call" || t === "dm_message" || t === "sms_message") {
        console.log("[CONNECT_USER_ALERT] notification_received", {
          type: t,
          channel: (data as any)?.androidChannelId,
          messageId: (data as any)?.messageId,
          voicemailId: (data as any)?.voicemailId,
        });

        // ── Foreground presentation of user alerts ──────────────────────────
        // The native FCM service (IncomingCallFirebaseService) deliberately
        // skips posting a tray notification while the app is foreground, and a
        // strict data-only push has no OS-rendered banner. Without this, a new
        // voicemail / chat message / missed call that arrives while the app is
        // open is silently dropped (the user's exact complaint). Present a
        // local notification so it always surfaces in-app.
        //
        // Guards:
        //  - _localPresented: prevents the re-entrant loop (this very listener
        //    fires again for the notification we schedule below).
        //  - hasOsContent: if the push already carried a notification block
        //    (title/body), the OS/handler renders it — don't duplicate.
        //  - shouldSuppressForegroundPush: don't alert for the chat thread the
        //    user is actively viewing.
        const hasOsContent = !!(evt.request.content.title || evt.request.content.body);
        if (shouldPresentForegroundUserAlert(data, hasOsContent)) {
          const channelId = userAlertChannelId(data);
          // Android: post through the native grouping/MessagingStyle engine so
          // foreground alerts collapse + count up and carry the inline Reply
          // action exactly like background pushes. iOS keeps the Expo path.
          // Only post natively when the app is genuinely active. When it's
          // backgrounded the native FCM service already posted the grouped
          // notification, so posting again here would double-count.
          const nativeMod: any =
            Platform.OS === "android" && AppState.currentState === "active"
              ? (NativeModules as any)?.IncomingCallUi
              : null;
          if (nativeMod?.postUserAlert) {
            try {
              nativeMod.postUserAlert({ ...(data as any), androidChannelId: channelId });
            } catch {
              /* fall through to Expo scheduling on any native failure */
            }
          } else if (Platform.OS !== "android" || AppState.currentState === "active") {
            Notifications.scheduleNotificationAsync({
              content: {
                title: String((data as any).alertTitle),
                body: (data as any)?.alertBody ? String((data as any).alertBody) : undefined,
                data: { ...(data as any), _localPresented: true },
                sound: "default",
              },
              trigger: Platform.OS === "android" ? ({ channelId } as any) : null,
            }).catch(() => undefined);
          }
        }
      }

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
          showIncomingNativeCall(invite.id, invite.fromNumber || invite.fromDisplay || "", invite.fromDisplay);
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

      if (data?.type === "INVITE_CLAIMED" || data?.type === "INVITE_CANCELED" || data?.type === "MISSED_CALL") {
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
          // INVITE_CLAIMED (answered on another device) or MISSED_CALL: dismiss immediately.
          clearExpireTimer();
          shownInviteIdRef.current = null;
          setIncomingCallUiState({ phase: "idle", inviteId: null, error: null });
          return null;
        });
      }

      // ── Missed call local notification ───────────────────────────────────
      // Removed: JS scheduleNotificationAsync for MISSED_CALL was redundant on
      // Android. IncomingCallFirebaseService.postMissedCallNotification() posts
      // the native notification directly via the connect-missed-calls channel,
      // so the JS path produced a duplicate notification every time.
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
      // Re-read the live OS battery-optimization + mic state every time the app
      // returns to the foreground (e.g. the user just came back from toggling
      // "Don't optimize"), so the Settings rows never show a stale/guessed value.
      refreshDeviceReadiness().catch(() => undefined);
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
        } else if (
          // Permission already granted, but the token is still missing because
          // a previous attempt hit a retryable error (typically Google Play
          // Services SERVICE_NOT_AVAILABLE on Moto G / Lenovo / older Android
          // 14 builds). Coming back to the foreground is a strong signal that
          // the user is actively using the app — Play Services has often
          // recovered by now, and even if not, a fresh attempt with a reset
          // backoff ladder is much friendlier than waiting up to 5 minutes
          // for the next scheduled retry timer to fire.
          nowGranted &&
          tokenMissing &&
          token &&
          isRetryablePushTokenError(prev.pushTokenError)
        ) {
          console.log(
            "[PUSH_RETRY_AUTO] App returned to foreground with retryable token error — kicking immediate retry",
          );
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
  }, [token, retryPushTokenRegistration, refreshDeviceReadiness]);

  // ── One-shot readiness check on mount ─────────────────────────────────────
  // Ensures the Settings rows have real battery/mic state the first time they
  // render, without waiting for a background→foreground transition.
  useEffect(() => {
    refreshDeviceReadiness().catch(() => undefined);
  }, [refreshDeviceReadiness]);

  // ── iOS foreground-active heartbeat — REMOVED 2026-07-07 ──────────────────
  // A heartbeat to /mobile/foreground-active used to live here, gating the
  // backend's APNs VoIP-push send (sendApnsVoipPushesForIncomingCallApi) off
  // while the app was foregrounded. It caused a real incoming-call outage and
  // was removed (see git history for the old effect body). Root cause: the
  // in-app Connect incoming-call screen (IncomingCallScreen) is ONLY ever
  // mounted by `safeSetInvite()` inside the APNs VoIP-push `onIncoming`
  // handler above — there is no code path on iOS that sets `incomingInvite`
  // from the raw SIP INVITE arriving over the live JsSIP socket (unlike
  // Android, which has the FCM `IncomingCall.ForegroundInvite` native event
  // as a fallback). The ringtone alone still fires independently (jssip.ts
  // calls startRingtone() straight off newRTCSession), which is why pinging
  // that endpoint produced "ringtone plays but no screen — neither native nor
  // in-app" while foregrounded: skipping the VoIP push also skipped the ONLY
  // thing that populates `incomingInvite`, so neither CallKit NOR the in-app
  // screen ever appeared. Re-adding this safely requires first constructing a
  // CallInvite from the live SIP session/headers and routing it into
  // `safeSetInvite` the same way onIncoming does, gated to
  // iOS-foreground-active — a real feature, not a quick re-enable.
  // The backend endpoint (/mobile/foreground-active) and gate remain deployed
  // but are now permanently inert since nothing calls them anymore.

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
      // Outbound flight sessions are opened/closed in SipContext.dial().
      const inboundCtx =
        answerInviteRef.current?.id ||
        answerHandoffInviteIdRef.current ||
        shownInviteIdRef.current ||
        incomingInvite?.id ||
        null;
      if (sip.callState === "ended" && inboundCtx) {
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

  // ── Device keep-alive health heartbeat (Android) ───────────────────────────
  // Periodically refresh MobileDevice.keepAliveSnapshot so the admin Device
  // Registration dashboard shows a CONTINUOUS health signal (FGS running?
  // startForeground landed? which process? battery exempt? re-arm count) rather
  // than only the snapshot captured once at launch. Reuses the already-issued
  // Expo push token (no token re-fetch) and the backend upsert is idempotent by
  // token, so this is cheap and safe to run alongside the diag heartbeat.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    if (!token || !expoPushToken) return;
    let cancelled = false;
    const push = async () => {
      try {
        const metadata = await mobileDeviceRegistrationMetadata();
        if (cancelled) return;
        await registerMobileDevice(token, {
          platform: "ANDROID",
          expoPushToken,
          ...metadata,
        }).catch(() => undefined);
      } catch {
        // best-effort — never block on a health refresh
      }
    };
    const interval = setInterval(() => void push(), 60_000);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void push();
    });
    return () => {
      cancelled = true;
      clearInterval(interval);
      sub.remove();
    };
  }, [token, expoPushToken]);

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
      quickReplyInviteId,
      clearQuickReplyRequest: () => setQuickReplyInviteId(null),
      clearIncomingInvite: () => safeSetInvite(null),
      answerIncomingCall: (invite: CallInvite) =>
        handleAcceptInvite(invite, invite.id, { skipBringToForeground: false }),
      declineIncomingCall: (invite: CallInvite | null) =>
        handleDeclineInvite(invite, invite?.id || ""),
      runMediaTest,
      callReadiness,
      openBatteryOptimizationSettings,
      requestBatteryOptimizationExclusion,
      requestNotificationPermission,
      requestMicrophonePermission,
      refreshDeviceReadiness,
      retryPushTokenRegistration,
    }),
    [
      expoPushToken,
      incomingInvite,
      incomingCallUiState,
      answerHandoffTick,
      quickReplyInviteId,
      runMediaTest,
      callReadiness,
      safeSetInvite,
      handleAcceptInvite,
      handleDeclineInvite,
      requestBatteryOptimizationExclusion,
      requestNotificationPermission,
      requestMicrophonePermission,
      refreshDeviceReadiness,
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
