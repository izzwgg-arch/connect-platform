import type { ExpoConfig } from "expo/config";

function resolveProfile(): string {
  return String(process.env.EAS_BUILD_PROFILE || process.env.EXPO_BUILD_PROFILE || "dev").toLowerCase();
}

const profile = resolveProfile();
const isProdProfile = profile === "production";
const requestedVoiceSimulate = String(process.env.EXPO_PUBLIC_VOICE_SIMULATE || "false").toLowerCase() === "true";
const voiceSimulate = isProdProfile ? false : requestedVoiceSimulate;
const logLevel = (process.env.EXPO_PUBLIC_LOG_LEVEL || (isProdProfile ? "warn" : profile === "preview" ? "info" : "debug")).toLowerCase();

const config: ExpoConfig = {
  name: "Connect Communications",
  slug: "connect-mobile",
  version: "1.0.0",
  orientation: "portrait",
  userInterfaceStyle: "light",
  ios: {
    supportsTablet: false,
    bundleIdentifier: "com.connectcommunications.mobile",
    infoPlist: {
      NSCameraUsageDescription: "Camera access is required to scan PBX provisioning QR codes.",
      NSMicrophoneUsageDescription: "Microphone access is required for voice calls.",
      UIBackgroundModes: ["voip", "remote-notification"]
    }
  },
  android: {
    package: "com.connectcommunications.mobile",
    permissions: ["CAMERA", "RECORD_AUDIO", "MODIFY_AUDIO_SETTINGS", "POST_NOTIFICATIONS", "FOREGROUND_SERVICE"]
  },
  extra: {
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL,
    voiceSimulate,
    logLevel,
    buildProfile: profile,
    easProjectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID
  },
  plugins: [
    "expo-secure-store",
    "expo-notifications",
    "expo-dev-client",
    [
      "expo-camera",
      {
        cameraPermission: "Allow Connect Communications to scan provisioning QR codes."
      }
    ]
  ]
};

export default config;
