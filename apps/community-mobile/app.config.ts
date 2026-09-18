import type { ExpoConfig } from "expo/config";

const easProjectId = process.env.EAS_PROJECT_ID_COMMUNITY || "00000000-0000-0000-0000-000000000000";

// Deep links: community.loopcom.net universal/app links plus the custom
// scheme, both routed through the same paths so a push notification's `href`
// (e.g. "/people/jdoe") and a real https link behave identically. See
// src/navigation/linking.ts for the path -> screen table this mirrors.
const ASSOCIATED_DOMAIN = "applinks:community.loopcom.net";
const HOST = "community.loopcom.net";

const config: ExpoConfig = {
  name: "Loopcom Community",
  slug: "loopcom-community",
  scheme: "loopcomcommunity",
  version: "1.0.0",
  runtimeVersion: "1.0.0",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  backgroundColor: "#0c1218",
  icon: "./assets/icon.png",
  splash: {
    image: "./assets/splash.png",
    backgroundColor: "#0c1218",
    resizeMode: "contain",
  },
  updates: { enabled: false },
  assetBundlePatterns: ["**/*"],
  ios: {
    supportsTablet: true,
    bundleIdentifier: "net.loopcom.community",
    buildNumber: "1",
    associatedDomains: [ASSOCIATED_DOMAIN],
    infoPlist: {
      CFBundleName: "Loopcom Community",
      CFBundleDisplayName: "Loopcom Community",
      NSCameraUsageDescription:
        "Loopcom Community uses the camera to scan a person's profile QR code and to attach photos or video to posts and messages.",
      NSPhotoLibraryUsageDescription:
        "Loopcom Community accesses your photo library only when you choose to attach a photo or video to a post or message.",
      NSContactsUsageDescription:
        "Loopcom Community can save a person's card to your phone contacts after you scan their profile QR code.",
      NSFaceIDUsageDescription: "Use Face ID to unlock Loopcom Community instead of typing your password every time.",
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: "net.loopcom.community",
    backgroundColor: "#0c1218",
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundImage: "./assets/adaptive-icon-background.png",
    },
    minSdkVersion: 24,
    permissions: [
      "CAMERA",
      "RECORD_AUDIO",
      "POST_NOTIFICATIONS",
      "READ_CONTACTS",
      "WRITE_CONTACTS",
      "USE_BIOMETRIC",
      "USE_FINGERPRINT",
    ],
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [{ scheme: "https", host: HOST, pathPrefix: "/" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
      {
        action: "VIEW",
        data: [{ scheme: "loopcomcommunity" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  extra: {
    // Android emulator reaches the host machine's localhost via 10.0.2.2; iOS
    // simulator shares the host's localhost directly. Overridden by
    // EXPO_PUBLIC_API_BASE_URL for device/preview/production builds (see eas.json).
    apiUrl: process.env.EXPO_PUBLIC_API_BASE_URL || undefined,
    loopcomPortalUrl: process.env.EXPO_PUBLIC_LOOPCOM_PORTAL_URL || "https://app.loopcom.net",
    googleClientIdIos: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS || null,
    googleClientIdAndroid: process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_ANDROID || null,
    eas: { projectId: easProjectId },
  },
  plugins: [
    "expo-secure-store",
    [
      "expo-notifications",
      {
        icon: "./assets/notification-icon.png",
        color: "#22a8ff",
      },
    ],
    [
      "expo-camera",
      { cameraPermission: "Allow Loopcom Community to scan profile and provisioning QR codes." },
    ],
    [
      "expo-contacts",
      { contactsPermission: "Allow Loopcom Community to save scanned contacts to your phone." },
    ],
    [
      "expo-image-picker",
      {
        photosPermission: "Loopcom Community accesses your photo library only when you attach a photo or video.",
      },
    ],
  ],
};

export default config;
