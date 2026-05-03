/**
 * Call wake diagnostics — JS-side surface over IncomingCallUiModule.
 *
 * These helpers read the Android native state so the Diagnostics screen can
 * show, for any device:
 *
 *   • whether the OS still grants USE_FULL_SCREEN_INTENT (Android 14+ can
 *     silently revoke this — the most likely Samsung S25 wake regression)
 *   • whether POST_NOTIFICATIONS is granted
 *   • the current incoming-call channel importance
 *   • when the FCM push physically reached IncomingCallFirebaseService
 *   • when the native CallStyle notification was last posted
 *   • when the ringtone last started/stopped
 *
 * iOS returns sane defaults (everything "ok" / unknown) so the screen can be
 * cross-platform without conditional rendering everywhere.
 */

import { NativeModules, Platform } from "react-native";

const Native: any = (NativeModules as any).IncomingCallUi ?? null;

export type CallWakeDeviceInfo = {
  manufacturer: string;
  model: string;
  brand: string;
  device: string;
  hardware: string;
  osVersion: string;
  sdkInt: number;
  packageName: string;
  appVersion: string;
  appBuild: string;
};

export type CallWakeNativeState = {
  lastPushReceivedAtMs: number;
  lastPushType: string;
  lastPushInviteId: string;
  lastPushReceivedAppState: string;
  lastIncomingUiDisplayedAtMs: number;
  lastIncomingUiPresentation: string;
  lastPushError: string;
  ringtoneStartedAtMs: number;
  ringtoneStoppedAtMs: number;
  ringtoneStopReason: string;
  /** Push-wake (Option 2) — last INCOMING_CALL_WAKE FCM receipt. */
  lastWakePushReceivedAtMs: number;
  lastWakePushPbxCallId: string;
  lastWakePushExtension: string;
  lastWakeBridgeEmittedAtMs: number;
  lastWakeBridgeStatus: string;
};

export type CallWakePermissionState = {
  notificationsEnabled: boolean | null;
  canUseFullScreenIntent: boolean | null;
  callChannelImportance: number | null;
  batteryOptimizationIgnored: boolean | null;
};

const EMPTY_NATIVE_STATE: CallWakeNativeState = {
  lastPushReceivedAtMs: 0,
  lastPushType: "",
  lastPushInviteId: "",
  lastPushReceivedAppState: "",
  lastIncomingUiDisplayedAtMs: 0,
  lastIncomingUiPresentation: "",
  lastPushError: "",
  ringtoneStartedAtMs: 0,
  ringtoneStoppedAtMs: 0,
  ringtoneStopReason: "",
  lastWakePushReceivedAtMs: 0,
  lastWakePushPbxCallId: "",
  lastWakePushExtension: "",
  lastWakeBridgeEmittedAtMs: 0,
  lastWakeBridgeStatus: "",
};

const EMPTY_DEVICE_INFO: CallWakeDeviceInfo = {
  manufacturer: "",
  model: "",
  brand: "",
  device: "",
  hardware: "",
  osVersion: "",
  sdkInt: 0,
  packageName: "",
  appVersion: "",
  appBuild: "",
};

export function getCallWakeNativeState(): CallWakeNativeState {
  if (Platform.OS !== "android" || !Native?.getCallWakeDiagnostics) {
    return EMPTY_NATIVE_STATE;
  }
  try {
    const raw = Native.getCallWakeDiagnostics();
    if (!raw || typeof raw !== "object") return EMPTY_NATIVE_STATE;
    return {
      lastPushReceivedAtMs: Number(raw.lastPushReceivedAtMs) || 0,
      lastPushType: String(raw.lastPushType ?? ""),
      lastPushInviteId: String(raw.lastPushInviteId ?? ""),
      lastPushReceivedAppState: String(raw.lastPushReceivedAppState ?? ""),
      lastIncomingUiDisplayedAtMs: Number(raw.lastIncomingUiDisplayedAtMs) || 0,
      lastIncomingUiPresentation: String(raw.lastIncomingUiPresentation ?? ""),
      lastPushError: String(raw.lastPushError ?? ""),
      ringtoneStartedAtMs: Number(raw.ringtoneStartedAtMs) || 0,
      ringtoneStoppedAtMs: Number(raw.ringtoneStoppedAtMs) || 0,
      ringtoneStopReason: String(raw.ringtoneStopReason ?? ""),
      lastWakePushReceivedAtMs: Number(raw.lastWakePushReceivedAtMs) || 0,
      lastWakePushPbxCallId: String(raw.lastWakePushPbxCallId ?? ""),
      lastWakePushExtension: String(raw.lastWakePushExtension ?? ""),
      lastWakeBridgeEmittedAtMs: Number(raw.lastWakeBridgeEmittedAtMs) || 0,
      lastWakeBridgeStatus: String(raw.lastWakeBridgeStatus ?? ""),
    };
  } catch {
    return EMPTY_NATIVE_STATE;
  }
}

export function getCallWakeDeviceInfo(): CallWakeDeviceInfo {
  if (Platform.OS !== "android" || !Native?.getDeviceInfo) {
    return EMPTY_DEVICE_INFO;
  }
  try {
    const raw = Native.getDeviceInfo();
    if (!raw || typeof raw !== "object") return EMPTY_DEVICE_INFO;
    return {
      manufacturer: String(raw.manufacturer ?? ""),
      model: String(raw.model ?? ""),
      brand: String(raw.brand ?? ""),
      device: String(raw.device ?? ""),
      hardware: String(raw.hardware ?? ""),
      osVersion: String(raw.osVersion ?? ""),
      sdkInt: Number(raw.sdkInt) || 0,
      packageName: String(raw.packageName ?? ""),
      appVersion: String(raw.appVersion ?? ""),
      appBuild: String(raw.appBuild ?? ""),
    };
  } catch {
    return EMPTY_DEVICE_INFO;
  }
}

export async function getCallWakePermissionState(): Promise<CallWakePermissionState> {
  if (Platform.OS !== "android" || !Native) {
    return {
      notificationsEnabled: null,
      canUseFullScreenIntent: null,
      callChannelImportance: null,
      batteryOptimizationIgnored: null,
    };
  }
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };
  const [notif, fsi, importance, batt] = await Promise.all([
    Native.areNotificationsEnabled
      ? safe<boolean>(() => Native.areNotificationsEnabled(), true)
      : Promise.resolve<boolean | null>(null),
    Native.canUseFullScreenIntent
      ? safe<boolean>(() => Native.canUseFullScreenIntent(), true)
      : Promise.resolve<boolean | null>(null),
    Native.getCallChannelImportance
      ? safe<number>(() => Native.getCallChannelImportance(), -1)
      : Promise.resolve<number | null>(null),
    Native.isBatteryOptimizationIgnored
      ? safe<boolean>(() => Native.isBatteryOptimizationIgnored(), false)
      : Promise.resolve<boolean | null>(null),
  ]);
  return {
    notificationsEnabled: notif as boolean | null,
    canUseFullScreenIntent: fsi as boolean | null,
    callChannelImportance: importance as number | null,
    batteryOptimizationIgnored: batt as boolean | null,
  };
}

export async function requestFullScreenIntentPermission(): Promise<boolean> {
  if (Platform.OS !== "android" || !Native?.requestFullScreenIntentPermission) return false;
  try {
    return Boolean(await Native.requestFullScreenIntentPermission());
  } catch {
    return false;
  }
}

/** True if the device manufacturer is Samsung (case-insensitive). */
export function isSamsungDevice(info: CallWakeDeviceInfo): boolean {
  const m = (info.manufacturer || info.brand || "").toLowerCase();
  return m === "samsung";
}

/**
 * Convert NotificationManager.IMPORTANCE_* into a label.
 * Mirrors the AOSP constants:
 *   NONE=0, MIN=1, LOW=2, DEFAULT=3, HIGH=4, MAX=5.
 */
export function describeChannelImportance(value: number | null | undefined): string {
  if (value == null) return "n/a";
  switch (value) {
    case 0: return "none";
    case 1: return "min";
    case 2: return "low";
    case 3: return "default";
    case 4: return "high";
    case 5: return "max";
    case -1: return "channel not yet created";
    default: return `unknown(${value})`;
  }
}

export function formatTimestamp(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "never";
  try {
    const date = new Date(ms);
    const ago = Date.now() - ms;
    const seconds = Math.round(ago / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
    return date.toLocaleString();
  } catch {
    return String(ms);
  }
}
