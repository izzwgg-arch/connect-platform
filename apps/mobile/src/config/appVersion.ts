// Single source of truth for "what build is this phone actually running?".
//
// WHY THIS EXISTS (2026-07-31): every Android device in the fleet reported a
// bare "1.0.0" to the server — all 16 of them — because the register payload
// used `Constants.expoConfig?.version` (a static JS string) and
// `Constants.nativeBuildVersion` came back EMPTY on our Android builds. With no
// build number, "which phones are on the July build?" was unanswerable, and a
// whole diagnostic round was spent unable to tell whether 10 devices lacked a
// push token because of an old APK or a runtime failure.
//
// The Android native module already exposes the real values from the package
// manager (IncomingCallUiModule.getDeviceInfo -> versionName / versionCode), so
// prefer those and keep expo-constants as the fallback and the iOS path.

import Constants from "expo-constants";
import { NativeModules, Platform } from "react-native";

/** e.g. "1.0.0+20260731" on Android, "1.0.0+37" on iOS. Never throws. */
export function mobileAppVersion(): string {
  if (Platform.OS === "android") {
    try {
      const native = (NativeModules as any)?.IncomingCallUi?.getDeviceInfo?.();
      if (native && typeof native === "object") {
        const v = String(native.appVersion || "");
        const b = String(native.appBuild || "");
        if (v) return b ? `${v}+${b}` : v;
      }
    } catch {
      // fall through to the Constants path
    }
  }
  const nativeVersion = Constants.nativeApplicationVersion || Constants.expoConfig?.version || "unknown";
  const nativeBuild = Constants.nativeBuildVersion || "";
  return nativeBuild ? `${nativeVersion}+${nativeBuild}` : nativeVersion;
}

/** Native build number alone (Android versionCode / iOS buildNumber), or "". */
export function mobileAppBuild(): string {
  if (Platform.OS === "android") {
    try {
      const native = (NativeModules as any)?.IncomingCallUi?.getDeviceInfo?.();
      if (native && typeof native === "object") {
        const b = String(native.appBuild || "");
        if (b) return b;
      }
    } catch {
      // fall through
    }
  }
  return String(Constants.nativeBuildVersion || "");
}
