import type { ExpoConfig } from "expo/config";

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
    voiceSimulate: process.env.EXPO_PUBLIC_VOICE_SIMULATE,
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
